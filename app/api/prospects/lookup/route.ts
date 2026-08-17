import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/guard';
import { findProspectBySlug, listProspectRuns } from '@/lib/supabase/queries';
import { prospectKeyFromUrl, daysSince } from '@/lib/prospects/types';

export const runtime = 'nodejs';

/**
 * "Have I researched this person before?"
 *
 * Called before starting a run so the UI can offer "Research again / View
 * history" instead of silently producing a second run the user did not expect.
 * It reads only the caller's own prospects, so it cannot be used to probe
 * whether someone ELSE has researched a given profile.
 */
export async function GET(req: Request) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;

  const raw = new URL(req.url).searchParams.get('linkedin_url');
  const key = prospectKeyFromUrl(raw);
  if (!key.ok) {
    return NextResponse.json({ error: key.error, field: 'linkedin_url' }, { status: 400 });
  }

  try {
    const prospect = await findProspectBySlug(auth.user.id, key.key.slug);
    if (!prospect) return NextResponse.json({ found: false });

    const runs = await listProspectRuns(prospect.id);
    return NextResponse.json({
      found: true,
      prospect,
      run_count: runs.length,
      last_researched_at: prospect.last_researched_at,
      days_since_research: daysSince(prospect.last_researched_at),
    });
  } catch {
    return NextResponse.json({ error: 'Could not look up prospect' }, { status: 500 });
  }
}
