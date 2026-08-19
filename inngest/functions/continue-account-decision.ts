// Durable execution path for POST /api/runs/[id]/account-decision (USE_INNGEST=true).
//
// continueAfterAccountDecision() resumes a paused run at contact discovery with
// its research and qualification already persisted — not the same operation as
// OUTREACH_RUN_REQUESTED, which starts from validate_input, so it gets its own
// event and function.

import { inngest, OUTREACH_ACCOUNT_DECISION_MADE } from '../client';
import { continueAfterAccountDecision } from '@/lib/pipeline/execute';
import { getRun } from '@/lib/supabase/queries';

export const continueAccountDecisionPipeline = inngest.createFunction(
  {
    id: 'continue-account-decision-pipeline',
    name: 'Continue Account Decision',
    triggers: [{ event: OUTREACH_ACCOUNT_DECISION_MADE }],
    // Consistent with every other pipeline function here: an automatic retry
    // would re-spend on research and model calls for a run whose partial work
    // is already persisted. The user can retry deliberately.
    retries: 0,
  },
  async ({ event, step }) => {
    const runId = event.data.runId as string;

    await step.run('continue-after-account-decision', () => continueAfterAccountDecision(runId));

    const run = await step.run('load-final-status', () => getRun(runId));
    return { runId, status: run?.status ?? 'unknown' };
  },
);
