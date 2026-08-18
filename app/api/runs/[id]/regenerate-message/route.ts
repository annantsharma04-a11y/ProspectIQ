import { NextResponse } from 'next/server';
import { regenerateMessageOnly } from '@/lib/pipeline/execute';
import { checkRateLimit } from '@/lib/rate-limit';
import { requireOwnedRun } from '@/lib/auth/guard';
import { inngest, OUTREACH_MESSAGE_REGENERATE_REQUESTED } from '@/inngest/client';

export const runtime = 'nodejs';

/**
 * Regenerate only the outreach message on a run that already has one — same
 * verified hook and evidence, new wording. Reuses the profile, research and
 * selected hook already on the run; costs one model call, not a fresh pass
 * through research or qualification.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireOwnedRun(id);
  if ('response' in access) return access.response;
  const { run } = access;

  if (run.status === 'running') {
    return NextResponse.json({ error: 'Run is already in progress' }, { status: 409 });
  }
  // Only meaningful once a hook was genuinely selected and a message drafted —
  // there is nothing to regenerate from a run that never reached that point.
  if (!run.selected_hook || !run.generated_message) {
    return NextResponse.json(
      { error: 'This run has no existing message to regenerate.' },
      { status: 400 },
    );
  }
  if (!checkRateLimit().ok) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 });
  }

  // regenerateMessageOnly() reuses the existing hook/research and forces one
  // fresh model call — a different operation from a fresh run, so it gets its
  // own durable Inngest path rather than reusing OUTREACH_RUN_REQUESTED
  // (which restarts from validate_input).
  if (process.env.USE_INNGEST === 'true') {
    await inngest.send({ name: OUTREACH_MESSAGE_REGENERATE_REQUESTED, data: { runId: id } });
  } else {
    regenerateMessageOnly(id).catch((err) => console.error(`[run ${id}] message regeneration error:`, err));
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
