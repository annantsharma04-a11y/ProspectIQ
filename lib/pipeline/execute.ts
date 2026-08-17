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
} from '@/lib/supabase/queries';
import { newContext, StageAbort, type PipelineContext } from './context';
import type { NormalizedSource } from '@/lib/research/normalize';
import { resolveIdentity } from '@/lib/research/identity';
import { parseLinkedInUrl } from '@/lib/linkedin/url';
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
  isQualified,
  haltUnqualified,
  collectSignalsStage,
  evaluateSignalsStage,
  selectHookStage,
  generateMessageStage,
  validateClaimsStage,
  readyForReviewStage,
} from './stages';

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
    if (!isQualified(ctx)) {
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
    if (!isQualified(ctx)) {
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
