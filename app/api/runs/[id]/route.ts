import { NextResponse } from 'next/server';
import { getRun, listStages, listSignals, listSources, getDraft } from '@/lib/supabase/queries';

export const runtime = 'nodejs';

/** Consistent snapshot for the live run view and result panel. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const [stages, signals, sources, draft] = await Promise.all([
    listStages(id),
    listSignals(id),
    listSources(id),
    getDraft(id),
  ]);

  return NextResponse.json({ run, stages, signals, sources, draft });
}
