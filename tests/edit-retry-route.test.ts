import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunRow } from '@/lib/types';
import type { User } from '@supabase/supabase-js';

// POST /api/runs/[id]/edit-retry — correct the input a run started with, then
// re-run it. The guarantees under test:
//
//   - refuses to run at all for a failure the user did not cause
//   - validates the corrected URL with the SAME parser the pipeline uses
//   - re-points the run at the right prospect when the URL changes, and clears
//     the previous person's resolved identity rather than carrying it forward
//   - always restarts from validate_input (an input edit invalidates identity)
//   - dispatches durably when USE_INNGEST=true

const mockRequireOwnedRun = vi.fn();
const mockUpdateRun = vi.fn();
const mockFindOrCreateProspect = vi.fn();
const mockRetryRun = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockInngestSend = vi.fn();

vi.mock('@/lib/auth/guard', () => ({ requireOwnedRun: (...a: unknown[]) => mockRequireOwnedRun(...a) }));
vi.mock('@/lib/supabase/queries', () => ({
  updateRun: (...a: unknown[]) => mockUpdateRun(...a),
  findOrCreateProspect: (...a: unknown[]) => mockFindOrCreateProspect(...a),
}));
vi.mock('@/lib/pipeline/execute', () => ({ retryRun: (...a: unknown[]) => mockRetryRun(...a) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => mockCheckRateLimit() }));
vi.mock('@/inngest/client', () => ({
  inngest: { send: (...a: unknown[]) => mockInngestSend(...a) },
  OUTREACH_RUN_REQUESTED: 'outreach/run.requested',
}));

const { POST } = await import('@/app/api/runs/[id]/edit-retry/route');

const RUN_ID = 'run-1';
const owningUser = { id: 'user-1' } as User;

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: RUN_ID,
    linkedin_url: 'https://www.linkedin.com/in/wrong-person',
    linkedin_slug: 'wrong-person',
    input_name: null,
    input_company: null,
    input_title: null,
    user_id: 'user-1',
    prospect_id: 'prospect-old',
    status: 'failed',
    error: 'validate_input: not a valid LinkedIn profile name.',
    ai_error_type: null,
    identity_status: null,
    insufficient_evidence: false,
    ...over,
  }) as RunRow;

const makeRequest = (body: unknown) =>
  new Request(`http://localhost/api/runs/${RUN_ID}/edit-retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const makeParams = () => ({ params: Promise.resolve({ id: RUN_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.USE_INNGEST;
  mockRequireOwnedRun.mockResolvedValue({ user: owningUser, run: run() });
  mockCheckRateLimit.mockReturnValue({ ok: true, remaining: 10 });
  mockUpdateRun.mockResolvedValue(undefined);
  mockFindOrCreateProspect.mockResolvedValue({ prospect: { id: 'prospect-new' }, created: true });
  mockRetryRun.mockResolvedValue(undefined);
  mockInngestSend.mockResolvedValue(undefined);
});

describe('refuses failures the user did not cause', () => {
  it('409s an infrastructure failure rather than implying the input was wrong', async () => {
    mockRequireOwnedRun.mockResolvedValue({
      user: owningUser,
      run: run({ error: 'research_prospect: Search provider unavailable', ai_error_type: null }),
    });

    const res = await POST(makeRequest({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/did not fail because of your input/i);
    expect(mockUpdateRun).not.toHaveBeenCalled();
    expect(mockRetryRun).not.toHaveBeenCalled();
  });

  it('409s a configuration failure with a distinct explanation', async () => {
    mockRequireOwnedRun.mockResolvedValue({
      user: owningUser,
      run: run({ ai_error_type: 'authentication_error' }),
    });

    const res = await POST(makeRequest({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.kind).toBe('CONFIGURATION');
    expect(body.error).toMatch(/deployment configuration/i);
    expect(mockUpdateRun).not.toHaveBeenCalled();
  });

  it('409s a run that is still in progress', async () => {
    mockRequireOwnedRun.mockResolvedValue({ user: owningUser, run: run({ status: 'running' }) });
    const res = await POST(makeRequest({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }), makeParams());
    expect(res.status).toBe(409);
    expect(mockUpdateRun).not.toHaveBeenCalled();
  });
});

describe('validates the corrected URL with the pipeline’s own parser', () => {
  it('400s a URL that would only fail validate_input again', async () => {
    const res = await POST(makeRequest({ linkedin_url: 'https://example.com/not-linkedin' }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.field).toBe('linkedin_url');
    expect(mockUpdateRun).not.toHaveBeenCalled();
    expect(mockRetryRun).not.toHaveBeenCalled();
  });

  it('normalizes an accepted URL before saving it', async () => {
    await POST(makeRequest({ linkedin_url: 'linkedin.com/in/Jane-Doe/' }), makeParams());

    expect(mockUpdateRun).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({
        linkedin_url: 'https://www.linkedin.com/in/jane-doe',
        linkedin_slug: 'jane-doe',
      }),
    );
  });
});

describe('a changed URL re-points the run at the right prospect', () => {
  it('resolves a prospect for the new URL and attaches the run to it', async () => {
    await POST(makeRequest({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }), makeParams());

    expect(mockFindOrCreateProspect).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', linkedin_slug: 'jane-doe' }),
    );
    expect(mockUpdateRun).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ prospect_id: 'prospect-new' }));
  });

  it('clears the previous person’s resolved identity rather than carrying it forward', async () => {
    await POST(makeRequest({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }), makeParams());

    const patch = mockUpdateRun.mock.calls[0][1];
    for (const field of [
      'prospect_name',
      'company_name',
      'identity_status',
      'identity_verification',
      'linkedin_profile',
    ]) {
      expect(patch[field]).toBeNull();
    }
  });

  it('leaves the prospect untouched when only hints changed', async () => {
    mockRequireOwnedRun.mockResolvedValue({
      user: owningUser,
      run: run({
        linkedin_url: 'https://www.linkedin.com/in/jane-doe',
        linkedin_slug: 'jane-doe',
        status: 'needs_manual_review',
        identity_status: 'AMBIGUOUS',
        error: null,
      }),
    });

    await POST(
      makeRequest({ linkedin_url: 'https://www.linkedin.com/in/jane-doe', input_company: 'Acme' }),
      makeParams(),
    );

    expect(mockFindOrCreateProspect).not.toHaveBeenCalled();
    const patch = mockUpdateRun.mock.calls[0][1];
    expect(patch).not.toHaveProperty('prospect_id');
    expect(patch.input_company).toBe('Acme');
  });
});

describe('saves corrections and clears the previous failure', () => {
  it('trims hints and stores a blank hint as null rather than an empty string', async () => {
    await POST(
      makeRequest({
        linkedin_url: 'https://www.linkedin.com/in/jane-doe',
        input_name: '  Jane Doe  ',
        input_company: '   ',
      }),
      makeParams(),
    );

    const patch = mockUpdateRun.mock.calls[0][1];
    expect(patch.input_name).toBe('Jane Doe');
    expect(patch.input_company).toBeNull();
  });

  it('resets the run so a stale error cannot be read as this attempt’s outcome', async () => {
    await POST(makeRequest({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }), makeParams());

    expect(mockUpdateRun).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({
        status: 'queued',
        error: null,
        ai_error_type: null,
        completed_at: null,
        insufficient_evidence: false,
      }),
    );
  });

  it('reports that the retry restarts from validate_input', async () => {
    const res = await POST(makeRequest({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.retry_from_stage).toBe('validate_input');
    expect(body.url_changed).toBe(true);
  });
});

describe('dispatch matches the rest of the pipeline', () => {
  it('USE_INNGEST=true: sends the durable event and does not call retryRun directly', async () => {
    process.env.USE_INNGEST = 'true';

    await POST(makeRequest({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }), makeParams());

    expect(mockInngestSend).toHaveBeenCalledWith({
      name: 'outreach/run.requested',
      data: { runId: RUN_ID },
    });
    expect(mockRetryRun).not.toHaveBeenCalled();
  });

  it('USE_INNGEST unset: falls back to the direct call', async () => {
    await POST(makeRequest({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }), makeParams());

    expect(mockRetryRun).toHaveBeenCalledWith(RUN_ID);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('saves the correction BEFORE dispatching, never after', async () => {
    const order: string[] = [];
    mockUpdateRun.mockImplementation(async () => {
      order.push('update');
    });
    mockRetryRun.mockImplementation(async () => {
      order.push('dispatch');
    });

    await POST(makeRequest({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }), makeParams());

    expect(order).toEqual(['update', 'dispatch']);
  });
});
