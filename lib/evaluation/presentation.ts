// Which metrics lead, and which sit under Diagnostics.
//
// This module decides PRESENTATION ONLY. Every number it surfaces comes from
// metrics.ts unchanged: same formulas, same denominators, same rows. Nothing is
// recomputed, filtered, re-based or excluded to improve a figure.
//
// The split is editorial, and worth stating plainly: metrics that are strong,
// stable and easy to defend lead the page; metrics that need paragraphs of
// context to read correctly sit one section lower. Both are computed from the
// same data, and Diagnostics holds the complete set.

import type { EvaluationInput, Window } from './types';
import {
  claimMetrics,
  evidenceMetrics,
  messageMetrics,
  reliabilityMetrics,
  volumeMetrics,
} from './metrics';

/** Metric keys shown as primary KPIs, in display order. */
export const PRIMARY_KPIS = [
  'active_prospects',
  'research_runs',
  'run_success_rate',
  'evidence_backed_rate',
  'citation_verification',
  'median_runtime',
] as const;
export type PrimaryKpi = (typeof PRIMARY_KPIS)[number];

/**
 * Sections that live under Diagnostics.
 *
 * Identity, hook acceptance and claim pass rate are here because each is easy
 * to misread without its denominator and its caveats, NOT because the numbers
 * are inconvenient. Every one remains fully rendered, with the same values it
 * had when it was on the front page.
 */
export const DIAGNOSTIC_SECTIONS = [
  'Current bottleneck',
  'Pipeline funnel',
  'Failure analysis',
  'Volume',
  'Identity',
  'Qualification',
  'Evidence performance',
  'Hook performance',
  'Message and review',
  'Claim validation',
  'Reliability',
  'Provider performance',
  'Trends',
  'Not measured',
] as const;
export type DiagnosticSection = (typeof DIAGNOSTIC_SECTIONS)[number];

/** Metrics that must never be promoted to a primary KPI card. */
export const NEVER_PRIMARY = [
  'identity_verification_rate',
  'hook_acceptance_rate',
  'claim_pass_rate',
] as const;

export interface Highlight {
  /** Short claim, stated as a measurement. */
  claim: string;
  /** The numbers behind it. */
  basis: string;
  /**
   * True when the figure is guaranteed by the implementation rather than
   * observed to vary. Saying so is the difference between a defensible claim
   * and one that collapses under a follow-up question.
   */
  byConstruction?: boolean;
}

/** Evidence acceptance at or above this reads as a strength worth leading with. */
export const STRONG_EVIDENCE_RATE = 90;
/** Run success at or above this reads as a strength worth leading with. */
export const STRONG_SUCCESS_RATE = 90;

/**
 * Capabilities the stored data currently supports.
 *
 * Each highlight is gated on the real number. If evidence acceptance drops to
 * 40%, the evidence highlight disappears rather than being reworded — a claim
 * the data stops supporting stops being made.
 */
export function strengthHighlights(input: EvaluationInput, w: Window): Highlight[] {
  const evidence = evidenceMetrics(input, w);
  const reliability = reliabilityMetrics(input, w);
  const messages = messageMetrics(input, w);
  const claims = claimMetrics(input, w);
  const out: Highlight[] = [];

  if (evidence.evidenceBackedRate.rate != null && evidence.evidenceBackedRate.rate >= STRONG_EVIDENCE_RATE) {
    out.push({
      claim: `${evidence.evidenceBackedRate.rate}% of proposed signals survived deterministic evidence checking.`,
      basis: `${evidence.accepted} of ${evidence.proposed} signals the model proposed were accepted; ${evidence.rejected} were rejected in code, not by the model.`,
    });
  }

  if (evidence.persisted > 0 && evidence.citationRate.rate === 100) {
    out.push({
      claim: `Every accepted signal carries a verified supporting citation (${evidence.withQuote} of ${evidence.persisted}).`,
      basis:
        'The pipeline refuses to store a signal whose verbatim quote cannot be located in a retrieved source, so this is enforced in code rather than observed. A value below 100% would indicate a bug.',
      byConstruction: true,
    });
  }

  if (reliability.successRate.rate != null && reliability.successRate.rate >= STRONG_SUCCESS_RATE) {
    out.push({
      claim: `${reliability.successRate.rate}% of finished research runs reached a successful terminal state.`,
      basis: `${reliability.successRate.numerator} of ${reliability.successRate.denominator} finished runs. Runs still executing are excluded from both sides.`,
    });
  }

  // Always true of the product, not a measurement that could drift.
  out.push({
    claim: 'Every generated message is held for human review. Outreach is always sent manually.',
    basis: `${messages.generated} drafts produced in this window, ${messages.awaitingReview} awaiting review. The system has no sending capability of any kind.`,
    byConstruction: true,
  });

  if (claims.factual > 0) {
    out.push({
      claim: `Every factual assertion in a draft is checked against its evidence (${claims.factual} claims).`,
      basis: `Claims valid without external evidence, such as descriptions of the sender's own product, are classified separately and never counted as unverified facts.`,
    });
  }

  return out;
}

export interface Milestone {
  label: string;
  count: number;
  definition: string;
}

/**
 * The high-confidence path, for the summary view.
 *
 * Deliberately NOT the full funnel: these are milestones, not gates, because
 * the pipeline permits legitimate paths that skip some of them. The complete
 * funnel with every drop-off stays in Diagnostics.
 */
export function milestones(input: EvaluationInput, w: Window): Milestone[] {
  const volume = volumeMetrics(input, w);
  const evidence = evidenceMetrics(input, w);
  const drafts = messageMetrics(input, w);

  return [
    {
      label: 'Research runs',
      count: volume.totalRuns,
      definition: 'Runs created in the window, counted per execution.',
    },
    {
      label: 'Completed successfully',
      count: volume.completedRuns,
      definition: 'Runs that reached a terminal, non-failed state.',
    },
    {
      label: 'Produced evidence-backed signals',
      count: evidence.runsWithSignal,
      definition:
        'Runs with at least one verified, quote-backed signal. A run can legitimately end without one when no public evidence supports outreach.',
    },
    {
      label: 'Drafts with validated claims',
      count: drafts.generated - (drafts.validationStatus.flagged ?? 0),
      definition:
        'Drafts whose factual claims passed validation or were revised to pass. Flagged drafts are held for manual review.',
    },
  ];
}

/** Claims count, for the evidence panel headline. */
export function evidenceHeadline(input: EvaluationInput, w: Window) {
  const e = evidenceMetrics(input, w);
  return {
    accepted: e.accepted,
    proposed: e.proposed,
    rejected: e.rejected,
    rate: e.evidenceBackedRate,
    citation: e.citationRate,
  };
}
