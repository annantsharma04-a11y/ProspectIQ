import { NextResponse } from 'next/server';
import { retryRun } from '@/lib/pipeline/execute';
import { checkRateLimit } from '@/lib/rate-limit';
import { requireOwnedRun } from '@/lib/auth/guard';

export const runtime = 'nodejs';

/**
 * Re-run the pipeline for an existing run (same row, same id).
 * Used after a search/LLM provider failure — the run state is preserved until
 * the retry overwrites it stage by stage.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireOwnedRun(id);
  if ('response' in access) return access.response;
  const { run } = access;

  if (run.status === 'running') {
    return NextResponse.json({ error: 'Run is already in progress' }, { status: 409 });
  }
  if (!checkRateLimit().ok) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 });
  }

  retryRun(id).catch((err) => console.error(`[run ${id}] retry error:`, err));
  return NextResponse.json({ ok: true }, { status: 202 });
}
