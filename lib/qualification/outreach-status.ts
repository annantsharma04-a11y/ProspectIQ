// Outreach status — deliberately separate from target qualification.
//
// They answer different questions and must not be conflated:
//   Target qualification — SHOULD we contact this person about this product?
//   Outreach status      — what has happened to the message itself?
//
// A target can be QUALIFIED while outreach still needs review (no verified hook
// was found), and a target can be NOT_QUALIFIED with outreach simply never
// started. Collapsing the two would hide which decision actually stopped a run.

import type { DraftRow, RunRow, RunStageRow } from '@/lib/types';

export type OutreachStatus =
  | 'NOT_STARTED'
  | 'GENERATING'
  | 'READY_FOR_REVIEW'
  | 'NEEDS_MANUAL_REVIEW'
  | 'SKIPPED';

export const OUTREACH_LABEL: Record<OutreachStatus, string> = {
  NOT_STARTED: 'Not started',
  GENERATING: 'Generating',
  READY_FOR_REVIEW: 'Ready for review',
  NEEDS_MANUAL_REVIEW: 'Needs manual review',
  SKIPPED: 'Skipped',
};

export function deriveOutreachStatus(
  run: RunRow,
  stages: RunStageRow[] = [],
  draft: DraftRow | null = null,
): OutreachStatus {
  // Qualification stopped the run before outreach work began.
  if (run.qualification_status === 'NOT_QUALIFIED' || run.qualification_status === 'BORDERLINE') {
    return 'NOT_STARTED';
  }

  if (run.status === 'failed') return 'SKIPPED';
  if (run.status === 'ai_analysis_pending') return 'SKIPPED';
  if (run.status === 'queued') return 'NOT_STARTED';

  if (run.status === 'running') {
    const generating = stages.some(
      (s) =>
        (s.stage_name === 'generate_message' || s.stage_name === 'evaluate_signals') &&
        s.status === 'running',
    );
    return generating ? 'GENERATING' : 'NOT_STARTED';
  }

  if (run.status === 'ready_for_review' || run.status === 'approved') return 'READY_FOR_REVIEW';
  if (run.status === 'rejected') return 'NEEDS_MANUAL_REVIEW';

  // needs_manual_review: a draft may or may not exist.
  if (run.status === 'needs_manual_review') {
    const messageStage = stages.find((s) => s.stage_name === 'generate_message');
    if (messageStage?.status === 'skipped' && !draft) return 'NEEDS_MANUAL_REVIEW';
    return 'NEEDS_MANUAL_REVIEW';
  }

  return 'NOT_STARTED';
}
