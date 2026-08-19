import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunRow } from '@/lib/types';
import type { ContactCandidateRow } from '@/lib/contacts/types';
import type { User } from '@supabase/supabase-js';

// The Maneesh Arora / AJIO case: candidate discovery proposed "Maneesh Arora
// — CFO, AJIO.com" from a single, undated LinkedIn post ("Our CFO, Maneesh
// Arora won the 'Most Impactful CFO' award"). His real, current LinkedIn
// experience is:
//   AJIO.com — Chief Financial Officer — Oct 2020 to Jun 2024
//   Reliance Retail — Group Chief Financial Officer — Jul 2024 to Present
// He is NOT a current AJIO contact, but selecting the candidate still
// resolved VERIFIED, because the select route never fetched his real
// profile (hasProfile: false, always) and decideIdentity() only treats a
// conflict as material when its provenance is PROFILE/USER_HINT/
// PUBLIC_EVIDENCE — never bare CANDIDATE, which is all a search-synthesized
// model conflict can ever be there.
//
// The fix: fetch the real profile at selection time (the same call
// identify_prospect already makes, just made before the decision instead of
// after), reconcile the model's conflicts against it so a profile-backed
// mismatch gets PROFILE provenance and can block, AND add one deterministic
// fallback (currentEmploymentConflict, lib/identity/provenance.ts) for the
// case the model's own conflict detection misses entirely. Real
// decideIdentity/reconcileProvenance run unmocked — only the model call and
// the provider fetch are mocked.

const mockRequireOwnedContactCandidate = vi.fn();
const mockClaimContactCandidateForSelection = vi.fn();
const mockGetContactCandidate = vi.fn();
const mockCreateRun = vi.fn();
const mockFindOrCreateProspect = vi.fn();
const mockUpdateContactCandidate = vi.fn();
const mockResearch = vi.fn();
const mockVerifySelectedCandidate = vi.fn();
const mockRetrieveLinkedInProfile = vi.fn();
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
vi.mock('@/lib/linkedin/fetch', () => ({
  retrieveLinkedInProfile: (...a: unknown[]) => mockRetrieveLinkedInProfile(...a),
}));
// decideIdentity and reconcileProvenance are deliberately REAL — this test
// proves the actual wiring, not a mocked stand-in for it.
vi.mock('@/lib/pipeline/execute', () => ({ executePipeline: (...a: unknown[]) => mockExecutePipeline(...a) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => mockCheckRateLimit() }));
vi.mock('@/inngest/client', () => ({
  inngest: { send: (...a: unknown[]) => mockInngestSend(...a) },
  OUTREACH_RUN_REQUESTED: 'outreach/run.requested',
}));

const { POST } = await import('@/app/api/runs/[id]/contact-candidates/[candidateId]/select/route');

const RUN_ID = 'run-original-1';
const CANDIDATE_ID = 'candidate-1';
const owningUser = { id: 'user-1' } as User;
const ownedRun = { id: RUN_ID, user_id: 'user-1' } as RunRow;

const maneeshCandidate = (over: Partial<ContactCandidateRow> = {}): ContactCandidateRow =>
  ({
    id: CANDIDATE_ID,
    run_id: RUN_ID,
    name: 'Maneesh Arora',
    role: 'CFO',
    company: 'AJIO.com',
    linkedin_url: 'https://www.linkedin.com/in/maneesharora23',
    reason: 'Public role matches the qualified workflow.',
    evidence: [
      {
        source_url: 'https://www.linkedin.com/posts/ajiolife_financememes-cfo-worldbestcfo-activity-7034878859565023232-sbyq',
        quote: "Our CFO, Maneesh Arora won the 'Most Impactful CFO' award, and we can't contain our joy.",
      },
    ],
    confidence: 83,
    rank_score: 99.4,
    identity_status: 'DISCOVERED',
    identity_verification: null,
    selected_at: null,
    resulting_run_id: null,
    created_at: '2026-08-19T00:00:00Z',
    ...over,
  }) as ContactCandidateRow;

const profile = (over: Partial<{ currentCompany: { name: string | null; title: string | null; url: string | null } | null }> = {}) => ({
  url: 'https://www.linkedin.com/in/maneesharora23',
  name: 'Maneesh Arora',
  headline: 'Group Chief Financial Officer at Reliance Retail',
  about: null,
  location: null,
  currentCompany: { name: 'Reliance Retail', title: 'Group Chief Financial Officer', url: null },
  experience: [
    { company: 'Reliance Retail', title: 'Group Chief Financial Officer', location: null, startDate: 'Jul 2024', endDate: null, description: null },
    { company: 'AJIO.com', title: 'Chief Financial Officer', location: null, startDate: 'Oct 2020', endDate: 'Jun 2024', description: null },
  ],
  education: [],
  skills: [],
  posts: [],
  followers: null,
  connections: null,
  ...over,
});

function profileResult(p: ReturnType<typeof profile> | null) {
  return {
    profile: p,
    access: {
      directLinkedIn: Boolean(p),
      primarySource: p ? 'brightdata' : 'public_web',
      profileCompleteness: p ? 'full' : 'none',
      reason: p ? null : 'no profile available',
    },
    meta: null,
    error_code: p ? null : 'empty_profile',
    duration_ms: 1000,
  };
}

const makeRequest = () =>
  new Request(`http://localhost/api/runs/${RUN_ID}/contact-candidates/${CANDIDATE_ID}/select`, { method: 'POST' });
const makeParams = () => ({ params: Promise.resolve({ id: RUN_ID, candidateId: CANDIDATE_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.USE_INNGEST;
  mockRequireOwnedContactCandidate.mockResolvedValue({ user: owningUser, run: ownedRun, candidate: maneeshCandidate() });
  mockCheckRateLimit.mockReturnValue({ ok: true, remaining: 10 });
  mockUpdateContactCandidate.mockResolvedValue(undefined);
  mockClaimContactCandidateForSelection.mockResolvedValue({ ...maneeshCandidate(), selected_at: '2026-08-19T00:00:01Z' });
  mockGetContactCandidate.mockResolvedValue(maneeshCandidate());
  mockResearch.mockResolvedValue({ sources: [] });
  mockFindOrCreateProspect.mockResolvedValue({ prospect: { id: 'prospect-1' }, created: true });
  mockCreateRun.mockResolvedValue({ id: 'run-new-1', prospect_id: 'prospect-1' });
  mockInngestSend.mockResolvedValue(undefined);
  mockExecutePipeline.mockResolvedValue(undefined);
});

describe('1. a current CFO at the target company is eligible', () => {
  it('profile matches the claimed company, model reports no conflict — VERIFIED', async () => {
    mockRetrieveLinkedInProfile.mockResolvedValue(
      profileResult(profile({ currentCompany: { name: 'AJIO.com', title: 'Chief Financial Officer', url: null } })),
    );
    mockVerifySelectedCandidate.mockResolvedValue({
      conflicts: [],
      assessedConfidence: 90,
      missingFields: [],
      corroboratedFields: ['name', 'company', 'role'],
    });

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(body.status).toBe('verified');
    expect(body.verification.status).toBe('VERIFIED');
    expect(mockCreateRun).toHaveBeenCalled();
  });
});

describe('2. a former CFO with an explicit end date is excluded', () => {
  it('the model itself reports the company conflict — real profile promotes it to blocking', async () => {
    mockRetrieveLinkedInProfile.mockResolvedValue(profileResult(profile()));
    mockVerifySelectedCandidate.mockResolvedValue({
      conflicts: [
        {
          field: 'company',
          candidate_value: 'AJIO.com',
          public_value: 'Reliance Retail',
          explanation:
            'Sources indicate the candidate previously served as CFO at AJIO.com from October 2020 to June 2024, and is currently Group Chief Financial Officer at Reliance Retail.',
          sources: [],
        },
      ],
      assessedConfidence: 85,
      missingFields: [],
      corroboratedFields: ['name'],
    });

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(['ambiguous', 'partial', 'failed']).toContain(body.status);
    expect(body.verification.status).not.toBe('VERIFIED');
    expect(mockCreateRun).not.toHaveBeenCalled();
  });
});

describe('3. historical evidence with no current-role signal from the model is still excluded once the real profile disagrees', () => {
  it('model reports NO conflict (only saw the old post) — the deterministic profile check still blocks for a genuinely unrelated company', async () => {
    // A genuinely unrelated employer — not a corporate relative of AJIO.com,
    // unlike Reliance Retail (see tests/corporate-groups.test.ts for that
    // specific, now-intentionally-different behavior).
    mockRetrieveLinkedInProfile.mockResolvedValue(
      profileResult(profile({ currentCompany: { name: 'Bluewave Freight', title: 'VP Finance', url: null } })),
    );
    // The model, given only the old undated LinkedIn post, finds nothing to
    // contradict the claim — this is the real gap: reconcileProvenance only
    // relabels conflicts it's given, so without the deterministic fallback
    // this candidate would sail straight through to VERIFIED.
    mockVerifySelectedCandidate.mockResolvedValue({
      conflicts: [],
      assessedConfidence: 88,
      missingFields: [],
      corroboratedFields: ['name', 'company'],
    });

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.verification.status).not.toBe('VERIFIED');
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('when no profile can be fetched at all, behavior is unchanged from before this fix (a known, documented limit — not a regression)', async () => {
    mockRetrieveLinkedInProfile.mockResolvedValue(profileResult(null));
    mockVerifySelectedCandidate.mockResolvedValue({
      conflicts: [],
      assessedConfidence: 88,
      missingFields: [],
      corroboratedFields: ['name', 'company'],
    });

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    // No profile to check against and nothing the model flagged — proceeds
    // exactly as the route always did with hasProfile:false. Documents the
    // fix's real boundary rather than silently assuming coverage it can't have.
    expect(body.verification.status).toBe('VERIFIED');
  });
});

describe('4. a genuinely concurrent current role is not incorrectly excluded', () => {
  it('the model itself frames the mismatch as a possible concurrent role — held for review, not silently rejected as a hard conflict, and not duplicated by the deterministic fallback', async () => {
    mockRetrieveLinkedInProfile.mockResolvedValue(
      profileResult(profile({ currentCompany: { name: 'Personal Foundation', title: 'Founder', url: null } })),
    );
    mockVerifySelectedCandidate.mockResolvedValue({
      conflicts: [
        {
          field: 'company',
          candidate_value: 'AJIO.com',
          public_value: 'Personal Foundation',
          explanation:
            'Multiple recent sources state, in the present tense with no departure or end date, that this person is also CFO at AJIO.com; this may be a concurrent role rather than a job change.',
          sources: [],
        },
      ],
      assessedConfidence: 80,
      missingFields: [],
      corroboratedFields: ['name'],
    });

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    // Held for a human, exactly like the plain former-role case — this
    // fix's job is to make sure the mismatch is never silently discarded,
    // not to auto-approve or auto-reject a concurrent-role read.
    expect(body.ok).toBe(false);
    expect(body.verification.status).not.toBe('VERIFIED');
    // Exactly one company conflict reached decideIdentity — the model's own
    // concurrent-role-aware entry — not a second, duplicated one from the
    // deterministic fallback.
    const companyConflicts = (body.verification.conflicts as { field: string; explanation: string }[]).filter(
      (c) => c.field === 'company',
    );
    expect(companyConflicts).toHaveLength(1);
    expect(companyConflicts[0].explanation).toMatch(/concurrent role/i);
  });
});
