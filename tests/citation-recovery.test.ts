import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findMissingCitations, recoverCitedSources } from '@/lib/research/recover';
import { verifyHooks } from '@/lib/signals/verify';
import { qualifyHook, scoreSignals } from '@/lib/ranking/rank';
import { evidenceLevel } from '@/lib/research/normalize';
import { source, signal } from './helpers';
import type { AnalysisHook } from '@/lib/llm/analyze';

const CITED = 'https://www.example-news.com/article/lean-teams';
const QUOTE = 'the company deliberately keeps its workforce close to one thousand people';
const PAGE_BODY = `A long profile of the business. ${QUOTE}, according to filings. ` +
  'Additional retrieved page body text to exceed the FULL evidence threshold. '.repeat(6);

const hook = (over: Partial<AnalysisHook> = {}): AnalysisHook => ({
  signal: 'The company keeps headcount near 1,000 while scaling',
  why_it_matters: 'Lean operations imply automation pressure.',
  category: 'strategic_initiative',
  source_url: CITED,
  published_date: null,
  supporting_quote: QUOTE,
  relevance_score: 80,
  specificity_score: 80,
  confidence_score: 80,
  conflicts_with: null,
  signal_level: 'PERSON',
  role_relevance: null,
  outreach_rationale: null,
  related_capability_id: null,
  ...over,
});

function scrapeOk(body: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { markdown: body } }),
  } as unknown as Response);
}

function scrapeFail(status = 500, error = 'boom') {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ success: false, error }),
  } as unknown as Response);
}

beforeEach(() => {
  process.env.FIRECRAWL_API_KEY = 'fc-test';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FIRECRAWL_API_KEY;
});

describe('findMissingCitations', () => {
  it('finds a cited URL that was never retrieved', () => {
    expect(findMissingCitations([CITED], [source()])).toEqual([CITED]);
  });

  it('ignores citations already in the source set, including URL variants', () => {
    const s = source({ url: 'https://www.linkedin.com/in/example', canonical_url: 'https://www.linkedin.com/in/example' });
    expect(findMissingCitations(['https://in.linkedin.com/in/example'], [s])).toEqual([]);
  });

  it('deduplicates repeated citations of the same document', () => {
    const missing = findMissingCitations([CITED, `${CITED}?utm_source=x`, CITED], [source()]);
    expect(missing).toHaveLength(1);
  });

  it('skips junk that is not a fetchable URL', () => {
    expect(findMissingCitations(['not a url', '', null, undefined, 'ftp://x/y'], [source()])).toEqual([]);
  });
});

describe('1. missing citation → successful retrieval → hook verified', () => {
  it('retrieves the page, stores it as evidence, and lets verification pass', async () => {
    vi.stubGlobal('fetch', scrapeOk(PAGE_BODY));

    const sources = [source()];
    const { recovered, attempts } = await recoverCitedSources([CITED], sources);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].ok).toBe(true);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].providers).toContain('citation_recovery');
    // It enters as real evidence, graded by the same rules as anything else.
    expect(evidenceLevel(recovered[0])).toBe('FULL');

    const { kept, rejected } = verifyHooks([hook()], [...sources, ...recovered]);
    expect(rejected).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });
});

describe('2. missing citation → retrieval failure → hook rejected', () => {
  it('rejects exactly as before when the page cannot be fetched', async () => {
    vi.stubGlobal('fetch', scrapeFail());

    const sources = [source()];
    const { recovered, attempts } = await recoverCitedSources([CITED], sources);

    expect(recovered).toHaveLength(0);
    expect(attempts[0].ok).toBe(false);
    expect(attempts[0].outcome).toMatch(/could not be retrieved/i);

    const { kept, rejected } = verifyHooks([hook()], [...sources, ...recovered]);
    expect(kept).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/not retrieved/i);
  });

  it('reports a policy refusal distinctly, without leaking provider internals', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { attempts } = await recoverCitedSources(
      ['https://www.linkedin.com/posts/someone-12345'],
      [source()],
    );
    expect(attempts[0].ok).toBe(false);
    expect(attempts[0].outcome).toMatch(/does not permit automated access/i);
    expect(attempts[0].outcome).not.toMatch(/firecrawl|http \d/i);
  });
});

describe('3. recovered page does not support the claim → hook rejected', () => {
  it('never lets a citation stand in for evidence', async () => {
    // The page is retrievable but says nothing like the quoted text.
    vi.stubGlobal('fetch', scrapeOk('An unrelated article about seasonal weather patterns. '.repeat(12)));

    const sources = [source()];
    const { recovered, attempts } = await recoverCitedSources([CITED], sources);

    expect(attempts[0].ok).toBe(true); // retrieval succeeded...
    const { kept, rejected } = verifyHooks([hook()], [...sources, ...recovered]);

    // ...but verification still fails, which is the whole point.
    expect(kept).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/does not appear/i);
  });
});

describe('4. recovered sources persist and are reused', () => {
  it('is not re-fetched once it is already in the source set', async () => {
    const fetchMock = scrapeOk(PAGE_BODY);
    vi.stubGlobal('fetch', fetchMock);

    const sources = [source()];
    const first = await recoverCitedSources([CITED], sources);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulating the retry path: the recovered source was persisted and rehydrated.
    const second = await recoverCitedSources([CITED], [...sources, ...first.recovered]);
    expect(second.attempts).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('5-7. existing safeguards are untouched', () => {
  const NOW = new Date('2026-08-17T00:00:00Z');
  const strong = () => source({ fetch_status: 'scraped', content: 'Full retrieved page body. '.repeat(12) });

  it('5. still rejects a hook resting on an INFERRED capability, recovered or not', () => {
    const ranked = scoreSignals(
      [signal({ related_capability_id: 'ap_automation' })],
      [strong()],
      NOW,
    );
    // Only KYC was observed for this company.
    const verdict = qualifyHook(ranked[0], 'Founder & CEO', new Set(['kyc_kyb']));
    expect(verdict.qualified).toBe(false);
    expect(verdict.reason).toMatch(/only inferred|not evidenced/i);
  });

  it('6. an observed-capability hook remains eligible', () => {
    const ranked = scoreSignals([signal({ related_capability_id: 'kyc_kyb' })], [strong()], NOW);
    expect(qualifyHook(ranked[0], 'Founder & CEO', new Set(['kyc_kyb'])).qualified).toBe(true);
  });

  it('7. recovery adds evidence but bypasses no gate', async () => {
    vi.stubGlobal('fetch', scrapeOk(PAGE_BODY));
    const { recovered } = await recoverCitedSources([CITED], [source()]);

    // Quote verification still applies.
    const bad = verifyHooks([hook({ supporting_quote: 'A sentence that is nowhere on the page at all.' })], recovered);
    expect(bad.kept).toHaveLength(0);

    // Threshold and disputed-signal rules still apply to a recovered-source hook.
    const { kept } = verifyHooks([hook()], recovered);
    const ranked = scoreSignals(kept, recovered, NOW);
    const disputed = { ...ranked[0], conflicts_with: 'Another source disagrees.' };
    expect(qualifyHook(disputed, 'CEO', new Set()).qualified).toBe(false);
  });

  it('caps how many citations it will chase in one run', async () => {
    const fetchMock = scrapeOk(PAGE_BODY);
    vi.stubGlobal('fetch', fetchMock);

    const many = Array.from({ length: 12 }, (_, i) => `https://example-news.com/story-${i}`);
    const { attempts } = await recoverCitedSources(many, [source()]);

    expect(attempts.length).toBeLessThanOrEqual(5);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
