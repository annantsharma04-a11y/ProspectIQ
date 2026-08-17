import { NextResponse } from 'next/server';
import { requireOwnedRun } from '@/lib/auth/guard';
import { listContactCandidates } from '@/lib/supabase/queries';

export const runtime = 'nodejs';

/** Alternative contacts discovered for this run. Usually empty. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireOwnedRun(id);
  if ('response' in access) return access.response;

  try {
    const candidates = await listContactCandidates(id);
    return NextResponse.json({ candidates });
  } catch {
    return NextResponse.json({ error: 'Could not load contact candidates' }, { status: 500 });
  }
}
