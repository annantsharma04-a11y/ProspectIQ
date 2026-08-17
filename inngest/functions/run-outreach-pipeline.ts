// Optional durable execution path (USE_INNGEST=true).
//
// The pipeline's stages share in-memory context, so the whole run is one
// durable step rather than ten. Inngest still buys retries and a persistent
// execution record; the per-stage audit trail lives in run_stages either way.

import { inngest, OUTREACH_RUN_REQUESTED } from '../client';
import { executePipeline } from '@/lib/pipeline/execute';
import { getRun } from '@/lib/supabase/queries';

export const runOutreachPipeline = inngest.createFunction(
  {
    id: 'run-outreach-pipeline',
    name: 'Run Outreach Pipeline',
    triggers: [{ event: OUTREACH_RUN_REQUESTED }],
  },
  async ({ event, step }) => {
    const runId = event.data.runId as string;

    await step.run('execute-pipeline', () => executePipeline(runId));

    const run = await step.run('load-final-status', () => getRun(runId));
    return { runId, status: run?.status ?? 'unknown' };
  },
);
