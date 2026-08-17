import { NextResponse } from 'next/server';
import { requireOwnedProspect } from '@/lib/auth/guard';
import { listProspectRuns } from '@/lib/supabase/queries';

export const runtime = 'nodejs';

/** A prospect's runs, newest first. Ownership is resolved through the prospect. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireOwnedProspect(id);
  if ('response' in access) return access.response;

  try {
    const runs = await listProspectRuns(access.prospect.id);
    return NextResponse.json({ runs });
  } catch {
    return NextResponse.json({ error: 'Could not load runs' }, { status: 500 });
  }
}
