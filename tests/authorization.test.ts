import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunRow } from '@/lib/types';

// The guard is the single chokepoint every route goes through, so these tests
// drive it directly with mocked auth and storage rather than booting Next.
// That keeps them fast and, more importantly, makes the failure modes explicit:
// no session, wrong owner, legacy unowned run, storage error.

const mockGetUser = vi.fn();
const mockGetRun = vi.fn();
const mockGetProspect = vi.fn();
const mockGetContactCandidate = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: () => mockGetUser(),
  createServerSupabase: vi.fn(),
}));

vi.mock('@/lib/supabase/queries', () => ({
  getRun: (id: string) => mockGetRun(id),
  getProspect: (id: string) => mockGetProspect(id),
  getContactCandidate: (id: string) => mockGetContactCandidate(id),
}));

const {
  requireUser,
  requireOwnedRun,
  requireOwnedProspect,
  unauthorized,
  notFound,
  prospectNotFound,
  requireOwnedContactCandidate,
  contactCandidateNotFound,
} = await import('@/lib/auth/guard');

const USER_A = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-0000-4000-8000-000000000002', email: 'b@example.com' };

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'run-a',
    user_id: USER_A.id,
    linkedin_url: 'https://www.linkedin.com/in/example',
    linkedin_slug: 'example',
    prospect_name: 'Example Person',
    status: 'ready_for_review',
    ...over,
  }) as RunRow;

const prospect = (over: Record<string, unknown> = {}) => ({
  id: 'prospect-a',
  user_id: USER_A.id,
  linkedin_slug: 'john-doe',
  linkedin_url: 'https://www.linkedin.com/in/john-doe',
  name: 'John Doe',
  current_job_role: 'CTO',
  current_company: 'ABC Technologies',
  company_domain: null,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
  last_researched_at: null,
  ...over,
});

beforeEach(() => {
  mockGetUser.mockReset();
  mockGetRun.mockReset();
  mockGetProspect.mockReset();
  mockGetContactCandidate.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('unauthenticated access is refused', () => {
  it('requireUser returns 401 with no session', async () => {
    mockGetUser.mockResolvedValue(null);
    const result = await requireUser();
    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(401);
  });

  it('requireOwnedRun returns 401 before any run is loaded', async () => {
    mockGetUser.mockResolvedValue(null);
    const result = await requireOwnedRun('run-a');

    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(401);
    // Critically: no data access happened at all.
    expect(mockGetRun).not.toHaveBeenCalled();
  });

  it('the 401 body carries no prospect or run detail', async () => {
    const body = await unauthorized().json();
    expect(body).toEqual({ error: 'Authentication required' });
    expect(JSON.stringify(body)).not.toMatch(/linkedin|prospect|company|run-/i);
  });
});

describe('cross-user access is refused (IDOR)', () => {
  it('User A reaching Run A is allowed', async () => {
    mockGetUser.mockResolvedValue(USER_A);
    mockGetRun.mockResolvedValue(run());

    const result = await requireOwnedRun('run-a');
    expect('run' in result).toBe(true);
    if (!('run' in result)) return;
    expect(result.run.id).toBe('run-a');
    expect(result.user.id).toBe(USER_A.id);
  });

  it('User B reaching Run A is refused', async () => {
    mockGetUser.mockResolvedValue(USER_B);
    mockGetRun.mockResolvedValue(run({ user_id: USER_A.id }));

    const result = await requireOwnedRun('run-a');
    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(404);
  });

  it('User A reaching Run B is refused', async () => {
    mockGetUser.mockResolvedValue(USER_A);
    mockGetRun.mockResolvedValue(run({ id: 'run-b', user_id: USER_B.id }));

    const result = await requireOwnedRun('run-b');
    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(404);
  });

  it('a missing run and someone else’s run are indistinguishable', async () => {
    mockGetUser.mockResolvedValue(USER_B);

    mockGetRun.mockResolvedValue(null);
    const missing = await requireOwnedRun('does-not-exist');

    mockGetRun.mockResolvedValue(run({ user_id: USER_A.id }));
    const foreign = await requireOwnedRun('run-a');

    if (!('response' in missing) || !('response' in foreign)) throw new Error('expected refusals');
    expect(missing.response.status).toBe(foreign.response.status);
    expect(await missing.response.json()).toEqual(await foreign.response.json());
  });

  it('the refusal never reveals that another user’s run exists', async () => {
    mockGetUser.mockResolvedValue(USER_B);
    mockGetRun.mockResolvedValue(run({ user_id: USER_A.id, prospect_name: 'Secret Prospect' }));

    const result = await requireOwnedRun('run-a');
    if (!('response' in result)) throw new Error('expected refusal');
    const body = JSON.stringify(await result.response.json());

    expect(body).not.toMatch(/Secret Prospect|belongs to|another user|forbidden/i);
    expect(body).toBe(JSON.stringify({ error: 'Run not found' }));
  });
});

describe('ownership edge cases', () => {
  it('a legacy run with no owner belongs to nobody', async () => {
    mockGetUser.mockResolvedValue(USER_A);
    mockGetRun.mockResolvedValue(run({ user_id: null }));

    const result = await requireOwnedRun('legacy-run');
    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(404);
  });

  it('a storage failure refuses rather than leaking the error', async () => {
    mockGetUser.mockResolvedValue(USER_A);
    mockGetRun.mockRejectedValue(new Error('connection to db.internal:5432 refused'));

    const result = await requireOwnedRun('run-a');
    if (!('response' in result)) throw new Error('expected refusal');
    expect(result.response.status).toBe(404);
    const body = JSON.stringify(await result.response.json());
    // The generic body must carry none of the underlying failure detail.
    expect(body).not.toMatch(/connection|5432|db\.internal|refused|stack/i);
    expect(body).toBe(JSON.stringify({ error: 'Run not found' }));
  });

  it('a forged user id in the request cannot grant access', async () => {
    // The guard reads identity from the verified session only; nothing the
    // caller sends is consulted.
    mockGetUser.mockResolvedValue(USER_B);
    mockGetRun.mockResolvedValue(run({ user_id: USER_A.id }));

    const result = await requireOwnedRun('run-a');
    expect('response' in result).toBe(true);
  });
});

describe('prospects are owned exactly like runs', () => {
  it('requireOwnedProspect returns 401 before any prospect is loaded', async () => {
    mockGetUser.mockResolvedValue(null);
    const result = await requireOwnedProspect('prospect-a');

    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(401);
    expect(mockGetProspect).not.toHaveBeenCalled();
  });

  it('User A reaching Prospect A is allowed', async () => {
    mockGetUser.mockResolvedValue(USER_A);
    mockGetProspect.mockResolvedValue(prospect());

    const result = await requireOwnedProspect('prospect-a');
    expect('prospect' in result).toBe(true);
    if (!('prospect' in result)) return;
    expect(result.prospect.id).toBe('prospect-a');
  });

  it('User B reaching Prospect A is refused', async () => {
    mockGetUser.mockResolvedValue(USER_B);
    mockGetProspect.mockResolvedValue(prospect({ user_id: USER_A.id }));

    const result = await requireOwnedProspect('prospect-a');
    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(404);
  });

  it('User A reaching Prospect B is refused', async () => {
    mockGetUser.mockResolvedValue(USER_A);
    mockGetProspect.mockResolvedValue(prospect({ id: 'prospect-b', user_id: USER_B.id }));

    const result = await requireOwnedProspect('prospect-b');
    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(404);
  });

  it('a missing prospect and someone else’s are indistinguishable', async () => {
    mockGetUser.mockResolvedValue(USER_B);

    mockGetProspect.mockResolvedValue(null);
    const missing = await requireOwnedProspect('nope');

    mockGetProspect.mockResolvedValue(prospect({ user_id: USER_A.id }));
    const foreign = await requireOwnedProspect('prospect-a');

    if (!('response' in missing) || !('response' in foreign)) throw new Error('expected refusals');
    expect(missing.response.status).toBe(foreign.response.status);
    expect(await missing.response.json()).toEqual(await foreign.response.json());
  });

  it('the refusal leaks no detail about the other user’s prospect', async () => {
    mockGetUser.mockResolvedValue(USER_B);
    mockGetProspect.mockResolvedValue(
      prospect({ user_id: USER_A.id, name: 'Secret Person', current_company: 'Secret Corp' }),
    );

    const result = await requireOwnedProspect('prospect-a');
    if (!('response' in result)) throw new Error('expected refusal');
    const body = JSON.stringify(await result.response.json());

    expect(body).not.toMatch(/Secret Person|Secret Corp|john-doe|belongs to|forbidden/i);
    expect(body).toBe(JSON.stringify({ error: 'Prospect not found' }));
  });

  it('a storage failure refuses rather than leaking the error', async () => {
    mockGetUser.mockResolvedValue(USER_A);
    mockGetProspect.mockRejectedValue(new Error('connection to db.internal:5432 refused'));

    const result = await requireOwnedProspect('prospect-a');
    if (!('response' in result)) throw new Error('expected refusal');
    expect(result.response.status).toBe(404);
    expect(JSON.stringify(await result.response.json())).not.toMatch(
      /connection|5432|db\.internal|refused|stack/i,
    );
  });

  it("a run reached through another user's prospect is still refused by the run guard", async () => {
    // Defence in depth: even if a prospect id were somehow obtained, the run
    // guard is gated on runs.user_id, which is independent of prospect_id.
    mockGetUser.mockResolvedValue(USER_B);
    mockGetRun.mockResolvedValue(run({ user_id: USER_A.id, prospect_id: 'prospect-a' } as never));

    const result = await requireOwnedRun('run-a');
    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(404);
  });
});

describe('contact candidates are owned through their run, exactly like signals and drafts', () => {
  const candidate = (over: Record<string, unknown> = {}) => ({
    id: 'candidate-a',
    run_id: 'run-a',
    name: 'Jane Kapoor',
    role: 'VP Finance',
    company: 'Acme',
    linkedin_url: 'https://www.linkedin.com/in/jane-kapoor',
    reason: 'Public role matches the qualified workflow',
    evidence: [{ source_url: 'https://a.com', quote: 'q' }],
    confidence: 78,
    rank_score: 82.5,
    identity_status: 'DISCOVERED',
    identity_verification: null,
    selected_at: null,
    resulting_run_id: null,
    created_at: '2026-08-01T00:00:00Z',
    ...over,
  });

  it('requires authentication before touching storage at all', async () => {
    mockGetUser.mockResolvedValue(null);
    const result = await requireOwnedContactCandidate('run-a', 'candidate-a');
    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(401);
    expect(mockGetRun).not.toHaveBeenCalled();
    expect(mockGetContactCandidate).not.toHaveBeenCalled();
  });

  it('User A reaching their own candidate on their own run is allowed', async () => {
    mockGetUser.mockResolvedValue(USER_A);
    mockGetRun.mockResolvedValue(run());
    mockGetContactCandidate.mockResolvedValue(candidate());

    const result = await requireOwnedContactCandidate('run-a', 'candidate-a');
    expect('candidate' in result).toBe(true);
    if (!('candidate' in result)) return;
    expect(result.candidate.id).toBe('candidate-a');
    expect(result.run.id).toBe('run-a');
  });

  it("User B reaching User A's run+candidate is refused before the candidate is even checked", async () => {
    mockGetUser.mockResolvedValue(USER_B);
    mockGetRun.mockResolvedValue(run({ user_id: USER_A.id }));

    const result = await requireOwnedContactCandidate('run-a', 'candidate-a');
    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(404);
    // The run guard refused first — the candidate lookup never ran.
    expect(mockGetContactCandidate).not.toHaveBeenCalled();
  });

  it("a candidate that belongs to a DIFFERENT run than the one in the URL is refused", async () => {
    // Defence in depth: even if User A owns run-a, a candidate id copied from
    // a different run (run-b) must not be usable through run-a's URL.
    mockGetUser.mockResolvedValue(USER_A);
    mockGetRun.mockResolvedValue(run({ id: 'run-a', user_id: USER_A.id }));
    mockGetContactCandidate.mockResolvedValue(candidate({ run_id: 'run-b' }));

    const result = await requireOwnedContactCandidate('run-a', 'candidate-a');
    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(404);
  });

  it('a missing candidate and a foreign candidate are indistinguishable', async () => {
    mockGetUser.mockResolvedValue(USER_A);
    mockGetRun.mockResolvedValue(run({ user_id: USER_A.id }));

    mockGetContactCandidate.mockResolvedValue(null);
    const missing = await requireOwnedContactCandidate('run-a', 'does-not-exist');

    mockGetContactCandidate.mockResolvedValue(candidate({ run_id: 'run-b' }));
    const foreign = await requireOwnedContactCandidate('run-a', 'candidate-a');

    if (!('response' in missing) || !('response' in foreign)) throw new Error('expected refusals');
    expect(missing.response.status).toBe(foreign.response.status);
    expect(await missing.response.json()).toEqual(await foreign.response.json());
  });

  it('a storage failure (including the table not existing yet) refuses rather than leaking detail', async () => {
    mockGetUser.mockResolvedValue(USER_A);
    mockGetRun.mockResolvedValue(run({ user_id: USER_A.id }));
    mockGetContactCandidate.mockRejectedValue(new Error('relation "contact_candidates" does not exist'));

    const result = await requireOwnedContactCandidate('run-a', 'candidate-a');
    if (!('response' in result)) throw new Error('expected refusal');
    expect(result.response.status).toBe(404);
    const body = JSON.stringify(await result.response.json());
    expect(body).not.toMatch(/relation|does not exist|contact_candidates/i);
    expect(body).toBe(JSON.stringify({ error: 'Contact candidate not found' }));
  });
});

describe('response shapes', () => {
  it('401 and 404 helpers return the documented statuses', () => {
    expect(unauthorized().status).toBe(401);
    expect(notFound().status).toBe(404);
    expect(prospectNotFound().status).toBe(404);
    expect(contactCandidateNotFound().status).toBe(404);
  });
});
