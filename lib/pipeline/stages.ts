// The fifteen pipeline stages.
//
// One stage (`evaluate_signals`) calls a model on every run. `find_contact_
// candidates` calls a second model, but ONLY in one narrow, rare state — the
// company qualified and the submitted person did not — and every other run
// pays nothing for it: the stage is a zero-cost no-op otherwise. Everything
// else is deterministic code: URL validation, profile retrieval and
// normalization, search, dedup, scraping, scoring, hook gating, quote
// verification and claim checks. Safety gates stay in code, where a model
// cannot argue with them, in both cases: the discovery model proposes
// candidates, and lib/contacts/rank.ts independently verifies and ranks them.
//
// Rules that hold for every stage:
//   * It records what actually happened — durations, provider failures, counts.
//   * A failure is written to the stage row and surfaced; never fabricated over.
//   * Partial failure (one provider down) degrades the stage; total failure
//     fails the run and leaves the state intact for a retry.

import {
  finishStage,
  markSignalAsHook,
  replaceSignals,
  replaceSources,
  startStage,
  updateRun,
  createDraft,
  deleteDrafts,
  skipRemainingStages,
  listSignals,
} from '@/lib/supabase/queries';
import { checkVoice } from '@/lib/generation/voice';
import { briefForContext } from '@/lib/generation/brief';
import { writeEmailFromBrief, type WrittenEmail } from '@/lib/generation/write-email';
import { editEmail, chooseDraft } from '@/lib/generation/edit-email';
import { checkEmailQuality, repairDirective, checkDivergence, MIN_EMAIL_WORDS } from '@/lib/generation/email-quality';
import { parseLinkedInUrl } from '@/lib/linkedin/url';
import { retrieveLinkedInProfile } from '@/lib/linkedin/fetch';
import { renderProfile } from '@/lib/linkedin/profile';
import { research, enrichSources } from '@/lib/research/engine';
import {
  identityQueries,
  signalQueries,
  profileEnrichmentQueries,
  employerDiscoveryQueries,
} from '@/lib/research/queries';
import { resolveIdentity, mergeAnalysisIdentity } from '@/lib/research/identity';
import { evidenceBreakdown, type NormalizedSource } from '@/lib/research/normalize';
import { verifyHooks } from '@/lib/signals/verify';
import { recoverCitedSources, type RecoveryAttempt } from '@/lib/research/recover';
import { scoreSignals, gateHook, HOOK_THRESHOLD } from '@/lib/ranking/rank';
import { analyzeProspect } from '@/lib/llm/analyze';
import { LLMError } from '@/lib/llm/types';
import { getSenderConfig, outreachContext, INSUFFICIENT_EVIDENCE_NOTICE } from '@/lib/generation/sender';
import { validateClaims } from '@/lib/validation/factcheck';
import {
  AUTO_REVISED_MARKER,
  MAX_REPAIR_ATTEMPTS,
  blockingClaims,
  repairMessage,
  shouldAttemptRepair,
  verifyRepairSafety,
} from '@/lib/generation/repair';
import { configuredProviders } from '@/lib/search';
import { qualifyTarget } from '@/lib/qualification/qualify';
import {
  accountDecisionPending,
  accountDecisionRecord,
  contactDiscoveryUnlockedByDecision,
  continuationPath,
} from '@/lib/qualification/account-decision';
import { discoverCandidates } from '@/lib/identity/discover';
import { verifySelectedCandidate } from '@/lib/identity/verify';
import { decideIdentity, selectCandidate, accountFields } from '@/lib/identity/types';
import { reconcileProvenance, providerFields, candidateFields } from '@/lib/identity/provenance';
import { fieldRecoveryQueries, recoverIdentityField, type RecoverableField } from '@/lib/identity/recover-field';
import {
  combineQualification,
  PROSPECT_FIT_FLOOR,
  COMPANY_FIT_FLOOR,
  type TargetQualification,
} from '@/lib/qualification/types';
import { discoverContacts } from '@/lib/contacts/discover';
import {
  rolesForWorkflows,
  adjacentRolesForWorkflows,
  deeperRolesForWorkflows,
  tier2RolesForWorkflows,
  tier3RolesForWorkflows,
} from '@/lib/contacts/roles';
import { rankCandidates, isCurrentProspect } from '@/lib/contacts/rank';
import { preVerifyCandidate } from '@/lib/contacts/preverify';
import { createContactCandidates } from '@/lib/supabase/queries';
import { matchApprovedProof, proofForPrompt } from '@/lib/proof/match';
import { NO_PROOF_MATCH_MESSAGE } from '@/lib/proof/types';
import { matchApprovedSolution, solutionForPrompt } from '@/lib/solutions/match';
import { NO_SOLUTION_MATCH_MESSAGE } from '@/lib/solutions/types';
import { StageAbort, type PipelineContext } from './context';
import type { SignalRow, SourceRow, StageName, StageStatus } from '@/lib/types';

/**
 * A message safe to store and show, from whatever was thrown.
 *
 * `if (error) throw error;` runs throughout lib/supabase/queries.ts — but the
 * supabase-js client's `{ data, error }` return style hands back a PLAIN
 * PARSED JSON OBJECT for `error`, not an actual `Error` instance (that class
 * only gets constructed on the throw-on-error code path this codebase doesn't
 * use). `err instanceof Error` is therefore false for every database failure,
 * and `String(err)` on a plain object is JavaScript's default coercion:
 * literally the text "[object Object]". This was latent everywhere a stage's
 * generic catch could receive a database error — it only surfaced once
 * find_contact_candidates became the first stage to hit a genuinely failing
 * write (contact_candidates did not exist in the database yet).
 *
 * Handles three shapes without ever falling through to a bare String(object):
 * real Errors, Postgrest-shaped objects ({message, details, hint, code}), and
 * anything else via JSON.stringify.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [e.message, e.details, e.hint].filter(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    if (parts.length > 0) return parts.join(' — ');
    if (typeof e.code === 'string' && e.code) return `Unexpected error (code ${e.code})`;
    try {
      return JSON.stringify(err);
    } catch {
      return 'Unexpected error.';
    }
  }
  return String(err);
}

/**
 * Wrap a stage: time it, persist start/finish, and convert a thrown error into
 * a recorded failure plus a StageAbort that halts the run.
 */
async function runStage<T>(
  ctx: PipelineContext,
  name: StageName,
  fn: () => Promise<{ status: StageStatus; summary: string; output: unknown; value: T }>,
): Promise<T> {
  const stageId = await startStage(ctx.runId, name);
  const startedAt = Date.now();

  try {
    const { status, summary, output, value } = await fn();
    await finishStage(stageId, { status, summary, output, duration_ms: Date.now() - startedAt });
    if (status === 'failed') {
      await failRun(ctx, name, summary);
      throw new StageAbort(name, summary);
    }
    return value;
  } catch (err) {
    if (err instanceof StageAbort) throw err;
    const message = describeError(err);
    await finishStage(stageId, {
      status: 'failed',
      summary: `Stage failed: ${message}`,
      error: message,
      duration_ms: Date.now() - startedAt,
    });
    await failRun(ctx, name, message);
    throw new StageAbort(name, message);
  }
}

async function failRun(ctx: PipelineContext, stage: StageName, message: string): Promise<void> {
  await updateRun(ctx.runId, {
    status: 'failed',
    error: `${stage}: ${message}`,
    completed_at: new Date().toISOString(),
  });
  await skipRemainingStages(ctx.runId, stage);
}

// ─── 1. validate input ───────────────────────────────────────────────────────

export async function validateInputStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'validate_input', async () => {
    const parsed = parseLinkedInUrl(ctx.run.linkedin_url);
    if (!parsed.ok) {
      return {
        status: 'failed' as const,
        summary: parsed.error,
        output: { valid: false, error: parsed.error, input: ctx.run.linkedin_url },
        value: undefined,
      };
    }

    ctx.slug = parsed.slug;
    ctx.normalizedUrl = parsed.normalized_url;
    ctx.nameHint = parsed.name_hint;

    const providers = configuredProviders();
    if (providers.length === 0) {
      const message = 'No search provider is configured (set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY).';
      return {
        status: 'failed' as const,
        summary: message,
        output: { valid: true, normalized_url: parsed.normalized_url, error: message },
        value: undefined,
      };
    }

    return {
      status: 'complete' as const,
      summary: `Valid LinkedIn profile URL (/in/${parsed.slug}).`,
      output: {
        valid: true,
        normalized_url: parsed.normalized_url,
        slug: parsed.slug,
        name_hint: parsed.name_hint,
        search_providers: providers,
        user_supplied: {
          name: ctx.run.input_name,
          company: ctx.run.input_company,
          title: ctx.run.input_title,
        },
      },
      value: undefined,
    };
  });
}

// ─── 2. identify prospect (Bright Data; no model call) ───────────────────────

export async function identifyProspectStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'identify_prospect', async () => {
    // LinkedIn URLs go straight to the dedicated profile provider.
    const retrieval = await retrieveLinkedInProfile(ctx.normalizedUrl);
    ctx.linkedinAccess = retrieval;
    ctx.profile = retrieval.profile;

    // Identity from a retrieved profile is data mapping, not reasoning.
    ctx.identity = resolveIdentity(retrieval.profile, {
      slug: ctx.slug,
      nameHint: ctx.nameHint,
      userName: ctx.run.input_name,
      userCompany: ctx.run.input_company,
      userTitle: ctx.run.input_title,
    });

    // Persist immediately: later stages can fail, and genuinely retrieved
    // profile data must survive that so the UI reports the real source.
    await updateRun(ctx.runId, {
      linkedin_profile: retrieval.profile,
      profile_access: retrieval.access,
      profile_source: retrieval.meta?.source ?? null,
      linkedin_access_status: retrieval.access.directLinkedIn ? 'accessible' : 'unavailable',
      linkedin_access_note: retrieval.access.reason,
      prospect_name: ctx.identity.full_name,
      prospect_title: ctx.identity.role,
      company_name: ctx.identity.company,
      company_domain: ctx.identity.company_domain,
      identity_confidence: ctx.identity.confidence,
    });

    // The profile is itself evidence: register it as a source so any hook drawn
    // from it carries a real URL and quotable text, exactly like a news source.
    if (retrieval.profile) {
      ctx.sources.unshift({
        url: ctx.normalizedUrl,
        canonical_url: ctx.normalizedUrl,
        title: `${retrieval.profile.name ?? ctx.slug} — LinkedIn profile`,
        snippet: retrieval.profile.headline ?? '',
        source_type: 'linkedin',
        credibility: 0.85, // first-party profile data, retrieved directly
        published_date: null,
        providers: ['brightdata'],
        queries: [],
        categories: ['prospect_identity'],
        duplicate_count: 0,
        retrieved_at: retrieval.meta?.retrieved_at ?? new Date().toISOString(),
        content: renderProfile(retrieval.profile),
        fetch_status: 'scraped',
      });
      await persistSources(ctx);
    }

    // Lightweight discovery: who could this input represent? Deliberately not a
    // full research pass — proving identity is the verification stage's job.
    const discovery = await discoverCandidates({
      slug: ctx.slug,
      profile: retrieval.profile,
      profileAccessNote: retrieval.access.reason ?? 'Profile retrieved directly.',
      provisional: {
        name: ctx.identity.full_name,
        role: ctx.identity.role,
        company: ctx.identity.company,
        location: ctx.identity.location,
      },
      userHints: {
        name: ctx.run.input_name,
        company: ctx.run.input_company,
        title: ctx.run.input_title,
      },
      sources: ctx.sources,
    });
    ctx.identityCandidates = discovery.candidates;

    // Never strand a run with nothing to verify: if discovery found no one but
    // we have a name from the profile or the slug, carry that forward as a
    // low-confidence candidate for verification to judge honestly.
    if (ctx.identityCandidates.length === 0 && (ctx.identity.full_name || ctx.nameHint)) {
      ctx.identityCandidates = [
        {
          id: 'candidate_1',
          name: ctx.identity.full_name ?? ctx.nameHint,
          role: ctx.identity.role,
          company: ctx.identity.company,
          location: ctx.identity.location,
          headline: null,
          linkedin_url: ctx.normalizedUrl,
          confidence: retrieval.profile ? 55 : 25,
          sources: [],
          origin: retrieval.profile ? 'profile_provider' : 'public_research',
        },
      ];
    }

    const sourceLabel = retrieval.access.directLinkedIn
      ? `profile retrieved (${retrieval.access.profileCompleteness})`
      : 'no direct profile — public web only';

    return {
      status: (retrieval.access.directLinkedIn ? 'complete' : 'degraded') as StageStatus,
      summary:
        `${discovery.candidates.length} candidate identit${discovery.candidates.length === 1 ? 'y' : 'ies'} discovered · ` +
        sourceLabel,
      output: {
        candidates: discovery.candidates,
        visible_conflicts: discovery.conflicts,
        discovery_llm: discovery.meta,
        // Attribution: exactly where the profile data came from.
        profile_source: retrieval.meta,
        profile_access: retrieval.access,
        profile_error_code: retrieval.error_code,
        profile: retrieval.profile,
        profile_fetch_ms: retrieval.duration_ms,
        identity: ctx.identity,
      },
      value: undefined,
    };
  });
}

// ─── 3 & 4. research ─────────────────────────────────────────────────────────

async function researchStage(
  ctx: PipelineContext,
  stage: 'research_prospect' | 'research_company',
): Promise<void> {
  await runStage(ctx, stage, async () => {
    // Anchored to the verified identity — never the provider's original guess.
    const verified = ctx.identityVerification?.resolved;
    const name = verified?.name ?? ctx.identity?.full_name ?? ctx.run.input_name ?? ctx.nameHint;
    const company = verified?.company ?? ctx.identity?.company ?? ctx.run.input_company;

    const all = signalQueries(name, company);
    const queries =
      stage === 'research_prospect'
        ? [
            ...(name ? identityQueries({ name, slug: ctx.slug, company, title: ctx.identity?.role ?? null }) : []),
            ...all.filter((q) => q.category.startsWith('prospect')),
            ...(ctx.profile ? profileEnrichmentQueries(ctx.profile) : []),
          ]
        : all.filter((q) => q.category.startsWith('company'));

    // A partial profile often lacks the employer. Rather than skipping company
    // research entirely, search for who this person works for so the analysis
    // has employer evidence to work from.
    let discoveryMode = false;
    if (stage === 'research_company' && queries.length === 0 && name) {
      queries.push(...employerDiscoveryQueries(name));
      discoveryMode = true;
    }

    if (queries.length === 0) {
      const why =
        stage === 'research_prospect'
          ? 'No prospect name was resolved, so no person-level searches could be built.'
          : 'Neither a company nor a prospect name was resolved, so no company-level searches could be built.';
      return {
        status: 'skipped' as const,
        summary: why,
        output: { skipped: true, reason: why },
        value: undefined,
      };
    }

    const domains = ctx.identity?.company_domain ? [ctx.identity.company_domain] : [];
    const result = await research(stage, queries, domains, ctx.sources);
    ctx.sources = result.sources;
    ctx.rounds.push(result.round);

    // Total search failure only fails the run when we have no profile either.
    if (result.all_failed && !ctx.profile) {
      const detail = result.round.outcomes.map((o) => o.error).filter(Boolean)[0] ?? 'all search calls failed';
      return {
        status: 'failed' as const,
        summary: `Search provider unavailable: ${detail}`,
        output: { round: result.round },
        value: undefined,
      };
    }

    const enrichment = await enrichSources(ctx.sources, stage === 'research_company' ? 6 : 4);
    ctx.sources = enrichment.sources;
    await persistSources(ctx);

    const failedQueries = result.round.queries_run - result.round.queries_ok;
    const evidence = evidenceBreakdown(ctx.sources);

    return {
      // Page extraction failing is a quality reduction, not a stage failure:
      // the search results remain usable evidence at SNIPPET level.
      status: (result.degraded ? 'degraded' : 'complete') as StageStatus,
      summary:
        (discoveryMode ? 'Employer unknown — searched for it. ' : '') +
        `${result.round.queries_ok}/${result.round.queries_run} searches ok · ` +
        `${result.round.sources_after_dedupe} sources · ` +
        `${evidence.FULL} full, ${evidence.SNIPPET} snippet, ${evidence.UNAVAILABLE} unavailable` +
        (failedQueries > 0 ? ` · ${failedQueries} search(es) failed` : ''),
      output: {
        round: result.round,
        employer_discovery_mode: discoveryMode,
        evidence,
        pages_fetched: enrichment.scraped,
        pages_unavailable: enrichment.failed,
        extraction_note:
          enrichment.failed > 0
            ? 'Some source pages could not be retrieved. Their search results are still used as snippet-level evidence.'
            : null,
        queries: queries.map((q) => q.query),
      },
      value: undefined,
    };
  });
}

export const researchProspectStage = (ctx: PipelineContext) => researchStage(ctx, 'research_prospect');
export const researchCompanyStage = (ctx: PipelineContext) => researchStage(ctx, 'research_company');

// ─── 3. candidate resolution ─────────────────────────────────────────────────
//
// Which of the discovered people do we mean? One plausible candidate resolves
// automatically; several means a human chooses. The system never guesses which
// person was intended.

export async function resolveCandidateStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'resolve_candidate', async () => {
    const selection = selectCandidate(ctx.identityCandidates);
    ctx.candidateSelection = selection;

    if (selection.needs_user_choice) {
      // Record an AMBIGUOUS verification so the UI can offer the candidates.
      const pending = decideIdentity({
        selected: null,
        selectionMethod: null,
        profile: {
          name: ctx.identity?.full_name ?? null,
          role: ctx.identity?.role ?? null,
          company: ctx.identity?.company ?? null,
          location: ctx.identity?.location ?? null,
          linkedin_url: ctx.normalizedUrl,
        },
        hasProfile: Boolean(ctx.profile),
        candidates: ctx.identityCandidates,
        // Ambiguity between candidates, not a contradiction within one.
        conflicts: [],
        assessedConfidence: 0,
        missingFields: [],
      });

      const ambiguous = {
        ...pending,
        status: 'AMBIGUOUS' as const,
        proceed: false,
        reason: selection.reason,
      };
      ctx.identityVerification = ambiguous;

      await updateRun(ctx.runId, {
        identity_status: 'AMBIGUOUS',
        identity_resolution: 'AUTOMATIC',
        identity_verification: ambiguous,
      });

      return {
        status: 'degraded' as const,
        summary: `${selection.plausible.length} plausible candidates — waiting for a human to choose.`,
        output: {
          needs_user_choice: true,
          candidates: ctx.identityCandidates,
          plausible: selection.plausible.length,
          reason: selection.reason,
        },
        value: undefined,
      };
    }

    return {
      status: (selection.selected ? 'complete' : 'degraded') as StageStatus,
      summary: selection.selected
        ? `Selected automatically: ${selection.selected.name ?? 'unnamed'}${selection.selected.company ? ` at ${selection.selected.company}` : ''}`
        : 'No candidate identity could be selected.',
      output: {
        needs_user_choice: false,
        selection_method: selection.selection_method,
        selected: selection.selected,
        candidates: ctx.identityCandidates,
        reason: selection.reason,
      },
      value: undefined,
    };
  });
}

// ─── 4. verify the selected identity ─────────────────────────────────────────
//
// Runs on ONE candidate. A human's choice is a preference, not proof, so this
// runs identically however the candidate was selected.

export async function verifyIdentityStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'verify_identity', async () => {
    const selected = ctx.candidateSelection?.selected ?? null;
    const method = ctx.candidateSelection?.selection_method ?? 'AUTOMATIC';

    if (!selected) {
      const failed = decideIdentity({
        selected: null,
        selectionMethod: null,
        profile: {
          name: ctx.identity?.full_name ?? null,
          role: ctx.identity?.role ?? null,
          company: ctx.identity?.company ?? null,
          location: ctx.identity?.location ?? null,
          linkedin_url: ctx.normalizedUrl,
        },
        hasProfile: Boolean(ctx.profile),
        candidates: ctx.identityCandidates,
        conflicts: [],
        assessedConfidence: 0,
        missingFields: ['company', 'role'],
      });
      ctx.identityVerification = failed;
      await persistIdentity(ctx, failed);
      return {
        status: 'degraded' as const,
        summary: `${failed.status} — no candidate to verify.`,
        output: { identity: failed },
        value: undefined,
      };
    }

    // Targeted corroboration for THIS person, not general research.
    const queries = identityQueries({
      name: selected.name,
      slug: ctx.slug,
      company: selected.company,
      title: selected.role,
    });
    const corroboration = await research('identity_verification', queries, [], ctx.sources);
    if (!corroboration.all_failed) {
      ctx.sources = corroboration.sources;
      ctx.rounds.push(corroboration.round);
      await persistSources(ctx);
    }

    const evidence = await verifySelectedCandidate({
      slug: ctx.slug,
      candidate: selected,
      selectionMethod: method,
      sources: ctx.sources,
    });

    // Separate what the PROVIDER returned from what the discovery model
    // proposed, before anything is compared against public evidence. Without
    // this the candidate's fields were handed to decideIdentity under the name
    // `profile`, so a model-invented role was blocked on as though the profile
    // provider had asserted it — for a profile that carried no role at all.
    const reconciled = reconcileProvenance({
      profileFields: providerFields(ctx.profile),
      hints: {
        name: ctx.run.input_name,
        role: ctx.run.input_title,
        company: ctx.run.input_company,
      },
      candidate: candidateFields(selected),
      conflicts: evidence.conflicts,
      corroboratedFields: evidence.corroboratedFields,
    });

    let working = { ...selected, ...reconciled.fields };
    let conflicts = reconciled.conflicts;
    let corroboratedFields = reconciled.corroboratedFields;
    let supportingSources = evidence.supportingSources;
    const recoveries: Awaited<ReturnType<typeof recoverIdentityField>>[] = [];

    let verification = decideIdentity({
      selected: working,
      selectionMethod: method,
      provenance: reconciled.provenance,
      profile: {
        name: working.name,
        role: working.role,
        company: working.company,
        location: working.location,
        linkedin_url: working.linkedin_url ?? ctx.normalizedUrl,
      },
      hasProfile: Boolean(ctx.profile),
      candidates: ctx.identityCandidates,
      conflicts,
      assessedConfidence: evidence.assessedConfidence,
      missingFields: evidence.missingFields,
    });

    // The rest of the identity agrees and nothing contradicts it — a single
    // missing field is worth one targeted attempt before giving up. This can
    // only ADD evidence: the thresholds and rules below are untouched.
    // Company first, deliberately: a role search has to be anchored to an
    // employer, so recovering the company can unlock the role in the same pass.
    const RECOVERY_ORDER: RecoverableField[] = ['company', 'role'];
    const missingCritical = RECOVERY_ORDER.filter((f) => !working[f]);

    if (verification.status === 'PARTIAL' && conflicts.length === 0 && missingCritical.length > 0) {
      for (const field of RECOVERY_ORDER) {
        // Re-check against the working candidate: an earlier recovery may have
        // filled this field, or supplied the anchor this one needs.
        if (working[field]) continue;

        const queries = fieldRecoveryQueries(working, field);
        if (queries.length === 0) continue;

        const found = await research(`recover_${field}`, queries, [], ctx.sources);
        if (!found.all_failed) {
          ctx.sources = found.sources;
          ctx.rounds.push(found.round);
          await persistSources(ctx);
        }

        const recovery = await recoverIdentityField({ candidate: working, field, sources: ctx.sources });
        recoveries.push(recovery);

        if (recovery.conflict) {
          // A same-name different person. Never overwrite the candidate.
          conflicts = [...conflicts, recovery.conflict];
          break;
        }
        if (recovery.value) {
          working = { ...working, [field]: recovery.value };
          corroboratedFields = [...corroboratedFields, field];
          if (recovery.evidence_url) supportingSources = [...supportingSources, recovery.evidence_url];
        }
      }

      // Re-run the same decision over the enriched identity.
      verification = decideIdentity({
        selected: working,
        selectionMethod: method,
        // Recovery fills fields from retrieved sources, so re-derive rather
        // than reusing the pre-recovery provenance.
        provenance: reconcileProvenance({
          profileFields: providerFields(ctx.profile),
          hints: {
            name: ctx.run.input_name,
            role: ctx.run.input_title,
            company: ctx.run.input_company,
          },
          candidate: candidateFields(working),
          conflicts,
          corroboratedFields,
        }).provenance,
        profile: {
          name: working.name,
          role: working.role,
          company: working.company,
          location: working.location,
          linkedin_url: working.linkedin_url ?? ctx.normalizedUrl,
        },
        hasProfile: Boolean(ctx.profile),
        candidates: ctx.identityCandidates,
        conflicts,
        assessedConfidence: evidence.assessedConfidence,
        missingFields: (['company', 'role'] as const).filter((f) => !working[f]),
      });
    }

    // A field the candidate never had cannot have been corroborated.
    const fieldEvidence = accountFields(
      working,
      corroboratedFields,
      conflicts,
      // Sources that actually backed verification — not the candidate's own list.
      [...supportingSources, ...working.sources],
    );
    const withEvidence = {
      ...verification,
      field_evidence: fieldEvidence,
      provenance: verification.provenance ?? reconciled.provenance,
    };

    ctx.identityVerification = withEvidence;
    await persistIdentity(ctx, withEvidence);

    return {
      status: (verification.status === 'VERIFIED' ? 'complete' : 'degraded') as StageStatus,
      summary:
        `${verification.status} (${verification.confidence}/100) · ` +
        `${fieldEvidence.corroborated.length}/${fieldEvidence.available.length} available field(s) corroborated` +
        (fieldEvidence.unavailable.length > 0 ? ` · ${fieldEvidence.unavailable.length} unavailable` : '') +
        (recoveries.some((r) => r.value) ? ` · ${recoveries.filter((r) => r.value).length} recovered` : '') +
        (conflicts.length > 0 ? ` · ${conflicts.length} conflict(s)` : '') +
        ` · ${method === 'USER_CONFIRMED' ? 'user confirmed' : 'automatic'}`,
      output: {
        identity: withEvidence,
        selection_method: method,
        field_evidence: fieldEvidence,
        field_recovery: recoveries.length > 0
          ? recoveries.map((r) => ({
              field: r.field,
              recovered: Boolean(r.value),
              value: r.value,
              evidence_url: r.evidence_url,
              supporting_quote: r.supporting_quote,
              source_kind: r.source_kind,
              conflict_detected: Boolean(r.conflict),
              reason: r.reason,
            }))
          : null,
        corroborated_fields: corroboratedFields,
        supporting_sources: supportingSources,
        // Says plainly which values were demoted from "profile fact" to
        // "model proposal", so a reader can see why a conflict did not block.
        provenance: withEvidence.provenance,
        provenance_notes: reconciled.notes.length > 0 ? reconciled.notes : null,
        conflicts,
        summary: evidence.summary,
        llm: evidence.meta,
      },
      value: undefined,
    };
  });
}

async function persistIdentity(ctx: PipelineContext, v: NonNullable<PipelineContext['identityVerification']>) {
  await updateRun(ctx.runId, {
    identity_status: v.status,
    identity_resolution: v.resolution,
    identity_verification: v,
    identity_confidence: v.confidence,
    prospect_name: v.resolved.name,
    prospect_title: v.resolved.role,
    company_name: v.resolved.company,
  });
}

/** True when a human must choose between candidate identities. */
export function needsCandidateChoice(ctx: PipelineContext): boolean {
  return ctx.candidateSelection?.needs_user_choice === true;
}

/**
 * Pause a run awaiting candidate selection.
 *
 * Distinct from every other halt: nothing has failed and nothing has been
 * judged. The run is simply waiting for a human to say which person is meant.
 */
export async function pauseForCandidateChoice(ctx: PipelineContext): Promise<void> {
  const stageId = await startStage(ctx.runId, 'ready_for_review');
  const startedAt = Date.now();

  await deleteDrafts(ctx.runId);
  await updateRun(ctx.runId, {
    status: 'needs_manual_review',
    overall_confidence: 0,
    selected_hook: null,
    generated_message: null,
    insufficient_evidence: true,
    completed_at: new Date().toISOString(),
    error: null,
  });

  const { listStages, finishStage: finish } = await import('@/lib/supabase/queries');
  const stages = await listStages(ctx.runId);
  const skippable: StageName[] = [
    'verify_identity',
    'research_prospect',
    'research_company',
    'qualify_prospect',
    'qualify_company',
    'find_contact_candidates',
    'collect_signals',
    'evaluate_signals',
    'select_hook',
    'generate_message',
    'validate_claims',
  ];
  for (const row of stages) {
    if (skippable.includes(row.stage_name) && row.status === 'pending') {
      await finish(row.id, {
        status: 'skipped',
        summary: 'Waiting — a human needs to confirm which candidate identity is intended.',
        output: { skipped: true, reason: 'AWAITING_CANDIDATE_SELECTION' },
      });
    }
  }

  await finishStage(stageId, {
    status: 'complete',
    summary: `Waiting for identity confirmation — ${ctx.candidateSelection?.plausible.length ?? 0} plausible candidates.`,
    duration_ms: Date.now() - startedAt,
    output: {
      needs_manual_review: true,
      stopped_at: 'candidate_selection',
      awaiting_user_choice: true,
      candidates: ctx.identityCandidates,
      qualification_started: false,
      nothing_sent: true,
    },
  });
}

/** True when identity is settled well enough to target anyone. */
export function isIdentityVerified(ctx: PipelineContext): boolean {
  return ctx.identityVerification?.proceed === true;
}

/**
 * Stop a run whose identity is not settled.
 *
 * Deliberately distinct from a qualification halt: nothing was judged about the
 * person's suitability, because we are not sure who they are.
 */
export async function haltUnverifiedIdentity(ctx: PipelineContext): Promise<void> {
  const v = ctx.identityVerification;
  const stageId = await startStage(ctx.runId, 'ready_for_review');
  const startedAt = Date.now();

  await deleteDrafts(ctx.runId);
  await updateRun(ctx.runId, {
    status: 'needs_manual_review',
    overall_confidence: v?.confidence ?? 0,
    selected_hook: null,
    generated_message: null,
    insufficient_evidence: true,
    completed_at: new Date().toISOString(),
    error: null,
  });

  const { listStages, finishStage: finish } = await import('@/lib/supabase/queries');
  const stages = await listStages(ctx.runId);
  const skippable: StageName[] = [
    'research_prospect',
    'research_company',
    'qualify_prospect',
    'qualify_company',
    'find_contact_candidates',
    'collect_signals',
    'evaluate_signals',
    'select_hook',
    'generate_message',
    'validate_claims',
  ];
  for (const row of stages) {
    if (skippable.includes(row.stage_name) && row.status === 'pending') {
      await finish(row.id, {
        status: 'skipped',
        summary: 'Skipped — the prospect’s identity is not sufficiently verified.',
        output: { skipped: true, reason: 'IDENTITY_NOT_VERIFIED' },
      });
    }
  }

  await finishStage(stageId, {
    status: 'complete',
    summary: `Held for manual review — identity ${v?.status.toLowerCase() ?? 'unresolved'}. ${v?.reason ?? ''}`.trim(),
    duration_ms: Date.now() - startedAt,
    output: {
      needs_manual_review: true,
      stopped_at: 'identity_verification',
      identity: v,
      // This is not a targeting judgment: no one was assessed for fit.
      qualification_started: false,
      reasons: [v?.reason ?? 'Identity could not be verified.'],
      nothing_sent: true,
    },
  });
}

// ─── 5 & 6. qualify the target ───────────────────────────────────────────────
//
// One model call answers both fits. The decision is then made in code, and an
// unqualified target stops here — before the expensive analysis-and-drafting
// pass ever runs.

export async function qualifyProspectStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'qualify_prospect', async () => {
    const sender = senderFor(ctx);

    const { prospect_fit, company_fit, meta } = await qualifyTarget({
      profile: ctx.profile,
      profileAccessNote: ctx.linkedinAccess?.access.reason ?? 'Profile retrieved directly.',
      sources: ctx.sources,
      prospectName: ctx.identity?.full_name ?? ctx.run.input_name,
      role: ctx.identity?.role ?? ctx.run.input_title,
      company: ctx.identity?.company ?? ctx.run.input_company,
      sender,
    });

    const decision = combineQualification(prospect_fit, company_fit);
    ctx.qualification = { prospect_fit, company_fit, ...decision };

    await updateRun(ctx.runId, {
      qualification: ctx.qualification,
      qualification_status: decision.classification,
      overall_fit: decision.overall_fit,
    });

    const weak = prospect_fit.classification === 'LOW' || prospect_fit.score < PROSPECT_FIT_FLOOR;

    return {
      status: (weak || prospect_fit.classification === 'UNKNOWN' ? 'degraded' : 'complete') as StageStatus,
      summary:
        `${prospect_fit.classification} prospect fit (${prospect_fit.score}/100)` +
        `${prospect_fit.seniority ? ` · ${prospect_fit.seniority}` : ''}` +
        ` · decision authority ${prospect_fit.decision_authority}`,
      output: {
        prospect_fit,
        floor: PROSPECT_FIT_FLOOR,
        passes_floor: !weak,
        llm: meta,
        note: 'Prospect and company fit are assessed together in one model call; the company half is reported in the next stage.',
      },
      value: undefined,
    };
  });
}

export async function qualifyCompanyStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'qualify_company', async () => {
    const q = ctx.qualification;
    if (!q) throw new Error('Qualification did not run.');

    const { company_fit } = q;
    const weak = company_fit.classification === 'LOW' || company_fit.score < COMPANY_FIT_FLOOR;
    const matched = company_fit.capability_matches.filter((m) => m.fit_strength >= 50);

    return {
      status: (q.proceed ? 'complete' : 'degraded') as StageStatus,
      summary:
        `${company_fit.classification} company fit (${company_fit.score}/100)` +
        `${company_fit.industry ? ` · ${company_fit.industry}` : ''}` +
        ` · ${matched.length}/${company_fit.capability_matches.length} capabilities plausibly relevant` +
        ` · ${q.classification.replace(/_/g, ' ')}`,
      output: {
        company_fit,
        floor: COMPANY_FIT_FLOOR,
        passes_floor: !weak,
        target_qualification: {
          overall_fit: q.overall_fit,
          classification: q.classification,
          action: q.action,
          reason: q.reason,
          proceed: q.proceed,
          suggestion: q.suggestion,
        },
      },
      value: undefined,
    };
  });
}

// ─── contact candidate discovery ─────────────────────────────────────────────
//
// Runs only in the two matrix cells where the COMPANY is confirmed QUALIFIED
// but the submitted person is not (VERIFY_BETTER_CONTACT, FIND_BETTER_
// CONTACT) — see CONTACT_DISCOVERY_ACTIONS below. A BORDERLINE company never
// triggers this stage, however BORDERLINE the prospect also is: an
// unconfirmed account doesn't get a paid search for a DIFFERENT contact,
// it gets exploratory outreach (if the prospect is decent) or held for a
// human (if not) — see combineQualification's matrix.
//
// Every other run — fully qualified, company not qualified, or company only
// borderline — passes through as a zero-cost no-op. No query, no model call,
// nothing persisted.

/**
 * The only two decision-matrix actions that mean "the company is confirmed,
 * go find a different contact there." Everything else — including every
 * BORDERLINE-company action, even though those can also carry `proceed:
 * false` (FIND_BETTER_CONTACT_OR_HOLD) — must never trigger a paid discovery
 * search, because the account itself isn't confirmed yet.
 *
 * Checked directly against `action` rather than inferred from `!proceed &&
 * suggestion`: that combination happens to be true only for these two
 * actions today, but a boolean heuristic is one future action away from
 * silently matching something it shouldn't. An explicit whitelist keyed to
 * the exhaustive QualificationAction enum can't drift out of sync with the
 * decision matrix the way an inferred condition can.
 */
const CONTACT_DISCOVERY_ACTIONS = new Set<TargetQualification['action']>([
  'VERIFY_BETTER_CONTACT',
  'FIND_BETTER_CONTACT',
]);

/**
 * Exported so the gate itself — not just the underlying matrix — has a
 * direct, fast, no-mocking-required regression test surface. This is the
 * exact predicate `findContactCandidatesStage` runs; a test importing and
 * calling this function is testing production wiring, not a parallel
 * reimplementation of it.
 */
export function contactDiscoveryApplicable(q: TargetQualification | null): boolean {
  if (!q) return false;
  // The whitelist above is unchanged. The only addition is the cell a person
  // explicitly opened by continuing a borderline account to look for a better
  // contact — which is false for every run without that recorded decision,
  // including every run that predates this feature.
  return CONTACT_DISCOVERY_ACTIONS.has(q.action) || contactDiscoveryUnlockedByDecision(q);
}

/** Why this stage is a no-op, keyed directly off `action` — no proceed/classification inference. */
const SKIP_REASON: Record<TargetQualification['action'], string> = {
  TARGET_DIRECTLY: 'PROSPECT_QUALIFIED',
  VERIFY_BETTER_CONTACT: 'NO_SUGGESTION', // unreachable — this action IS applicable
  FIND_BETTER_CONTACT: 'NO_SUGGESTION', // unreachable — this action IS applicable
  EXPLORATORY_OUTREACH: 'COMPANY_BORDERLINE_EXPLORATORY',
  // Reachable only when a person has NOT continued this account; once they
  // have, the cell is applicable and this stage runs for real.
  EXPLORATORY_OUTREACH_IF_SIGNAL: 'COMPANY_BORDERLINE_EXPLORATORY',
  FIND_BETTER_CONTACT_OR_HOLD: 'COMPANY_BORDERLINE',
  DO_NOT_CONTACT: 'NOT_QUALIFIED',
};

export async function findContactCandidatesStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'find_contact_candidates', async () => {
    const q = ctx.qualification;
    const applicable = contactDiscoveryApplicable(q);

    if (!applicable) {
      const reason = q ? SKIP_REASON[q.action] : 'NO_QUALIFICATION';
      return {
        status: 'skipped' as const,
        summary: q?.proceed
          ? 'Not applicable — the submitted prospect already qualified or is proceeding as exploratory outreach.'
          : q
            ? `Not applicable — ${q.reason}`
            : 'Not applicable — qualification did not run.',
        output: { skipped: true, reason },
        value: undefined,
      };
    }

    const company = ctx.identity?.company ?? ctx.run.input_company;
    if (!company) {
      return {
        status: 'skipped' as const,
        summary: 'No company name was resolved, so no contact search could be built.',
        output: { skipped: true, reason: 'NO_COMPANY' },
        value: undefined,
      };
    }

    const capabilities = capabilityContext(ctx);
    // Both the observed company_signal text AND the capability's own name are
    // handed to rolesForWorkflows() — company_signal is free-form model prose
    // that may describe the workflow without ever using the word a role
    // family keys on (e.g. a chargebacks match whose company_signal talks
    // about "consumer transaction volume" and never says "chargeback" or
    // "dispute"), while capability_name is the fixed, configured label for
    // exactly that workflow. Index 0 stays company_signal so the ranked
    // candidate's stored `reason` text (workflowSignals[0], read below) is
    // unchanged — this only widens what role derivation is allowed to match.
    let workflowSignals = capabilities.observed.flatMap((c) => [c.workflow, c.name]);

    // HUMAN-AUTHORIZED EXPLORATORY DISCOVERY.
    //
    // A person continuing a BORDERLINE account with no OBSERVED workflow is
    // explicitly saying "I accept this account is borderline and I want a
    // better contact searched for anyway" — see
    // lib/qualification/account-decision.ts. That authorization licenses
    // WHERE this stage looks; it changes nothing about what counts as
    // evidence. So this only ever widens the SEARCH INPUT — the free-form
    // signal text and capability names handed to the exact same
    // rolesForWorkflows()/adjacentRolesForWorkflows()/etc used by the
    // OBSERVED path below. It does not read, write or reclassify
    // company_fit.capability_matches, and every candidate found still goes
    // through the identical evidence, ranking and pre-verification gates.
    //
    // Falls back to INFERRED capabilities ONLY when there is no OBSERVED
    // workflow AND a human has explicitly unlocked this path — never for the
    // ordinary automatic cells (VERIFY_BETTER_CONTACT / FIND_BETTER_CONTACT),
    // whose behavior is unchanged: a QUALIFIED company already requires an
    // OBSERVED capability, so those cells never reach this branch.
    const exploratoryInferredContext =
      workflowSignals.length === 0 && contactDiscoveryUnlockedByDecision(q);
    if (exploratoryInferredContext) {
      workflowSignals = capabilities.inferred.flatMap((c) => {
        const raw = ctx.qualification?.company_fit.capability_matches.find((m) => m.capability_id === c.id);
        return raw?.company_signal ? [raw.company_signal, c.name] : [c.name];
      });
    }

    if (workflowSignals.length === 0) {
      ctx.contactCandidates = [];
      return {
        status: 'complete' as const,
        summary: 'No observed workflow to derive functional-owner roles from — no candidates searched for.',
        // Still the applicable state (company qualified, contact did not) —
        // only the role derivation came up empty. The UI shows this case too,
        // just with an honest empty result rather than hiding the section.
        output: { applicable: true, candidates: [], roles: [], reason: 'NO_OBSERVED_WORKFLOW' },
        value: undefined,
      };
    }

    const domains = ctx.identity?.company_domain ? [ctx.identity.company_domain] : [];

    // The person this run is already about. Discovery must never suggest
    // them back to themselves as an "alternative contact" at their own
    // company — see lib/contacts/rank.ts's isCurrentProspect().
    const currentProspectIdentity = {
      linkedin_url: ctx.normalizedUrl,
      name: ctx.identity?.full_name ?? ctx.run.input_name,
      company,
    };

    // Discovery runs in deterministic LEVELS, widening only when the previous
    // level produced nothing a human could actually act on.
    //
    //   1  the workflow's primary functional owners (Tier 1)
    //   2  owners of an ADJACENT function for the same workflow
    //   3  deeper into the same families, past the primary search's cap
    //   4  Director / Senior Manager owners of the same functions (Tier 2)
    //   5  Manager / Lead operators of the same functions (Tier 3)
    //
    // The rule is: STRICT about verification, more flexible about discovery.
    // Every level's candidates go through the identical ranking, evidence and
    // pre-verification gates below — widening changes only WHERE we look, and
    // never what a candidate must prove. A level is skipped entirely once an
    // eligible candidate exists, so the common case costs exactly what it did
    // before.
    const levelsAttempted: { level: number; roles: string[]; eligible: number }[] = [];
    const searchedRoles: string[] = [];
    let allProposed: Awaited<ReturnType<typeof discoverContacts>>['proposed'] = [];
    let queriesRun = 0;
    let queriesOk = 0;
    let preVerified: { candidate: (typeof rankedForLevel)[number]; result: ReturnType<typeof preVerifyCandidate> }[] = [];
    let rankedForLevel: ReturnType<typeof rankCandidates> = [];

    for (const level of [1, 2, 3, 4, 5] as const) {
      const levelRoles =
        level === 1
          ? rolesForWorkflows(workflowSignals)
          : level === 2
            ? adjacentRolesForWorkflows(workflowSignals, searchedRoles)
            : level === 3
              ? deeperRolesForWorkflows(workflowSignals, searchedRoles)
              : level === 4
                ? tier2RolesForWorkflows(workflowSignals, searchedRoles)
                : tier3RolesForWorkflows(workflowSignals, searchedRoles);

      if (levelRoles.length === 0) continue;

      const result = await discoverContacts({
        company,
        workflowSignals,
        existingSources: ctx.sources,
        companyDomains: domains,
        roles: levelRoles,
      });

      ctx.sources = result.sources;
      await persistSources(ctx);

      searchedRoles.push(...levelRoles);
      queriesRun += result.queriesRun;
      queriesOk += result.queriesOk;
      // Dropped here, before ranking, pre-verification or persistence ever
      // see it — the current prospect is never a valid "alternative contact"
      // suggestion at their own company.
      const proposedExcludingCurrentProspect = result.proposed.filter(
        (c) => !isCurrentProspect({ name: c.name, linkedin_url: c.linkedin_url, company }, currentProspectIdentity),
      );
      allProposed = [...allProposed, ...proposedExcludingCurrentProspect];

      // Ranked and pre-verified against every role searched so far, so a
      // candidate found at one level is still judged against the full set of
      // legitimate owner titles rather than only that level's slice.
      rankedForLevel = rankCandidates(allProposed, ctx.sources, searchedRoles, workflowSignals[0]);
      preVerified = rankedForLevel.map((c) => ({
        candidate: c,
        result: preVerifyCandidate(
          { name: c.name, role: c.role, company, linkedin_url: c.linkedin_url, evidence: [c.evidence] },
          { targetRoles: searchedRoles },
        ),
      }));

      const eligibleCount = preVerified.filter((p) => p.result.eligibility === 'ELIGIBLE').length;
      levelsAttempted.push({ level, roles: levelRoles, eligible: eligibleCount });

      // Something a human can actually act on — stop, rather than spending
      // further provider calls to lengthen a list that is already useful.
      if (eligibleCount > 0) break;
    }

    const result = { roles: searchedRoles, queriesRun, queriesOk, proposed: allProposed };

    // EXCLUDED means there is nothing to verify against at all (no name, no
    // usable profile URL, no evidence) — those are dropped from suggestions
    // entirely. NEEDS_VERIFICATION is a real conflict in otherwise-usable
    // data: still shown, so a human can see it and judge, but persisted as
    // PARTIAL so Select is disabled.
    const excluded = preVerified.filter((p) => p.result.eligibility === 'EXCLUDED');
    const offered = preVerified.filter((p) => p.result.eligibility !== 'EXCLUDED');

    const ranked = offered.map((p) => p.candidate);
    ctx.contactCandidates = ranked;

    // Persistence is wrapped on its own, separately from discovery above: the
    // candidates were genuinely found by this point (real search, real
    // verification against real quotes), and a write failure here — most
    // plausibly the table not existing yet in a not-fully-migrated database —
    // must not be reported as though nothing was discovered, and must not
    // fail the whole run over what a human still needs to see. It is surfaced
    // explicitly instead: DEGRADED, not complete, with the reason spelled out
    // in both the summary and the output, never swallowed silently.
    let persistenceError: string | null = null;
    if (ranked.length > 0) {
      try {
        await createContactCandidates(
          ctx.runId,
          offered.map(({ candidate: c, result }) => ({
            name: c.name,
            role: c.role,
            company,
            linkedin_url: c.linkedin_url,
            reason: c.reason,
            evidence: [c.evidence],
            confidence: c.confidence,
            rank_score: c.rankScore,
            // ELIGIBLE stays DISCOVERED — the pending-selection state Select
            // acts on. A pre-verification conflict lands as PARTIAL, which
            // canSelectCandidate() already treats as non-selectable, so the
            // row is non-selectable from the moment it exists.
            identity_status: result.eligibility === 'ELIGIBLE' ? ('DISCOVERED' as const) : ('PARTIAL' as const),
          })),
        );
      } catch (err) {
        persistenceError = describeError(err);
      }
    }

    const found = ranked.length > 0;
    // Named explicitly wherever this path ran — never silently identical to
    // the ordinary OBSERVED-workflow result. This is what makes requirement
    // #5 (mark the path as human-authorized exploratory discovery) durable:
    // it is on the persisted stage output, not just in a comment.
    const exploratoryPrefix = exploratoryInferredContext
      ? 'Human-authorized exploratory discovery (inferred workflow context, no observed capability) — '
      : '';
    return {
      status: (persistenceError ? 'degraded' : 'complete') as StageStatus,
      summary:
        exploratoryPrefix +
        (persistenceError
          ? `${ranked.length} candidate(s) found for ${result.roles.join(', ')} at ${company}, but they could not be saved: ${persistenceError}`
          : found
            ? `${ranked.length} candidate(s) found for ${result.roles.join(', ')} at ${company}.`
            : `No verified candidates found at ${company} after ${levelsAttempted.length} discovery level(s) covering ${result.roles.join(', ')} — searched ${result.queriesOk}/${result.queriesRun} queries.`),
      output: {
        applicable: true,
        // True only when the OBSERVED path found nothing and a human
        // explicitly continued the account — see contactDiscoveryUnlockedByDecision().
        // Never implies the inferred capability became evidence: qualification's
        // own capability_matches (basis/evidence) are untouched by this stage.
        exploratory_inferred_context: exploratoryInferredContext,
        company,
        roles: result.roles,
        // Shown even when persistence failed — they were genuinely found;
        // Select is unavailable until they exist as rows, which the
        // persistence_error field makes explicit rather than silent.
        candidates: ranked,
        queries_ok: result.queriesOk,
        // Which levels actually ran, and what each looked for — so a
        // no-candidate result can state how hard the system tried rather than
        // just asserting that nobody was found.
        discovery_levels: levelsAttempted,
        queries_run: result.queriesRun,
        proposed_count: result.proposed.length,
        suggestion: q?.suggestion,
        persistence_error: persistenceError,
        // Exactly why each candidate is or is not offered as selectable —
        // recorded so a blocked suggestion is inspectable after the fact
        // rather than silently missing from the list.
        pre_verification: {
          eligible: preVerified.filter((p) => p.result.eligibility === 'ELIGIBLE').length,
          needs_verification: preVerified.filter((p) => p.result.eligibility === 'NEEDS_VERIFICATION').length,
          excluded: excluded.length,
          blocked: preVerified
            .filter((p) => p.result.eligibility !== 'ELIGIBLE')
            .map((p) => ({
              name: p.candidate.name,
              eligibility: p.result.eligibility,
              reason: p.result.blockedReason,
              checks: p.result.checks,
            })),
        },
      },
      value: undefined,
    };
  });
}

/**
 * The capabilities this company was actually shown to have, versus the ones
 * merely inferred. Only the observed set may justify an outreach angle.
 */
/**
 * Who signs this run's message: what the requester typed, else the deployment
 * default, else nothing (the signature block is then omitted entirely).
 */
export function senderFor(ctx: PipelineContext) {
  const config = getSenderConfig();
  return { ...config, name: ctx.run.sender_name?.trim() || config.name };
}

export function capabilityContext(ctx: PipelineContext) {
  const matches = ctx.qualification?.company_fit.capability_matches ?? [];
  const observed = matches
    .filter((m) => m.basis === 'OBSERVED' && m.evidence.length > 0)
    .map((m) => ({ id: m.capability_id, name: m.capability_name, workflow: m.company_signal }));
  const inferred = matches
    .filter((m) => m.basis !== 'OBSERVED')
    .map((m) => ({ id: m.capability_id, name: m.capability_name }));

  return { observed, inferred, observedIds: new Set(observed.map((c) => c.id)) };
}

/**
 * The approved Zamp solution for this run, matched deterministically in code
 * from the same OBSERVED, evidenced capabilities `capabilityContext()` treats
 * as established — see lib/solutions/match.ts. Null when no verified
 * capability maps onto the catalog; the model is never asked to guess one.
 */
export function solutionContext(ctx: PipelineContext) {
  return matchApprovedSolution(ctx.qualification);
}

/**
 * The approved customer proof for this run's matched solution, if any.
 *
 * Phase 1: computed and RECORDED ONLY. It is not passed to the model, not
 * added to the prompt, and not used to write or validate anything — the
 * generated email is byte-for-byte what it was before this existed. Surfacing
 * it in the stage output first means the matching can be reviewed against
 * real runs before any of it reaches a message.
 */
export function proofContext(ctx: PipelineContext) {
  return matchApprovedProof(matchApprovedSolution(ctx.qualification));
}

// ─── human account decision ──────────────────────────────────────────────────
//
// A BORDERLINE company is not an evidence problem — more research does not
// resolve it. It is a commercial judgment, so the run pauses and asks. See
// lib/qualification/account-decision.ts for the state model and for why
// continuing cannot relax anything downstream.

/** True when this run is waiting on a person before anything else may run. */
export function awaitingAccountDecision(ctx: PipelineContext): boolean {
  return accountDecisionPending(ctx.qualification);
}

/**
 * Pause a run for a human account decision.
 *
 * Deliberately unlike every halt around it: nothing failed and nothing was
 * judged unfit. The remaining stages are left PENDING rather than skipped,
 * because this run genuinely resumes into them — marking them skipped would
 * claim the pipeline had finished with them when a person is about to send it
 * back through. No draft is written and no model call is made while waiting.
 */
export async function pauseForAccountDecision(ctx: PipelineContext): Promise<void> {
  const q = ctx.qualification;
  const path = continuationPath(q);

  await deleteDrafts(ctx.runId);
  await updateRun(ctx.runId, {
    status: 'needs_manual_review',
    overall_confidence: q?.overall_fit ?? 0,
    selected_hook: null,
    generated_message: null,
    insufficient_evidence: true,
    completed_at: new Date().toISOString(),
    error: null,
  });

  const stageId = await startStage(ctx.runId, 'ready_for_review');
  await finishStage(stageId, {
    status: 'complete',
    summary:
      path === 'FIND_CONTACT'
        ? 'Waiting — a person needs to decide whether to look for a better contact at this borderline account.'
        : 'Waiting — a person needs to decide whether this borderline account is worth pursuing.',
    duration_ms: 0,
    output: {
      needs_manual_review: true,
      stopped_at: 'account_decision',
      awaiting_account_decision: true,
      continuation_path: path,
      // Stated explicitly so the record cannot be read as a qualification change.
      account_status: 'BORDERLINE',
      qualification_unchanged: true,
      nothing_sent: true,
    },
  });
}

/**
 * Record a held account. Terminal — the person decided not to pursue it.
 *
 * The account keeps its BORDERLINE qualification: a person declining to spend
 * effort on an account is not a finding about the evidence.
 */
export async function haltAccountHeld(ctx: PipelineContext): Promise<void> {
  const q = ctx.qualification;
  const stageId = await startStage(ctx.runId, 'ready_for_review');
  const startedAt = Date.now();

  await deleteDrafts(ctx.runId);
  await updateRun(ctx.runId, {
    status: 'needs_manual_review',
    overall_confidence: q?.overall_fit ?? 0,
    selected_hook: null,
    generated_message: null,
    insufficient_evidence: true,
    completed_at: new Date().toISOString(),
    error: null,
  });

  const { listStages, finishStage: finish } = await import('@/lib/supabase/queries');
  const stages = await listStages(ctx.runId);
  const skippable: StageName[] = [
    'find_contact_candidates',
    'collect_signals',
    'evaluate_signals',
    'select_hook',
    'generate_message',
    'validate_claims',
  ];
  for (const row of stages) {
    if (skippable.includes(row.stage_name) && row.status === 'pending') {
      await finish(row.id, {
        status: 'skipped',
        summary: 'Skipped — a person held this account, so no outreach was generated.',
        output: { skipped: true, reason: 'ACCOUNT_HELD' },
      });
    }
  }

  await finishStage(stageId, {
    status: 'complete',
    summary: 'Account held by a person — no outreach generated.',
    duration_ms: Date.now() - startedAt,
    output: {
      needs_manual_review: true,
      stopped_at: 'account_decision',
      account_held: true,
      account_status: 'BORDERLINE',
      qualification_unchanged: true,
      nothing_sent: true,
      decision: accountDecisionRecord(q),
    },
  });
}

/** True when qualification says we may proceed to hooks and outreach. */
export function isQualified(ctx: PipelineContext): boolean {
  return ctx.qualification?.proceed === true;
}

/**
 * Stop a run that did not qualify.
 *
 * The remaining stages are marked skipped rather than failed — nothing went
 * wrong, the system decided this is not someone to pitch. No draft is written
 * and no further model calls are made.
 */
export async function haltUnqualified(ctx: PipelineContext): Promise<void> {
  const q = ctx.qualification;
  const stageId = await startStage(ctx.runId, 'ready_for_review');
  const startedAt = Date.now();

  await deleteDrafts(ctx.runId);
  await updateRun(ctx.runId, {
    status: 'needs_manual_review',
    overall_confidence: q?.overall_fit ?? 0,
    selected_hook: null,
    generated_message: null,
    insufficient_evidence: true,
    completed_at: new Date().toISOString(),
    error: null,
  });

  // Everything between qualification and the final stage is moot.
  const { listStages, finishStage: finish } = await import('@/lib/supabase/queries');
  const stages = await listStages(ctx.runId);
  const skippable: StageName[] = [
    'collect_signals',
    'evaluate_signals',
    'select_hook',
    'generate_message',
    'validate_claims',
  ];
  for (const row of stages) {
    if (skippable.includes(row.stage_name) && row.status === 'pending') {
      await finish(row.id, {
        status: 'skipped',
        summary: 'Skipped — the target did not qualify, so no outreach was generated.',
        output: { skipped: true, reason: 'NOT_QUALIFIED' },
      });
    }
  }

  await finishStage(stageId, {
    status: 'complete',
    summary: `Held for manual review — ${q?.classification.replace(/_/g, ' ').toLowerCase() ?? 'not qualified'}. ${q?.reason ?? ''}`.trim(),
    duration_ms: Date.now() - startedAt,
    output: {
      needs_manual_review: true,
      stopped_at: 'qualification',
      qualification: q,
      reasons: [q?.reason ?? 'Target did not qualify.'],
      suggestion: q?.suggestion ?? null,
      // Populated only in the account-qualified/contact-not-qualified state;
      // null contactCandidates means the state does not apply to this run.
      contact_candidates: ctx.contactCandidates ?? null,
      model_calls_used: 1,
      nothing_sent: true,
    },
  });
}

// ─── 5. collect signals (assemble the evidence set; no model call) ───────────

export async function collectSignalsStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'collect_signals', async () => {
    // Everything is already deduped and normalized by the research engine; this
    // stage finalizes the evidence set and reports what the analysis will read.
    const evidence = evidenceBreakdown(ctx.sources);
    const withText = ctx.sources.filter((s) => (s.content ?? s.snippet).trim().length > 40);
    const dated = ctx.sources.filter((s) => s.published_date);
    const credible = ctx.sources.filter((s) => s.credibility >= 0.7);

    await persistSources(ctx);

    // Only a total absence of evidence is fatal. Snippet-only evidence is thin,
    // but it is real and the analysis can work from it.
    if (evidence.FULL === 0 && evidence.SNIPPET === 0 && !ctx.profile) {
      return {
        status: 'failed' as const,
        summary: 'No profile data and no usable evidence were collected; there is nothing to analyse.',
        output: { evidence, sources: ctx.sources.length },
        value: undefined,
      };
    }

    return {
      status: (withText.length === 0 ? 'degraded' : 'complete') as StageStatus,
      summary:
        `${ctx.sources.length} sources ready · ` +
        `${evidence.FULL} full evidence, ${evidence.SNIPPET} snippet, ${evidence.UNAVAILABLE} unavailable · ` +
        `${dated.length} dated · ${credible.length} high-credibility` +
        (ctx.profile ? ' · includes LinkedIn profile data' : ''),
      output: {
        evidence,
        source_count: ctx.sources.length,
        with_text: withText.length,
        dated: dated.length,
        credible: credible.length,
        has_profile: Boolean(ctx.profile),
        sources: ctx.sources.map((s) => ({
          url: s.url,
          type: s.source_type,
          credibility: s.credibility,
          published_date: s.published_date,
          fetch_status: s.fetch_status,
        })),
      },
      value: undefined,
    };
  });
}

// ─── 6. evaluate signals — THE single model call ─────────────────────────────

export async function evaluateSignalsStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'evaluate_signals', async () => {
    const sender = senderFor(ctx);
    const companyBeforeAnalysis = ctx.identity?.company ?? null;
    let lateCompanyResearch: { company: string; new_sources: number; queries: number } | null = null;

    let analysis;
    try {
      analysis = await analyzeProspect({
        profile: ctx.profile,
        profileAccessNote: ctx.linkedinAccess?.access.reason ?? 'Profile retrieved directly.',
        sources: ctx.sources,
        slug: ctx.slug,
        nameHint: ctx.nameHint,
        userHints: {
          name: ctx.run.input_name,
          company: ctx.run.input_company,
          title: ctx.run.input_title,
        },
        outreachContext: outreachContext(sender),
        senderName: sender.name,
        senderCompany: sender.company,
        capabilityContext: capabilityContext(ctx),
        approvedSolution: solutionContext(ctx) ? solutionForPrompt(solutionContext(ctx)!) : undefined,
        // Selected deterministically in lib/proof/match.ts. The model receives
        // this ONE statement and no catalog, so it has nothing to choose from.
        approvedProof: proofContext(ctx) ? proofForPrompt(proofContext(ctx)!) : undefined,
      });
    } catch (err) {
      if (err instanceof LLMError) {
        // The research is real and already persisted. Park the run for retry
        // instead of throwing it away over a provider quota problem.
        await parkForRetry(ctx, err);
        throw new StageAbort('evaluate_signals', err.userMessage);
      }
      throw err;
    }

    ctx.analysis = analysis.data;
    ctx.analysisMeta = analysis.meta;

    // A candidate may cite a page the research pass never fetched. Go and get it
    // rather than discarding real signal — but the citation buys nothing on its
    // own: the recovered page still has to survive the same verification below.
    const proposedHooks = analysis.data.personalizationHooks ?? [];
    const recovery = await recoverCitedSources(
      proposedHooks.map((h) => h.source_url),
      ctx.sources,
      ctx.identity?.company_domain ? [ctx.identity.company_domain] : [],
    );

    if (recovery.recovered.length > 0) {
      ctx.sources = [...ctx.sources, ...recovery.recovered];
      // Persist so a later retry reuses the recovered evidence.
      await persistSources(ctx);
    }

    // Deterministic gate: drop any hook whose quote isn't really in its source.
    // Runs against the final source set, including late company research and
    // anything recovered above.
    const { kept, rejected } = verifyHooks(proposedHooks, ctx.sources);
    ctx.rejectedSignals = rejected;

    // Deterministic scoring and ordering.
    ctx.ranked = scoreSignals(kept, ctx.sources);

    // Identity: once verification has settled who this is, the analysis does not
    // get to revise it. Downstream intelligence runs ON an identity; it is not
    // another vote about who the person is.
    const identitySettled = ctx.identityVerification?.status === 'VERIFIED';

    if (identitySettled && ctx.identity) {
      const resolved = ctx.identityVerification!.resolved;
      ctx.identity = {
        ...ctx.identity,
        full_name: resolved.name ?? ctx.identity.full_name,
        role: resolved.role ?? ctx.identity.role,
        company: resolved.company ?? ctx.identity.company,
        location: resolved.location ?? ctx.identity.location,
        confidence: ctx.identityVerification!.confidence,
      };
    } else if (ctx.identity && analysis.data.prospect) {
      ctx.identity = mergeAnalysisIdentity(ctx.identity, {
        name: analysis.data.prospect.name ?? null,
        currentCompany: analysis.data.prospect.currentCompany ?? null,
        currentRole: analysis.data.prospect.currentRole ?? null,
        location: analysis.data.prospect.location ?? null,
        identityConfidence: analysis.data.prospect.identityConfidence ?? 0,
        identityNotes: analysis.data.prospect.identityNotes ?? null,
        ambiguous: Boolean(analysis.data.prospect.ambiguous),
      });

      await updateRun(ctx.runId, {
        prospect_name: ctx.identity.full_name,
        prospect_title: ctx.identity.role,
        company_name: ctx.identity.company,
        identity_confidence: ctx.identity.confidence,
      });
    }

    // Late employer discovery: the profile gave no company, but the analysis
    // found one in the public evidence. Research that company now and re-analyse
    // once, so a partial profile does not cost us company-level signals.
    if (!companyBeforeAnalysis && ctx.identity?.company && !ctx.companyResearchDone) {
      ctx.companyResearchDone = true;
      const domains = ctx.identity.company_domain ? [ctx.identity.company_domain] : [];
      const followUp = await research(
        'late_company_research',
        signalQueries(ctx.identity.full_name, ctx.identity.company).filter((q) =>
          q.category.startsWith('company'),
        ),
        domains,
        ctx.sources,
      );

      if (!followUp.all_failed && followUp.round.sources_after_dedupe > ctx.sources.length) {
        ctx.sources = followUp.sources;
        ctx.rounds.push(followUp.round);
        const enriched = await enrichSources(ctx.sources, 4);
        ctx.sources = enriched.sources;
        await persistSources(ctx);

        lateCompanyResearch = {
          company: ctx.identity.company,
          new_sources: followUp.round.sources_after_dedupe,
          queries: followUp.round.queries_run,
        };

        // Re-analyse with the company evidence now in hand.
        const second = await analyzeProspect({
          profile: ctx.profile,
          profileAccessNote: ctx.linkedinAccess?.access.reason ?? 'Profile retrieved directly.',
          sources: ctx.sources,
          slug: ctx.slug,
          nameHint: ctx.nameHint,
          userHints: {
            name: ctx.run.input_name,
            company: ctx.run.input_company,
            title: ctx.run.input_title,
          },
          outreachContext: outreachContext(sender),
          senderName: sender.name,
          senderCompany: sender.company,
          // Previously omitted here, which left this path writing with no
          // capability, solution or proof context at all — the new structure
          // cannot be followed without them.
          capabilityContext: capabilityContext(ctx),
          approvedSolution: solutionContext(ctx) ? solutionForPrompt(solutionContext(ctx)!) : undefined,
          approvedProof: proofContext(ctx) ? proofForPrompt(proofContext(ctx)!) : undefined,
        });
        analysis = second;
        ctx.analysis = second.data;
        ctx.analysisMeta = second.meta;
      }
    }

    const rows: Omit<SignalRow, 'id' | 'run_id'>[] = ctx.ranked.map((s) => ({
      signal: s.signal,
      why_it_matters: s.why_it_matters,
      category: s.category,
      source_url: s.source_url,
      source_title: s.source_title ?? null,
      source_type: s.source_type,
      published_date: s.published_date,
      supporting_quote: s.supporting_quote,
      relevance_score: s.relevance_score,
      specificity_score: s.specificity_score,
      recency_score: s.recency_score,
      confidence_score: s.confidence_score,
      credibility_score: s.credibility_score,
      corroboration_count: s.corroboration_count,
      composite_score: s.composite_score,
      conflicts_with: s.conflicts_with,
      selected_as_hook: false,
      retrieved_at: s.retrieved_at,
    }));
    await replaceSignals(ctx.runId, rows);

    const usable = ctx.ranked.filter((s) => s.composite_score >= HOOK_THRESHOLD && !s.conflicts_with);

    return {
      status: (ctx.ranked.length === 0 ? 'degraded' : 'complete') as StageStatus,
      summary:
        (ctx.ranked.length === 0
          ? 'No verifiable signals found.'
          : `${ctx.ranked.length} verified signal(s) · top score ${ctx.ranked[0].composite_score}/100 · ${usable.length} above the ${HOOK_THRESHOLD} threshold`) +
        (recovery.attempts.length > 0
          ? ` · ${recovery.recovered.length}/${recovery.attempts.length} cited source(s) recovered`
          : '') +
        (rejected.length > 0 ? ` · ${rejected.length} rejected as unverifiable` : '') +
        ` · 1 model call (${analysis.meta.model}${analysis.meta.used_fallback_model ? ', fallback' : ''})`,
      output: {
        summary: analysis.data.summary,
        career_insights: analysis.data.careerInsights,
        company_context: analysis.data.companyContext,
        pain_points_or_interests: analysis.data.painPointsOrInterests,
        outreach_angle: analysis.data.outreachAngle,
        ranked: ctx.ranked.map((s, i) => ({
          rank: i + 1,
          signal: s.signal,
          composite_score: s.composite_score,
          components: {
            recency: s.recency_score,
            relevance: s.relevance_score,
            specificity: s.specificity_score,
            confidence: s.confidence_score,
            credibility: s.credibility_score,
            corroboration: s.corroboration_count,
          },
          conflicts_with: s.conflicts_with,
          source_url: s.source_url,
        })),
        rejected,
        citation_recovery: summariseRecovery(recovery.attempts),
        threshold: HOOK_THRESHOLD,
        late_company_research: lateCompanyResearch,
        llm: analysis.meta,
      },
      value: undefined,
    };
  });
}

// ─── 7. select hook (deterministic gate over the analysis) ───────────────────

export async function selectHookStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'select_hook', async () => {
    const analysis = ctx.analysis;
    const selection = gateHook(
      ctx.ranked,
      {
        index: analysis?.selectedHookIndex ?? null,
        reason: analysis?.hookReason ?? '',
        confidence: analysis?.confidence ?? 0,
        alternatives: analysis?.alternativesConsidered ?? [],
        insufficient: Boolean(analysis?.insufficientEvidence),
        insufficientReason: analysis?.insufficientReason ?? null,
      },
      // A company-level signal only qualifies when it connects to a known role.
      ctx.identity?.role ?? ctx.run.input_title ?? null,
      // And a hook may not lean on a use case that was never evidenced.
      capabilityContext(ctx).observedIds,
    );

    ctx.selection = selection;
    ctx.hook = selection.selected_index !== null ? (ctx.ranked[selection.selected_index] ?? null) : null;

    if (ctx.hook) {
      const stored = await listSignals(ctx.runId);
      const match = stored.find(
        (row) => row.source_url === ctx.hook!.source_url && row.signal === ctx.hook!.signal,
      );
      if (match) {
        ctx.hookSignalId = match.id;
        await markSignalAsHook(ctx.runId, match.id);
      }
      await updateRun(ctx.runId, { selected_hook: ctx.hook.signal, insufficient_evidence: false });
    } else {
      await updateRun(ctx.runId, { selected_hook: null, insufficient_evidence: true });
    }

    return {
      status: (ctx.hook ? 'complete' : 'degraded') as StageStatus,
      summary: ctx.hook
        ? `Hook: ${truncate(ctx.hook.signal, 90)} (confidence ${selection.confidence}/100)`
        : INSUFFICIENT_EVIDENCE_NOTICE,
      output: {
        selected: ctx.hook
          ? {
              signal: ctx.hook.signal,
              why_it_matters: ctx.hook.why_it_matters,
              signal_level: ctx.hook.signal_level,
              role_relevance: ctx.hook.role_relevance,
              outreach_rationale: ctx.hook.outreach_rationale,
              prospect_role: ctx.identity?.role ?? ctx.run.input_title ?? null,
              source_url: ctx.hook.source_url,
              source_title: ctx.hook.source_title,
              supporting_quote: ctx.hook.supporting_quote,
              evidence_level: ctx.hook.evidence_level,
              published_date: ctx.hook.published_date,
              composite_score: ctx.hook.composite_score,
            }
          : null,
        // Consistency check: what qualified the company vs what the hook uses.
        capability_alignment: (() => {
          const caps = capabilityContext(ctx);
          const hookCapability = ctx.hook?.related_capability_id ?? null;
          return {
            qualified_by: caps.observed.map((c) => c.name),
            hook_capability: hookCapability
              ? (caps.observed.find((c) => c.id === hookCapability)?.name ??
                caps.inferred.find((c) => c.id === hookCapability)?.name ??
                hookCapability)
              : null,
            hook_assumes_use_case: Boolean(hookCapability),
            evidence_backed: hookCapability ? caps.observedIds.has(hookCapability) : true,
            note: hookCapability
              ? caps.observedIds.has(hookCapability)
                ? 'The hook relies on a use case this company was actually shown to have.'
                : 'The hook relied on an unevidenced use case and was rejected.'
              : 'The hook assumes no particular use case, so no capability evidence is required.',
          };
        })(),
        rejected_candidates: selection.rejected_candidates,
        research_coverage: {
          sources: ctx.sources.length,
          signals_verified: ctx.ranked.length,
          signals_rejected: ctx.rejectedSignals.length,
        },
        missing_information: ctx.analysis?.informationRequests ?? [],
        selection_reason: selection.selection_reason,
        confidence: selection.confidence,
        // The model indexes its own candidate list, which verification may have
        // shrunk. Only surface alternatives we can actually name.
        alternatives_considered: (selection.alternatives_considered ?? [])
          .filter((a) => ctx.ranked[a.index])
          .map((a) => ({ signal: ctx.ranked[a.index].signal, why_not: a.why_not })),
        insufficient_evidence: selection.insufficient_evidence,
        insufficient_reason: selection.insufficient_reason,
        // True when code rejected the model's pick.
        overridden_by_gate: selection.overridden,
      },
      value: undefined,
    };
  });
}

// ─── 8. generate message (persist the analysis's message; no model call) ─────

/**
 * A message that could be sent to hundreds of people with minimal edits is not
 * personalisation. The test is whether the hook's own specifics — the distinctive
 * words from the verified observation — actually appear in the text.
 */
/**
 * Placeholder tokens a model uses when it does not know who is signing.
 * Deliberately narrow: only bracketed/braced tokens whose inner text is
 * sender-identity wording. A product or company name that merely contains the
 * word "name" is not a placeholder and must survive untouched.
 */
const SENDER_PLACEHOLDER =
  /(\[|<|\{\{?)\s*(your[\s_-]*name|sender[\s_-]*name|sender|your[\s_-]*full[\s_-]*name|full[\s_-]*name|name|your[\s_-]*signature|signature|rep[\s_-]*name)\s*(\]|>|\}\}?)/gi;

/** Sign-off words a message may end on before the signature line. */
const SIGNOFF = /(best|best regards|regards|thanks|thank you|cheers|sincerely|warmly)\s*,?\s*$/i;

/**
 * Put the configured sender identity into the finished draft.
 *
 * Any sender placeholder the model emitted is replaced with the configured
 * name; if none is configured, the fallback is used. A draft handed to a
 * reviewer should never contain fill-in-the-blank markers, and should never
 * need the reviewer to remember to swap in their own name.
 *
 * Applied at generation time only — stored historical drafts are never rewritten.
 */
export function applySenderIdentity(
  message: string,
  senderName: string | null | undefined,
  fallback = 'the sending team',
): string {
  const signature = (senderName ?? '').trim() || fallback;

  let out = message.replace(SENDER_PLACEHOLDER, signature);

  // Collapse whitespace damage from any replacement, without touching paragraphs.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // A dangling sign-off ("Best,") with nothing after it gets the signature.
  const lines = out.split('\n');
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim().length > 0) ?? '';
  if (SIGNOFF.test(lastNonEmpty.trim())) {
    out = `${out}\n${signature}`;
  }

  return out;
}

/** Back-compat wrapper: strips placeholders using the configured fallback. */
export function stripPlaceholders(message: string, senderName?: string | null): string {
  return applySenderIdentity(message, senderName);
}

export interface OpenerCheck {
  /** True when the opener is rejected for any quality reason. */
  isHeadline: boolean;
  reason: string | null;
  /** Highest overlap found against any source-derived text, 0–1. */
  similarity: number;
  /** Every reason it was rejected, most important first. */
  failures: string[];
  word_count: number;
  /** Independent factual clauses packed into the opening sentence. */
  fact_clauses: number;
}

/** Openers that announce a research summary rather than an observation. */
const REPORT_OPENING =
  /^\s*(given that|as the (largest|leading|biggest|top|foremost|premier)|with (over|more than) [\d,]+|considering that|in light of|it is worth noting|noting that|having reviewed|based on (my|our) research|per (public|available) (information|records))\b/i;

/** Corporate-profile phrasing: describing the company back to the company. */
const COMPANY_PROFILE =
  /\b(operates as|is (a|an|the) (largest|leading|biggest|premier|foremost)?\s*[\w-]*\s*(firm|company|platform|provider|brokerage|marketplace|business)|serving (millions|thousands|[\d,]+)|handling (millions|thousands|[\d,]+)|with (a )?(market share|revenue|valuation) of|headquartered in)\b/i;

/**
 * Superlatives that pad an opener without adding an observation.
 *
 * "leading" is handled separately from the rest: it is the one word on this
 * list that is also an ordinary verb form ("time leading business finance",
 * "you're co-leading Sunday PropTech"), and the plain word-boundary match
 * flagged that usage exactly as readily as the adjective sense ("the leading
 * firm"). The adjective sense is reliably preceded by a determiner — "the
 * leading X", "a leading X", "one of the leading X" — so that is what is
 * required for "leading" specifically. Every other term here has no such
 * verb-form ambiguity and keeps the original plain match.
 */
const SUPERLATIVE_HIGH_CONFIDENCE =
  /\b(largest|biggest|foremost|premier|top-tier|world-class|renowned|prestigious|cutting-edge|state-of-the-art)\b/i;
/** "leading" only in its adjective sense — never the verb ("leading X", "co-leading X"). */
const SUPERLATIVE_LEADING = /\b(?:the|an?|one of the)\s+leading\b/i;

function hasSuperlative(text: string): boolean {
  return SUPERLATIVE_HIGH_CONFIDENCE.test(text) || SUPERLATIVE_LEADING.test(text);
}

/**
 * Count the independent factual clauses crammed into one sentence.
 *
 * An opener that stacks several facts reads as a briefing, not a message. Each
 * comma- or conjunction-separated segment carrying a figure, a named entity or
 * a superlative counts as its own fact.
 */
function countFactClauses(sentence: string): number {
  const segments = sentence
    .split(/,|\band\b|\bwhich\b|\bwhile\b|\bwhere\b|\brequiring\b|\bhandling\b|\bunder\b/i)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

  return segments.filter((seg) => {
    const hasFigure = /\d/.test(seg) || /\b(millions?|thousands?|billions?)\b/i.test(seg);
    // A capitalised token that is not simply the first word of the sentence.
    const hasEntity = /(?:\s)[A-Z][A-Za-z0-9&.-]{2,}/.test(seg);
    return hasFigure || hasEntity || hasSuperlative(seg);
  }).length;
}

/** Words that carry no signal when comparing an opener to a headline. */
const OPENER_STOP = new Set([
  'the', 'a', 'an', 'and', 'to', 'of', 'in', 'for', 'on', 'with', 'is', 'are',
  'their', 'they', 'you', 'your', 'that', 'this', 'has', 'have', 'was', 'were',
  'its', 'at', 'as', 'from', 'by', 'it', 'be', 'been', 'we', 'our', 'i', 'me',
  'saw', 'read', 'noticed', 'came', 'across', 'about', 'recently', 'recent',
]);

function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !OPENER_STOP.has(w));
}

/**
 * How much of `sourceText` is reproduced in `opener`.
 *
 * Containment rather than Jaccard: an opener that swallows a headline whole and
 * adds a few words of its own is still a pasted headline, and Jaccard would
 * dilute that away.
 */
function containment(opener: string, sourceText: string): number {
  const sourceTokens = [...new Set(contentTokens(sourceText))];
  if (sourceTokens.length < 4) return 0;
  const openerSet = new Set(contentTokens(opener));
  return sourceTokens.filter((t) => openerSet.has(t)).length / sourceTokens.length;
}

/**
 * Does the message open by restating the research rather than interpreting it?
 *
 * A good opener reads as a person's observation. A bad one is the source title,
 * the quote, or the signal sentence with a few words changed — factually fine,
 * but it reads like a pasted news headline and signals no actual thought.
 */
/**
 * Translate checkOpener()'s own recorded reason into an accurate stage
 * summary line, instead of assuming every isHeadline failure is source
 * restatement (the previous behaviour, which mislabeled a superlative-only
 * failure as "restating the source").
 *
 * Reads `opener.reason` — already `failures[0]`, i.e. the first check that
 * failed in checkOpener()'s own fixed evaluation order — so a message that
 * fails more than one opener check still reports the SAME primary reason
 * checkOpener() itself considers first. No second classification system:
 * this only puts a name to the text checkOpener() already produced.
 */
export function openerFailureSummary(opener: { reason: string | null }, words: number): string {
  const reason = opener.reason ?? '';
  const suffix = `after one regeneration (${words} words) — sent to manual review.`;

  if (/restates .+ almost verbatim/i.test(reason)) {
    return `Draft still opens by restating the source ${suffix}`;
  }
  if (/superlatives?/i.test(reason) || /own size and standing/i.test(reason)) {
    return `Draft still leans on superlative phrasing ${suffix}`;
  }
  if (/packs \d+ separate facts/i.test(reason)) {
    return `Draft still stacks too many facts in the opening ${suffix}`;
  }
  if (/runs to \d+ words/i.test(reason)) {
    return `Draft still opens with an overlong sentence ${suffix}`;
  }
  if (/research-report phrasing/i.test(reason)) {
    return `Draft still opens with research-report phrasing ${suffix}`;
  }
  if (/describes the company back to itself/i.test(reason)) {
    return `Draft still describes the company back to itself ${suffix}`;
  }
  // Unreachable given checkOpener()'s exhaustive checks, but never silently
  // relabel an unrecognised reason as one of the above.
  return `Draft still opens like a pasted headline ${suffix}`;
}

export function checkOpener(
  message: string,
  hook: { signal: string; supporting_quote?: string | null; source_title?: string | null },
): OpenerCheck {
  const trimmed = message.trim();
  const clean = (over: Partial<OpenerCheck> = {}): OpenerCheck => ({
    isHeadline: false,
    reason: null,
    similarity: 0,
    failures: [],
    word_count: 0,
    fact_clauses: 0,
    ...over,
  });

  if (!trimmed) return clean();

  // Skip a greeting line ("Hi Nithin,") — the opener is the first real sentence.
  const body = trimmed
    .split(/\n+/)
    .filter((line) => line.trim() && !/^(hi|hello|hey|dear)\b[^.!?]*,?\s*$/i.test(line.trim()))
    .join(' ');

  const firstSentence = (body.split(/(?<=[.!?])\s+/)[0] ?? body).trim();
  if (contentTokens(firstSentence).length < 4) return clean();

  const wordCount = firstSentence.split(/\s+/).filter(Boolean).length;
  const factClauses = countFactClauses(firstSentence);
  const failures: string[] = [];

  const candidates: { label: string; text: string }[] = [
    { label: 'the source headline', text: hook.source_title ?? '' },
    { label: 'the quoted source text', text: hook.supporting_quote ?? '' },
    { label: 'the research signal', text: hook.signal },
  ].filter((c) => c.text.trim().length > 0);

  let worst = { label: '', score: 0 };
  for (const c of candidates) {
    const score = containment(firstSentence, c.text);
    if (score > worst.score) worst = { label: c.label, score };
  }

  // Above this, the opening sentence is essentially the source restated.
  const HEADLINE_THRESHOLD = 0.72;
  if (worst.score >= HEADLINE_THRESHOLD) {
    failures.push(
      `The opening sentence restates ${worst.label} almost verbatim (${Math.round(worst.score * 100)}% of its content words), so it reads like a pasted headline rather than an observation.`,
    );
  }

  // A briefing sentence, not a message. ~15-30 words is the natural shape; this
  // only fires well beyond that, so it stays a guideline rather than a ruler.
  if (wordCount > 45) {
    failures.push(
      `The opening sentence runs to ${wordCount} words. A natural observation is roughly 15-30.`,
    );
  }

  if (factClauses >= 3) {
    failures.push(
      `The opening sentence packs ${factClauses} separate facts together, which reads as a research summary rather than one clear observation.`,
    );
  }

  if (REPORT_OPENING.test(firstSentence)) {
    failures.push(
      'The message opens with research-report phrasing rather than an observation a salesperson would write.',
    );
  }

  if (COMPANY_PROFILE.test(firstSentence)) {
    failures.push(
      'The opening describes the company back to itself. The prospect already knows what their company does.',
    );
  } else {
    // Scale-and-superlative phrasing ("running the largest X with millions of Y")
    // is the same mistake in a shorter sentence: it recites the company's own
    // size to the person who runs it instead of observing something.
    const openerHasSuperlative = hasSuperlative(firstSentence);
    const hasScale = /\b(millions?|thousands?|billions?|[\d,]{4,}\+?)\b/i.test(firstSentence);

    if (openerHasSuperlative && hasScale) {
      failures.push(
        'The opening recites the company’s own size and standing back to them rather than making an observation.',
      );
    } else if (openerHasSuperlative) {
      failures.push(
        'The opening leans on superlatives ("largest", "leading") instead of a specific observation.',
      );
    }
  }

  return {
    isHeadline: failures.length > 0,
    reason: failures[0] ?? null,
    similarity: worst.score,
    failures,
    word_count: wordCount,
    fact_clauses: factClauses,
  };
}

export interface PersonalizationCheck {
  passed: boolean;
  score: number;
  failures: string[];
  detail: Record<string, boolean>;
}

/**
 * Does this message actually depend on the hook, or is it sales copy with a
 * name dropped into it?
 *
 * Vocabulary overlap alone is too easy to game — a message can echo the hook's
 * words and still read as a template. So the gate scores several independent
 * properties and requires the message to pass the ones that matter most:
 * it must engage the hook's specifics, name the prospect's world, avoid
 * boilerplate, and avoid asserting pain the evidence never established.
 */
export function checkPersonalization(
  message: string,
  hook: {
    signal: string;
    role_relevance?: string | null;
    signal_level?: string;
    evidence_level?: string;
  },
  context: { prospectName?: string | null; company?: string | null; role?: string | null } = {},
): PersonalizationCheck {
  const body = message.toLowerCase();
  const failures: string[] = [];

  const stop = new Set([
    'the', 'a', 'an', 'and', 'to', 'of', 'in', 'for', 'on', 'with', 'is', 'are',
    'their', 'they', 'you', 'your', 'that', 'this', 'has', 'have', 'was', 'were',
    'its', 'at', 'as', 'from', 'by', 'company', 'business', 'team', 'new', 'recent',
  ]);
  const hookTerms = hook.signal
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));

  const coverage =
    hookTerms.length === 0 ? 1 : hookTerms.filter((w) => body.includes(w)).length / hookTerms.length;

  // 1. Hook usage — does the message engage the specifics of the observation?
  const usesHook = hookTerms.length === 0 || coverage >= 0.3;
  if (!usesHook) {
    failures.push(
      `The message barely engages with the selected hook (only ${Math.round(coverage * 100)}% of its distinctive terms appear).`,
    );
  }

  // 2. Boilerplate — phrasing that survives regardless of recipient.
  const TEMPLATE =
    /\b(i hope this (email )?finds you well|i wanted to reach out|i came across your profile|hope you'?re doing well|quick question for you|as a leader in your (space|industry)|reaching out because i noticed|i'?ll keep this brief|circling back)\b/i;
  const noBoilerplate = !TEMPLATE.test(message);
  if (!noBoilerplate) failures.push('The message uses boilerplate outreach phrasing.');

  // 3. Specificity — does it name the prospect's actual world?
  const specifics = [context.prospectName, context.company].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
  const namesSpecifics =
    specifics.length === 0 || specifics.some((v) => body.includes(v.toLowerCase().split(' ')[0]));
  if (!namesSpecifics) failures.push('The message never names the prospect or their company.');

  // 4. Assumed pain — asserting problems the evidence never established.
  const ASSUMED_PAIN =
    /\b(i('m| am) sure (you|your team)|you('re| are) (probably|likely|no doubt)|must be (a )?(struggling|bottleneck|painful|challenging|frustrating)|i imagine (you|your)|chances are you)\b/i;
  const noAssumedPain = !ASSUMED_PAIN.test(message);
  if (!noAssumedPain) {
    failures.push('The message asserts a pain point the research did not establish.');
  }

  // 5. Dependency — could the hook sentence be deleted and the message still work?
  //    If nothing but the greeting is prospect-specific, it is a template.
  const sentences = message.split(/(?<=[.!?])\s+/).filter((x) => x.trim().length > 0);
  const hookSentences = sentences.filter((sn) => {
    const l = sn.toLowerCase();
    return hookTerms.some((w) => l.includes(w));
  });
  const dependsOnHook = hookTerms.length === 0 || hookSentences.length > 0;
  if (!dependsOnHook) failures.push('No sentence in the message actually rests on the hook.');

  // 6. Role relevance — a company signal should be tied to what they do.
  const roleTied =
    hook.signal_level !== 'COMPANY' ||
    !context.role ||
    Boolean(hook.role_relevance && hook.role_relevance.trim().length > 0);
  if (!roleTied) {
    failures.push('Company-level hook with no stated relevance to the prospect’s role.');
  }

  const detail = {
    uses_hook: usesHook,
    no_boilerplate: noBoilerplate,
    names_specifics: namesSpecifics,
    no_assumed_pain: noAssumedPain,
    depends_on_hook: dependsOnHook,
    role_tied: roleTied,
  };
  const score = Math.round((Object.values(detail).filter(Boolean).length / 6) * 100);

  return { passed: failures.length === 0, score, failures, detail };
}

/** Back-compat wrapper used by the existing vocabulary-overlap tests. */
export function isGenericMessage(
  message: string,
  hookSignal: string,
): { generic: boolean; reason: string | null } {
  const result = checkPersonalization(message, { signal: hookSignal });
  return {
    generic: !result.passed,
    reason: result.failures[0] ?? null,
  };
}

export async function generateMessageStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'generate_message', async () => {
    const analysis = ctx.analysis;
    if (!analysis) throw new Error('No analysis available to draft from.');

    // No verified hook means no outreach. We do not write a "conservative"
    // message and call it personalised — there is nothing to personalise with.
    if (!ctx.hook) {
      await deleteDrafts(ctx.runId);
      return {
        status: 'skipped' as const,
        summary: `No message generated — ${INSUFFICIENT_EVIDENCE_NOTICE}`,
        output: {
          skipped: true,
          reason: 'NO_VERIFIED_OUTREACH_HOOK',
          explanation:
            'No signal survived verification, so no outreach was drafted. Generating a message here would mean inventing a reason to make contact.',
          information_requests: analysis.informationRequests ?? [],
        },
        value: undefined,
      };
    }

    const sender = senderFor(ctx);
    // Matched once, deterministically, from this run's verified capabilities —
    // recorded here so the UI can show the same recommendation the model was
    // (or was not) given, never a claim invented after the fact.
    const solutionMatch = solutionContext(ctx);
    // Phase 1: matched and recorded, deliberately NOT passed to the model.
    const proofMatch = matchApprovedProof(solutionMatch);

    // Personalisation gate: one regeneration, then manual review.
    const personContext = {
      prospectName: ctx.identity?.full_name ?? ctx.run.input_name,
      company: ctx.identity?.company ?? ctx.run.input_company,
      role: ctx.identity?.role ?? ctx.run.input_title,
    };

    // Every business decision is settled by this point: the hook has been
    // quote-verified, scored and gated; the solution and proof were matched
    // deterministically. The brief carries exactly those decisions.
    const brief = briefForContext(ctx, solutionMatch, proofMatch);

    // THE EMAIL IS WRITTEN HERE, from the brief — not taken from the analysis
    // pass, which drafts a message in the same breath as it PROPOSES hooks and
    // therefore writes against a hook the gate may go on to reject. When the
    // writer is unavailable the analysis draft is still used, so a model
    // failure degrades rather than dead-ends the run.
    // A user-requested rewrite is written by regenerateMessageOnly() before
    // this stage starts, so a writer failure there can be reported without
    // failing the stage. Otherwise this is a first generation.
    const preWritten = ctx.pendingMessage as WrittenEmail | null;
    ctx.pendingMessage = null;

    let written: WrittenEmail | null =
      preWritten ??
      (brief
        ? await writeEmailFromBrief({
            brief,
            senderName: sender.name,
            senderCompany: sender.company,
            outreachContext: outreachContext(sender),
            sources: ctx.sources,
          })
        : null);

    // One editorial pass over the writer's draft. It may only improve prose;
    // its output is compared against the writer's on the same deterministic
    // checks and discarded unless it holds up. No loop — see edit-email.ts.
    let editNote: string | null = null;
    let wasEdited = false;
    if (written && brief) {
      const edited = await editEmail({ brief, message: written.message, claims: written.claims });
      const choice = chooseDraft(brief, written, edited, ctx.hook.supporting_quote ?? null, ctx.previousMessage);
      editNote = choice.reason;
      wasEdited = choice.edited;
      written = { ...written, message: choice.message, claims: choice.claims };
    }

    if (written) {
      // Claims must describe the text that will actually be validated.
      analysis.suggestedMessage = written.message;
      analysis.messageClaims = written.claims;
      if (written.subject) analysis.suggestedSubject = written.subject;
    }

    const messageText = applySenderIdentity(
      written?.message ?? analysis.suggestedMessage ?? '',
      sender.name,
    );
    if (!messageText) {
      return {
        status: 'failed' as const,
        summary: 'A hook was selected but no message text could be produced.',
        output: { hook: ctx.hook.signal },
        value: undefined,
      };
    }

    const gate = checkPersonalization(messageText, ctx.hook, personContext);
    const opener = checkOpener(messageText, ctx.hook);
    // The specific defects the earlier checks do not cover — stacked openings,
    // interpreted facts, asserted pain, product-category language, missing
    // workflow, invented proof, pushy CTAs.
    const quality = checkEmailQuality(messageText, { brief });
    // Voice is checked in code, not trusted to the prompt. The hook's verified
    // quote is exempted so evidence is never rewritten to satisfy a style rule.
    const voice = checkVoice(messageText, { quotes: [ctx.hook.supporting_quote] });
    // Only meaningful on a user regeneration — ctx.previousMessage is set by
    // regenerateMessageOnly() and stays null on every first generation, so
    // this check never fires there. Catches the "same email, one word
    // changed" failure the writer's regeneration instruction alone did not
    // reliably prevent.
    const divergence = ctx.previousMessage ? checkDivergence(messageText, ctx.previousMessage) : null;
    let finalText = messageText;
    let regenerated = false;

    // One regeneration total, whichever check failed.
    if (!gate.passed || opener.isHeadline || !voice.passed || !quality.passed || divergence?.passed === false) {
      const qualityDirective =
        [
          // "Too generic" here means specifically the personalization gate —
          // low hook-term coverage, no stated role relevance — which is this
          // codebase's own definition of "sales copy with a name dropped in".
          // The prior generic nudge left the model free to fix it by
          // inventing a plausible-sounding pain instead of tightening its
          // grip on the verified signal and the role, which is exactly the
          // failure mode this instruction now names directly.
          !gate.passed
            ? 'The previous draft avoided restating the research signal but became too generic. Do not introduce ' +
              "an unsupported operational pain. Instead, make the opener more specific to the verified signal and " +
              'this prospect\'s role by turning the implication into a concrete, cautious observation or question. ' +
              `Specifically: ${gate.failures.join(' ')}`
            : null,
          opener.isHeadline
            ? // The exact wording matters here: a generic "don't restate the
              // research summary" nudge left the model free to produce a
              // close paraphrase that still failed containment on retry. When
              // the actual failure IS restatement, say so unambiguously and
              // forbid the two easiest non-fixes (rewording the same sentence,
              // narrating the same fact) by name.
              (/restates .+ almost verbatim/i.test(opener.reason ?? '')
                ? 'The previous opener was rejected because it restated the research signal. Do not rewrite the same ' +
                  'sentence. Do not paraphrase the hook. Start from the implication for the prospect\'s role instead. '
                : 'Rewrite the opening as a concise, natural observation for a human salesperson. Preserve the verified fact ' +
                  'and role relevance, but do not restate the research summary. ') +
              `Specifically: ${opener.failures.join(' ')} ` +
              'Aim for roughly 15-30 words, one observation, no company description, no superlatives.'
            : null,
          !voice.passed
            ? 'The draft reads as generated rather than written. Fix these specific problems without ' +
              `changing any verified fact or adding a new one: ${voice.failures.join(' ')}`
            : null,
          // Named failures, not "try again" — a rewrite told exactly what is
          // wrong is far likelier to fix it. A draft that failed ONLY on
          // being under the word minimum gets a dedicated expansion
          // instruction instead of the generic repair wrapper — the generic
          // one does not tell the model HOW to add words without inventing
          // pain or filler, which is exactly what "too short" needs to hear.
          // Any other quality failure (including being over the max, and any
          // combination with other failures) still goes through the
          // existing repairDirective path, unchanged.
          !quality.passed
            ? quality.failures.length === 1 && quality.detail.word_count === false && quality.wordCount < MIN_EMAIL_WORDS
              ? 'The previous draft is below the required 90-word minimum. Expand it naturally to approximately ' +
                '100–115 words by adding substantive, prospect-specific context or a clearer role-relevant question. ' +
                'Do not repeat the research hook, invent a business pain, or add generic filler.'
              : repairDirective(quality, brief)
            : null,
        ]
          .filter(Boolean)
          .join(' ') || null;

      // Same brief, same fact, same workflow, same proof — new prose only.
      // Deliberately NOT a return to the research corpus: a prose failure must
      // not be allowed to pick a different business angle.
      //
      // On a regeneration, the retry stays a REGENERATION call (previousMessage
      // carried forward) rather than falling back to the repair wrapper — the
      // two wrappers say opposite things, and silently swapping to "change
      // nothing else" here would recreate the exact bug this fix exists for.
      const retry = brief
        ? await writeEmailFromBrief({
            brief,
            senderName: sender.name,
            senderCompany: sender.company,
            outreachContext: outreachContext(sender),
            sources: ctx.sources,
            ...(ctx.previousMessage
              ? {
                  previousMessage: ctx.previousMessage,
                  regenerationReinforcement:
                    divergence?.passed === false
                      ? 'The previous regenerated version was too similar to the original. Produce substantially different sentence construction and wording.'
                      : null,
                  repairNotes: qualityDirective,
                }
              : { repairNotes: qualityDirective })
          })
        : null;
      const retryResult =
        retry?.message ?? (brief ? null : await regenerateMessage(ctx, qualityDirective ?? 'Rewrite this message.'));

      if (retryResult) {
        regenerated = true;
        finalText = applySenderIdentity(retryResult, sender.name);
        if (retry) {
          analysis.suggestedMessage = retry.message;
          analysis.messageClaims = retry.claims;
        }
      }
    }

    const secondGate = checkPersonalization(finalText, ctx.hook, personContext);
    const secondOpener = checkOpener(finalText, ctx.hook);
    const secondVoice = checkVoice(finalText, { quotes: [ctx.hook.supporting_quote] });
    const secondQuality = checkEmailQuality(finalText, { brief });
    // Re-checked against the SAME previous message, never the just-rejected
    // first attempt — the bar is "different from what the user already has",
    // not "different from what we just tried".
    const secondDivergence = ctx.previousMessage ? checkDivergence(finalText, ctx.previousMessage) : null;
    const words = wordCount(finalText);

    await deleteDrafts(ctx.runId);
    const row = await createDraft({
      run_id: ctx.runId,
      hook_signal_id: ctx.hookSignalId,
      mode: 'personalized',
      subject: analysis.suggestedSubject ?? '',
      message_text: finalText,
      personalization_basis: ctx.hook.signal,
      reasoning: analysis.outreachAngle ?? analysis.hookReason ?? '',
      information_requests: analysis.informationRequests ?? [],
    });
    ctx.draftId = row.id;
    const qualityPassed =
      secondGate.passed &&
      !secondOpener.isHeadline &&
      secondVoice.passed &&
      secondQuality.passed &&
      secondDivergence?.passed !== false;
    ctx.messageFailedGate = !qualityPassed;

    return {
      status: (qualityPassed ? 'complete' : 'degraded') as StageStatus,
      summary: qualityPassed
        ? `Personalised draft (${words} words, personalisation ${secondGate.score}/100)${regenerated ? ', regenerated once for quality' : ''}.`
        : secondOpener.isHeadline
          ? openerFailureSummary(secondOpener, words)
          : !secondVoice.passed
            ? `Draft still carries generated-sounding phrasing after one regeneration (${words} words) — sent to manual review.`
            : `Draft still reads as generic after one regeneration (${words} words) — sent to manual review.`,
      output: {
        mode: 'personalized',
        subject: analysis.suggestedSubject,
        message_text: finalText,
        word_count: words,
        outreach_angle: analysis.outreachAngle,
        personalization_basis: ctx.hook.signal,
        personalization_gate: {
          passed: secondGate.passed,
          score: secondGate.score,
          checks: secondGate.detail,
          regenerated,
          first_attempt_failures: gate.failures,
          final_failures: secondGate.failures,
        },
        opener_check: {
          passed: !secondOpener.isHeadline,
          similarity: Math.round(secondOpener.similarity * 100),
          word_count: secondOpener.word_count,
          fact_clauses: secondOpener.fact_clauses,
          first_attempt_failures: opener.failures,
          final_failures: secondOpener.failures,
          first_attempt_reason: opener.reason,
          final_reason: secondOpener.reason,
        },
        voice_check: {
          passed: secondVoice.passed,
          word_count: secondVoice.wordCount,
          exclamations: secondVoice.exclamations,
          issues: secondVoice.issues,
          first_attempt_failures: voice.failures,
          final_failures: secondVoice.failures,
        },
        email_quality: {
          passed: secondQuality.passed,
          word_count: secondQuality.wordCount,
          paragraphs: secondQuality.paragraphs,
          first_attempt_failures: quality.failures,
          final_failures: secondQuality.failures,
          checks: secondQuality.detail,
        },
        email_brief: brief,
        editorial_pass: { applied: wasEdited, note: editNote },
        // Only meaningful on a user regeneration; null on every first
        // generation. Recorded on the SECOND (post-retry) attempt, since that
        // is the text actually being persisted.
        regeneration_divergence: secondDivergence
          ? {
              passed: secondDivergence.passed,
              whole_message_similarity: secondDivergence.wholeMessageSimilarity,
              opening_similarity: secondDivergence.openingSimilarity,
              reason: secondDivergence.reason,
            }
          : null,
        declared_claims: analysis.messageClaims,
        information_requests: analysis.informationRequests,
        approved_solution: solutionMatch
          ? {
              id: solutionMatch.solution.id,
              name: solutionMatch.solution.name,
              description: solutionMatch.solution.description,
              supported_workflows: solutionMatch.solution.supported_workflows,
              target_functions: solutionMatch.solution.target_functions,
              use_cases: solutionMatch.solution.use_cases,
              non_use_cases: solutionMatch.solution.non_use_cases,
              matched_capabilities: solutionMatch.matched_capabilities,
              why_it_fits: solutionMatch.why_it_fits,
            }
          : null,
        solution_match_note: solutionMatch ? null : NO_SOLUTION_MATCH_MESSAGE,
        // Phase 1 — recorded for review only. Nothing below was shown to the
        // model or used to produce the message above it.
        approved_proof: proofMatch
          ? {
              id: proofMatch.proof.id,
              customer: proofMatch.proof.customer,
              workflow: proofMatch.proof.workflow,
              approved_statement: proofMatch.proof.approved_statement,
              matched_on: proofMatch.matched_on,
              solution_id: proofMatch.solution_id,
              selection_basis: proofMatch.selection_basis,
              why_this_proof: proofMatch.why_this_proof,
              // Phase 2: the approved statement IS now supplied to generation.
              // Recorded as an OBSERVATION, not a gate — nothing branches on
              // it, and the run status is unaffected. It exists so the
              // verbatim rule can be evaluated against real drafts before any
              // structural check is made deterministic.
              supplied_to_model: true,
              statement_present_verbatim: finalText.includes(proofMatch.proof.approved_statement),
            }
          : null,
        proof_match_note: proofMatch ? null : NO_PROOF_MATCH_MESSAGE,
      },
      value: undefined,
    };
  });
}

/**
 * One targeted rewrite when the first draft reads as generic. This is the only
 * place a second model call can happen, and only for this specific failure.
 *
 * Exported so `regenerateMessageOnly()` (lib/pipeline/execute.ts) can reuse it
 * directly for a user-triggered "Regenerate message" action — same rewrite
 * mechanics, same fixed hook, just invoked outside the automatic quality gate.
 */
export async function regenerateMessage(
  ctx: PipelineContext,
  directive: string,
): Promise<string | null> {
  if (!ctx.hook || !ctx.analysis) return null;
  const sender = senderFor(ctx);

  try {
    const retry = await analyzeProspect({
      profile: ctx.profile,
      profileAccessNote: ctx.linkedinAccess?.access.reason ?? 'Profile retrieved directly.',
      sources: ctx.sources,
      slug: ctx.slug,
      nameHint: ctx.nameHint,
      userHints: {
        name: ctx.run.input_name,
        company: ctx.run.input_company,
        title: ctx.run.input_title,
      },
      outreachContext: outreachContext(sender),
      senderName: sender.name,
      senderCompany: sender.company,
      capabilityContext: capabilityContext(ctx),
      approvedSolution: solutionContext(ctx) ? solutionForPrompt(solutionContext(ctx)!) : undefined,
      approvedProof: proofContext(ctx) ? proofForPrompt(proofContext(ctx)!) : undefined,
      // Settled inputs, so the rewrite turns them into prose rather than
      // re-deciding the narrative that just failed.
      emailBrief: briefForContext(ctx, solutionContext(ctx), proofContext(ctx)) ?? undefined,
      rewriteDirective:
        `${directive} ` +
        `The message must remain unmistakably about THIS prospect and rest on this verified observation: "${ctx.hook.signal}". ` +
        `Do not assert problems the evidence does not establish — ask rather than assume. ` +
        `Do not use boilerplate openers. Keep every fact accurate. 90-130 words.`,
    });

    const text = (retry.data.suggestedMessage ?? '').trim();
    if (!text) return null;

    // Keep the regenerated claims so validation checks what will actually be sent.
    ctx.analysis = { ...ctx.analysis, suggestedMessage: text, messageClaims: retry.data.messageClaims ?? [] };
    return text;
  } catch {
    // A failed rewrite is not fatal: the original draft goes to manual review.
    return null;
  }
}

// ─── 9. validate claims (deterministic re-check) ─────────────────────────────

export async function validateClaimsStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'validate_claims', async () => {
    const analysis = ctx.analysis;
    if (!analysis) throw new Error('No analysis available.');

    // No hook means no draft, so there are no claims to check.
    if (!ctx.hook || !ctx.draftId) {
      return {
        status: 'skipped' as const,
        summary: 'No draft was generated, so there were no claims to validate.',
        output: { skipped: true, reason: 'NO_DRAFT' },
        value: undefined,
      };
    }

    const validateInput = {
      sources: ctx.sources,
      evidence: ctx.ranked,
      conservative: ctx.hook === null,
      modelConfidence: analysis.confidence ?? 0,
    };

    const first = validateClaims({
      message: analysis.suggestedMessage,
      claims: analysis.messageClaims ?? [],
      ...validateInput,
    });

    // One bounded attempt to REMOVE an unsupported claim before troubling a
    // human with it. The validator is untouched and still strict: repair only
    // ever subtracts, and its output has to clear the same checks from
    // scratch. See lib/generation/repair.ts.
    let result = first;
    const repair: {
      attempted: boolean;
      accepted: boolean;
      reason: string | null;
      removed: string[];
      blocking_before: string[];
    } = {
      attempted: false,
      accepted: false,
      reason: null,
      removed: [],
      blocking_before: blockingClaims(first.claims, analysis.suggestedMessage).map((c) => c.claim),
    };

    if (shouldAttemptRepair(first.claims, analysis.suggestedMessage)) {
      repair.attempted = true;
      const solution = solutionContext(ctx);
      const repaired = await repairMessage({
        message: analysis.suggestedMessage,
        claims: first.claims,
        sources: ctx.sources,
        approvedSolution: solution ? solutionForPrompt(solution) : undefined,
      });

      if (!repaired) {
        repair.reason = 'The repair attempt did not return a usable draft.';
      } else {
        // Deterministic gate first: catches a fabricated citation or a newly
        // introduced fact, which a second validation pass would not, because
        // it judges the claims it is handed.
        const safety = verifyRepairSafety({ claims: first.claims }, repaired, ctx.sources);
        if (!safety.safe) {
          repair.reason = safety.reason;
        } else {
          // Revalidation from scratch, through the identical validator.
          const second = validateClaims({
            message: repaired.message,
            claims: repaired.claims,
            ...validateInput,
          });
          // The same quality gates the original draft had to clear.
          const gate = checkPersonalization(repaired.message, ctx.hook, {
            prospectName: ctx.identity?.full_name ?? ctx.run.input_name,
            company: ctx.identity?.company ?? ctx.run.input_company,
            role: ctx.identity?.role ?? ctx.run.input_title,
          });
          const voice = checkVoice(repaired.message, { quotes: [ctx.hook.supporting_quote] });

          if (blockingClaims(second.claims, repaired.message).length > 0) {
            repair.reason = 'The repaired draft still contained an unsupported claim.';
          } else if (second.status === 'flagged') {
            repair.reason = 'The repaired draft was still flagged by claim validation.';
          } else if (!gate.passed || !voice.passed) {
            repair.reason = 'The repaired draft no longer met the message quality checks.';
          } else {
            // Accepted. This text is what the draft, Stage 13 and the
            // regeneration flow all read, via the existing final_text field.
            repair.accepted = true;
            repair.removed = repaired.removed;
            result = {
              ...second,
              was_revised: true,
              // Marker the UI keys on. Carried in the existing notes field so
              // the draft row stays the single source of truth.
              notes: `${AUTO_REVISED_MARKER} ${second.notes}`.trim(),
            };
            analysis.suggestedMessage = repaired.message;
            analysis.messageClaims = repaired.claims;
            ctx.messageFailedGate = false;
          }
        }
      }
    }

    ctx.validation = result;

    const { updateDraft } = await import('@/lib/supabase/queries');
    await updateDraft(ctx.draftId, {
      final_text: result.final_message_text,
      claims: result.claims,
      validation_status: result.status,
      validation_notes: result.notes,
      sensitivity_note: result.sensitivity_note,
      confidence: result.confidence,
    });

    const counts = { SUPPORTED: 0, UNSUPPORTED: 0, UNCERTAIN: 0 } as Record<string, number>;
    for (const c of result.claims) counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;

    return {
      status: (result.status === 'flagged' ? 'degraded' : 'complete') as StageStatus,
      summary:
        `${counts.SUPPORTED} supported · ${counts.UNCERTAIN} uncertain · ${counts.UNSUPPORTED} unsupported` +
        (repair.accepted ? ' · auto-revised once to remove an unsupported claim' : '') +
        (repair.attempted && !repair.accepted ? ' · auto-repair rejected' : '') +
        (result.status === 'flagged' ? ' · flagged for human judgment' : ''),
      output: {
        status: result.status,
        claims: result.claims,
        notes: result.notes,
        sensitivity_note: result.sensitivity_note,
        confidence: result.confidence,
        checked_deterministically: true,
        auto_repair: {
          attempted: repair.attempted,
          accepted: repair.accepted,
          rejected_reason: repair.reason,
          unsupported_before: repair.blocking_before,
          removed_claims: repair.removed,
          max_attempts: MAX_REPAIR_ATTEMPTS,
        },
      },
      value: undefined,
    };
  });
}

// ─── 10. ready for review ────────────────────────────────────────────────────

export async function readyForReviewStage(ctx: PipelineContext): Promise<void> {
  await runStage(ctx, 'ready_for_review', async () => {
    const confidence = overallConfidence(ctx);
    const needsManual =
      !ctx.hook ||
      ctx.messageFailedGate ||
      ctx.validation?.status === 'flagged' ||
      ctx.identity?.ambiguous === true ||
      ctx.identity?.resolved === false;

    // No hook means no message at all — never a placeholder draft.
    const finalText = ctx.hook
      ? (ctx.validation?.final_message_text ?? ctx.analysis?.suggestedMessage ?? null)
      : null;

    await updateRun(ctx.runId, {
      status: needsManual ? 'needs_manual_review' : 'ready_for_review',
      overall_confidence: confidence,
      generated_message: finalText,
      completed_at: new Date().toISOString(),
      error: null,
      ai_error_type: null,
    });

    const reasons: string[] = [];
    if (!ctx.hook) reasons.push('No verified outreach hook found — no message was generated.');
    if (ctx.messageFailedGate)
      reasons.push('The draft was not specific enough to this prospect after one regeneration.');
    if (ctx.validation?.status === 'flagged') reasons.push('Claim validation flagged the message.');
    if (ctx.identity?.ambiguous) reasons.push('Prospect identity is ambiguous.');
    if (ctx.identity?.resolved === false) reasons.push('Prospect identity could not be resolved.');

    return {
      status: 'complete' as const,
      summary: needsManual
        ? `Held for manual review — ${reasons.join(' ')}`
        : `Ready for human review · overall confidence ${confidence}/100`,
      output: {
        overall_confidence: confidence,
        needs_manual_review: needsManual,
        reasons,
        model_calls_used: 1,
        model: ctx.analysisMeta?.model ?? null,
        used_fallback_model: ctx.analysisMeta?.used_fallback_model ?? false,
        nothing_sent: true,
      },
      value: undefined,
    };
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Persist the run as awaiting AI analysis. Profile and research are already in
 * the database, so a later retry re-runs only the analysis — a quota problem
 * never costs the collected data.
 */
async function parkForRetry(ctx: PipelineContext, err: LLMError): Promise<void> {
  await updateRun(ctx.runId, {
    status: 'ai_analysis_pending',
    error: err.userMessage,
    ai_error_type: err.type,
    completed_at: new Date().toISOString(),
  });
  await skipRemainingStages(ctx.runId, 'evaluate_signals');

  const { getStage, finishStage: finish } = await import('@/lib/supabase/queries');
  const stage = await getStage(ctx.runId, 'evaluate_signals');
  if (stage) {
    await finish(stage.id, {
      status: 'failed',
      summary: err.userMessage,
      error: `${err.type}: ${err.message}`,
      output: {
        error_type: err.type,
        model_attempted: err.model ?? null,
        research_preserved: true,
        sources_collected: ctx.sources.length,
        profile_retrieved: Boolean(ctx.profile),
        retry_hint: 'POST /api/runs/<id>/retry-analysis re-runs only the analysis.',
      },
    });
  }
}

/** Recovery reported in business language; provider detail stays in the record. */
function summariseRecovery(attempts: RecoveryAttempt[]) {
  if (attempts.length === 0) return null;
  const ok = attempts.filter((a) => a.ok);
  return {
    attempted: attempts.length,
    recovered: ok.length,
    explanation:
      'A candidate cited a source that was not in the initial research set. ProspectIQ attempted targeted retrieval before deciding.',
    attempts,
  };
}

async function persistSources(ctx: PipelineContext): Promise<void> {
  const rows: Omit<SourceRow, 'id' | 'run_id'>[] = ctx.sources.map((s: NormalizedSource) => ({
    url: s.url,
    canonical_url: s.canonical_url,
    title: s.title,
    snippet: s.snippet.slice(0, 2000),
    source_type: s.source_type,
    credibility: s.credibility,
    published_date: s.published_date,
    retrieved_at: s.retrieved_at,
    fetch_status: s.fetch_status,
    providers: s.providers,
    found_via: s.categories,
    duplicate_count: s.duplicate_count,
    // Persist the extracted body so a retry reuses evidence already paid for.
    content: s.content,
    content_chars: s.content ? s.content.length : null,
  }));
  await replaceSources(ctx.runId, rows);
}

/**
 * Overall confidence blends identity certainty, hook quality and claim safety.
 * A conservative draft is capped low by construction: no hook means no
 * personalisation confidence to contribute.
 */
export function overallConfidence(ctx: PipelineContext): number {
  const identity = ctx.identity?.confidence ?? 0;
  const hook = ctx.hook ? (ctx.selection?.confidence ?? ctx.hook.composite_score) : 0;
  const validation = ctx.validation?.confidence ?? 0;
  return Math.round(0.3 * identity + 0.35 * hook + 0.35 * validation);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
