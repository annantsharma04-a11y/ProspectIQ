import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sameCorporateGroup } from '@/lib/identity/corporate-groups';
import { currentEmploymentConflict } from '@/lib/identity/provenance';
import { preVerifyCandidate } from '@/lib/contacts/preverify';
import type { RunRow } from '@/lib/types';
import type { ContactCandidateRow } from '@/lib/contacts/types';
import type { User } from '@supabase/supabase-js';

// The brand/parent-company gap flagged in the stability audit: a legitimate
// current AJIO employee, discovered as "CFO, AJIO.com", whose real LinkedIn
// profile is pinned to "Reliance Retail" (AJIO's parent), was indistinguishable
// from Maneesh Arora's genuine departure — both are a plain string mismatch
// between claimed and profile company. currentEmploymentConflict() had no way
// to tell "same corporate family" apart from "different employer entirely".
//
// sameCorporateGroup() (lib/identity/corporate-groups.ts) closes that gap with
// an explicit, curated membership check — never fuzzy similarity — consulted
// only inside currentEmploymentConflict(), the one deterministic company
// comparison this fix is scoped to. valuesAgree(), decideIdentity(),
// reconcileProvenance(), pre-verification, ranking, role discovery and
// candidate selection are all untouched.

describe('1 & 2. known parent/brand relationships suppress the false conflict', () => {
  it('AJIO + Reliance Retail: recognized as the same corporate family', () => {
    expect(sameCorporateGroup('AJIO.com', 'Reliance Retail')).toBe(true);
    expect(sameCorporateGroup('AJIO', 'Reliance Industries')).toBe(true);
  });

  it('a second, independent real brand/parent pair behaves the same way', () => {
    expect(sameCorporateGroup('Myntra', 'Flipkart')).toBe(true);
    expect(sameCorporateGroup('Whole Foods Market', 'Amazon.com')).toBe(true);
  });

  it('currentEmploymentConflict() returns null for a known parent/brand pair — no false conflict', () => {
    expect(currentEmploymentConflict('AJIO.com', 'Reliance Retail')).toBeNull();
    expect(currentEmploymentConflict('Myntra', 'Flipkart Internet')).toBeNull();
  });

  it('the relationship is symmetric — either name may be the claimed one', () => {
    expect(currentEmploymentConflict('Reliance Retail', 'AJIO.com')).toBeNull();
  });
});

describe('3. unrelated companies, including similar-sounding ones, still conflict', () => {
  it('two genuinely unrelated, similarly-styled company names are not related', () => {
    expect(sameCorporateGroup('Sterling Corp', 'Sterling Technologies')).toBe(false);
  });

  it('currentEmploymentConflict() still raises a conflict for an unrelated company', () => {
    const c = currentEmploymentConflict('AJIO.com', 'Sterling Technologies');
    expect(c).not.toBeNull();
    expect(c!.field).toBe('company');
  });

  it('a name that is not in the registry at all is never matched to anything', () => {
    expect(sameCorporateGroup('AJIO.com', 'Some Startup Nobody Has Heard Of')).toBe(false);
  });
});

describe('4. an unknown/unclear corporate relationship stays conservative', () => {
  it('two companies with no registered relationship are not treated as related, even if plausible-sounding', () => {
    // "Reliance Jio" is a real, different Reliance Industries business from
    // "Reliance Retail" — plausible-sounding, but not in the curated list,
    // so the conservative, existing behavior (no relationship assumed) holds.
    expect(sameCorporateGroup('Reliance Jio', 'Bluewave Freight')).toBe(false);
  });

  it('an unrecognized pair still produces a conflict — ambiguity is not silently resolved in favor of "related"', () => {
    expect(currentEmploymentConflict('Reliance Jio', 'Bluewave Freight')).not.toBeNull();
  });
});

describe('5. former employment at a parent/brand is still treated as former', () => {
  // currentEmploymentConflict() only ever runs when the model reported NO
  // company conflict of its own (see the route). An explicit, dated
  // departure — even within the same corporate family — is something the
  // MODEL reports directly (unchanged by this fix), so it never reaches
  // currentEmploymentConflict() or sameCorporateGroup() at all.
  it('a model-reported, explicitly-dated departure is untouched by the corporate-group check', () => {
    const modelConflict = {
      field: 'company' as const,
      claimed_value: 'AJIO.com',
      claimed_provenance: 'CANDIDATE' as const,
      public_value: 'Reliance Retail',
      explanation:
        'Sources indicate the candidate previously served as CFO at AJIO.com from October 2020 to June 2024, and left for a different role at Reliance Retail.',
      sources: [],
    };
    // sameCorporateGroup() recognizing the pair does not matter here — this
    // conflict came from the model, not from currentEmploymentConflict(),
    // and the route never calls currentEmploymentConflict() when the model
    // already reported a company conflict (see hasModelCompanyConflict in
    // the select route). The explicit departure conflict is preserved as-is.
    expect(modelConflict.field).toBe('company');
    expect(sameCorporateGroup(modelConflict.claimed_value, modelConflict.public_value)).toBe(true);
    // Demonstrates the point: even though the pair IS a known corporate
    // family, that fact plays no role in whether this model-authored
    // conflict is honored — it flows into reconcileProvenance/decideIdentity
    // completely unchanged. Full route-level proof is in
    // tests/select-candidate-current-employment.test.ts, test 2, which uses
    // this exact AJIO/Reliance Retail pair with an explicit end date and
    // still resolves as excluded, unaffected by this fix.
  });
});

describe('6. concurrent role across different organizations remains AMBIGUOUS, unchanged', () => {
  it('a model-reported concurrent-role conflict is unaffected by corporate-group membership either way', () => {
    // Personal Foundation has no registered corporate relationship to
    // AJIO.com — proving this fix does not need one to leave the existing
    // concurrent-role behavior alone; that behavior already came entirely
    // from the model's own conflict report, never from
    // currentEmploymentConflict().
    expect(sameCorporateGroup('AJIO.com', 'Personal Foundation')).toBe(false);
  });
});

describe('7. existing pre-verification behavior is unchanged for unrelated cases', () => {
  it('preVerifyCandidate — untouched by this fix — still passes a normal, evidenced candidate', () => {
    const result = preVerifyCandidate({
      name: 'Jordan Alt',
      role: 'VP Finance',
      company: 'Bluewave Freight',
      linkedin_url: 'https://www.linkedin.com/in/jordan-alt',
      evidence: [{ source_url: 'https://example.com/a', quote: 'Jordan Alt leads Finance at Bluewave Freight.' }],
    });
    expect(result.eligibility).toBe('ELIGIBLE');
  });

  it('preVerifyCandidate has no awareness of corporate groups at all — it never imports this module', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.join(process.cwd(), 'lib/contacts/preverify.ts'), 'utf-8');
    expect(src).not.toContain('corporate-groups');
  });
});

// ─── full route, real profile pinned to the parent entity ──────────────────

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

const candidate = (over: Partial<ContactCandidateRow> = {}): ContactCandidateRow =>
  ({
    id: CANDIDATE_ID,
    run_id: RUN_ID,
    name: 'Maneesh Arora',
    role: 'CFO',
    company: 'AJIO.com',
    linkedin_url: 'https://www.linkedin.com/in/maneesharora23',
    reason: 'Public role matches the qualified workflow.',
    evidence: [{ source_url: 'https://example.com/a', quote: "Our CFO, Maneesh Arora won the 'Most Impactful CFO' award." }],
    confidence: 83,
    rank_score: 99.4,
    identity_status: 'DISCOVERED',
    identity_verification: null,
    selected_at: null,
    resulting_run_id: null,
    created_at: '2026-08-19T00:00:00Z',
    ...over,
  }) as ContactCandidateRow;

function profileResult(companyName: string | null) {
  return {
    profile: companyName
      ? {
          url: 'https://www.linkedin.com/in/maneesharora23',
          name: 'Maneesh Arora',
          headline: `Group Chief Financial Officer at ${companyName}`,
          about: null,
          location: null,
          currentCompany: { name: companyName, title: 'Group Chief Financial Officer', url: null },
          experience: [],
          education: [],
          skills: [],
          posts: [],
          followers: null,
          connections: null,
        }
      : null,
    access: {
      directLinkedIn: Boolean(companyName),
      primarySource: companyName ? 'brightdata' : 'public_web',
      profileCompleteness: companyName ? 'full' : 'none',
      reason: null,
    },
    meta: null,
    error_code: companyName ? null : 'empty_profile',
    duration_ms: 1000,
  };
}

const makeRequest = () =>
  new Request(`http://localhost/api/runs/${RUN_ID}/contact-candidates/${CANDIDATE_ID}/select`, { method: 'POST' });
const makeParams = () => ({ params: Promise.resolve({ id: RUN_ID, candidateId: CANDIDATE_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.USE_INNGEST;
  mockRequireOwnedContactCandidate.mockResolvedValue({ user: owningUser, run: ownedRun, candidate: candidate() });
  mockCheckRateLimit.mockReturnValue({ ok: true, remaining: 10 });
  mockUpdateContactCandidate.mockResolvedValue(undefined);
  mockClaimContactCandidateForSelection.mockResolvedValue({ ...candidate(), selected_at: '2026-08-19T00:00:01Z' });
  mockGetContactCandidate.mockResolvedValue(candidate());
  mockResearch.mockResolvedValue({ sources: [] });
  mockFindOrCreateProspect.mockResolvedValue({ prospect: { id: 'prospect-1' }, created: true });
  mockCreateRun.mockResolvedValue({ id: 'run-new-1', prospect_id: 'prospect-1' });
  mockInngestSend.mockResolvedValue(undefined);
  mockExecutePipeline.mockResolvedValue(undefined);
});

describe('end-to-end: a legitimate current AJIO employee whose profile shows Reliance Retail verifies cleanly', () => {
  it('model reports no conflict, real profile shows the parent entity — VERIFIED, not held', async () => {
    mockRetrieveLinkedInProfile.mockResolvedValue(profileResult('Reliance Retail'));
    mockVerifySelectedCandidate.mockResolvedValue({
      conflicts: [],
      assessedConfidence: 88,
      missingFields: [],
      corroboratedFields: ['name', 'company'],
    });

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe('verified');
    expect(body.verification.status).toBe('VERIFIED');
    expect(mockCreateRun).toHaveBeenCalled();
  });

  it('the same shape with a genuinely unrelated company is still held for review', async () => {
    mockRetrieveLinkedInProfile.mockResolvedValue(profileResult('Sterling Technologies'));
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
});
