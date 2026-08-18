import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunRow } from '@/lib/types';
import type { ContactCandidateRow } from '@/lib/contacts/types';
import type { User } from '@supabase/supabase-js';

// Regression test for the contact-candidate selection race: selecting a
// DISCOVERED candidate used to be a plain read-then-write (check
// identity_status, THEN write selected_at in a separate call) — two
// near-simultaneous POSTs to the select endpoint could both pass the check
// before either write landed, both run paid verification (research +
// verifySelectedCandidate), and both create a prospect + run for the same
// candidate, leaving one run permanently orphaned (its resulting_run_id
// overwritten by whichever request updated last) while both were fully
// billed. claimContactCandidateForSelection() closes this by making the
// claim itself an atomic conditional UPDATE (`... WHERE selected_at is
// null`), so only one of two racing requests can ever proceed past it.

const mockRequireOwnedContactCandidate = vi.fn();
const mockClaimContactCandidateForSelection = vi.fn();
const mockGetContactCandidate = vi.fn();
const mockCreateRun = vi.fn();
const mockFindOrCreateProspect = vi.fn();
const mockUpdateContactCandidate = vi.fn();
const mockResearch = vi.fn();
const mockVerifySelectedCandidate = vi.fn();
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

vi.mock('@/lib/research/engine', () => ({
  research: (...a: unknown[]) => mockResearch(...a),
}));

vi.mock('@/lib/identity/verify', () => ({
  verifySelectedCandidate: (...a: unknown[]) => mockVerifySelectedCandidate(...a),
}));

vi.mock('@/lib/identity/types', () => ({
  decideIdentity: (...a: unknown[]) => mockDecideIdentity(...a),
}));

vi.mock('@/lib/pipeline/execute', () => ({
  executePipeline: (...a: unknown[]) => mockExecutePipeline(...a),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => mockCheckRateLimit(),
}));

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

const discoveredCandidate = (): ContactCandidateRow => ({
  id: CANDIDATE_ID,
  run_id: RUN_ID,
  name: 'Jordan Alt',
  role: 'VP Operations',
  company: 'Bluewave Freight',
  linkedin_url: 'https://www.linkedin.com/in/jordan-alt',
  reason: 'Owns the workflow the original contact did not.',
  evidence: [{ source_url: 'https://example.com/a', quote: 'Jordan Alt leads operations at Bluewave Freight.' }],
  confidence: 80,
  rank_score: 80,
  identity_status: 'DISCOVERED',
  identity_verification: null,
  selected_at: null,
  resulting_run_id: null,
  created_at: '2026-08-18T00:00:00Z',
});

const newRun = { id: NEW_RUN_ID, prospect_id: 'prospect-1' } as RunRow;

function makeRequest(): Request {
  return new Request(`http://localhost/api/runs/${RUN_ID}/contact-candidates/${CANDIDATE_ID}/select`, {
    method: 'POST',
  });
}

function makeParams() {
  return { params: Promise.resolve({ id: RUN_ID, candidateId: CANDIDATE_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();

  mockRequireOwnedContactCandidate.mockResolvedValue({
    user: owningUser,
    run: ownedRun,
    candidate: discoveredCandidate(),
  });
  mockCheckRateLimit.mockReturnValue({ ok: true, remaining: 10 });
  mockUpdateContactCandidate.mockResolvedValue(undefined);
  mockResearch.mockResolvedValue({ sources: [] });
  mockVerifySelectedCandidate.mockResolvedValue({ conflicts: [], assessedConfidence: 90, missingFields: [] });
  mockDecideIdentity.mockReturnValue({ status: 'VERIFIED', proceed: true });
  mockFindOrCreateProspect.mockResolvedValue({ prospect: { id: 'prospect-1' }, created: true });
  mockCreateRun.mockResolvedValue(newRun);
  mockInngestSend.mockResolvedValue(undefined);
  mockExecutePipeline.mockResolvedValue(undefined);
});

describe('POST .../contact-candidates/[candidateId]/select — concurrent selection', () => {
  it('two simultaneous requests: only one claims, verifies, and creates a run', async () => {
    // Simulates the atomic `UPDATE ... WHERE selected_at is null` — only the
    // first of the two concurrent calls "wins" the row; every call after
    // that (including a genuine third click later) sees it already claimed.
    let claimed = false;
    mockClaimContactCandidateForSelection.mockImplementation(async () => {
      if (claimed) return null;
      claimed = true;
      return { ...discoveredCandidate(), selected_at: '2026-08-18T00:00:01Z' };
    });
    mockGetContactCandidate.mockResolvedValue({
      ...discoveredCandidate(),
      selected_at: '2026-08-18T00:00:01Z',
    });

    const [resA, resB] = await Promise.all([
      POST(makeRequest(), makeParams()),
      POST(makeRequest(), makeParams()),
    ]);
    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 201]);

    const winner = resA.status === 201 ? bodyA : bodyB;
    const loser = resA.status === 201 ? bodyB : bodyA;

    expect(winner.run_id).toBe(NEW_RUN_ID);
    expect(loser.already_resolved).toBe(true);
    expect(loser.run_id).toBeUndefined();

    // The expensive, paid work happened exactly once, not twice.
    expect(mockResearch).toHaveBeenCalledTimes(1);
    expect(mockVerifySelectedCandidate).toHaveBeenCalledTimes(1);
    expect(mockFindOrCreateProspect).toHaveBeenCalledTimes(1);
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    expect(mockClaimContactCandidateForSelection).toHaveBeenCalledTimes(2);
  });

  it('a single valid selection is unaffected: claims, verifies, and creates exactly one run', async () => {
    mockClaimContactCandidateForSelection.mockResolvedValue({
      ...discoveredCandidate(),
      selected_at: '2026-08-18T00:00:01Z',
    });

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.run_id).toBe(NEW_RUN_ID);
    expect(body.prospect_id).toBe('prospect-1');

    expect(mockClaimContactCandidateForSelection).toHaveBeenCalledTimes(1);
    expect(mockClaimContactCandidateForSelection).toHaveBeenCalledWith(CANDIDATE_ID);
    expect(mockResearch).toHaveBeenCalledTimes(1);
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    expect(mockInngestSend).not.toHaveBeenCalled(); // USE_INNGEST unset in this test
  });

  it('re-selecting an already-resolved candidate never reaches the atomic claim', async () => {
    mockRequireOwnedContactCandidate.mockResolvedValue({
      user: owningUser,
      run: ownedRun,
      candidate: { ...discoveredCandidate(), identity_status: 'VERIFIED', resulting_run_id: NEW_RUN_ID },
    });

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.already_resolved).toBe(true);
    expect(body.resulting_run_id).toBe(NEW_RUN_ID);
    expect(mockClaimContactCandidateForSelection).not.toHaveBeenCalled();
    expect(mockResearch).not.toHaveBeenCalled();
  });
});
