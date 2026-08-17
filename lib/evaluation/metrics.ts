// Evaluation metrics.
//
// Every function here is pure: input rows in, numbers out. Nothing queries, and
// nothing estimates. If the schema cannot support a metric it is reported as
// unavailable (see unavailableMetrics) rather than approximated — a plausible
// invented number is worse than an honest gap, because it gets acted on.
//
// Denominators are the whole game. Each rate carries its own definition string,
// which the UI renders next to the number, so no figure is readable without its
// denominator.

import type { CheckedClaim } from '@/lib/validation/factcheck';
import type { RunRow, StageName } from '@/lib/types';
import {
  inWindow,
  rate,
  type EvaluationInput,
  type FailureBucket,
  type FunnelStep,
  type Rate,
  type StageTiming,
  type UnavailableMetric,
  type Window,
} from './types';

// ─── shared predicates ───────────────────────────────────────────────────────

/** A run that reached a terminal, non-failed state. */
const COMPLETED = new Set(['ready_for_review', 'needs_manual_review', 'approved', 'rejected']);
/** Still moving. `ai_analysis_pending` is parked awaiting a retry, not finished. */
const PROCESSING = new Set(['queued', 'running', 'ai_analysis_pending']);
/** A stage actually executed (as opposed to pending or skipped by a gate). */
const EXECUTED = new Set(['complete', 'degraded', 'failed']);

export function isCompleted(r: RunRow): boolean {
  return COMPLETED.has(r.status);
}
export function isFailed(r: RunRow): boolean {
  return r.status === 'failed';
}
export function isProcessing(r: RunRow): boolean {
  return PROCESSING.has(r.status);
}

/** Runs submitted inside the window. See Window docs for why created_at. */
export function runsInWindow(input: EvaluationInput, w: Window): RunRow[] {
  return input.runs.filter((r) => inWindow(r.created_at, w));
}

/** Did this run execute the named stage at all? */
function reached(input: EvaluationInput, runIds: Set<string>, stage: StageName): Set<string> {
  const out = new Set<string>();
  for (const s of input.stages) {
    if (s.stage_name === stage && runIds.has(s.run_id) && EXECUTED.has(s.status)) out.add(s.run_id);
  }
  return out;
}

// ─── volume ──────────────────────────────────────────────────────────────────

export interface VolumeMetrics {
  /** prospect-level: distinct people with at least one run in the window. */
  activeProspects: number;
  /** prospect-level: prospects whose record was created in the window. */
  prospectsAdded: number;
  /** prospect-level: every prospect on record, ignoring the window. */
  totalProspects: number;
  /** run-level. */
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  processingRuns: number;
  /** run-level ÷ prospect-level. Null when no prospect was active. */
  runsPerProspect: number | null;
}

export function volumeMetrics(input: EvaluationInput, w: Window): VolumeMetrics {
  const runs = runsInWindow(input, w);
  const active = new Set(runs.map((r) => r.prospect_id).filter(Boolean) as string[]);

  return {
    activeProspects: active.size,
    prospectsAdded: input.prospects.filter((p) => inWindow(p.created_at, w)).length,
    totalProspects: input.prospects.length,
    totalRuns: runs.length,
    completedRuns: runs.filter(isCompleted).length,
    failedRuns: runs.filter(isFailed).length,
    processingRuns: runs.filter(isProcessing).length,
    runsPerProspect: active.size > 0 ? Math.round((runs.length / active.size) * 100) / 100 : null,
  };
}

// ─── identity ────────────────────────────────────────────────────────────────

export interface IdentityMetrics {
  verified: number;
  partial: number;
  ambiguous: number;
  failed: number;
  /** Runs that executed the verify_identity stage. */
  reached: number;
  verificationRate: Rate;
  /** Of verified runs, how many needed a human to pick the candidate. */
  userConfirmed: number;
  automatic: number;
}

export function identityMetrics(input: EvaluationInput, w: Window): IdentityMetrics {
  const runs = runsInWindow(input, w);
  const ids = new Set(runs.map((r) => r.id));
  const reachedIds = reached(input, ids, 'verify_identity');
  const scoped = runs.filter((r) => reachedIds.has(r.id));

  const count = (s: string) => scoped.filter((r) => r.identity_status === s).length;
  const verified = count('VERIFIED');

  return {
    verified,
    partial: count('PARTIAL'),
    ambiguous: count('AMBIGUOUS'),
    failed: count('FAILED'),
    reached: reachedIds.size,
    verificationRate: rate(
      verified,
      reachedIds.size,
      'VERIFIED runs ÷ runs that executed verify_identity. Runs halted earlier are excluded from the denominator.',
    ),
    userConfirmed: scoped.filter((r) => r.identity_resolution === 'USER_CONFIRMED').length,
    automatic: scoped.filter((r) => r.identity_resolution === 'AUTOMATIC').length,
  };
}

// ─── qualification ───────────────────────────────────────────────────────────

export interface QualificationMetrics {
  qualified: number;
  borderline: number;
  notQualified: number;
  /** Reached the stage but produced no classification — never counted as a "no". */
  unknown: number;
  reached: number;
  qualificationRate: Rate;
  prospectFit: Record<string, number>;
  companyFit: Record<string, number>;
  /** OBSERVED / INFERRED / UNKNOWN evidence basis behind company fit. */
  companyEvidenceBasis: Record<string, number>;
}

export function qualificationMetrics(input: EvaluationInput, w: Window): QualificationMetrics {
  const runs = runsInWindow(input, w);
  const ids = new Set(runs.map((r) => r.id));
  // Either qualify stage executing means the run reached qualification.
  const reachedIds = new Set([
    ...reached(input, ids, 'qualify_prospect'),
    ...reached(input, ids, 'qualify_company'),
  ]);
  const scoped = runs.filter((r) => reachedIds.has(r.id));

  const count = (s: string) => scoped.filter((r) => r.qualification_status === s).length;
  const qualified = count('QUALIFIED');

  const prospectFit: Record<string, number> = {};
  const companyFit: Record<string, number> = {};
  const companyEvidenceBasis: Record<string, number> = {};
  for (const r of scoped) {
    const q = r.qualification;
    if (!q) continue;
    bump(prospectFit, q.prospect_fit?.classification ?? 'UNKNOWN');
    bump(companyFit, q.company_fit?.classification ?? 'UNKNOWN');
    bump(companyEvidenceBasis, q.company_fit?.evidence_basis ?? 'UNKNOWN');
  }

  return {
    qualified,
    borderline: count('BORDERLINE'),
    notQualified: count('NOT_QUALIFIED'),
    // UNKNOWN is its own bucket. Folding it into NOT_QUALIFIED would report
    // "we decided against this target" when the truth is "we never decided".
    unknown: scoped.filter((r) => !r.qualification_status).length,
    reached: reachedIds.size,
    qualificationRate: rate(
      qualified,
      reachedIds.size,
      'QUALIFIED runs ÷ runs that executed a qualification stage. UNKNOWN stays in the denominator but is never counted as disqualified.',
    ),
    prospectFit,
    companyFit,
    companyEvidenceBasis,
  };
}

// ─── evidence ────────────────────────────────────────────────────────────────

export interface EvidenceMetrics {
  proposed: number;
  accepted: number;
  rejected: number;
  evidenceBackedRate: Rate;
  /** Persisted signals carrying a verbatim supporting quote. */
  withQuote: number;
  persisted: number;
  citationRate: Rate;
  runsWithSignal: number;
}

export function evidenceMetrics(input: EvaluationInput, w: Window): EvidenceMetrics {
  const runs = runsInWindow(input, w);
  const ids = new Set(runs.map((r) => r.id));

  const proposals = input.proposals.filter((p) => ids.has(p.run_id));
  const accepted = proposals.reduce((n, p) => n + p.ranked, 0);
  const rejected = proposals.reduce((n, p) => n + p.rejected, 0);

  const signals = input.signals.filter((s) => ids.has(s.run_id));
  const withQuote = signals.filter((s) => (s.supporting_quote ?? '').trim().length > 0).length;

  return {
    proposed: accepted + rejected,
    accepted,
    rejected,
    evidenceBackedRate: rate(
      accepted,
      accepted + rejected,
      'Accepted verified signals ÷ proposed signals. A signal is never counted as accepted merely because the model proposed it.',
    ),
    withQuote,
    persisted: signals.length,
    citationRate: rate(
      withQuote,
      signals.length,
      'Accepted signals with a verified verbatim quote ÷ accepted signals. Enforced in code, so anything below 100% is a bug.',
    ),
    runsWithSignal: new Set(signals.map((s) => s.run_id)).size,
  };
}

// ─── hooks ───────────────────────────────────────────────────────────────────

export interface HookMetrics {
  runsReachingSelection: number;
  selected: number;
  insufficientEvidence: number;
  rejectedCandidates: number;
  acceptanceRate: Rate;
  byCategory: Record<string, number>;
}

export function hookMetrics(input: EvaluationInput, w: Window): HookMetrics {
  const runs = runsInWindow(input, w);
  const ids = new Set(runs.map((r) => r.id));
  const hooks = input.hooks.filter((h) => ids.has(h.run_id));

  const selected = hooks.filter((h) => h.selected).length;
  const byCategory: Record<string, number> = {};
  for (const s of input.signals) {
    if (ids.has(s.run_id) && s.selected_as_hook) bump(byCategory, s.category ?? 'uncategorised');
  }

  return {
    runsReachingSelection: hooks.length,
    selected,
    insufficientEvidence: hooks.filter((h) => h.insufficient_evidence).length,
    rejectedCandidates: hooks.reduce((n, h) => n + h.rejected_candidates, 0),
    acceptanceRate: rate(
      selected,
      hooks.length,
      'Runs where a hook cleared the quality gate ÷ runs that executed hook selection. "No verified hook" counts against it by design.',
    ),
    byCategory,
  };
}

// ─── messages and review ─────────────────────────────────────────────────────

export interface MessageMetrics {
  generated: number;
  personalized: number;
  conservative: number;
  awaitingReview: number;
  approved: number;
  edited: number;
  rejected: number;
  reviewed: number;
  approvalRate: Rate;
  editRate: Rate;
  validationStatus: Record<string, number>;
}

export function messageMetrics(input: EvaluationInput, w: Window): MessageMetrics {
  const runs = runsInWindow(input, w);
  const ids = new Set(runs.map((r) => r.id));
  const drafts = input.drafts.filter((d) => ids.has(d.run_id));

  const act = (a: string) => drafts.filter((d) => d.reviewer_action === a).length;
  const approved = act('approved');
  const edited = act('edited');
  const rejected = act('rejected');
  const reviewed = approved + edited + rejected;

  const validationStatus: Record<string, number> = {};
  for (const d of drafts) bump(validationStatus, d.validation_status ?? 'not validated');

  return {
    generated: drafts.length,
    personalized: drafts.filter((d) => d.mode === 'personalized').length,
    conservative: drafts.filter((d) => d.mode === 'conservative').length,
    awaitingReview: drafts.filter((d) => !d.reviewer_action).length,
    approved,
    edited,
    rejected,
    reviewed,
    approvalRate: rate(
      approved,
      reviewed,
      'Approved drafts ÷ drafts a human has reviewed. Drafts awaiting review are excluded, not counted as rejections.',
    ),
    // Edits ARE recorded (drafts.reviewer_action = "edited" plus edited_text),
    // so this is a real rate, not an inference from timestamps.
    editRate: rate(
      edited,
      reviewed,
      'Drafts a reviewer edited before accepting ÷ drafts reviewed. Recorded at review time, never inferred.',
    ),
    validationStatus,
  };
}

// ─── claim validation ────────────────────────────────────────────────────────

export interface ClaimMetrics {
  total: number;
  byType: Record<string, number>;
  byVerdict: Record<string, number>;
  /** Claims that assert something about the world and so need external evidence. */
  factual: number;
  factualSupported: number;
  factualUnsupported: number;
  factualUncertain: number;
  passRate: Rate;
  /** Claims valid without external evidence (sender offering, generic phrasing). */
  allowedByType: number;
  /** Older drafts stored claims before types existed; counted, never guessed at. */
  uncategorised: number;
}

export function claimMetrics(input: EvaluationInput, w: Window): ClaimMetrics {
  const runs = runsInWindow(input, w);
  const ids = new Set(runs.map((r) => r.id));

  const claims: CheckedClaim[] = [];
  for (const d of input.drafts) {
    if (ids.has(d.run_id) && d.claims) claims.push(...d.claims);
  }

  const byType: Record<string, number> = {};
  const byVerdict: Record<string, number> = {};
  for (const c of claims) {
    bump(byType, c.type ?? 'uncategorised');
    bump(byVerdict, c.verdict ?? 'unknown');
  }

  // A claim needs evidence when the checker said so. Generic outreach phrasing
  // and statements about the sender's own offering are ALLOWED by type — they
  // are not failed factual claims and must not drag the pass rate down.
  const factualClaims = claims.filter((c) => c.requires_external_evidence === true);
  const supported = factualClaims.filter((c) => c.verdict === 'SUPPORTED').length;

  return {
    total: claims.length,
    byType,
    byVerdict,
    factual: factualClaims.length,
    factualSupported: supported,
    factualUnsupported: factualClaims.filter((c) => c.verdict === 'UNSUPPORTED').length,
    factualUncertain: factualClaims.filter((c) => c.verdict === 'UNCERTAIN').length,
    passRate: rate(
      supported,
      factualClaims.length,
      'SUPPORTED claims ÷ claims requiring external evidence. Claims allowed by type, such as sender offering or generic phrasing, are excluded from both sides.',
    ),
    allowedByType: claims.filter((c) => c.requires_external_evidence === false).length,
    uncategorised: claims.filter((c) => c.requires_external_evidence == null).length,
  };
}

// ─── funnel ──────────────────────────────────────────────────────────────────

export function funnel(input: EvaluationInput, w: Window): FunnelStep[] {
  const runs = runsInWindow(input, w);
  const ids = new Set(runs.map((r) => r.id));

  // Gate steps are measured by STAGE PROGRESSION, not by the gate's verdict
  // column. The pipeline only executes a stage if the preceding gate passed, so
  // "executed research_prospect" IS "cleared the identity gate" — and unlike
  // reading identity_status, it stays true for runs recorded before that column
  // existed. Using the verdict column instead produced a funnel where a later
  // step exceeded its predecessor by 5x, which is not a funnel.
  const validated = reached(input, ids, 'validate_input').size;
  const pastIdentity = reached(input, ids, 'research_prospect').size;
  const researched = reached(input, ids, 'research_company').size;
  const pastQualification = reached(input, ids, 'collect_signals').size;
  const withSignal = new Set(
    input.signals.filter((s) => ids.has(s.run_id)).map((s) => s.run_id),
  ).size;
  // The tail of the funnel tracks the EVIDENCE-LED path: runs that produced a
  // verified signal and then a message from it. A conservative draft can be
  // written without a verified hook, so counting every draft here would make
  // "message generated" exceed "evidence-backed signal" — a funnel step larger
  // than its predecessor. Those drafts are still reported in full in the
  // message panel; they are simply not on this path.
  const signalRunIds = new Set(input.signals.filter((s) => ids.has(s.run_id)).map((s) => s.run_id));
  const drafts = input.drafts.filter((d) => ids.has(d.run_id) && signalRunIds.has(d.run_id));
  const generated = new Set(drafts.map((d) => d.run_id)).size;
  const claimsValidated = new Set(
    drafts.filter((d) => d.validation_status === 'pass' || d.validation_status === 'revised')
      .map((d) => d.run_id),
  ).size;
  const approved = new Set(
    drafts.filter((d) => d.reviewer_action === 'approved').map((d) => d.run_id),
  ).size;

  const steps: { label: string; count: number; definition: string }[] = [
    { label: 'Submitted', count: runs.length, definition: 'Runs created in the window.' },
    { label: 'Validated', count: validated, definition: 'Executed validate_input.' },
    {
      label: 'Cleared identity gate',
      count: pastIdentity,
      definition:
        'Executed research_prospect, the first stage after the identity gate. Progression, not verdict — see the Identity panel for the VERIFIED/PARTIAL/AMBIGUOUS split.',
    },
    { label: 'Research completed', count: researched, definition: 'Executed research_company.' },
    {
      label: 'Cleared qualification gate',
      count: pastQualification,
      definition:
        'Executed collect_signals, the first stage after the qualification gate. See the Qualification panel for the QUALIFIED/BORDERLINE/NOT_QUALIFIED split.',
    },
    { label: 'Evidence-backed signal', count: withSignal, definition: 'At least one persisted, quote-backed signal.' },
    {
      label: 'Message generated',
      count: generated,
      definition:
        'A draft was written for a run that produced a verified signal. Conservative drafts written without a verified hook are excluded from this path and reported in the message panel instead.',
    },
    { label: 'Claims validated', count: claimsValidated, definition: 'Draft validation passed or was revised to pass (not flagged).' },
    {
      label: 'Approved after human review',
      count: approved,
      definition:
        'A reviewer approved the draft. Zero here means no draft has been reviewed yet, not that the pipeline failed to produce one.',
    },
  ];

  const start = steps[0].count;
  return steps.map((s, i) => ({
    ...s,
    ofPrevious: i === 0 ? null : pct(s.count, steps[i - 1].count),
    ofStart: i === 0 ? null : pct(s.count, start),
  }));
}

// ─── failure analysis ────────────────────────────────────────────────────────

/**
 * Why runs did not reach a human-reviewable draft.
 *
 * Only categories the stored data can actually distinguish appear, and each run
 * lands in exactly one bucket, checked in pipeline order so the EARLIEST reason
 * wins — a run halted at identity is not also counted as "no evidence".
 */
export function failureAnalysis(input: EvaluationInput, w: Window): FailureBucket[] {
  const runs = runsInWindow(input, w);
  const draftRuns = new Set(input.drafts.map((d) => d.run_id));

  const buckets = new Map<string, { count: number; definition: string }>();
  const add = (label: string, definition: string) => {
    const b = buckets.get(label) ?? { count: 0, definition };
    b.count++;
    buckets.set(label, b);
  };

  let considered = 0;
  for (const r of runs) {
    if (draftRuns.has(r.id) && !isFailed(r)) continue; // reached a draft: not a failure
    if (isProcessing(r)) continue; // still running: not yet a failure
    considered++;

    if (r.ai_error_type) {
      add(`AI analysis — ${r.ai_error_type.replace(/_/g, ' ')}`, 'run.ai_error_type recorded by the model client.');
    } else if (r.status === 'failed' && /search provider|tavily|brave/i.test(r.error ?? '')) {
      add('Search provider failure', 'Run failed with a search-provider error.');
    } else if (r.status === 'failed') {
      const stage = (r.error ?? '').split(':')[0]?.replace(/_/g, ' ') || 'unknown stage';
      add(`Run error — ${stage}`, 'Run status = failed; bucketed by the stage named in the error.');
    } else if (r.linkedin_access_status === 'blocked' || r.linkedin_access_status === 'unavailable') {
      if (r.identity_status && r.identity_status !== 'VERIFIED') {
        add(`Identity ${r.identity_status.toLowerCase()}`, 'Halted at the identity gate.');
      } else {
        add('Profile unavailable', 'The LinkedIn provider returned no usable profile.');
      }
    } else if (r.identity_status && r.identity_status !== 'VERIFIED') {
      add(`Identity ${r.identity_status.toLowerCase()}`, 'Halted at the identity gate.');
    } else if (r.qualification_status && r.qualification_status !== 'QUALIFIED') {
      add(
        r.qualification_status === 'BORDERLINE' ? 'Borderline target fit' : 'Target did not qualify',
        'Halted at the qualification gate.',
      );
    } else if (r.insufficient_evidence) {
      add('Insufficient evidence for a hook', 'No signal cleared the evidence and quality gates.');
    } else {
      add('Did not reach a draft', 'Ended without a draft and without a recorded reason.');
    }
  }

  return [...buckets.entries()]
    .map(([label, b]) => ({
      label,
      count: b.count,
      share: pct(b.count, considered) ?? 0,
      definition: b.definition,
    }))
    .sort((a, b) => b.count - a.count);
}

// ─── reliability ─────────────────────────────────────────────────────────────

export interface ReliabilityMetrics {
  successRate: Rate;
  failureRate: Rate;
  /** Runs with both timestamps; the denominator for the duration figures. */
  timed: number;
  avgMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  slowestStages: StageTiming[];
}

export function reliabilityMetrics(input: EvaluationInput, w: Window): ReliabilityMetrics {
  const runs = runsInWindow(input, w);
  const finished = runs.filter((r) => isCompleted(r) || isFailed(r));
  const completed = finished.filter(isCompleted).length;

  const durations = runs
    .filter((r) => r.started_at && r.completed_at)
    .map((r) => new Date(r.completed_at!).getTime() - new Date(r.started_at!).getTime())
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);

  const ids = new Set(runs.map((r) => r.id));
  const byStage = new Map<StageName, number[]>();
  for (const s of input.stages) {
    if (!ids.has(s.run_id) || s.duration_ms == null) continue;
    const list = byStage.get(s.stage_name as StageName) ?? [];
    list.push(s.duration_ms);
    byStage.set(s.stage_name as StageName, list);
  }

  const slowestStages: StageTiming[] = [...byStage.entries()]
    .map(([stage, ms]) => {
      const sorted = [...ms].sort((a, b) => a - b);
      return {
        stage,
        runs: sorted.length,
        avgMs: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
        medianMs: percentile(sorted, 50)!,
        p95Ms: percentile(sorted, 95)!,
      };
    })
    .sort((a, b) => b.avgMs - a.avgMs);

  return {
    successRate: rate(
      completed,
      finished.length,
      'Completed runs ÷ finished runs. In-flight runs are excluded from both sides.',
    ),
    failureRate: rate(
      finished.length - completed,
      finished.length,
      'Failed runs ÷ finished runs.',
    ),
    timed: durations.length,
    avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    medianMs: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    slowestStages,
  };
}

// ─── providers ───────────────────────────────────────────────────────────────

export interface ProviderMetrics {
  /** Bright Data: profile retrieval outcomes, from the run row. */
  profileAttempted: number;
  profileAccessible: number;
  profileUnavailable: number;
  profileBlocked: number;
  profileSuccessRate: Rate;
  /** Search attribution, by provider, counted over retrieved sources. */
  searchAttribution: Record<string, number>;
  /** Page retrieval outcomes (full text vs snippet-only vs failed fetch). */
  fetchStatus: Record<string, number>;
  fullTextRate: Rate;
  /** Model failures, by classified error type. Empty means none recorded. */
  modelErrors: Record<string, number>;
  modelErrorRate: Rate;
}

export function providerMetrics(input: EvaluationInput, w: Window): ProviderMetrics {
  const runs = runsInWindow(input, w);

  const attempted = runs.filter(
    (r) => r.linkedin_access_status && r.linkedin_access_status !== 'not_attempted',
  );
  const accessible = attempted.filter((r) => r.linkedin_access_status === 'accessible').length;

  const modelErrors: Record<string, number> = {};
  for (const r of runs) if (r.ai_error_type) bump(modelErrors, r.ai_error_type);

  const scraped = input.sourceFetchStatus.scraped ?? 0;
  const totalFetch = Object.values(input.sourceFetchStatus).reduce((a, b) => a + b, 0);

  return {
    profileAttempted: attempted.length,
    profileAccessible: accessible,
    profileUnavailable: attempted.filter((r) => r.linkedin_access_status === 'unavailable').length,
    profileBlocked: attempted.filter((r) => r.linkedin_access_status === 'blocked').length,
    profileSuccessRate: rate(
      accessible,
      attempted.length,
      'Runs with a usable profile ÷ runs that attempted retrieval.',
    ),
    searchAttribution: input.sourceProviders,
    fetchStatus: input.sourceFetchStatus,
    fullTextRate: rate(
      scraped,
      totalFetch,
      'Sources with full page text ÷ retrieved sources. The rest are snippet-only, which is weaker evidence.',
    ),
    modelErrors,
    modelErrorRate: rate(
      Object.values(modelErrors).reduce((a, b) => a + b, 0),
      runs.length,
      'Runs with a classified model error ÷ runs in the window.',
    ),
  };
}

// ─── trends ──────────────────────────────────────────────────────────────────

export interface Trend {
  label: string;
  current: number | null;
  previous: number | null;
  /** Percentage-point change for rates, percent change for durations. */
  delta: number | null;
  unit: 'pp' | '%';
  /** Lower is better (durations). */
  inverted?: boolean;
}

/**
 * Compare the selected window with the immediately preceding one of equal
 * length. Returns null when the previous window holds no runs — "no change"
 * and "no data" are different claims.
 */
export function trends(input: EvaluationInput, current: Window, previous: Window | null): Trend[] | null {
  if (!previous) return null;
  if (runsInWindow(input, previous).length === 0) return null;

  const c = { id: identityMetrics(input, current), q: qualificationMetrics(input, current), e: evidenceMetrics(input, current), r: reliabilityMetrics(input, current), m: messageMetrics(input, current) };
  const p = { id: identityMetrics(input, previous), q: qualificationMetrics(input, previous), e: evidenceMetrics(input, previous), r: reliabilityMetrics(input, previous), m: messageMetrics(input, previous) };

  const pp = (label: string, a: Rate, b: Rate): Trend => ({
    label,
    current: a.rate,
    previous: b.rate,
    delta: a.rate != null && b.rate != null ? Math.round((a.rate - b.rate) * 10) / 10 : null,
    unit: 'pp',
  });

  const out: Trend[] = [
    pp('Identity verification', c.id.verificationRate, p.id.verificationRate),
    pp('Qualification', c.q.qualificationRate, p.q.qualificationRate),
    pp('Evidence acceptance', c.e.evidenceBackedRate, p.e.evidenceBackedRate),
    pp('Run success', c.r.successRate, p.r.successRate),
    pp('Draft approval', c.m.approvalRate, p.m.approvalRate),
  ];

  if (c.r.avgMs != null && p.r.avgMs != null && p.r.avgMs > 0) {
    out.push({
      label: 'Average runtime',
      current: c.r.avgMs,
      previous: p.r.avgMs,
      delta: Math.round(((c.r.avgMs - p.r.avgMs) / p.r.avgMs) * 1000) / 10,
      unit: '%',
      inverted: true,
    });
  }

  return out;
}

// ─── what this schema cannot answer ──────────────────────────────────────────

/**
 * Metrics deliberately NOT shown, with what each would need.
 *
 * Rendered in the dashboard so a gap is visible rather than silently absent.
 */
export function unavailableMetrics(): UnavailableMetric[] {
  return [
    {
      name: 'Retry rate',
      reason:
        'A retry re-executes the same run row in place. Nothing increments a counter, so a run retried three times is indistinguishable from one that succeeded first time.',
      requires: 'An attempts table, or a retry_count column on runs incremented by retryRun/retryAnalysis.',
    },
    {
      name: 'Cost per run / per prospect',
      reason:
        'No token counts, request counts or pricing are recorded. Any figure would be a guess presented as an accounting number.',
      requires:
        'Per-call telemetry: model input/output tokens, provider request counts, and a pricing table applied at write time.',
    },
    {
      name: 'Provider latency, timeout and rate-limit counts',
      reason:
        'Provider outcomes are captured only as their effect on the run (profile accessible/blocked, classified model error). Individual calls are not timed or logged, so timeouts cannot be separated from other failures.',
      requires: 'A provider_calls table recording provider, operation, status, duration and error class per call.',
    },
    {
      name: 'Stage-level attempt history',
      reason:
        'A stage row is upserted on each execution, so only the latest attempt survives. Earlier attempts at the same stage are overwritten.',
      requires: 'Append-only stage attempts rather than upsert on (run_id, stage_name).',
    },
  ];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

/** `sorted` must already be ascending. Nearest-rank percentile. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
