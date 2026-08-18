import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunRow } from '@/lib/types';
import type { ContactCandidateRow } from '@/lib/contacts/types';
import type { User } from '@supabase/supabase-js';

// Regression test for the production bug: selecting a suggested/alternative
// contact candidate got stuck forever at Stage 2 (identify_prospect) because
// app/api/runs/[id]/contact-candidates/[candidateId]/select/route.ts called
// executePipeline(run.id) as a fire-and-forget promise, unconditionally —
// unlike POST /api/runs, it never checked USE_INNGEST or sent
// OUTREACH_RUN_REQUESTED. On Vercel, a serverless invocation is not
// guaranteed to keep running un-awaited background work after the HTTP
// response is sent, so the pipeline could be frozen mid-stage with no error
// ever recorded. This test proves the route now dispatches through the same
// durable path POST /api/runs uses whenever USE_INNGEST=true, and still
// falls back to the direct call when it is not.

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

const candidate = (): ContactCandidateRow => ({
  id: CANDIDATE_ID,
  run_id: RUN_ID,
  name: 'Jordan Alt',
  role: 'VP Operations',
  company: 'Bluewave Freight',
  linkedin_url: 'https://www.linkedin.com/in/jordan-alt',
  reason: 'Owns the workflow the original contact did not.',
  evidence: [{ source_url: 'https://example.com/a', quote: 'Jordan leads ops.' }],
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
  delete process.env.USE_INNGEST;

  mockRequireOwnedContactCandidate.mockResolvedValue({
    user: owningUser,
    run: ownedRun,
    candidate: candidate(),
  });
  mockUpdateContactCandidate.mockResolvedValue(undefined);
  mockCheckRateLimit.mockReturnValue({ ok: true, remaining: 10 });
  // The atomic claim succeeds — the branch under test here is dispatch, not
  // the claim itself (see tests/select-candidate-race.test.ts for that).
  mockClaimContactCandidateForSelection.mockResolvedValue({ ...candidate(), selected_at: '2026-08-18T00:00:01Z' });
  mockGetContactCandidate.mockResolvedValue(candidate());
  mockResearch.mockResolvedValue({ sources: [] });
  mockVerifySelectedCandidate.mockResolvedValue({ conflicts: [], assessedConfidence: 90, missingFields: [] });
  // VERIFIED and proceeding — the branch that reaches run creation and dispatch.
  mockDecideIdentity.mockReturnValue({ status: 'VERIFIED', proceed: true });
  mockFindOrCreateProspect.mockResolvedValue({ prospect: { id: 'prospect-1' }, created: true });
  mockCreateRun.mockResolvedValue(newRun);
  mockInngestSend.mockResolvedValue(undefined);
  // The route calls executePipeline(...).catch(...) fire-and-forget — the
  // mock must return a real promise for that chain to be valid.
  mockExecutePipeline.mockResolvedValue(undefined);
});

describe('POST .../contact-candidates/[candidateId]/select — pipeline dispatch', () => {
  it('USE_INNGEST=true: sends OUTREACH_RUN_REQUESTED with the new run id, and does not call executePipeline directly', async () => {
    process.env.USE_INNGEST = 'true';

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.run_id).toBe(NEW_RUN_ID);

    expect(mockInngestSend).toHaveBeenCalledTimes(1);
    expect(mockInngestSend).toHaveBeenCalledWith({
      name: 'outreach/run.requested',
      data: { runId: NEW_RUN_ID },
    });

    // The bug: this used to be called unconditionally, fire-and-forget, even
    // when USE_INNGEST=true — bypassing the durable execution path entirely.
    expect(mockExecutePipeline).not.toHaveBeenCalled();
  });

  it('USE_INNGEST unset/false: falls back to the direct executePipeline() call, and does not touch Inngest', async () => {
    // beforeEach already leaves USE_INNGEST unset.
    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.run_id).toBe(NEW_RUN_ID);

    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    expect(mockExecutePipeline).toHaveBeenCalledWith(NEW_RUN_ID);

    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});
