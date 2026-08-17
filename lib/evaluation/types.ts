// Evaluation dashboard contracts.
//
// COUNTING LEVELS — every metric declares which one it uses, because mixing
// them is the easiest way to produce a flattering lie:
//
//   prospect-level  one row per PERSON. A prospect researched five times counts
//                   once. Used for reach ("how many people have we looked at").
//   run-level       one row per pipeline EXECUTION. A retry of a failed run
//                   reuses the same row, so a retried run is still one run.
//   attempt-level   one row per STAGE execution within a run.
//
// The 65 runs in this database cover 16 prospects. Reporting 65 as "prospects"
// would overstate reach four-fold, so the two are never merged.

import type { RunRow, RunStageRow, SignalRow, DraftRow, StageName } from '@/lib/types';
import type { ProspectRow } from '@/lib/prospects/types';

export const PERIODS = ['today', '7d', '30d', '90d', 'all'] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABEL: Record<Period, string> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  all: 'All time',
};

export function periodDays(p: Period): number | null {
  switch (p) {
    case 'today':
      return 1;
    case '7d':
      return 7;
    case '30d':
      return 30;
    case '90d':
      return 90;
    case 'all':
      return null;
  }
}

/**
 * The window a period selects.
 *
 * DATE BASIS — chosen per metric family and documented here once:
 *
 *   run-level volume, identity, qualification, evidence, hooks, claims, funnel,
 *   failures        → runs.created_at (when research was SUBMITTED). A run
 *                     submitted inside the window belongs to it even if it is
 *                     still executing, otherwise in-flight work vanishes.
 *   duration        → the same runs, but only those with both timestamps; a run
 *                     without completed_at has no duration to average.
 *   prospect reach  → prospects with at least one run in the window ("active"),
 *                     NOT prospects.created_at, so a prospect first seen last
 *                     year but re-researched today counts as active today.
 *   prospects added → prospects.created_at, reported separately and labelled.
 */
export interface Window {
  from: Date | null;
  to: Date;
}

export function windowFor(period: Period, now = new Date()): Window {
  const days = periodDays(period);
  if (days === null) return { from: null, to: now };
  const from = new Date(now.getTime() - days * 86_400_000);
  return { from, to: now };
}

/** The immediately preceding window of equal length, for trend comparison. */
export function previousWindow(period: Period, now = new Date()): Window | null {
  const days = periodDays(period);
  if (days === null) return null;
  const to = new Date(now.getTime() - days * 86_400_000);
  return { from: new Date(to.getTime() - days * 86_400_000), to };
}

export function inWindow(iso: string | null | undefined, w: Window): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  if (w.from && t < w.from.getTime()) return false;
  return t <= w.to.getTime();
}

/** Signal proposal counts, recovered from the evaluate_signals stage output. */
export interface SignalProposal {
  run_id: string;
  ranked: number;
  rejected: number;
}

/** Hook outcome per run, from the select_hook stage output. */
export interface HookOutcome {
  run_id: string;
  selected: boolean;
  insufficient_evidence: boolean;
  rejected_candidates: number;
}

/** Everything the metric functions read. Fetched once, server-side, per user. */
export interface EvaluationInput {
  prospects: Pick<ProspectRow, 'id' | 'created_at'>[];
  runs: RunRow[];
  stages: Pick<RunStageRow, 'run_id' | 'stage_name' | 'status' | 'duration_ms'>[];
  signals: Pick<SignalRow, 'run_id' | 'selected_as_hook' | 'supporting_quote' | 'composite_score' | 'category'>[];
  drafts: Pick<DraftRow, 'run_id' | 'reviewer_action' | 'validation_status' | 'claims' | 'mode'>[];
  proposals: SignalProposal[];
  hooks: HookOutcome[];
  /** Provider attribution, aggregated server-side to avoid shipping every source. */
  sourceProviders: Record<string, number>;
  sourceFetchStatus: Record<string, number>;
  /**
   * True when the source counts above come from a capped page rather than every
   * row. PostgREST caps a response at 1,000 rows, so on a large history these
   * are a SAMPLE and the UI must say so rather than implying a full census.
   */
  sourcesSampled: boolean;
  /** How many source rows the counts are actually based on. */
  sourcesCounted: number;
  /** Discovered contact candidates for the caller's runs. Usually empty. */
  contactCandidates: { run_id: string; identity_status: string; selected_at: string | null; created_at: string }[];
}

/** A metric with its denominator made explicit. Null rate = denominator was 0. */
export interface Rate {
  numerator: number;
  denominator: number;
  /** 0–100, or null when there is nothing to divide by. */
  rate: number | null;
  /** Plain-language definition, rendered in the UI. */
  definition: string;
}

export function rate(numerator: number, denominator: number, definition: string): Rate {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null,
    definition,
  };
}

export interface FunnelStep {
  label: string;
  count: number;
  /** % of the previous step. Null for the first step. */
  ofPrevious: number | null;
  /** % of the very first step. */
  ofStart: number | null;
  definition: string;
}

export interface FailureBucket {
  label: string;
  count: number;
  /** % of all non-completing runs in the window. */
  share: number;
  definition: string;
}

export interface StageTiming {
  stage: StageName;
  runs: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
}

/** A metric that the current schema cannot support, with the reason. */
export interface UnavailableMetric {
  name: string;
  reason: string;
  requires: string;
}
