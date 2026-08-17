import { NextResponse } from 'next/server';
import { getRun, updateRun } from '@/lib/supabase/queries';
import { applyUserSelection } from '@/lib/identity/types';
import { resumeAfterIdentity } from '@/lib/pipeline/execute';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * Record which candidate identity a human picked, re-validate it, and resume.
 *
 * Selection resolves ambiguity between candidates; it does not waive
 * verification. A chosen identity that still conflicts with public sources
 * stays AMBIGUOUS and the run stays at manual review.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: { candidate_id?: string };
  try {
    body = (await req.json()) as { candidate_id?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const candidateId = body.candidate_id?.trim();
  if (!candidateId) {
    return NextResponse.json({ error: 'candidate_id is required' }, { status: 400 });
  }

  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  if (!run.identity_verification) {
    return NextResponse.json({ error: 'This run has no identity candidates to choose from.' }, { status: 400 });
  }
  if (run.status === 'running') {
    return NextResponse.json({ error: 'Run is already in progress' }, { status: 409 });
  }
  if (!checkRateLimit().ok) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 });
  }

  const verification = applyUserSelection(run.identity_verification, candidateId);
  if (verification.selected_candidate_id !== candidateId) {
    return NextResponse.json({ error: verification.reason }, { status: 400 });
  }

  // The automated result is preserved inside the verification record; only the
  // resolved identity and resolution method change.
  await updateRun(id, {
    identity_verification: verification,
    identity_status: verification.status,
    identity_resolution: verification.resolution,
    identity_confidence: verification.confidence,
    prospect_name: verification.resolved.name,
    prospect_title: verification.resolved.role,
    company_name: verification.resolved.company,
  });

  if (!verification.proceed) {
    return NextResponse.json({
      ok: true,
      resumed: false,
      status: verification.status,
      reason: verification.reason,
    });
  }

  resumeAfterIdentity(id).catch((err) => console.error(`[run ${id}] resume error:`, err));
  return NextResponse.json({ ok: true, resumed: true, status: verification.status }, { status: 202 });
}
