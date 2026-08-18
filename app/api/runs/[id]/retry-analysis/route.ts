import { NextResponse } from 'next/server';
import { retryAnalysis } from '@/lib/pipeline/execute';
import { checkRateLimit } from '@/lib/rate-limit';
import { requireOwnedRun } from '@/lib/auth/guard';
import { inngest, OUTREACH_ANALYSIS_RETRY_REQUESTED } from '@/inngest/client';

export const runtime = 'nodejs';

/**
 * Retry only the AI analysis for a run parked as `ai_analysis_pending`.
 *
 * The profile and research are already stored, so this costs one model call
 * rather than a fresh round of provider spend.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireOwnedRun(id);
  if ('response' in access) return access.response;
  const { run } = access;

  if (run.status === 'running') {
    return NextResponse.json({ error: 'Run is already in progress' }, { status: 409 });
  }
  if (run.status !== 'ai_analysis_pending' && run.status !== 'failed') {
    return NextResponse.json(
      { error: 'This run does not have a pending analysis to retry.' },
      { status: 400 },
    );
  }
  if (!checkRateLimit().ok) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 });
  }

  // retryAnalysis() resumes from evaluate_signals onward, rehydrating the
  // already-persisted profile and sources — a different operation from a
  // fresh run, so it gets its own durable Inngest path rather than reusing
  // OUTREACH_RUN_REQUESTED (which restarts from validate_input).
  if (process.env.USE_INNGEST === 'true') {
    await inngest.send({ name: OUTREACH_ANALYSIS_RETRY_REQUESTED, data: { runId: id } });
  } else {
    retryAnalysis(id).catch((err) => console.error(`[run ${id}] analysis retry error:`, err));
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
