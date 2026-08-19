// Pipeline orchestration.
//
// Stages run in order and share an in-memory context. If a stage fails it has
// already recorded the failure on its own row and marked the run failed, so the
// orchestrator simply stops — no output is invented to fill the gap.

import {
  getRun,
  initStages,
  updateRun,
  listSources,
  getStage,
  getDraft,
  syncProspectFromRun,
} from '@/lib/supabase/queries';
import { newContext, StageAbort, type PipelineContext } from './context';
import { briefForContext } from '@/lib/generation/brief';
import { outreachContext } from '@/lib/generation/sender';
import { writeEmailFromBrief } from '@/lib/generation/write-email';
import {
  accountDecisionState,
  accountHeld,
  outreachAllowedByDecision,
} from '@/lib/qualification/account-decision';
import type { NormalizedSource } from '@/lib/research/normalize';
import { resolveIdentity } from '@/lib/research/identity';
import { parseLinkedInUrl } from '@/lib/linkedin/url';
import type { ScoredSignal } from '@/lib/signals/types';
import {
  validateInputStage,
  identifyProspectStage,
  researchProspectStage,
  researchCompanyStage,
  resolveCandidateStage,
  verifyIdentityStage,
  isIdentityVerified,
  haltUnverifiedIdentity,
  needsCandidateChoice,
  pauseForCandidateChoice,
  qualifyProspectStage,
  qualifyCompanyStage,
  findContactCandidatesStage,
  isQualified,
  haltUnqualified,
  awaitingAccountDecision,
  pauseForAccountDecision,
  haltAccountHeld,
  collectSignalsStage,
  evaluateSignalsStage,
  selectHookStage,
  generateMessageStage,
  solutionContext,
  proofContext,
  senderFor,
  validateClaimsStage,
  readyForReviewStage,
} from './stages';

/**
 * Refresh the prospect's "latest known state" from the run that just finished.
 *
 * Called on every terminal path — success, halt, park and failure alike — so the
 * prospect reflects whatever the run did establish. It never throws into the
 * pipeline: failing to update a rollup must not fail a run whose research is
 * already safely stored.
 */
async function syncProspect(runId: string): Promise<void> {
  try {
    const fresh = await getRun(runId);
    if (fresh) await syncProspectFromRun(fresh);
  } catch (err) {
    console.error(`[run ${runId}] prospect sync failed:`, err);
  }
}

export async function executePipeline(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const ctx = newContext(run);

  await initStages(runId);
  await updateRun(runId, {
    status: 'running',
    started_at: new Date().toISOString(),
    error: null,
    ai_error_type: null,
    completed_at: null,
  });

  try {
    await validateInputStage(ctx);
    await identifyProspectStage(ctx);

    // Which person did the caller mean? Several plausible answers means a human
    // decides, and the run pauses here rather than guessing.
    await resolveCandidateStage(ctx);
    if (needsCandidateChoice(ctx)) {
      await pauseForCandidateChoice(ctx);
      return;
    }

    // Identity gate: nothing downstream may run on an unverified identity.
    await verifyIdentityStage(ctx);
    if (!isIdentityVerified(ctx)) {
      await haltUnverifiedIdentity(ctx);
      return;
    }

    // Full research begins only once we know who we are researching.
    await researchProspectStage(ctx);
    await researchCompanyStage(ctx);

    // Qualification gate: decide whether we should be contacting this person
    // about this product at this company, before spending an analysis pass.
    await qualifyProspectStage(ctx);
    await qualifyCompanyStage(ctx);

    // Human account decision gate. A BORDERLINE company pauses here and asks a
    // person whether the account is worth pursuing — BEFORE contact discovery
    // and before any outreach work, so nothing is spent on an account nobody
    // has decided to pursue. Runs that need no decision fall straight through.
    if (awaitingAccountDecision(ctx)) {
      await pauseForAccountDecision(ctx);
      return;
    }
    if (accountHeld(ctx.qualification)) {
      await haltAccountHeld(ctx);
      return;
    }

    // Zero-cost no-op unless the company qualified and this person did not.
    await findContactCandidatesStage(ctx);
    if (!isQualified(ctx) || !outreachAllowedByDecision(ctx.qualification)) {
      await haltUnqualified(ctx);
      return;
    }

    await collectSignalsStage(ctx);
    await evaluateSignalsStage(ctx);
    await selectHookStage(ctx);
    await generateMessageStage(ctx);
    await validateClaimsStage(ctx);
    await readyForReviewStage(ctx);
  } catch (err) {
    // A StageAbort is already fully recorded (including the ai_analysis_pending
    // park); anything else still needs to land on the run row.
    if (err instanceof StageAbort) return;
    const message = err instanceof Error ? err.message : String(err);
    await updateRun(runId, {
      status: 'failed',
      error: message,
      completed_at: new Date().toISOString(),
    });
    throw err;
  } finally {
    // Runs on every exit: completion, early return from a gate, and failure.
    await syncProspect(runId);
  }
}

/**
 * Re-run everything for an existing run, reusing the same row and id.
 * Used when the research itself needs redoing.
 */
export async function retryRun(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  await executePipeline(runId);
}

/**
 * Retry ONLY the AI analysis for a run parked as `ai_analysis_pending`.
 *
 * The profile and every source were persisted before the model call, so this
 * rehydrates them from Postgres and resumes at the analysis stage. A quota
 * problem therefore costs one model call to recover from, not a whole new round
 * of Bright Data and search spend.
 */
export async function retryAnalysis(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const ctx = await rehydrate(runId);

  await updateRun(runId, {
    status: 'running',
    error: null,
    ai_error_type: null,
    completed_at: null,
  });

  try {
    if (!isQualified(ctx)) {
      await haltUnqualified(ctx);
      return;
    }
    await evaluateSignalsStage(ctx);
    await selectHookStage(ctx);
    await generateMessageStage(ctx);
    await validateClaimsStage(ctx);
    await readyForReviewStage(ctx);
  } catch (err) {
    if (err instanceof StageAbort) return;
    const message = err instanceof Error ? err.message : String(err);
    await updateRun(runId, {
      status: 'failed',
      error: message,
      completed_at: new Date().toISOString(),
    });
    throw err;
  } finally {
    // Runs on every exit: completion, early return from a gate, and failure.
    await syncProspect(runId);
  }
}

/**
 * Continue a run that was paused for identity confirmation.
 *
 * Research is already done and persisted, so this resumes at qualification with
 * the human-confirmed identity — no repeat provider spend.
 */
export async function resumeAfterIdentity(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!run.identity_verification?.selected_candidate_id) return;

  const ctx = await rehydrate(runId);

  // The human chose a candidate; that choice now has to survive verification.
  const v = run.identity_verification;
  const chosen = v.candidates.find((c) => c.id === v.selected_candidate_id) ?? null;
  ctx.identityCandidates = v.candidates;
  ctx.candidateSelection = {
    selected: chosen,
    selection_method: 'USER_CONFIRMED',
    needs_user_choice: false,
    plausible: v.candidates,
    reason: 'Identity chosen by a human; verifying that choice independently.',
  };

  await updateRun(runId, { status: 'running', error: null, completed_at: null });

  try {
    // Selection is a preference, not proof — verify before anything else runs.
    await verifyIdentityStage(ctx);
    if (!isIdentityVerified(ctx)) {
      await haltUnverifiedIdentity(ctx);
      return;
    }

    await researchProspectStage(ctx);
    await researchCompanyStage(ctx);
    await qualifyProspectStage(ctx);
    await qualifyCompanyStage(ctx);

    // Same human account decision gate as executePipeline — confirming an
    // identity must not walk a borderline account past the pause.
    if (awaitingAccountDecision(ctx)) {
      await pauseForAccountDecision(ctx);
      return;
    }
    if (accountHeld(ctx.qualification)) {
      await haltAccountHeld(ctx);
      return;
    }

    await findContactCandidatesStage(ctx);
    if (!isQualified(ctx) || !outreachAllowedByDecision(ctx.qualification)) {
      await haltUnqualified(ctx);
      return;
    }
    await collectSignalsStage(ctx);
    await evaluateSignalsStage(ctx);
    await selectHookStage(ctx);
    await generateMessageStage(ctx);
    await validateClaimsStage(ctx);
    await readyForReviewStage(ctx);
  } catch (err) {
    if (err instanceof StageAbort) return;
    const message = err instanceof Error ? err.message : String(err);
    await updateRun(runId, {
      status: 'failed',
      error: message,
      completed_at: new Date().toISOString(),
    });
    throw err;
  } finally {
    // Runs on every exit: completion, early return from a gate, and failure.
    await syncProspect(runId);
  }
}

/**
 * Continue a run a person decided to pursue.
 *
 * Everything up to and including qualification is already done and persisted,
 * so this rehydrates and resumes at the point the pause interrupted — no
 * repeated provider spend and no re-run of a completed stage.
 *
 * It grants no exemptions. The run re-enters the SAME sequence
 * `executePipeline` uses from this point, including `isQualified` — a person
 * continuing an account does not make an unqualified target qualified, and
 * every evidence, hook, solution and claim gate downstream is untouched.
 *
 * Which path it resumes into is decided by the matrix cell, not by the caller:
 * a borderline account with a well-evidenced contact continues to outreach,
 * while one with a borderline contact continues into contact discovery and
 * stops there for a human to pick someone better.
 */
export async function continueAfterAccountDecision(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  // Only ever acts on a decision already persisted by the API route. A run
  // that is not CONTINUED is left exactly as it is.
  if (accountDecisionState(run.qualification) !== 'CONTINUED') return;

  const ctx = await rehydrate(runId);
  await updateRun(runId, { status: 'running', error: null, completed_at: null });

  try {
    await findContactCandidatesStage(ctx);
    if (!isQualified(ctx) || !outreachAllowedByDecision(ctx.qualification)) {
      await haltUnqualified(ctx);
      return;
    }
    await collectSignalsStage(ctx);
    await evaluateSignalsStage(ctx);
    await selectHookStage(ctx);
    await generateMessageStage(ctx);
    await validateClaimsStage(ctx);
    await readyForReviewStage(ctx);
  } catch (err) {
    if (err instanceof StageAbort) return;
    const message = err instanceof Error ? err.message : String(err);
    await updateRun(runId, {
      status: 'failed',
      error: message,
      completed_at: new Date().toISOString(),
    });
    throw err;
  } finally {
    await syncProspect(runId);
  }
}

/**
 * Record that a person held a borderline account. Terminal.
 *
 * No stage runs, no model is called and no draft is written — the whole point
 * is that nothing further happens.
 */
export async function holdAfterAccountDecision(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (accountDecisionState(run.qualification) !== 'HELD') return;

  const ctx = await rehydrate(runId);
  try {
    await haltAccountHeld(ctx);
  } finally {
    await syncProspect(runId);
  }
}

/**
 * Regenerate ONLY the outreach message on a run that already has a verified
 * hook and a draft — new wording, same evidence, same hook. No research, no
 * qualification, no re-derivation of candidate signals: those are exactly
 * what `retryAnalysis()` above redoes, and this deliberately does not.
 *
 * Ends by running the SAME voice/personalization checks and the SAME
 * validate_claims stage as a normal run — a user-requested rewrite gets no
 * less scrutiny than the original draft did.
 */
export async function regenerateMessageOnly(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const previousStatus = run.status;

  const ctx = await rehydrateForMessageRegeneration(runId);

  await updateRun(runId, { status: 'running', error: null, ai_error_type: null, completed_at: null });

  try {
    if (!ctx.hook) {
      throw new Error('No verified hook on this run — there is nothing to regenerate a message from.');
    }

    // A rewrite, not a re-analysis: the run's settled brief (same hook, same
    // workflow, same proof) plus an instruction to find new wording. No second
    // research pass, and no route to a different business angle.
    const brief = briefForContext(ctx, solutionContext(ctx), proofContext(ctx));
    if (!brief) {
      throw new Error('This run has no settled email brief, so there is nothing to regenerate from.');
    }

    const sender = senderFor(ctx);
    const written = await writeEmailFromBrief({
      brief,
      senderName: sender.name,
      senderCompany: sender.company,
      outreachContext: outreachContext(sender),
      sources: ctx.sources,
      directive:
        'Write a genuinely different version of this outreach message: new phrasing, new structure, ' +
        'a different opening line from before. Stay grounded in the same verified observation and keep ' +
        'every fact accurate — do not add or drop claims.',
    });

    // Written before the stage begins, so this failure never marks the stage
    // (and therefore the run) failed. The existing draft is untouched.
    if (!written) {
      throw new Error('The model could not produce a new draft. The existing message is unchanged.');
    }
    ctx.pendingMessage = written;

    // Same save-and-check path a normal run uses: personalization/opener/voice/
    // quality checks, persist the draft, validate its claims, then finalize.
    await generateMessageStage(ctx);
    await validateClaimsStage(ctx);
    await readyForReviewStage(ctx);
  } catch (err) {
    // A StageAbort means a stage already recorded its own failure and set the
    // run status — nothing more to do. Anything else is ours to report, and we
    // restore the run to whatever it was rather than degrading it to 'failed'
    // over what is, from the account's perspective, a low-stakes rewrite.
    if (err instanceof StageAbort) return;
    const message = err instanceof Error ? err.message : String(err);
    await updateRun(runId, {
      status: previousStatus,
      error: message,
      completed_at: new Date().toISOString(),
    });
    throw err;
  } finally {
    await syncProspect(runId);
  }
}

/** Can this run's analysis be retried without redoing the research? */
export async function canRetryAnalysis(runId: string): Promise<boolean> {
  const run = await getRun(runId);
  if (!run) return false;
  if (run.status !== 'ai_analysis_pending') return false;
  const collected = await getStage(runId, 'collect_signals');
  return collected?.status === 'complete' || collected?.status === 'degraded';
}

/**
 * Rebuild a pipeline context from what is already in the database.
 * Only the fields the analysis stage onward actually read are restored.
 */
async function rehydrate(runId: string): Promise<PipelineContext> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const ctx = newContext(run);
  const parsed = parseLinkedInUrl(run.linkedin_url);
  if (parsed.ok) {
    ctx.slug = parsed.slug;
    ctx.normalizedUrl = parsed.normalized_url;
    ctx.nameHint = parsed.name_hint;
  }

  ctx.profile = run.linkedin_profile;
  ctx.qualification = run.qualification;
  ctx.identityVerification = run.identity_verification;
  ctx.identity = resolveIdentity(run.linkedin_profile, {
    slug: ctx.slug,
    nameHint: ctx.nameHint,
    userName: run.input_name,
    userCompany: run.input_company,
    userTitle: run.input_title,
  });

  if (run.profile_access) {
    ctx.linkedinAccess = {
      profile: run.linkedin_profile,
      access: run.profile_access,
      meta: null,
      error_code: null,
      duration_ms: 0,
    };
  }

  const rows = await listSources(runId);
  ctx.sources = rows.map(
    (r): NormalizedSource => ({
      url: r.url,
      canonical_url: r.canonical_url,
      title: r.title ?? '',
      snippet: r.snippet ?? '',
      source_type: (r.source_type ?? 'web') as NormalizedSource['source_type'],
      credibility: Number(r.credibility ?? 0.45),
      published_date: r.published_date,
      providers: r.providers ?? [],
      queries: [],
      categories: r.found_via ?? [],
      duplicate_count: r.duplicate_count,
      retrieved_at: r.retrieved_at,
      // Stored page bodies are restored, so a retry keeps FULL evidence
      // instead of silently degrading to snippets.
      content: r.content,
      fetch_status: (r.fetch_status ?? 'snippet_only') as NormalizedSource['fetch_status'],
    }),
  );

  return ctx;
}

/**
 * Reconcile `ctx.identity`'s resolved/ambiguous status with the run's OWN
 * persisted identity verification, for the message-only regenerate path only.
 *
 * `rehydrate()` sets `ctx.identity` by calling `resolveIdentity()` on nothing
 * but the stored LinkedIn profile and typed hints (see above). That function
 * has no way to know a run without either was still settled — VERIFIED — by
 * the full identity-verification subsystem (public-web corroboration,
 * `verifyIdentityStage`), whose result is what actually decided this run was
 * fit for review in the first place. Left alone, a hint-free, profile-less
 * run's fresh `resolveIdentity()` guess reports `resolved: false`, and
 * `readyForReviewStage`'s `needsManual` check reads exactly that field —
 * incorrectly sending an already-VERIFIED run back to manual review on every
 * regenerate, even though nothing about who this person is has changed.
 *
 * This is intentionally narrow: only `resolved`/`ambiguous` (and the identity
 * fields already carried on `IdentityVerification.resolved`) are reconciled,
 * and only for this one call path. It does not touch how identity is
 * established in the first place — `verifyIdentityStage`, `resolveIdentity()`,
 * and every other reader of `ctx.identity` are untouched.
 */
function reconcileIdentityForRegeneration(ctx: PipelineContext): void {
  const verification = ctx.identityVerification;
  if (!verification || !ctx.identity) return;

  if (verification.status === 'VERIFIED' || verification.status === 'PARTIAL') {
    ctx.identity = {
      ...ctx.identity,
      resolved: true,
      ambiguous: false,
      full_name: verification.resolved.name ?? ctx.identity.full_name,
      role: verification.resolved.role ?? ctx.identity.role,
      company: verification.resolved.company ?? ctx.identity.company,
      location: verification.resolved.location ?? ctx.identity.location,
      confidence: verification.confidence,
    };
  } else if (verification.status === 'AMBIGUOUS') {
    // Still genuinely unresolved — a human never confirmed who this is (or
    // this reconciliation would not be looking at an AMBIGUOUS record at
    // all), so regeneration must keep sending it to manual review.
    ctx.identity = { ...ctx.identity, ambiguous: true };
  } else if (verification.status === 'FAILED') {
    ctx.identity = { ...ctx.identity, resolved: false };
  }
}

/**
 * `rehydrate()` plus the ALREADY-SELECTED hook — for a message-only
 * regenerate, which must not re-derive it from a fresh model pass the way
 * `retryAnalysis()`'s `evaluateSignalsStage()` would.
 *
 * The hook is restored from the persisted `select_hook` stage's own output,
 * not the `signals` table — that table does not store `signal_level` /
 * `role_relevance` / `outreach_rationale` (a pre-existing schema gap, out of
 * scope here), while `select_hook`'s output already embeds every field those
 * checks actually read (see selectHookStage's `output.selected`). `ctx.ranked`
 * and `ctx.analysis` are filled in only with fields something downstream of
 * this path genuinely reads (verified against generateMessageStage,
 * regenerateMessage, validateClaims and readyForReviewStage directly) — never
 * guessed values presented to the user as if they were real research output.
 */
async function rehydrateForMessageRegeneration(runId: string): Promise<PipelineContext> {
  const ctx = await rehydrate(runId);
  reconcileIdentityForRegeneration(ctx);

  const hookStage = await getStage(runId, 'select_hook');
  const hookOutput = hookStage?.output as Record<string, unknown> | null;
  const selected = (hookOutput?.selected as Record<string, unknown> | null) ?? null;
  if (!selected) return ctx; // ctx.hook stays null; the caller reports this as the precondition failure it is

  const draft = await getDraft(runId);
  const genStage = await getStage(runId, 'generate_message');
  const genOutput = genStage?.output as Record<string, unknown> | null;

  const hook: ScoredSignal = {
    signal: String(selected.signal ?? ''),
    why_it_matters: String(selected.why_it_matters ?? ''),
    // Not read anywhere in this path (only used upstream, during signal
    // extraction/ranking, which this path deliberately does not redo).
    category: 'other',
    source_title: String(selected.source_title ?? ''),
    source_url: String(selected.source_url ?? ''),
    published_date: (selected.published_date as string | null) ?? null,
    supporting_quote: String(selected.supporting_quote ?? ''),
    relevance_score: 0,
    specificity_score: 0,
    confidence_score: 0,
    conflicts_with: null,
    signal_level: selected.signal_level === 'COMPANY' ? 'COMPANY' : 'PERSON',
    role_relevance: (selected.role_relevance as string | null) ?? null,
    outreach_rationale: (selected.outreach_rationale as string | null) ?? null,
    related_capability_id: null,
    source_type: 'web',
    evidence_level: String(selected.evidence_level ?? 'SNIPPET'),
    credibility_score: 0,
    recency_score: 0,
    corroboration_count: 0,
    composite_score: Number(selected.composite_score ?? 0),
    retrieved_at: (selected.published_date as string | null) ?? new Date().toISOString(),
  };

  ctx.hook = hook;
  // The only other consumer of `ctx.ranked` on this path is validateClaims(),
  // which declares an `evidence` parameter but never actually reads it — see
  // lib/validation/factcheck.ts. The hook itself is the one genuine piece of
  // evidence this path has without re-running signal extraction.
  ctx.ranked = [hook];
  ctx.hookSignalId = draft?.hook_signal_id ?? null;

  ctx.analysis = {
    // Not read anywhere downstream of this path — analyzeProspect() is called
    // with the profile/sources/hints directly, not through ctx.analysis.prospect.
    prospect: {
      name: null,
      headline: null,
      currentCompany: null,
      currentRole: null,
      location: null,
      identityConfidence: 0,
      identityNotes: null,
      ambiguous: false,
      employerChangeNote: null,
    },
    summary: '',
    careerInsights: [],
    companyContext: [],
    personalizationHooks: [],
    painPointsOrInterests: [],
    selectedHookIndex: 0,
    hookReason: '',
    alternativesConsidered: [],
    insufficientEvidence: false,
    insufficientReason: null,
    // Real, previously-generated values, carried forward from the run's own
    // prior output — a message-only regenerate keeps the same angle and
    // subject line unless the fresh rewrite changes them.
    outreachAngle: String(genOutput?.outreach_angle ?? ''),
    suggestedSubject: String(genOutput?.subject ?? draft?.subject ?? ''),
    suggestedMessage: draft?.message_text ?? '',
    // Overwritten unconditionally by regenerateMessage() on success; only
    // matters here as a safe fallback if that call is never reached.
    messageClaims: [],
    confidence: Number(hookOutput?.confidence ?? 0),
    informationRequests: (genOutput?.information_requests as string[] | undefined) ?? [],
  };

  return ctx;
}
