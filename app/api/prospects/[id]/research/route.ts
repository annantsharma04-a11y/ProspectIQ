import { NextResponse } from 'next/server';
import { requireOwnedProspect } from '@/lib/auth/guard';
import { createRun } from '@/lib/supabase/queries';
import { executePipeline } from '@/lib/pipeline/execute';
import { inngest, OUTREACH_RUN_REQUESTED } from '@/inngest/client';
import { checkRateLimit, checkSharedSecret } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * Research an existing prospect again.
 *
 * This ADDS a run. It never edits, replaces or reruns an earlier one: the whole
 * point of prospect history is that each run stays a record of what was known
 * when it executed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!checkSharedSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const access = await requireOwnedProspect(id);
  if ('response' in access) return access.response;
  const { prospect, user } = access;

  if (!checkRateLimit().ok) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 });
  }

  let body: { sender_name?: string | null } = {};
  try {
    body = (await req.json()) as { sender_name?: string | null };
  } catch {
    // Body is optional here — the prospect already carries the identity.
  }

  let run;
  try {
    run = await createRun({
      // The prospect's stored canonical URL and slug, not client input: the
      // caller has already been authorized for THIS prospect.
      linkedin_url: prospect.linkedin_url,
      linkedin_slug: prospect.linkedin_slug,
      // Seed the new run with what is already known, exactly as a user would
      // have typed it. The pipeline still verifies identity from scratch.
      input_name: prospect.name,
      input_company: prospect.current_company,
      input_title: prospect.current_job_role,
      sender_name: body.sender_name?.trim() || null,
      user_id: user.id,
      prospect_id: prospect.id,
    });
  } catch {
    return NextResponse.json({ error: 'Could not create run' }, { status: 500 });
  }

  if (process.env.USE_INNGEST === 'true') {
    await inngest.send({ name: OUTREACH_RUN_REQUESTED, data: { runId: run.id } });
  } else {
    executePipeline(run.id).catch((err) => console.error(`[run ${run.id}] pipeline error:`, err));
  }

  return NextResponse.json({ id: run.id, prospect_id: prospect.id }, { status: 201 });
}
