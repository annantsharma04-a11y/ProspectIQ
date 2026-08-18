// Durable execution path for POST /api/runs/[id]/retry-analysis (USE_INNGEST=true).
//
// retryAnalysis() resumes a run parked at `ai_analysis_pending` from
// evaluate_signals onward, rehydrating the already-persisted profile and
// sources rather than restarting the whole pipeline — it is NOT the same
// operation as OUTREACH_RUN_REQUESTED, so it gets its own event and function.

import { inngest, OUTREACH_ANALYSIS_RETRY_REQUESTED } from '../client';
import { retryAnalysis } from '@/lib/pipeline/execute';
import { getRun } from '@/lib/supabase/queries';

export const retryAnalysisPipeline = inngest.createFunction(
  {
    id: 'retry-analysis-pipeline',
    name: 'Retry Analysis',
    triggers: [{ event: OUTREACH_ANALYSIS_RETRY_REQUESTED }],
    // Not resume-safe across an automatic retry — same reasoning as
    // run-outreach-pipeline: a transient failure should not re-spend on a
    // second model call. Recovery is the user-triggered retry-analysis
    // endpoint itself, not an automatic Inngest retry.
    retries: 0,
  },
  async ({ event, step }) => {
    const runId = event.data.runId as string;

    await step.run('retry-analysis', () => retryAnalysis(runId));

    const run = await step.run('load-final-status', () => getRun(runId));
    return { runId, status: run?.status ?? 'unknown' };
  },
);
