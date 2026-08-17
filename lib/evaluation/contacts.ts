// Contact-candidate-discovery metrics.
//
// A separate module rather than an addition to metrics.ts on purpose: this
// tracks a genuinely different question ("when the account qualified but the
// contact didn't, how well did discovery do?") and must not be folded into, or
// confused with, ordinary qualification failure. A run in this bucket is
// EXPLICITLY NOT counted as a company failure anywhere — it already has its own
// "Target did not qualify" bucket in failureAnalysis for the person, and this
// module adds a second, additive lens on the same runs rather than replacing
// that classification.

import type { RunRow, StageName } from '@/lib/types';
import { inWindow, rate, type Rate, type Window } from './types';

export interface ContactCandidateInput {
  run_id: string;
  identity_status: string;
  selected_at: string | null;
  created_at: string;
}

export interface ContactDiscoveryMetrics {
  /** Runs in the window where the company qualified but this contact did not. */
  applicable: number;
  /** Of those, how many had at least one candidate proposed. */
  candidatesFound: number;
  /** Total candidates proposed across applicable runs. */
  totalCandidates: number;
  /** Candidates a human has selected (any outcome, not only VERIFIED). */
  selected: number;
  /** Candidates that passed independent identity verification. */
  verified: number;
  discoveryYieldRate: Rate;
  selectionRate: Rate;
  verificationRate: Rate;
}

const CONTACT_CANDIDATES_STAGE: StageName = 'find_contact_candidates';

/**
 * Runs where the company qualified but the submitted contact did not.
 *
 * Reads the SAME `qualification.suggestion` flag combineQualification already
 * sets — never re-derives "is the contact weak", so this can never diverge
 * from the qualification logic itself.
 */
export function applicableRuns(runs: RunRow[], w: Window): RunRow[] {
  return runs.filter(
    (r) => inWindow(r.created_at, w) && r.qualification_status === 'NOT_QUALIFIED' && Boolean(r.qualification?.suggestion),
  );
}

export function contactDiscoveryMetrics(
  runs: RunRow[],
  candidates: ContactCandidateInput[],
  w: Window,
): ContactDiscoveryMetrics {
  const applicable = applicableRuns(runs, w);
  const applicableIds = new Set(applicable.map((r) => r.id));
  const scoped = candidates.filter((c) => applicableIds.has(c.run_id));

  const runsWithCandidates = new Set(scoped.map((c) => c.run_id)).size;
  const selected = scoped.filter((c) => c.selected_at).length;
  const verified = scoped.filter((c) => c.identity_status === 'VERIFIED').length;

  return {
    applicable: applicable.length,
    candidatesFound: runsWithCandidates,
    totalCandidates: scoped.length,
    selected,
    verified,
    discoveryYieldRate: rate(
      runsWithCandidates,
      applicable.length,
      'Runs where discovery proposed at least one candidate ÷ runs where the company qualified but the contact did not. This is a distinct outcome from a company failing to qualify at all.',
    ),
    selectionRate: rate(
      selected,
      scoped.length,
      'Candidates a human selected ÷ candidates proposed in applicable runs.',
    ),
    verificationRate: rate(
      verified,
      selected,
      'Selected candidates that passed independent identity verification ÷ candidates selected. Verification is the same system every prospect identity goes through.',
    ),
  };
}

/** Referenced so the stage name stays a compile-time check against StageName. */
export const _STAGE = CONTACT_CANDIDATES_STAGE;
