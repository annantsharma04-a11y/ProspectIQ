import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunRow } from '@/lib/types';
import type { User } from '@supabase/supabase-js';
import {
  combineQualification,
  type CompanyFit,
  type EvidenceItem,
  type ProspectFit,
  type TargetQualification,
} from '@/lib/qualification/types';

// POST /api/runs/[id]/account-decision — record a person's judgment on a
// borderline account and act on it.
//
// The point of testing the ROUTE rather than only the state model: hiding a
// button is not a safeguard. The floor has to hold against a hand-made
// request, so these prove the server refuses on its own — a NOT_QUALIFIED
// account cannot be continued by anyone who can type curl.

const mockRequireOwnedRun = vi.fn();
const mockUpdateRun = vi.fn();
const mockContinue = vi.fn();
const mockHold = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockInngestSend = vi.fn();
const mockAfter = vi.fn((task: () => unknown) => task());

vi.mock('@/lib/auth/guard', () => ({ requireOwnedRun: (...a: unknown[]) => mockRequireOwnedRun(...a) }));
vi.mock('@/lib/supabase/queries', () => ({ updateRun: (...a: unknown[]) => mockUpdateRun(...a) }));
vi.mock('@/lib/pipeline/execute', () => ({
  continueAfterAccountDecision: (...a: unknown[]) => mockContinue(...a),
  holdAfterAccountDecision: (...a: unknown[]) => mockHold(...a),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => mockCheckRateLimit() }));
vi.mock('@/inngest/client', () => ({
  inngest: { send: (...a: unknown[]) => mockInngestSend(...a) },
  OUTREACH_ACCOUNT_DECISION_MADE: 'outreach/account.decision.made',
}));
// after() (lib/pipeline resume durability fix) requires Next's real
// request-scoped work-store, which only exists inside an actual served
// request — never when a route handler is called directly, as every test
// in this file does. Stubbed to invoke its callback immediately, which is
// enough to keep asserting dispatch behavior; real request-scope behavior
// is Next's own concern, not this route's.
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: (task: () => unknown) => mockAfter(task) };
});

const { POST } = await import('@/app/api/runs/[id]/account-decision/route');

const RUN_ID = 'run-1';
const owningUser = { id: 'user-1' } as User;

const ev = (url: string): EvidenceItem => ({ url, quote: 'A verified excerpt.' });

const prospect = (over: Partial<ProspectFit> = {}): ProspectFit =>
  ({
    score: 80, classification: 'HIGH', role: 'VP Finance', seniority: 'VP',
    relevance_reason: 'Owns AP.', decision_authority: 'HIGH', product_relevance: 'HIGH',
    why_this_person: [], why_not_this_person: [], missing_information: [],
    evidence_basis: 'OBSERVED', evidence: [ev('https://example.com/p')], ...over,
  }) as ProspectFit;

const company = (over: Partial<CompanyFit> = {}): CompanyFit =>
  ({
    score: 80, classification: 'HIGH', industry: 'Logistics', company_size: '1,000+',
    relevant_workflows: ['accounts payable'], capability_matches: [],
    fit_reasons: [{ reason: 'Runs AP at scale.', basis: 'OBSERVED', evidence: [ev('https://example.com/c')] }],
    missing_information: [], evidence_basis: 'OBSERVED', evidence_adjustment: null, ...over,
  }) as CompanyFit;

const qualify = (p: ProspectFit, c: CompanyFit): TargetQualification =>
  ({ prospect_fit: p, company_fit: c, ...combineQualification(p, c) });

/** BORDERLINE company (inferred only), QUALIFIED contact — the pausing cell. */
const borderline = () =>
  qualify(prospect(), company({ score: 55, classification: 'MEDIUM', evidence_basis: 'INFERRED' }));
/** BORDERLINE company, BORDERLINE contact — the find-a-better-contact cell. */
const borderlineBoth = () =>
  qualify(
    prospect({ score: 55, classification: 'MEDIUM', evidence_basis: 'INFERRED' }),
    company({ score: 55, classification: 'MEDIUM', evidence_basis: 'INFERRED' }),
  );
const notQualified = () =>
  qualify(prospect(), company({ score: 20, classification: 'LOW', evidence_basis: 'UNKNOWN' }));
const fullyQualified = () => qualify(prospect(), company());

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: RUN_ID,
    user_id: 'user-1',
    status: 'needs_manual_review',
    qualification: borderline(),
    ...over,
  }) as RunRow;

const post = (body: unknown) =>
  POST(new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: RUN_ID }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.USE_INNGEST;
  mockCheckRateLimit.mockReturnValue({ ok: true });
  mockUpdateRun.mockResolvedValue(undefined);
  mockContinue.mockResolvedValue(undefined);
  mockHold.mockResolvedValue(undefined);
  mockRequireOwnedRun.mockResolvedValue({ user: owningUser, run: run() });
});

describe('the evidence floor is enforced by the server, not by the UI', () => {
  it('refuses to continue a NOT_QUALIFIED account', async () => {
    mockRequireOwnedRun.mockResolvedValue({ user: owningUser, run: run({ qualification: notQualified() }) });

    const res = await post({ decision: 'CONTINUED' });

    expect(res.status).toBe(409);
    expect(mockUpdateRun).not.toHaveBeenCalled();
    expect(mockContinue).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('refuses a QUALIFIED account too — the evidence already decided', async () => {
    mockRequireOwnedRun.mockResolvedValue({ user: owningUser, run: run({ qualification: fullyQualified() }) });

    expect((await post({ decision: 'CONTINUED' })).status).toBe(409);
    expect(mockUpdateRun).not.toHaveBeenCalled();
  });

  it('refuses a run that has not been qualified at all', async () => {
    mockRequireOwnedRun.mockResolvedValue({ user: owningUser, run: run({ qualification: null }) });
    expect((await post({ decision: 'CONTINUED' })).status).toBe(409);
  });
});

describe('recording a decision', () => {
  it('persists the choice, the time and the user — and nothing else', async () => {
    const res = await post({ decision: 'CONTINUED' });

    expect(res.status).toBe(202);
    const [, patch] = mockUpdateRun.mock.calls[0];
    const saved = (patch as { qualification: TargetQualification }).qualification;

    expect(saved.human_account_decision).toMatchObject({
      decision: 'CONTINUED',
      decided_by: 'user-1',
    });
    expect(typeof saved.human_account_decision?.decided_at).toBe('string');
  });

  it('leaves the qualification itself completely unchanged', async () => {
    const before = borderline();
    mockRequireOwnedRun.mockResolvedValue({ user: owningUser, run: run({ qualification: before }) });

    await post({ decision: 'CONTINUED' });

    const [, patch] = mockUpdateRun.mock.calls[0];
    const { human_account_decision, ...rest } = (patch as { qualification: TargetQualification }).qualification;

    expect(rest).toEqual(before);
    expect(rest.classification).toBe('BORDERLINE');
    expect(rest.proceed).toBe(before.proceed);
    // The decision is the ONLY thing that was added.
    expect(human_account_decision?.decision).toBe('CONTINUED');
  });

  it('rejects anything that is not CONTINUED or HELD', async () => {
    for (const bad of ['QUALIFIED', 'yes', '', null, undefined, 42]) {
      vi.clearAllMocks();
      mockCheckRateLimit.mockReturnValue({ ok: true });
      mockRequireOwnedRun.mockResolvedValue({ user: owningUser, run: run() });

      expect((await post({ decision: bad })).status).toBe(400);
      expect(mockUpdateRun).not.toHaveBeenCalled();
    }
  });

  it('refuses a second decision rather than dispatching the run twice', async () => {
    const already = { ...borderline(), human_account_decision: { decision: 'CONTINUED' as const, decided_at: 'x', decided_by: 'user-1' } };
    mockRequireOwnedRun.mockResolvedValue({ user: owningUser, run: run({ qualification: already }) });

    expect((await post({ decision: 'HELD' })).status).toBe(409);
    expect(mockUpdateRun).not.toHaveBeenCalled();
    expect(mockContinue).not.toHaveBeenCalled();
  });

  it('refuses while the run is still in progress', async () => {
    mockRequireOwnedRun.mockResolvedValue({ user: owningUser, run: run({ status: 'running' }) });
    expect((await post({ decision: 'CONTINUED' })).status).toBe(409);
  });

  it('honours the rate limit', async () => {
    mockCheckRateLimit.mockReturnValue({ ok: false });
    expect((await post({ decision: 'CONTINUED' })).status).toBe(429);
    expect(mockUpdateRun).not.toHaveBeenCalled();
  });
});

describe('acting on the decision', () => {
  it('CONTINUE saves BEFORE dispatching, never after', async () => {
    await post({ decision: 'CONTINUED' });

    expect(mockUpdateRun).toHaveBeenCalled();
    expect(mockContinue).toHaveBeenCalledWith(RUN_ID);
    expect(mockUpdateRun.mock.invocationCallOrder[0]).toBeLessThan(
      mockContinue.mock.invocationCallOrder[0],
    );
  });

  it('CONTINUE reports which path the run resumes into', async () => {
    mockRequireOwnedRun.mockResolvedValue({ user: owningUser, run: run({ qualification: borderlineBoth() }) });
    const body = await (await post({ decision: 'CONTINUED' })).json();
    expect(body.continuation_path).toBe('FIND_CONTACT');
  });

  it('HOLD runs the terminal path and dispatches no pipeline work', async () => {
    const res = await post({ decision: 'HELD' });

    expect(res.status).toBe(200);
    expect(mockHold).toHaveBeenCalledWith(RUN_ID);
    expect(mockContinue).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('USE_INNGEST=true dispatches durably instead of calling in-process', async () => {
    process.env.USE_INNGEST = 'true';

    await post({ decision: 'CONTINUED' });

    expect(mockInngestSend).toHaveBeenCalledWith({
      name: 'outreach/account.decision.made',
      data: { runId: RUN_ID },
    });
    expect(mockContinue).not.toHaveBeenCalled();
  });

  it('a held account never dispatches, even under Inngest', async () => {
    process.env.USE_INNGEST = 'true';
    await post({ decision: 'HELD' });
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

// ─── the actual fix: run d67ca7ae — decision persisted, pipeline never resumed ──
//
// Traced to the CONTINUE dispatch being a bare, unawaited promise
// (`continueAfterAccountDecision(id).catch(...)`) with nothing keeping the
// invocation alive after the response was sent — on a serverless deployment
// the platform is free to freeze or recycle the function the instant the
// response streams, tearing the promise down before getRun() even resolves.
// No error was ever recorded because nothing survived long enough to catch
// one. after() (next/server) is the platform's own primitive for exactly
// this: it keeps the invocation alive until the given work finishes, without
// delaying the response.

describe('the reproduced bug: dispatch must survive past the response, not merely be attempted', () => {
  it('CONTINUE (non-Inngest) dispatches through after(), not a bare unguarded promise', async () => {
    await post({ decision: 'CONTINUED' });

    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockAfter.mock.calls[0][0]).toBeInstanceOf(Function);
    // The work after() was given is genuinely the pipeline resume — not a
    // no-op or something unrelated.
    expect(mockContinue).toHaveBeenCalledWith(RUN_ID);
  });

  it('HOLD is unaffected — it was already awaited before the response, never needed after()', async () => {
    await post({ decision: 'HELD' });
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockHold).toHaveBeenCalledWith(RUN_ID);
  });

  it('the Inngest branch is unaffected — durable dispatch never needed after() either', async () => {
    process.env.USE_INNGEST = 'true';
    await post({ decision: 'CONTINUED' });
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockInngestSend).toHaveBeenCalled();
  });

  it('double-clicking CONTINUE still cannot dispatch the pipeline twice', async () => {
    // First click: succeeds, dispatches once.
    await post({ decision: 'CONTINUED' });
    expect(mockAfter).toHaveBeenCalledTimes(1);

    // Second click on the SAME run: the route re-reads the run's own
    // persisted state, sees a decision already recorded, and refuses before
    // ever reaching the dispatch — unrelated to and unweakened by this fix.
    mockRequireOwnedRun.mockResolvedValue({
      user: owningUser,
      run: run({
        qualification: {
          ...borderline(),
          human_account_decision: { decision: 'CONTINUED', decided_at: '2026-01-01T00:00:00Z', decided_by: 'user-1' },
        },
      }),
    });
    const res = await post({ decision: 'CONTINUED' });

    expect(res.status).toBe(409);
    expect(mockAfter).toHaveBeenCalledTimes(1); // still just the one, real dispatch
  });
});
