import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callStructured, classifyError, primaryModel, fallbackModel } from '@/lib/llm/gemini';
import { LLMError } from '@/lib/llm/types';

const REQ = {
  purpose: 'analyze_prospect',
  system: 'system',
  input: 'input',
  schema: { type: 'object', properties: {} },
};

/** Google's real free-tier 429 body. */
const FREE_TIER_QUOTA_BODY = JSON.stringify({
  error: {
    message:
      'You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash Please retry in 43.5s.',
    code: 'too_many_requests',
  },
});

function ok(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: 'completed',
      usage: { total_tokens: 42 },
      steps: [
        { type: 'thought' },
        { type: 'model_output', content: [{ type: 'text', text: JSON.stringify(payload) }] },
      ],
    }),
    text: async () => '',
  } as unknown as Response;
}

function fail(status: number, body: string) {
  return { ok: false, status, text: async () => body, json: async () => ({}) } as unknown as Response;
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_MODEL = 'primary-model';
  delete process.env.GEMINI_FALLBACK_MODEL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_FALLBACK_MODEL;
});

// ─── classification ──────────────────────────────────────────────────────────

describe('classifyError — distinguishing quota states', () => {
  it('classifies a free-tier daily cap as quota_exhausted, not a rate limit', () => {
    expect(classifyError(429, FREE_TIER_QUOTA_BODY)).toBe('quota_exhausted');
  });

  it('classifies an explicit per-day cap as quota_exhausted', () => {
    expect(classifyError(429, 'Quota exceeded: requests per day')).toBe('quota_exhausted');
  });

  it('classifies a pure per-minute throttle as rate_limited', () => {
    expect(classifyError(429, 'Rate limit: requests per minute exceeded, try again in 5s')).toBe('rate_limited');
    expect(classifyError(429, 'tokens per minute exceeded')).toBe('rate_limited');
  });

  it('classifies auth failures', () => {
    expect(classifyError(401, 'unauthorized')).toBe('authentication_error');
    expect(classifyError(403, 'forbidden')).toBe('authentication_error');
    expect(classifyError(400, 'API key not valid')).toBe('authentication_error');
  });

  it('classifies model availability problems', () => {
    expect(classifyError(404, 'Model not found')).toBe('model_unavailable');
    expect(classifyError(400, 'This model is no longer available to new users')).toBe('model_unavailable');
  });

  it('classifies our own bad payloads separately from provider outages', () => {
    expect(classifyError(400, 'invalid schema field')).toBe('invalid_request');
    expect(classifyError(500, 'internal')).toBe('provider_error');
    expect(classifyError(503, 'overloaded')).toBe('provider_error');
  });
});

describe('LLMError — routing and user-facing messages', () => {
  it('routes quota and model failures to the fallback model', () => {
    expect(new LLMError('x', 'quota_exhausted').shouldTryFallbackModel).toBe(true);
    expect(new LLMError('x', 'model_unavailable').shouldTryFallbackModel).toBe(true);
    expect(new LLMError('x', 'authentication_error').shouldTryFallbackModel).toBe(false);
    expect(new LLMError('x', 'invalid_request').shouldTryFallbackModel).toBe(false);
  });

  it('retries only transient classes on the same model', () => {
    expect(new LLMError('x', 'rate_limited').shouldRetrySameModel).toBe(true);
    expect(new LLMError('x', 'provider_error').shouldRetrySameModel).toBe(true);
    expect(new LLMError('x', 'quota_exhausted').shouldRetrySameModel).toBe(false);
  });

  it('gives a user-safe message that promises the data was kept', () => {
    const msg = new LLMError('raw internals', 'quota_exhausted').userMessage;
    expect(msg).toMatch(/quota has been exhausted/i);
    expect(msg).toMatch(/collected successfully/i);
    expect(msg).not.toMatch(/raw internals/);
  });
});

// ─── fallback model ──────────────────────────────────────────────────────────

describe('model fallback', () => {
  it('uses the fallback model when the primary is quota-exhausted', async () => {
    process.env.GEMINI_FALLBACK_MODEL = 'fallback-model';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fail(429, FREE_TIER_QUOTA_BODY))
      .mockResolvedValueOnce(ok({ value: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callStructured<{ value: number }>(REQ);

    expect(result.data.value).toBe(1);
    expect(result.meta.model).toBe('fallback-model');
    expect(result.meta.used_fallback_model).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('primary-model');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe('fallback-model');
  });

  it('does NOT retry a quota-exhausted model before falling back', async () => {
    process.env.GEMINI_FALLBACK_MODEL = 'fallback-model';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fail(429, FREE_TIER_QUOTA_BODY))
      .mockResolvedValueOnce(ok({ value: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await callStructured(REQ);
    // Exactly one attempt per model — no hammering of a capped model.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back when the primary model is unavailable', async () => {
    process.env.GEMINI_FALLBACK_MODEL = 'fallback-model';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fail(404, 'Model not found')).mockResolvedValueOnce(ok({ value: 2 })),
    );

    const result = await callStructured<{ value: number }>(REQ);
    expect(result.meta.used_fallback_model).toBe(true);
  });

  it('throws quota_exhausted when every model is exhausted', async () => {
    process.env.GEMINI_FALLBACK_MODEL = 'fallback-model';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(429, FREE_TIER_QUOTA_BODY)));

    const err = await callStructured(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.type).toBe('quota_exhausted');
    expect(err.userMessage).toMatch(/retried later/i);
  });

  it('does not try a fallback on an auth error — it would fail identically', async () => {
    process.env.GEMINI_FALLBACK_MODEL = 'fallback-model';
    const fetchMock = vi.fn().mockResolvedValue(fail(401, 'invalid key'));
    vi.stubGlobal('fetch', fetchMock);

    const err = await callStructured(REQ).catch((e) => e);
    expect(err.type).toBe('authentication_error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a fallback identical to the primary', () => {
    process.env.GEMINI_FALLBACK_MODEL = 'primary-model';
    expect(fallbackModel()).toBeNull();
  });

  it('reads both models from the environment, not from code', () => {
    process.env.GEMINI_MODEL = 'configured-primary';
    process.env.GEMINI_FALLBACK_MODEL = 'configured-fallback';
    expect(primaryModel()).toBe('configured-primary');
    expect(fallbackModel()).toBe('configured-fallback');
  });
});

// ─── retry policy ────────────────────────────────────────────────────────────

describe('retry policy', () => {
  it('retries a 503 on the same model with backoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fail(503, 'overloaded'))
      .mockResolvedValueOnce(ok({ value: 3 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callStructured<{ value: number }>(REQ);
    expect(result.data.value).toBe(3);
    expect(result.meta.attempts).toBe(2);
    expect(result.meta.used_fallback_model).toBe(false);
  });

  it('gives up on a model after bounded retries rather than looping', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(503, 'overloaded')));
    const err = await callStructured(REQ).catch((e) => e);
    expect(err.type).toBe('provider_error');
  });

  it('fails fast on an invalid request without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fail(400, 'schema is malformed'));
    vi.stubGlobal('fetch', fetchMock);

    const err = await callStructured(REQ).catch((e) => e);
    expect(err.type).toBe('invalid_request');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws authentication_error when no key is configured, with no request', async () => {
    delete process.env.GEMINI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const err = await callStructured(REQ).catch((e) => e);
    expect(err.type).toBe('authentication_error');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── secret hygiene ──────────────────────────────────────────────────────────

describe('secret hygiene', () => {
  it('sends the key as a header, never in the URL, and never logs it', async () => {
    process.env.GEMINI_API_KEY = 'super-secret-key-value';
    const logged: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...a) => void logged.push(a.join(' ')));

    const fetchMock = vi.fn().mockResolvedValue(ok({ value: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await callStructured(REQ);

    expect(String(fetchMock.mock.calls[0][0])).not.toContain('super-secret-key-value');
    expect(fetchMock.mock.calls[0][1].headers['x-goog-api-key']).toBe('super-secret-key-value');
    expect(logged.join('\n')).not.toContain('super-secret-key-value');
  });

  it('keeps the key out of error messages shown to users', async () => {
    process.env.GEMINI_API_KEY = 'super-secret-key-value';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(429, FREE_TIER_QUOTA_BODY)));

    const err = (await callStructured(REQ).catch((e) => e)) as LLMError;
    expect(err.userMessage).not.toContain('super-secret-key-value');
    expect(err.message).not.toContain('super-secret-key-value');
  });
});
