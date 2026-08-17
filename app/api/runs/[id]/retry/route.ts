import { NextResponse } from 'next/server';
import { retryRun } from '@/lib/pipeline/execute';
import { getRun } from '@/lib/supabase/queries';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * Re-run the pipeline for an existing run (same row, same id).
 * Used after a search/LLM provider failure — the run state is preserved until
 * the retry overwrites it stage by stage.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  if (run.status === 'running') {
    return NextResponse.json({ error: 'Run is already in progress' }, { status: 409 });
  }
  if (!checkRateLimit().ok) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 });
  }

  retryRun(id).catch((err) => console.error(`[run ${id}] retry error:`, err));
  return NextResponse.json({ ok: true }, { status: 202 });
}
