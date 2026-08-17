import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { evidenceLevel, evidenceBreakdown, type NormalizedSource } from '@/lib/research/normalize';
import { employerDiscoveryQueries, signalQueries } from '@/lib/research/queries';
import { research, enrichSources } from '@/lib/research/engine';
import { source } from './helpers';
import type { SourceRow } from '@/lib/types';

beforeEach(() => {
  process.env.TAVILY_API_KEY = 'tvly-test';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TAVILY_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
});

// ─── extraction failure must degrade, not delete ─────────────────────────────

describe('Firecrawl failure → snippet fallback', () => {
  it('keeps the source and downgrades it to SNIPPET when extraction fails', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
      } as unknown as Response),
    );

    const sources = [source({ fetch_status: 'snippet_only', content: null })];
    const result = await enrichSources(sources, 1);

    expect(result.scraped).toBe(0);
    expect(result.failed).toBe(1);
    // The source survives, carrying its snippet.
    expect(result.sources).toHaveLength(1);
    expect(evidenceLevel(result.sources[0])).toBe('SNIPPET');
  });

  it('mixes FULL and SNIPPET when only some pages fetch', () => {
    const mixed: NormalizedSource[] = [
      source({ fetch_status: 'scraped', content: 'Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. ' }),
      source({ url: 'https://a.com/1', canonical_url: 'https://a.com/1', fetch_status: 'scrape_failed', content: null }),
      source({ url: 'https://b.com/2', canonical_url: 'https://b.com/2', fetch_status: 'snippet_only', content: null }),
      source({ url: 'https://c.com/3', canonical_url: 'https://c.com/3', fetch_status: 'scrape_failed', content: null, snippet: '', title: '' }),
    ];

    expect(evidenceBreakdown(mixed)).toEqual({ FULL: 1, SNIPPET: 2, UNAVAILABLE: 1 });
  });

  it('research still returns sources when extraction is entirely unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { url: 'https://reuters.com/a', title: 'Acme raises', content: 'A meaningful snippet of at least forty characters here.' },
          ],
        }),
      } as unknown as Response),
    );

    const result = await research('test', [{ query: 'acme', category: 'company_news' }]);
    expect(result.all_failed).toBe(false);
    expect(result.sources).toHaveLength(1);
    expect(evidenceLevel(result.sources[0])).toBe('SNIPPET');
  });
});

// ─── evidence survives a retry ───────────────────────────────────────────────

describe('evidence persistence across retry', () => {
  /** Mirrors how execute.ts rebuilds a source from its stored row. */
  function rehydrate(row: Partial<SourceRow>): NormalizedSource {
    return {
      url: row.url ?? 'https://reuters.com/a',
      canonical_url: row.canonical_url ?? 'https://reuters.com/a',
      title: row.title ?? 'Title',
      snippet: row.snippet ?? 'snippet text',
      source_type: 'news_major',
      credibility: Number(row.credibility ?? 0.9),
      published_date: row.published_date ?? null,
      providers: row.providers ?? [],
      queries: [],
      categories: row.found_via ?? [],
      duplicate_count: row.duplicate_count ?? 0,
      retrieved_at: row.retrieved_at ?? '2026-08-16T00:00:00.000Z',
      content: row.content ?? null,
      fetch_status: (row.fetch_status ?? 'snippet_only') as NormalizedSource['fetch_status'],
    };
  }

  it('restores FULL evidence when the page body was stored', () => {
    const restored = rehydrate({ fetch_status: 'scraped', content: 'Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. ' });
    expect(evidenceLevel(restored)).toBe('FULL');
  });

  it('would degrade to SNIPPET if the body had not been stored — the bug this prevents', () => {
    const notStored = rehydrate({ fetch_status: 'scraped', content: null });
    expect(evidenceLevel(notStored)).toBe('SNIPPET');
  });

  it('keeps snippet-only sources at SNIPPET across the round trip', () => {
    expect(evidenceLevel(rehydrate({ fetch_status: 'snippet_only', content: null }))).toBe('SNIPPET');
  });
});

// ─── company discovered after identity resolution ────────────────────────────

describe('company research when the employer is not on the profile', () => {
  it('builds no company queries when the company is unknown', () => {
    const companyQueries = signalQueries('Jane Doe', null).filter((q) => q.category.startsWith('company'));
    expect(companyQueries).toHaveLength(0);
  });

  it('falls back to employer-discovery queries built from the person', () => {
    const queries = employerDiscoveryQueries('Jane Doe');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => q.query.includes('Jane Doe'))).toBe(true);
    expect(queries.some((q) => /employer|works at|company/i.test(q.query))).toBe(true);
  });

  it('produces real company queries once an employer is known', () => {
    const queries = signalQueries('Jane Doe', 'Acme').filter((q) => q.category.startsWith('company'));
    expect(queries.length).toBeGreaterThanOrEqual(4);
    expect(queries.every((q) => q.query.includes('Acme'))).toBe(true);
  });
});
