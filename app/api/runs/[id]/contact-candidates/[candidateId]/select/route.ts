import { NextResponse } from 'next/server';
import { requireOwnedContactCandidate } from '@/lib/auth/guard';
import {
  claimContactCandidateForSelection,
  createRun,
  findOrCreateProspect,
  getContactCandidate,
  updateContactCandidate,
} from '@/lib/supabase/queries';
import { parseLinkedInUrl } from '@/lib/linkedin/url';
import { research } from '@/lib/research/engine';
import { identityQueries } from '@/lib/research/queries';
import { verifySelectedCandidate } from '@/lib/identity/verify';
import { decideIdentity } from '@/lib/identity/types';
import type { IdentityCandidate } from '@/lib/identity/types';
import { executePipeline } from '@/lib/pipeline/execute';
import { checkRateLimit } from '@/lib/rate-limit';
import type { ContactCandidateStatus } from '@/lib/contacts/types';
import { preVerifyCandidate } from '@/lib/contacts/preverify';
import { selectionStatusFor } from '@/lib/contacts/select-ui';
import { inngest, OUTREACH_RUN_REQUESTED } from '@/inngest/client';

export const runtime = 'nodejs';

/**
 * The idempotent re-select response.
 *
 * This path is where the reported bug lived: it returned HTTP 200 carrying
 * `resulting_run_id` and nothing else, while the client looked for `run_id`,
 * a `message` and an `error` — found none of the three, and fell through to
 * a generic "Could not verify this candidate (HTTP 200)". A successful,
 * already-completed selection was reported to the user as a verification
 * failure.
 *
 * It now states the verification verdict explicitly (see the contract in
 * lib/contacts/select-ui.ts) and always carries a human-readable message, so
 * no branch can leave the client with nothing to say. Legacy fields are kept
 * alongside for existing consumers.
 */
function alreadyResolvedBody(identityStatus: ContactCandidateStatus, resultingRunId: string | null) {
  const status = selectionStatusFor(identityStatus);
  const resolvedToRun = status === 'verified' && Boolean(resultingRunId);

  return {
    ok: resolvedToRun,
    status,
    runId: resultingRunId,
    message: resolvedToRun
      ? 'This candidate was already verified. Opening the research run that was created for them.'
      : `This candidate was already reviewed and could not be verified (${identityStatus.toLowerCase()}). Choose another candidate.`,
    // Legacy shape, retained so existing consumers keep working.
    identity_status: identityStatus,
    resulting_run_id: resultingRunId,
    already_resolved: true,
  };
}

/**
 * A human selects a discovered contact candidate.
 *
 * Selecting is a preference, not proof — exactly the same principle the
 * original identity-candidate flow follows. This runs the SAME independent
 * verification (identityQueries + verifySelectedCandidate + decideIdentity)
 * before anything downstream happens. Only a VERIFIED outcome creates a
 * research run; AMBIGUOUS, PARTIAL and FAILED all stop here and hand the
 * decision back to the human. Nothing is ever auto-selected or auto-escalated.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; candidateId: string }> }) {
  const { id, candidateId } = await params;

  const access = await requireOwnedContactCandidate(id, candidateId);
  if ('response' in access) return access.response;
  const { user, candidate } = access;

  // Idempotent: re-clicking Select on an already-resolved candidate returns
  // the existing outcome rather than re-running verification or creating a
  // second run for the same choice.
  if (candidate.identity_status !== 'DISCOVERED') {
    return NextResponse.json(alreadyResolvedBody(candidate.identity_status, candidate.resulting_run_id));
  }

  if (!checkRateLimit().ok) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 });
  }

  // Atomic claim: only the first of two simultaneous requests for this
  // candidate gets a row back. A second, racing request stops here — before
  // any paid verification call or run creation — rather than duplicating
  // both the spend and the run. See claimContactCandidateForSelection().
  const claimed = await claimContactCandidateForSelection(candidateId);
  if (!claimed) {
    // Ownership of this candidate was already confirmed above; only its
    // resolution state may have changed since, by whichever request won the
    // race, so a plain re-read (not another ownership check) is all this needs.
    const current = await getContactCandidate(candidateId);
    return NextResponse.json(
      alreadyResolvedBody(
        current?.identity_status ?? candidate.identity_status,
        current?.resulting_run_id ?? candidate.resulting_run_id,
      ),
    );
  }

  // Server-side pre-verification, mirroring the gate the Select button uses
  // (lib/contacts/preverify.ts). The UI already disables Select for anything
  // that fails this, so reaching here means either a crafted request or a row
  // that changed underneath — either way it is refused BEFORE any paid
  // research call, rather than spending a verification pass to reach the same
  // conclusion. This is the cheap half of the check; the full identity
  // verification below still runs in its entirety for everything that passes.
  const preVerification = preVerifyCandidate(candidate);
  if (preVerification.eligibility !== 'ELIGIBLE') {
    return NextResponse.json(
      {
        ok: false,
        status: 'blocked' as const,
        error: preVerification.blockedReason ?? 'This candidate cannot be verified.',
        message: `Candidate could not be verified. Choose another candidate. ${preVerification.blockedReason ?? ''}`.trim(),
        identity_status: candidate.identity_status,
        pre_verification: preVerification,
      },
      { status: 422 },
    );
  }

  const parsed = parseLinkedInUrl(candidate.linkedin_url);
  if (!parsed.ok) {
    // Unreachable in practice — preVerifyCandidate() already parsed this same
    // URL and would have blocked above. Kept as a type-narrowing guard.
    return NextResponse.json(
      { error: `Stored LinkedIn URL is not a valid profile link: ${parsed.error}`, identity_status: 'DISCOVERED' },
      { status: 422 },
    );
  }

  const seed: IdentityCandidate = {
    id: 'contact_candidate',
    name: candidate.name,
    role: candidate.role,
    company: candidate.company,
    location: null,
    headline: null,
    linkedin_url: parsed.normalized_url,
    confidence: candidate.confidence,
    sources: candidate.evidence.map((e) => e.source_url),
    origin: 'public_research',
  };

  // Targeted corroboration for THIS person — the same call verifyIdentityStage
  // makes, not general company research.
  const corroboration = await research(
    'contact_candidate_verification',
    identityQueries({ name: seed.name, slug: parsed.slug, company: seed.company, title: seed.role }),
    [],
    [],
  );

  const evidence = await verifySelectedCandidate({
    slug: parsed.slug,
    candidate: seed,
    selectionMethod: 'USER_CONFIRMED',
    sources: corroboration.sources,
  });

  const verification = decideIdentity({
    selected: seed,
    selectionMethod: 'USER_CONFIRMED',
    profile: {
      name: seed.name,
      role: seed.role,
      company: seed.company,
      location: null,
      linkedin_url: parsed.normalized_url,
    },
    hasProfile: false,
    candidates: [seed],
    conflicts: evidence.conflicts,
    assessedConfidence: evidence.assessedConfidence,
    missingFields: evidence.missingFields,
  });

  const status: ContactCandidateStatus = verification.status;
  await updateContactCandidate(candidateId, {
    identity_status: status,
    identity_verification: verification,
  });

  // Full verification failed on a candidate that passed pre-verification —
  // the genuinely unexpected case. This is NOT a pipeline failure: the run
  // that discovered this candidate is untouched, no prospect or run is
  // created for the unverified person, and no qualification, evidence or
  // message data is produced for them. The human is handed back to the
  // candidate list with a candidate-specific reason.
  if (!verification.proceed) {
    return NextResponse.json({
      // HTTP 200 — the request succeeded. `ok: false` reports that the
      // VERIFICATION did not, which is a different question and now says so
      // explicitly rather than leaving the client to infer it.
      ok: false,
      status: selectionStatusFor(status),
      runId: null,
      message:
        status === 'AMBIGUOUS'
          ? 'Candidate could not be verified because public sources conflict about their identity or current role. Choose another candidate.'
          : `Candidate could not be verified. Choose another candidate. Independent evidence was ${status.toLowerCase()} for this person.`,
      identity_status: status,
      verification,
      candidate_verification_failed: true,
    });
  }

  // VERIFIED: create the prospect and run for this person. The run that
  // discovered them is untouched — this is a new prospect and a new run.
  let run;
  try {
    const { prospect } = await findOrCreateProspect({
      user_id: user.id,
      linkedin_slug: parsed.slug,
      linkedin_url: parsed.normalized_url,
    });

    run = await createRun({
      linkedin_url: parsed.normalized_url,
      linkedin_slug: parsed.slug,
      input_name: candidate.name,
      input_company: candidate.company,
      input_title: candidate.role,
      sender_name: null,
      user_id: user.id,
      prospect_id: prospect.id,
      origin_contact_candidate_id: candidateId,
    });
  } catch {
    return NextResponse.json({ error: 'Could not create a run for the selected candidate' }, { status: 500 });
  }

  await updateContactCandidate(candidateId, { resulting_run_id: run.id });

  // Same dispatch as POST /api/runs: in production (USE_INNGEST=true) this MUST
  // go through Inngest, not a fire-and-forget call. A serverless invocation is
  // not guaranteed to keep running once this handler's response has been sent —
  // an un-awaited executePipeline() here can be frozen mid-stage (observed:
  // stuck forever at identify_prospect), where Inngest's durable, out-of-band
  // execution is unaffected by this request's lifecycle.
  if (process.env.USE_INNGEST === 'true') {
    await inngest.send({ name: OUTREACH_RUN_REQUESTED, data: { runId: run.id } });
  } else {
    executePipeline(run.id).catch((err) => console.error(`[run ${run.id}] pipeline error:`, err));
  }

  return NextResponse.json(
    {
      ok: true,
      status: selectionStatusFor(status),
      runId: run.id,
      message: 'Candidate verified. Starting research…',
      identity_status: status,
      verification,
      run_id: run.id,
      prospect_id: run.prospect_id,
    },
    { status: 201 },
  );
}
