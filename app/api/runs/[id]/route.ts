import { NextResponse } from 'next/server';
import { listStages, listSignals, listSources, getDraft, listContactCandidates } from '@/lib/supabase/queries';
import { requireOwnedRun } from '@/lib/auth/guard';

export const runtime = 'nodejs';

/** Consistent snapshot for the live run view and result panel. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Authenticates and confirms ownership before any run data is read.
  const access = await requireOwnedRun(id);
  if ('response' in access) return access.response;
  const { run } = access;

  const [stages, signals, sources, draft, contactCandidates] = await Promise.all([
    listStages(id),
    listSignals(id),
    listSources(id),
    getDraft(id),
    // Supplementary: until migration 011 is applied the table does not
    // exist yet, and that must never take down the run page itself.
    listContactCandidates(id).catch(() => []),
  ]);

  return NextResponse.json({ run, stages, signals, sources, draft, contactCandidates });
}
