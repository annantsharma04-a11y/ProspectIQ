// Durable execution path for POST /api/runs/[id]/regenerate-message (USE_INNGEST=true).
//
// regenerateMessageOnly() reuses the run's already-selected hook and research,
// forcing one fresh model call for new wording — it is NOT the same operation
// as OUTREACH_RUN_REQUESTED, so it gets its own event and function.

import { inngest, OUTREACH_MESSAGE_REGENERATE_REQUESTED } from '../client';
import { regenerateMessageOnly } from '@/lib/pipeline/execute';
import { getRun } from '@/lib/supabase/queries';

export const regenerateMessagePipeline = inngest.createFunction(
  {
    id: 'regenerate-message-pipeline',
    name: 'Regenerate Message',
    triggers: [{ event: OUTREACH_MESSAGE_REGENERATE_REQUESTED }],
    // Not resume-safe across an automatic retry — a transient failure should
    // not silently re-spend on a second rewrite; the existing draft is already
    // preserved and the user can retry deliberately.
    retries: 0,
  },
  async ({ event, step }) => {
    const runId = event.data.runId as string;

    await step.run('regenerate-message', () => regenerateMessageOnly(runId));

    const run = await step.run('load-final-status', () => getRun(runId));
    return { runId, status: run?.status ?? 'unknown' };
  },
);
