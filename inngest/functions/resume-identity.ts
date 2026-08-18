// Durable execution path for POST /api/runs/[id]/identity (USE_INNGEST=true).
//
// resumeAfterIdentity() continues a run paused for a human's candidate choice,
// resuming at verify_identity with that choice — it is NOT the same operation
// as OUTREACH_RUN_REQUESTED, so it gets its own event and function. The
// chosen candidate is read back from the run row itself (persisted by the
// route before dispatch), not carried on the event.

import { inngest, OUTREACH_IDENTITY_RESUME_REQUESTED } from '../client';
import { resumeAfterIdentity } from '@/lib/pipeline/execute';
import { getRun } from '@/lib/supabase/queries';

export const resumeIdentityPipeline = inngest.createFunction(
  {
    id: 'resume-identity-pipeline',
    name: 'Resume After Identity Selection',
    triggers: [{ event: OUTREACH_IDENTITY_RESUME_REQUESTED }],
    // Not resume-safe across an automatic retry — same reasoning as the other
    // pipeline entry points: a transient failure should not re-spend on
    // research/qualification that already ran.
    retries: 0,
  },
  async ({ event, step }) => {
    const runId = event.data.runId as string;

    await step.run('resume-after-identity', () => resumeAfterIdentity(runId));

    const run = await step.run('load-final-status', () => getRun(runId));
    return { runId, status: run?.status ?? 'unknown' };
  },
);
