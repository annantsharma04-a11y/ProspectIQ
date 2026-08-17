import { describe, it, expect } from 'vitest';
import {
  canonicalUrl,
  classifySource,
  normalizeAndDedupe,
  similarity,
  titleTokens,
} from '@/lib/research/normalize';
import { hit } from './helpers';

describe('canonicalUrl', () => {
  it('strips tracking params, fragments, trailing slashes and www', () => {
    expect(canonicalUrl('https://www.example.com/a/b/?utm_source=x&id=7#frag')).toBe(
      'https://example.com/a/b?id=7',
    );
  });

  it('treats http and https as the same document', () => {
    expect(canonicalUrl('http://example.com/a')).toBe(canonicalUrl('https://www.example.com/a/'));
  });
});

describe('classifySource', () => {
  it('tiers known publishers', () => {
    expect(classifySource('https://reuters.com/x')).toBe('news_major');
    expect(classifySource('https://prnewswire.com/x')).toBe('press_release');
    expect(classifySource('https://boards.greenhouse.io/acme/jobs/1')).toBe('job_posting');
    expect(classifySource('https://crunchbase.com/organization/acme')).toBe('database');
    expect(classifySource('https://x.com/someone/status/1')).toBe('social');
    expect(classifySource('https://randomblog.dev/post')).toBe('web');
  });

  it('treats the prospect company domain as first-party', () => {
    expect(classifySource('https://acme.com/newsroom/post', ['acme.com'])).toBe('official');
    expect(classifySource('https://news.acme.com/post', ['acme.com'])).toBe('official');
  });

  it('separates LinkedIn jobs from LinkedIn profiles', () => {
    expect(classifySource('https://www.linkedin.com/in/jane')).toBe('linkedin');
    expect(classifySource('https://www.linkedin.com/jobs/view/123')).toBe('job_posting');
  });
});

describe('normalizeAndDedupe — requirement H (duplicate results)', () => {
  it('collapses the same URL found by different providers and records corroboration', () => {
    const out = normalizeAndDedupe([
      hit({ provider: 'tavily' }),
      hit({ provider: 'brave_web', url: 'https://www.techcrunch.com/2026/05/01/acme-series-b/' }),
      hit({ provider: 'tavily_news', url: 'https://techcrunch.com/2026/05/01/acme-series-b?utm_source=news' }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].duplicate_count).toBe(2);
    expect(out[0].providers).toEqual(expect.arrayContaining(['tavily', 'brave_web', 'tavily_news']));
  });

  it('collapses the same story syndicated across different outlets', () => {
    const out = normalizeAndDedupe([
      hit({ url: 'https://smallblog.dev/acme-b', title: 'Acme raises $40M Series B round' }),
      hit({ url: 'https://reuters.com/acme-b', title: 'Acme raises $40M Series B round' }),
    ]);

    expect(out).toHaveLength(1);
    // The more credible outlet is the one kept.
    expect(out[0].url).toContain('reuters.com');
    expect(out[0].duplicate_count).toBeGreaterThan(0);
  });

  it('keeps genuinely different stories apart', () => {
    const out = normalizeAndDedupe([
      hit({ url: 'https://reuters.com/a', title: 'Acme raises $40M Series B' }),
      hit({ url: 'https://reuters.com/b', title: 'Acme opens a new office in Berlin' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('recovers a date from a duplicate when the first copy was undated', () => {
    const out = normalizeAndDedupe([
      hit({ published_date: null }),
      hit({ provider: 'brave_news', published_date: '2026-05-01' }),
    ]);
    expect(out[0].published_date).toBe('2026-05-01');
  });

  it('drops hits with no URL', () => {
    expect(normalizeAndDedupe([hit({ url: '' })])).toHaveLength(0);
  });
});

describe('similarity', () => {
  it('scores identical titles 1 and unrelated titles near 0', () => {
    expect(similarity(titleTokens('Acme raises Series B'), titleTokens('Acme raises Series B'))).toBe(1);
    expect(
      similarity(titleTokens('Acme raises Series B'), titleTokens('Weather forecast for Tuesday')),
    ).toBeLessThan(0.1);
  });
});
