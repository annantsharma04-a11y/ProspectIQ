import { NextResponse } from 'next/server';
import { createRun, findOrCreateProspect, listRuns } from '@/lib/supabase/queries';
import { inngest, OUTREACH_RUN_REQUESTED } from '@/inngest/client';
import { executePipeline } from '@/lib/pipeline/execute';
import { checkRateLimit, checkSharedSecret } from '@/lib/rate-limit';
import { requireUser } from '@/lib/auth/guard';
import { parseLinkedInUrl } from '@/lib/linkedin/url';
import type { RunRequest } from '@/lib/types';

export const runtime = 'nodejs';

/** History: the caller's own runs, newest first. */
export async function GET() {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;

  try {
    // Scoped to the caller — never every run in the table.
    const runs = await listRuns(auth.user.id);
    return NextResponse.json({ runs });
  } catch {
    // Generic: a database message could leak schema or connection detail.
    return NextResponse.json({ error: 'Could not load runs' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  // Shared secret first: it gates the deployment, before any session work.
  if (!checkSharedSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const auth = await requireUser();
  if ('response' in auth) return auth.response;

  if (!checkRateLimit().ok) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 });
  }

  let body: RunRequest;
  try {
    body = (await req.json()) as RunRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validation happens BEFORE a run is created, so an invalid URL never
  // produces a half-finished run in history.
  const parsed = parseLinkedInUrl(body.linkedin_url);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: 'linkedin_url' }, { status: 400 });
  }

  let run;
  let prospectCreated: boolean;
  try {
    // Resolve the persistent prospect BEFORE the run exists, so every run has a
    // prospect from the moment it is created. Re-submitting a URL that has been
    // researched before reuses the prospect and adds a run to its history — it
    // never forks a second prospect for the same person.
    const { prospect, created } = await findOrCreateProspect({
      user_id: auth.user.id,
      linkedin_slug: parsed.slug,
      linkedin_url: parsed.normalized_url,
    });
    prospectCreated = created;

    run = await createRun({
      linkedin_url: parsed.normalized_url,
      linkedin_slug: parsed.slug,
      input_name: body.prospect_name?.trim() || null,
      input_company: body.company_name?.trim() || null,
      input_title: body.prospect_title?.trim() || null,
      sender_name: body.sender_name?.trim() || null,
      // Ownership is stamped server-side from the session, never from the body.
      user_id: auth.user.id,
      prospect_id: prospect.id,
    });
  } catch {
    return NextResponse.json({ error: 'Could not create run' }, { status: 500 });
  }

  if (process.env.USE_INNGEST === 'true') {
    await inngest.send({ name: OUTREACH_RUN_REQUESTED, data: { runId: run.id } });
  } else {
    // Fire-and-forget; the live view follows progress via Realtime/polling.
    executePipeline(run.id).catch((err) => console.error(`[run ${run.id}] pipeline error:`, err));
  }

  return NextResponse.json(
    {
      id: run.id,
      linkedin_url: parsed.normalized_url,
      prospect_id: run.prospect_id,
      // Lets the client say "new run added to an existing prospect".
      prospect_created: prospectCreated,
    },
    { status: 201 },
  );
}
