import { NextResponse } from 'next/server';
import { requireOwnedRun } from '@/lib/auth/guard';
import { findOrCreateProspect, updateRun } from '@/lib/supabase/queries';
import { parseLinkedInUrl } from '@/lib/linkedin/url';
import { classifyFailure } from '@/lib/pipeline/failure-classification';
import { retryRun } from '@/lib/pipeline/execute';
import { checkRateLimit } from '@/lib/rate-limit';
import { inngest, OUTREACH_RUN_REQUESTED } from '@/inngest/client';

export const runtime = 'nodejs';

interface EditRetryBody {
  linkedin_url?: string;
  input_name?: string | null;
  input_company?: string | null;
  input_title?: string | null;
}

const trimmed = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

/**
 * Correct the input a run was started with, then re-run it.
 *
 * Only offered for failures the user can actually fix — an invalid profile
 * URL, or hints too thin/wrong for identity verification to settle on one
 * person (see lib/pipeline/failure-classification.ts). An infrastructure
 * failure is refused here on purpose: nothing about the input is wrong, so
 * editing it would be theatre, and POST /api/runs/[id]/retry is the correct
 * action.
 *
 * The run row is edited in place and re-executed — it keeps its id and its
 * history, exactly like the existing retry. This does NOT weaken anything
 * downstream: identity verification, qualification and evidence rules all run
 * again in full against the corrected input.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireOwnedRun(id);
  if ('response' in access) return access.response;
  const { user, run } = access;

  if (run.status === 'running' || run.status === 'queued') {
    return NextResponse.json({ error: 'Run is already in progress' }, { status: 409 });
  }

  // The same classifier the UI branches on decides whether this route applies
  // at all, so a hand-crafted request cannot route an infrastructure failure
  // through the edit path and imply the user caused it.
  const classification = classifyFailure(run);
  if (!classification?.isEditable) {
    return NextResponse.json(
      {
        error:
          classification?.kind === 'CONFIGURATION'
            ? 'This run failed because of a deployment configuration problem, which editing your details cannot fix.'
            : 'This run did not fail because of your input, so there is nothing to correct. Use Retry instead.',
        kind: classification?.kind ?? null,
      },
      { status: 409 },
    );
  }

  if (!checkRateLimit().ok) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 });
  }

  let body: EditRetryBody;
  try {
    body = (await req.json()) as EditRetryBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Absent means "leave unchanged"; present-but-blank means "clear this hint".
  const nextUrl = typeof body.linkedin_url === 'string' ? body.linkedin_url.trim() : run.linkedin_url;
  const patch: Record<string, unknown> = {
    input_name: 'input_name' in body ? trimmed(body.input_name) : run.input_name,
    input_company: 'input_company' in body ? trimmed(body.input_company) : run.input_company,
    input_title: 'input_title' in body ? trimmed(body.input_title) : run.input_title,
  };

  // Validated with the SAME parser the pipeline uses, so a URL accepted here
  // cannot fail validate_input for a reason this route did not already report.
  const parsed = parseLinkedInUrl(nextUrl);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: 'linkedin_url' }, { status: 400 });
  }

  const urlChanged = parsed.normalized_url !== run.linkedin_url;
  if (urlChanged) {
    patch.linkedin_url = parsed.normalized_url;
    patch.linkedin_slug = parsed.slug;

    // A corrected URL can point at a DIFFERENT person, so the run must be
    // re-pointed at that person's prospect. Leaving it attached to the
    // original would make syncProspectFromRun() write this run's identity
    // onto the wrong prospect's record when it completes.
    try {
      const { prospect } = await findOrCreateProspect({
        user_id: user.id,
        linkedin_slug: parsed.slug,
        linkedin_url: parsed.normalized_url,
      });
      patch.prospect_id = prospect.id;
    } catch {
      return NextResponse.json({ error: 'Could not resolve the prospect for that URL' }, { status: 500 });
    }

    // Identity is re-established from scratch on the new URL — carrying the
    // old person's resolved identity forward would be a lie about who this
    // run is about.
    patch.prospect_name = null;
    patch.prospect_title = null;
    patch.company_name = null;
    patch.identity_status = null;
    patch.identity_resolution = null;
    patch.identity_verification = null;
    patch.identity_confidence = null;
    patch.linkedin_profile = null;
    patch.profile_access = null;
  }

  // Clear the previous failure before re-running, so a stale error cannot be
  // mistaken for the outcome of this attempt.
  patch.status = 'queued';
  patch.error = null;
  patch.ai_error_type = null;
  patch.completed_at = null;
  patch.insufficient_evidence = false;

  try {
    await updateRun(id, patch);
  } catch {
    return NextResponse.json({ error: 'Could not save the corrected details' }, { status: 500 });
  }

  // An input edit invalidates identity, and everything downstream is built on
  // identity — so this always restarts from validate_input. Same durable
  // dispatch as every other pipeline entry point.
  if (process.env.USE_INNGEST === 'true') {
    await inngest.send({ name: OUTREACH_RUN_REQUESTED, data: { runId: id } });
  } else {
    retryRun(id).catch((err) => console.error(`[run ${id}] edit-retry error:`, err));
  }

  return NextResponse.json(
    { ok: true, retried: true, url_changed: urlChanged, retry_from_stage: classification.retryFromStage },
    { status: 202 },
  );
}
