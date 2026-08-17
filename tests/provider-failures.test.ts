import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { tavilySearch } from '@/lib/search/tavily';
import { runSearches, configuredProviders } from '@/lib/search';
import { research } from '@/lib/research/engine';
import { scrapeUrl } from '@/lib/research/scrape';

const QUERY = { query: '"Acme" funding', category: 'company_funding' as const };

beforeEach(() => {
  process.env.TAVILY_API_KEY = 'tvly-test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
});

// ─── requirement I: search API failure / timeout / rate limit ────────────────

describe('search provider failures', () => {
  it('reports an HTTP failure as ok:false instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' }),
    );

    const outcome = await tavilySearch(QUERY);
    expect(outcome.ok).toBe(false);
    expect(outcome.hits).toEqual([]);
    expect(outcome.error).toMatch(/500/);
  });

  it('reports a rate limit distinctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'slow down' }),
    );
    const outcome = await tavilySearch(QUERY);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/429/);
  });

  it('reports a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('abort'), { name: 'AbortError' })),
    );
    const outcome = await tavilySearch(QUERY);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/timed out/i);
  });

  it('fails loudly when no provider is configured at all', async () => {
    delete process.env.TAVILY_API_KEY;
    expect(configuredProviders()).toEqual([]);

    const outcomes = await runSearches([QUERY]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].error).toMatch(/No search provider configured/i);
  });

  it('marks the research round all_failed so the stage can fail honestly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'down' }));

    const result = await research('test', [QUERY]);
    expect(result.all_failed).toBe(true);
    expect(result.sources).toEqual([]);
    expect(result.round.queries_ok).toBe(0);
  });

  it('degrades rather than fails when only one of several queries dies', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        call++;
        if (call === 1) return { ok: false, status: 500, text: async () => 'boom' };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [{ url: 'https://reuters.com/a', title: 'Acme raises', content: 'text here' }],
          }),
        };
      }),
    );

    const result = await research('test', [QUERY, { ...QUERY, query: 'other query' }]);
    expect(result.all_failed).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('does not re-issue a duplicate query', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await research('test', [QUERY, { ...QUERY }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Firecrawl failures ──────────────────────────────────────────────────────

describe('page fetch failures', () => {
  it('returns ok:false without throwing when Firecrawl errors', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
    );

    const result = await scrapeUrl('https://example.com/article');
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it('flags a policy refusal as blocked', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ success: false, error: 'we do not support this site' }),
      }),
    );

    const result = await scrapeUrl('https://example.com/blocked');
    expect(result.blocked).toBe(true);
  });
});
