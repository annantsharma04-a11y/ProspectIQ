import { Inngest } from 'inngest';

export const inngest = new Inngest({ id: 'ps3-outreach-engine' });

export const OUTREACH_RUN_REQUESTED = 'outreach/run.requested';

export interface OutreachRunRequestedEvent {
  name: typeof OUTREACH_RUN_REQUESTED;
  data: { runId: string };
}

// A retry restarts executePipeline() from validate_input — the identical
// operation OUTREACH_RUN_REQUESTED already performs — so retries are
// deliberately NOT given their own event; app/api/runs/[id]/retry/route.ts
// sends this same event. The three below resume a run partway through
// (evaluate_signals / generate_message / verify_identity onward), which
// run-outreach-pipeline's function does not do, so each needs its own event
// and its own Inngest function.

export const OUTREACH_ANALYSIS_RETRY_REQUESTED = 'outreach/analysis.retry.requested';

export interface OutreachAnalysisRetryRequestedEvent {
  name: typeof OUTREACH_ANALYSIS_RETRY_REQUESTED;
  data: { runId: string };
}

export const OUTREACH_MESSAGE_REGENERATE_REQUESTED = 'outreach/message.regenerate.requested';

export interface OutreachMessageRegenerateRequestedEvent {
  name: typeof OUTREACH_MESSAGE_REGENERATE_REQUESTED;
  data: { runId: string };
}

export const OUTREACH_IDENTITY_RESUME_REQUESTED = 'outreach/identity.resume.requested';

export interface OutreachIdentityResumeRequestedEvent {
  name: typeof OUTREACH_IDENTITY_RESUME_REQUESTED;
  data: { runId: string };
}

export const OUTREACH_ACCOUNT_DECISION_MADE = 'outreach/account.decision.made';

export interface OutreachAccountDecisionMadeEvent {
  name: typeof OUTREACH_ACCOUNT_DECISION_MADE;
  data: { runId: string };
}
