import { NextResponse } from 'next/server';
import { createRun, listRuns } from '@/lib/supabase/queries';
import { inngest, OUTREACH_RUN_REQUESTED } from '@/inngest/client';
import { executePipeline } from '@/lib/pipeline/execute';
import { checkRateLimit, checkSharedSecret } from '@/lib/rate-limit';
import { parseLinkedInUrl } from '@/lib/linkedin/url';
import type { RunRequest } from '@/lib/types';

export const runtime = 'nodejs';

/** History: every real run, newest first. */
export async function GET() {
  try {
    const runs = await listRuns();
    return NextResponse.json({ runs });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load runs: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  if (!checkSharedSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
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
  try {
    run = await createRun({
      linkedin_url: parsed.normalized_url,
      linkedin_slug: parsed.slug,
      input_name: body.prospect_name?.trim() || null,
      input_company: body.company_name?.trim() || null,
      input_title: body.prospect_title?.trim() || null,
      sender_name: body.sender_name?.trim() || null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not create run: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  if (process.env.USE_INNGEST === 'true') {
    await inngest.send({ name: OUTREACH_RUN_REQUESTED, data: { runId: run.id } });
  } else {
    // Fire-and-forget; the live view follows progress via Realtime/polling.
    executePipeline(run.id).catch((err) => console.error(`[run ${run.id}] pipeline error:`, err));
  }

  return NextResponse.json({ id: run.id, linkedin_url: parsed.normalized_url }, { status: 201 });
}
