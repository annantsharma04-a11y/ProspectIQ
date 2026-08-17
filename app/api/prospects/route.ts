import { NextResponse } from 'next/server';
import { countProspects, listProspects } from '@/lib/supabase/queries';
import { requireUser } from '@/lib/auth/guard';

export const runtime = 'nodejs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * The caller's prospects, most recently researched first.
 *
 * Paginated, and served from the prospect_overview view so each row already
 * carries its run count and latest-run summary — one query, not one per row.
 */
export async function GET(req: Request) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;

  const url = new URL(req.url);
  const limit = clamp(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clamp(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

  try {
    // Scoped to the caller — never every prospect in the table.
    const [prospects, total] = await Promise.all([
      listProspects(auth.user.id, { limit, offset }),
      countProspects(auth.user.id),
    ]);
    return NextResponse.json({ prospects, total, limit, offset });
  } catch {
    return NextResponse.json({ error: 'Could not load prospects' }, { status: 500 });
  }
}

function clamp(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
