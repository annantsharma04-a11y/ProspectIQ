// Where the pipeline is currently losing the most prospects.
//
// Deterministic and derived entirely from metrics the dashboard already
// computes. No model call, no scoring heuristic, no advice — it names the
// largest measured loss and shows the number behind it. The reader draws the
// conclusion; this only points at the row.
//
// THE RULE, in full:
//
//   1. Take the funnel's step-to-step losses (run-level, already monotonic).
//      Ignore the final human-approval step: an unreviewed queue is not a
//      pipeline loss, it is work that has not happened yet.
//   2. The largest loss wins. Ties go to the EARLIER stage, because fixing an
//      earlier gate is what makes the later ones reachable at all.
//   3. A loss must reach MATERIAL_SHARE of submitted runs to count. Below that
//      there is no dominant bottleneck, and saying otherwise would turn a
//      one-run difference in a small dataset into a finding.
//   4. Evidence has one extra path: if the model's proposed signals are being
//      rejected at a high rate, that is an evidence problem even when few runs
//      reach the stage. It overrides the funnel comparison.
//   5. Latency is considered only when no stage loss is material — a pipeline
//      losing a quarter of its runs has a bigger problem than a slow one.

import type { EvaluationInput, Window } from './types';
import { evidenceMetrics, funnel, identityMetrics, qualificationMetrics, reliabilityMetrics } from './metrics';

/**
 * A stage loss must be at least this share of submitted runs to be reported.
 *
 * Calibrated against the current data, where step losses are 23.1%, 12.3%,
 * 12.3%, 6.2%, 3.1% and 0%. A 10% floor separates the three real losses from
 * the three that are single-digit run counts.
 */
export const MATERIAL_SHARE = 10;

/** Below this acceptance rate, evidence is the story regardless of volume. */
export const WEAK_EVIDENCE_RATE = 50;
/** Too few proposals to judge an acceptance rate on. */
export const MIN_PROPOSALS_TO_JUDGE = 10;
/** Median runtime, in ms, above which latency can be reported as the bottleneck. */
export const SLOW_MEDIAN_MS = 120_000;

export type BottleneckKind =
  | 'identity'
  | 'research'
  | 'qualification'
  | 'evidence'
  | 'message'
  | 'latency'
  | 'none';

export interface Bottleneck {
  kind: BottleneckKind;
  /** One line, stated as fact. */
  headline: string;
  /** The measurement behind it, in numbers. */
  why: string;
  /** Runs lost at this step, where the bottleneck is a funnel loss. */
  lost: number | null;
  /** That loss as a share of submitted runs. */
  share: number | null;
}

/** Funnel steps that represent a pipeline gate, in order, mapped to a kind. */
const STEP_KIND: Record<string, BottleneckKind> = {
  'Cleared identity gate': 'identity',
  'Research completed': 'research',
  'Cleared qualification gate': 'qualification',
  'Evidence-backed signal': 'evidence',
  'Message generated': 'message',
};

export function identifyBottleneck(input: EvaluationInput, w: Window): Bottleneck {
  const steps = funnel(input, w);
  const submitted = steps[0]?.count ?? 0;

  if (submitted === 0) {
    return {
      kind: 'none',
      headline: 'No runs in this period.',
      why: 'There is nothing to measure in the selected window.',
      lost: null,
      share: null,
    };
  }

  const evidence = evidenceMetrics(input, w);

  // Rule 4: a high rejection rate on proposed signals is an evidence problem
  // even if only a handful of runs got that far.
  if (
    evidence.proposed >= MIN_PROPOSALS_TO_JUDGE &&
    evidence.evidenceBackedRate.rate != null &&
    evidence.evidenceBackedRate.rate < WEAK_EVIDENCE_RATE
  ) {
    return {
      kind: 'evidence',
      headline: 'Evidence collection is currently the largest bottleneck.',
      why: `${evidence.rejected} of ${evidence.proposed} proposed signals failed evidence verification (${evidence.evidenceBackedRate.rate}% accepted).`,
      lost: evidence.rejected,
      share: null,
    };
  }

  // Rules 1–3: the biggest step-to-step loss, earliest on ties.
  let worst: { kind: BottleneckKind; label: string; lost: number; share: number } | null = null;
  for (let i = 1; i < steps.length; i++) {
    const kind = STEP_KIND[steps[i].label];
    if (!kind) continue; // skips Validated, Claims validated and human approval
    const lost = steps[i - 1].count - steps[i].count;
    const share = Math.round((lost / submitted) * 1000) / 10;
    // Strictly greater keeps the earliest stage on a tie.
    if (!worst || lost > worst.lost) worst = { kind, label: steps[i].label, lost, share };
  }

  if (worst && worst.share >= MATERIAL_SHARE) {
    return { ...worst, ...describe(worst.kind, worst.lost, input, w) };
  }

  // Rule 5: latency only matters once nothing is bleeding runs.
  const reliability = reliabilityMetrics(input, w);
  if (reliability.medianMs != null && reliability.medianMs >= SLOW_MEDIAN_MS) {
    const slowest = reliability.slowestStages[0];
    return {
      kind: 'latency',
      headline: 'Research latency is currently the largest bottleneck.',
      why: slowest
        ? `Median run takes ${fmt(reliability.medianMs)} (p95 ${fmt(reliability.p95Ms)}). The slowest stage is ${slowest.stage.replace(/_/g, ' ')} at ${fmt(slowest.avgMs)} on average.`
        : `Median run takes ${fmt(reliability.medianMs)} (p95 ${fmt(reliability.p95Ms)}).`,
      lost: null,
      share: null,
    };
  }

  return {
    kind: 'none',
    headline: 'No dominant bottleneck.',
    why: worst
      ? `The largest single drop is ${worst.lost} run${worst.lost === 1 ? '' : 's'} at "${worst.label}", ${worst.share}% of submitted — below the ${MATERIAL_SHARE}% threshold for reporting one.`
      : `No stage lost a material share of the ${submitted} submitted run${submitted === 1 ? '' : 's'}.`,
    lost: null,
    share: null,
  };
}

/** The headline and supporting number for a funnel-loss bottleneck. */
function describe(
  kind: BottleneckKind,
  lost: number,
  input: EvaluationInput,
  w: Window,
): { headline: string; why: string } {
  switch (kind) {
    case 'identity': {
      const id = identityMetrics(input, w);
      const unverified = id.reached - id.verified;
      const detail =
        id.partial > id.ambiguous + id.failed
          ? 'Most were PARTIAL rather than FAILED.'
          : id.ambiguous > id.partial
            ? 'Most were AMBIGUOUS, meaning several people plausibly matched.'
            : '';
      return {
        headline: 'Identity resolution is currently the largest bottleneck.',
        why: `${unverified} of ${id.reached} runs reaching identity verification did not reach VERIFIED. ${detail}`.trim(),
      };
    }
    case 'research':
      return {
        headline: 'Company research is currently the largest bottleneck.',
        why: `${lost} runs cleared identity but did not complete company research.`,
      };
    case 'qualification': {
      const q = qualificationMetrics(input, w);
      return {
        headline: 'Qualification is currently the largest bottleneck.',
        why: `${q.notQualified + q.borderline} of ${q.reached} runs reaching qualification did not qualify${q.unknown > 0 ? `, and ${q.unknown} produced no verdict` : ''}.`,
      };
    }
    case 'evidence': {
      const e = evidenceMetrics(input, w);
      return {
        headline: 'Evidence collection is currently the largest bottleneck.',
        why: `${lost} runs cleared qualification but produced no verified signal. ${e.accepted} of ${e.proposed} proposed signals passed evidence verification.`,
      };
    }
    case 'message':
      return {
        headline: 'Message generation is currently the largest bottleneck.',
        why: `${lost} runs had a verified signal but produced no draft.`,
      };
    default:
      return { headline: 'No dominant bottleneck.', why: '' };
  }
}

function fmt(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
