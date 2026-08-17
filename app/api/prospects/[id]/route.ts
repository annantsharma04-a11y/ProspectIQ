import { NextResponse } from 'next/server';
import { requireOwnedProspect } from '@/lib/auth/guard';
import { listProspectRuns } from '@/lib/supabase/queries';

export const runtime = 'nodejs';

/** One prospect: current known state plus its run history. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireOwnedProspect(id);
  if ('response' in access) return access.response;

  try {
    const runs = await listProspectRuns(access.prospect.id);
    return NextResponse.json({ prospect: access.prospect, runs });
  } catch {
    return NextResponse.json({ error: 'Could not load prospect' }, { status: 500 });
  }
}
