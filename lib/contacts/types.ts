// contact_candidates row shape and the state machine its identity_status moves
// through. Mirrors the run-level identity model deliberately — a candidate is
// not a second identity system, it is the same one applied before a run exists.

export type ContactCandidateStatus = 'DISCOVERED' | 'PARTIAL' | 'VERIFIED' | 'AMBIGUOUS' | 'FAILED' | 'REJECTED';

/** Only these may produce a research run. Everything else stops at review. */
export const SELECTABLE_STATUSES: ContactCandidateStatus[] = ['VERIFIED'];

export interface ContactCandidateEvidence {
  source_url: string;
  quote: string;
}

export interface ContactCandidateRow {
  id: string;
  run_id: string;
  name: string | null;
  role: string | null;
  company: string | null;
  linkedin_url: string | null;
  reason: string;
  evidence: ContactCandidateEvidence[];
  confidence: number;
  rank_score: number;
  identity_status: ContactCandidateStatus;
  identity_verification: unknown | null;
  selected_at: string | null;
  resulting_run_id: string | null;
  created_at: string;
}

/**
 * Whether the find_contact_candidates stage should be shown as a distinct,
 * navigable step in the UI.
 *
 * The stage runs on every pipeline execution, but it is a real no-op on all
 * but one state (company qualified, contact not). Listing it alongside the
 * other fourteen steps on every run — most of them "skipped" — would present
 * a rare, conditional capability as a permanent thing everyone has to click
 * past. `output.applicable` is the one flag the stage itself sets, in every
 * branch, whenever that specific state genuinely occurred (including the case
 * where it occurred but yielded zero candidates) — this reads that flag and
 * nothing else, so the UI can never diverge from what the stage decided.
 */
export function contactCandidatesStageIsVisible(stageOutput: unknown): boolean {
  if (!stageOutput || typeof stageOutput !== 'object') return false;
  return (stageOutput as { applicable?: unknown }).applicable === true;
}
