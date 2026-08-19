import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunRow } from '@/lib/types';
import type { ContactCandidateRow } from '@/lib/contacts/types';
import type { User } from '@supabase/supabase-js';

// The two guarantees that must survive pre-verification being added in front
// of the Select button (lib/contacts/preverify.ts):
//
//   6. A selected candidate STILL receives the full identity verification —
//      pre-verification is an additional gate, never a replacement for it.
//   7. When that full verification fails, NO downstream outreach data is
//      created for the unverified person, and the original run is untouched.
//
// Plus the server-side half of the gate: a candidate that fails
// pre-verification is refused BEFORE any paid research call, so a crafted
// request cannot spend a verification pass the UI would have prevented.

const mockRequireOwnedContactCandidate = vi.fn();
const mockClaimContactCandidateForSelection = vi.fn();
const mockGetContactCandidate = vi.fn();
const mockCreateRun = vi.fn();
const mockFindOrCreateProspect = vi.fn();
const mockUpdateContactCandidate = vi.fn();
const mockResearch = vi.fn();
const mockVerifySelectedCandidate = vi.fn();
const mockRetrieveLinkedInProfile = vi.fn();
const mockDecideIdentity = vi.fn();
const mockExecutePipeline = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockInngestSend = vi.fn();

vi.mock('@/lib/auth/guard', () => ({
  requireOwnedContactCandidate: (...a: unknown[]) => mockRequireOwnedContactCandidate(...a),
}));

vi.mock('@/lib/supabase/queries', () => ({
  claimContactCandidateForSelection: (...a: unknown[]) => mockClaimContactCandidateForSelection(...a),
  getContactCandidate: (...a: unknown[]) => mockGetContactCandidate(...a),
  createRun: (...a: unknown[]) => mockCreateRun(...a),
  findOrCreateProspect: (...a: unknown[]) => mockFindOrCreateProspect(...a),
  updateContactCandidate: (...a: unknown[]) => mockUpdateContactCandidate(...a),
}));

vi.mock('@/lib/research/engine', () => ({ research: (...a: unknown[]) => mockResearch(...a) }));
vi.mock('@/lib/identity/verify', () => ({
  verifySelectedCandidate: (...a: unknown[]) => mockVerifySelectedCandidate(...a),
}));
// No real profile in these tests — reconcileProvenance() (real, unmocked)
// then has nothing PROFILE-sourced to promote a conflict's provenance with,
// which keeps this file's existing conflict-free fixtures behaving exactly
// as before. The current-employment reconciliation itself is tested
// directly in tests/select-candidate-current-employment.test.ts.
vi.mock('@/lib/linkedin/fetch', () => ({
  retrieveLinkedInProfile: (...a: unknown[]) => mockRetrieveLinkedInProfile(...a),
}));
vi.mock('@/lib/identity/types', () => ({ decideIdentity: (...a: unknown[]) => mockDecideIdentity(...a) }));
vi.mock('@/lib/pipeline/execute', () => ({ executePipeline: (...a: unknown[]) => mockExecutePipeline(...a) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => mockCheckRateLimit() }));
vi.mock('@/inngest/client', () => ({
  inngest: { send: (...a: unknown[]) => mockInngestSend(...a) },
  OUTREACH_RUN_REQUESTED: 'outreach/run.requested',
}));

const { POST } = await import('@/app/api/runs/[id]/contact-candidates/[candidateId]/select/route');

const RUN_ID = 'run-original-1';
const NEW_RUN_ID = 'run-alternate-1';
const CANDIDATE_ID = 'candidate-1';

const owningUser = { id: 'user-1' } as User;
const ownedRun = { id: RUN_ID, user_id: 'user-1' } as RunRow;

/** A candidate that PASSES pre-verification — evidence names them and their company. */
const eligibleCandidate = (over: Partial<ContactCandidateRow> = {}): ContactCandidateRow =>
  ({
    id: CANDIDATE_ID,
    run_id: RUN_ID,
    name: 'Jordan Alt',
    role: 'VP Operations',
    company: 'Bluewave Freight',
    linkedin_url: 'https://www.linkedin.com/in/jordan-alt',
    reason: 'Owns the workflow the original contact did not.',
    evidence: [
      { source_url: 'https://example.com/a', quote: 'Jordan Alt leads operations at Bluewave Freight.' },
    ],
    confidence: 80,
    rank_score: 80,
    identity_status: 'DISCOVERED',
    identity_verification: null,
    selected_at: null,
    resulting_run_id: null,
    created_at: '2026-08-18T00:00:00Z',
    ...over,
  }) as ContactCandidateRow;

const newRun = { id: NEW_RUN_ID, prospect_id: 'prospect-1' } as RunRow;

const makeRequest = () =>
  new Request(`http://localhost/api/runs/${RUN_ID}/contact-candidates/${CANDIDATE_ID}/select`, { method: 'POST' });
const makeParams = () => ({ params: Promise.resolve({ id: RUN_ID, candidateId: CANDIDATE_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.USE_INNGEST;

  mockRequireOwnedContactCandidate.mockResolvedValue({
    user: owningUser,
    run: ownedRun,
    candidate: eligibleCandidate(),
  });
  mockCheckRateLimit.mockReturnValue({ ok: true, remaining: 10 });
  mockUpdateContactCandidate.mockResolvedValue(undefined);
  mockClaimContactCandidateForSelection.mockResolvedValue({
    ...eligibleCandidate(),
    selected_at: '2026-08-18T00:00:01Z',
  });
  mockGetContactCandidate.mockResolvedValue(eligibleCandidate());
  mockResearch.mockResolvedValue({ sources: [] });
  mockRetrieveLinkedInProfile.mockResolvedValue({
    profile: null,
    access: { directLinkedIn: false, primarySource: 'public_web', profileCompleteness: 'none', reason: null },
    meta: null,
    error_code: 'no_token',
    duration_ms: 0,
  });
  mockVerifySelectedCandidate.mockResolvedValue({ conflicts: [], assessedConfidence: 90, missingFields: [], corroboratedFields: [] });
  mockDecideIdentity.mockReturnValue({ status: 'VERIFIED', proceed: true });
  mockFindOrCreateProspect.mockResolvedValue({ prospect: { id: 'prospect-1' }, created: true });
  mockCreateRun.mockResolvedValue(newRun);
  mockInngestSend.mockResolvedValue(undefined);
  mockExecutePipeline.mockResolvedValue(undefined);
});

// ─── 6. full identity verification still runs after selection ───────────────

describe('6. a selected candidate still receives the FULL identity verification', () => {
  it('runs targeted corroboration, verifySelectedCandidate and decideIdentity before creating anything', async () => {
    const res = await POST(makeRequest(), makeParams());

    expect(res.status).toBe(201);

    // Pre-verification did not short-circuit any of these.
    expect(mockResearch).toHaveBeenCalledTimes(1);
    expect(mockVerifySelectedCandidate).toHaveBeenCalledTimes(1);
    expect(mockDecideIdentity).toHaveBeenCalledTimes(1);

    // And the human's choice is passed as a preference, never as proof.
    expect(mockVerifySelectedCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ selectionMethod: 'USER_CONFIRMED' }),
    );
  });

  it('verifies BEFORE the run is created, never after', async () => {
    const order: string[] = [];
    mockVerifySelectedCandidate.mockImplementation(async () => {
      order.push('verify');
      return { conflicts: [], assessedConfidence: 90, missingFields: [], corroboratedFields: [] };
    });
    mockCreateRun.mockImplementation(async () => {
      order.push('createRun');
      return newRun;
    });

    await POST(makeRequest(), makeParams());

    expect(order).toEqual(['verify', 'createRun']);
  });
});

// ─── 7. failed final verification creates no downstream outreach ────────────

describe('7. a failed final verification produces no downstream outreach data', () => {
  for (const status of ['AMBIGUOUS', 'FAILED', 'PARTIAL'] as const) {
    it(`${status}: no prospect, no run, no pipeline dispatch`, async () => {
      mockDecideIdentity.mockReturnValue({ status, proceed: false });

      const res = await POST(makeRequest(), makeParams());
      const body = await res.json();

      expect(body.identity_status).toBe(status);
      expect(body.candidate_verification_failed).toBe(true);

      // Nothing downstream was created for an unverified person.
      expect(mockFindOrCreateProspect).not.toHaveBeenCalled();
      expect(mockCreateRun).not.toHaveBeenCalled();
      expect(mockExecutePipeline).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
      expect(body.run_id).toBeUndefined();
    });
  }

  it('reports the candidate-specific message and hands the user back to candidate selection', async () => {
    mockDecideIdentity.mockReturnValue({ status: 'AMBIGUOUS', proceed: false });

    const body = await (await POST(makeRequest(), makeParams())).json();

    // AMBIGUOUS names the actual conflict rather than issuing a generic
    // refusal, and still tells the user what to do next.
    expect(body.message).toMatch(/public sources conflict about their identity or current role/i);
    expect(body.message).toMatch(/Choose another candidate/i);
  });

  it('records the outcome on the candidate row, leaving the original run untouched', async () => {
    mockDecideIdentity.mockReturnValue({ status: 'AMBIGUOUS', proceed: false });

    await POST(makeRequest(), makeParams());

    expect(mockUpdateContactCandidate).toHaveBeenCalledWith(
      CANDIDATE_ID,
      expect.objectContaining({ identity_status: 'AMBIGUOUS' }),
    );
    // resulting_run_id is only ever set on the success path.
    for (const call of mockUpdateContactCandidate.mock.calls) {
      expect(call[1]).not.toHaveProperty('resulting_run_id');
    }
  });
});

// ─── the response contract the client reads ─────────────────────────────────

describe('the route states the verification verdict explicitly', () => {
  it('6. VERIFIED: emits ok/status/runId so a 201 is unambiguously a success', async () => {
    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('verified');
    expect(body.runId).toBe(NEW_RUN_ID);
    expect(body.message).toMatch(/starting research/i);
    // Legacy field kept so existing consumers keep working.
    expect(body.run_id).toBe(NEW_RUN_ID);
  });

  for (const [identityStatus, wire] of [
    ['AMBIGUOUS', 'ambiguous'],
    ['FAILED', 'failed'],
    ['PARTIAL', 'partial'],
  ] as const) {
    it(`${identityStatus}: HTTP 200 but ok:false and status:'${wire}' — never a bare 200`, async () => {
      mockDecideIdentity.mockReturnValue({ status: identityStatus, proceed: false });

      const res = await POST(makeRequest(), makeParams());
      const body = await res.json();

      // The request succeeded...
      expect(res.status).toBe(200);
      // ...the verification did not, and the body says so.
      expect(body.ok).toBe(false);
      expect(body.status).toBe(wire);
      expect(body.runId).toBeNull();
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });
  }

  it('every non-proceeding verdict carries a message, so the client can never fall through', async () => {
    for (const identityStatus of ['AMBIGUOUS', 'FAILED', 'PARTIAL'] as const) {
      vi.clearAllMocks();
      mockRequireOwnedContactCandidate.mockResolvedValue({
        user: owningUser,
        run: ownedRun,
        candidate: eligibleCandidate(),
      });
      mockCheckRateLimit.mockReturnValue({ ok: true, remaining: 10 });
      mockClaimContactCandidateForSelection.mockResolvedValue({
        ...eligibleCandidate(),
        selected_at: '2026-08-18T00:00:01Z',
      });
      mockResearch.mockResolvedValue({ sources: [] });
      mockVerifySelectedCandidate.mockResolvedValue({ conflicts: [], assessedConfidence: 50, missingFields: [], corroboratedFields: [] });
      mockDecideIdentity.mockReturnValue({ status: identityStatus, proceed: false });

      const body = await (await POST(makeRequest(), makeParams())).json();
      expect(body.message, `${identityStatus} must carry a message`).toBeTruthy();
    }
  });
});

// ─── server-side pre-verification gate ──────────────────────────────────────

describe('the select route refuses a pre-verification failure before spending anything', () => {
  it('rejects a candidate whose evidence names someone else, with no research call', async () => {
    mockRequireOwnedContactCandidate.mockResolvedValue({
      user: owningUser,
      run: ownedRun,
      candidate: eligibleCandidate({
        evidence: [{ source_url: 'https://example.com/a', quote: 'Someone Else leads operations at Bluewave Freight.' }],
      }),
    });

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.message).toMatch(/Candidate could not be verified\. Choose another candidate\./);
    expect(body.pre_verification.eligibility).toBe('NEEDS_VERIFICATION');

    // The whole point: refused before any paid work.
    expect(mockResearch).not.toHaveBeenCalled();
    expect(mockVerifySelectedCandidate).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('rejects an unusable LinkedIn URL before any research call', async () => {
    mockRequireOwnedContactCandidate.mockResolvedValue({
      user: owningUser,
      run: ownedRun,
      candidate: eligibleCandidate({ linkedin_url: null }),
    });

    const res = await POST(makeRequest(), makeParams());

    expect(res.status).toBe(422);
    expect(mockResearch).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
  });
});
