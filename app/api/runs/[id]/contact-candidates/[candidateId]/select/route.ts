import { NextResponse } from 'next/server';
import { requireOwnedContactCandidate } from '@/lib/auth/guard';
import { createRun, findOrCreateProspect, updateContactCandidate } from '@/lib/supabase/queries';
import { parseLinkedInUrl } from '@/lib/linkedin/url';
import { research } from '@/lib/research/engine';
import { identityQueries } from '@/lib/research/queries';
import { verifySelectedCandidate } from '@/lib/identity/verify';
import { decideIdentity } from '@/lib/identity/types';
import type { IdentityCandidate } from '@/lib/identity/types';
import { executePipeline } from '@/lib/pipeline/execute';
import { checkRateLimit } from '@/lib/rate-limit';
import type { ContactCandidateStatus } from '@/lib/contacts/types';

export const runtime = 'nodejs';

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
    return NextResponse.json({
      identity_status: candidate.identity_status,
      resulting_run_id: candidate.resulting_run_id,
      already_resolved: true,
    });
  }

  if (!checkRateLimit().ok) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 });
  }

  await updateContactCandidate(candidateId, { selected_at: new Date().toISOString() });

  // No LinkedIn URL means no research target under this system's identity
  // model — refusing rather than guessing which profile this person owns.
  if (!candidate.linkedin_url) {
    return NextResponse.json(
      {
        error:
          'This candidate has no public LinkedIn URL, so identity cannot be verified. Confirm this person manually, or choose a different candidate.',
        identity_status: 'DISCOVERED',
      },
      { status: 422 },
    );
  }

  const parsed = parseLinkedInUrl(candidate.linkedin_url);
  if (!parsed.ok) {
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

  if (!verification.proceed) {
    return NextResponse.json({
      identity_status: status,
      verification,
      message:
        status === 'AMBIGUOUS'
          ? 'Identity ambiguous. Choose another candidate or confirm manually.'
          : `Identity ${status.toLowerCase()} — independent evidence was not strong enough to proceed automatically.`,
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

  executePipeline(run.id).catch((err) => console.error(`[run ${run.id}] pipeline error:`, err));

  return NextResponse.json(
    { identity_status: status, verification, run_id: run.id, prospect_id: run.prospect_id },
    { status: 201 },
  );
}
