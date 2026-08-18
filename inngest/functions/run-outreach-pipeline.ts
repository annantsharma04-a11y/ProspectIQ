// Optional durable execution path (USE_INNGEST=true).
//
// The pipeline's stages share in-memory context, so the whole run is one
// durable step rather than fourteen. Inngest still buys retries and a persistent
// execution record; the per-stage audit trail lives in run_stages either way.

import { inngest, OUTREACH_RUN_REQUESTED } from '../client';
import { executePipeline } from '@/lib/pipeline/execute';
import { getRun } from '@/lib/supabase/queries';

export const runOutreachPipeline = inngest.createFunction(
  {
    id: 'run-outreach-pipeline',
    name: 'Run Outreach Pipeline',
    triggers: [{ event: OUTREACH_RUN_REQUESTED }],
    // The whole run is ONE step (see above) and executePipeline() is not
    // resume-safe — it always restarts from validate_input. Inngest's default
    // of 3 automatic retries would therefore re-run the entire pipeline on any
    // transient failure, re-spending on Bright Data, search and Gemini calls
    // that already succeeded. A failed run is already fully recorded
    // (status, error, all completed stage output preserved) and has
    // purpose-built, cheaper recovery paths a human triggers deliberately
    // (POST /api/runs/[id]/retry, /retry-analysis) — automatic retries here
    // would only duplicate spend, never help.
    retries: 0,
  },
  async ({ event, step }) => {
    const runId = event.data.runId as string;

    await step.run('execute-pipeline', () => executePipeline(runId));

    const run = await step.run('load-final-status', () => getRun(runId));
    return { runId, status: run?.status ?? 'unknown' };
  },
);
