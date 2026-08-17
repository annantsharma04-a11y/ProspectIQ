import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedSource } from '@/lib/research/normalize';
import type { ResearchResult } from '@/lib/research/engine';

// One deterministic, fully-mocked end-to-end fixture for the exact Ankit
// Tandon / PRISM failure: research() and callStructured() are mocked so this
// exercises the REAL discoverContacts() orchestration — role search, model
// proposal, name-specific follow-up search, deterministic URL recovery — with
// zero live provider or model calls. No network, no cost, fully repeatable.
//
// Scenario, reproducing the live trace exactly:
//   round 1 (role search "PRISM" "CFO" etc.): mostly unrelated companies that
//     happen to share the name PRISM, plus one relevant source — a LinkedIn
//     POST announcing Ankit Tandon's promotion, not his own profile.
//   model proposal: Ankit Tandon, citing that post, linkedin_url: null —
//     correct, since it was never shown his profile.
//   round 2 (the fix's new name+company follow-up search): a mix including
//     his REAL profile, a malformed URL, a company page, and another post —
//     discovery must pick the real profile and nothing else.

const mockResearch = vi.fn();
const mockCallStructured = vi.fn();

vi.mock('@/lib/research/engine', () => ({ research: (...args: unknown[]) => mockResearch(...args) }));
vi.mock('@/lib/llm/gemini', () => ({ callStructured: (...args: unknown[]) => mockCallStructured(...args) }));

const { discoverContacts } = await import('@/lib/contacts/discover');

let seq = 0;
const source = (over: Partial<NormalizedSource> = {}): NormalizedSource => {
  seq += 1;
  const url = over.url ?? `https://example${seq}.com/a`;
  return {
    url,
    canonical_url: url,
    title: 'Untitled',
    snippet: '',
    source_type: 'web',
    credibility: 0.5,
    published_date: null,
    providers: ['tavily'],
    queries: [],
    categories: ['contact_discovery'],
    duplicate_count: 0,
    retrieved_at: '2026-01-01T00:00:00Z',
    content: null,
    fetch_status: 'snippet_only',
    ...over,
  } as NormalizedSource;
};

const researchResult = (sources: NormalizedSource[], over: Partial<ResearchResult> = {}): ResearchResult => ({
  sources,
  round: {
    label: 'x',
    outcomes: [],
    queries_run: 5,
    queries_ok: 5,
    hits_before_dedupe: sources.length,
    sources_after_dedupe: sources.length,
  },
  degraded: false,
  all_failed: false,
  ...over,
});

// The real evidence quote from the live PRISM leadership-announcement post.
const ANKIT_QUOTE =
  'PRISM, the parent company of hospitality giant OYO, has executed a significant leadership overhaul to fortify its global strategy. In the top move, Ankit Tandon has been elevated to global Chief Operating Officer (COO) of PRISM and CEO of its European arm.';
const ANKIT_POST_URL =
  'https://www.linkedin.com/posts/startupbydoc_oyo-prism-leadershipchange-activity-7382399610008272896-IGpw';
const ANKIT_REAL_PROFILE = 'https://www.linkedin.com/in/ankit-tandon-7455429/';

/** Round 1: the real noisy batch — unrelated "Prism" companies + the one relevant post. */
const roundOneNoise: NormalizedSource[] = [
  source({ url: 'https://growjo.com/company/Prism_Systems', title: 'Prism Systems: Revenue, Competitors' }),
  source({ url: 'https://prismengineering.com/our-leadership-team', title: 'Our Leadership Team - Prism Engineering' }),
  source({ url: 'https://ca.linkedin.com/in/robertgreenwald', title: 'Robert Greenwald' }),
  source({ url: ANKIT_POST_URL, title: 'PRISM Appoints Ankit Tandon as Global COO, Reorganizes Leadership | StartupbyDOC' }),
];

beforeEach(() => {
  mockResearch.mockReset();
  mockCallStructured.mockReset();
});

describe('discoverContacts — deterministic end-to-end fixture, no live calls', () => {
  it('recovers and persists the real LinkedIn URL missed by the initial role search', async () => {
    // Round 1: role search returns the noisy batch, no profile for Ankit.
    mockResearch.mockResolvedValueOnce(researchResult(roundOneNoise));

    // The model proposes Ankit from the post, correctly reporting no URL —
    // it was genuinely never shown one.
    mockCallStructured.mockResolvedValueOnce({
      data: {
        candidates: [
          { name: 'Ankit Tandon', role: 'Global COO', linkedin_url: null, quote: ANKIT_QUOTE, source_url: ANKIT_POST_URL },
        ],
      },
      meta: { model: 'test', used_fallback_model: false, purpose: 'discover_contact_candidates', duration_ms: 1, attempts: 1, total_tokens: null },
    });

    // Round 2: the fix's follow-up "Ankit Tandon" "PRISM" search. Mixed
    // results: his REAL profile, a malformed URL, a company page, and
    // another post — discovery must pick only the real profile.
    const roundTwo: NormalizedSource[] = [
      source({ url: 'https://www.linkedin.com/pub/ankit-tandon/12/345/678', title: 'Ankit Tandon' }), // legacy /pub/, invalid
      source({ url: 'https://www.linkedin.com/company/prism', title: 'Ankit Tandon at PRISM | LinkedIn' }), // company page, not a profile
      source({ url: ANKIT_POST_URL, title: 'PRISM Appoints Ankit Tandon as Global COO | StartupbyDOC' }), // the same post again
      source({ url: ANKIT_REAL_PROFILE, title: 'Ankit Tandon - Global COO - PRISM | LinkedIn' }), // the real profile
    ];
    mockResearch.mockResolvedValueOnce(researchResult([...roundOneNoise, ...roundTwo]));

    const result = await discoverContacts({
      company: 'PRISM',
      workflowSignals: ['high-volume vendor payment and invoice processing operation'],
      existingSources: [],
      companyDomains: [],
    });

    expect(mockResearch).toHaveBeenCalledTimes(2);
    expect(mockCallStructured).toHaveBeenCalledTimes(1); // exactly one model call — no second call added for URL recovery

    expect(result.proposed).toHaveLength(1);
    const ankit = result.proposed[0];
    expect(ankit.name).toBe('Ankit Tandon');
    // Recovered AND normalized (no trailing slash) — never the raw string.
    expect(ankit.linkedin_url).toBe('https://www.linkedin.com/in/ankit-tandon-7455429');
    // Not the malformed /pub/ URL, not the company page, not the post.
    expect(ankit.linkedin_url).not.toContain('/pub/');
    expect(ankit.linkedin_url).not.toContain('/company/');
    expect(ankit.linkedin_url).not.toContain('/posts/');

    // The recovered source is merged in, so persistSources picks it up too.
    expect(result.sources.some((s) => s.url === ANKIT_REAL_PROFILE)).toBe(true);
  });

  it('leaves linkedin_url null when only malformed/post/company URLs are found — never guesses', async () => {
    mockResearch.mockResolvedValueOnce(researchResult(roundOneNoise));
    mockCallStructured.mockResolvedValueOnce({
      data: {
        candidates: [
          { name: 'Ankit Tandon', role: 'Global COO', linkedin_url: null, quote: ANKIT_QUOTE, source_url: ANKIT_POST_URL },
        ],
      },
      meta: { model: 'test', used_fallback_model: false, purpose: 'discover_contact_candidates', duration_ms: 1, attempts: 1, total_tokens: null },
    });

    // Round 2 this time contains NO real profile — only the same
    // malformed/post/company noise.
    const roundTwoNoRealProfile: NormalizedSource[] = [
      source({ url: 'https://www.linkedin.com/pub/ankit-tandon/12/345/678', title: 'Ankit Tandon' }),
      source({ url: 'https://www.linkedin.com/company/prism', title: 'Ankit Tandon at PRISM | LinkedIn' }),
      source({ url: ANKIT_POST_URL, title: 'PRISM Appoints Ankit Tandon as Global COO | StartupbyDOC' }),
    ];
    mockResearch.mockResolvedValueOnce(researchResult([...roundOneNoise, ...roundTwoNoRealProfile]));

    const result = await discoverContacts({
      company: 'PRISM',
      workflowSignals: ['high-volume vendor payment and invoice processing operation'],
      existingSources: [],
      companyDomains: [],
    });

    expect(result.proposed).toHaveLength(1);
    expect(result.proposed[0].name).toBe('Ankit Tandon');
    expect(result.proposed[0].linkedin_url).toBeNull();
  });

  it('skips the follow-up search entirely when the model already reported a valid URL', async () => {
    mockResearch.mockResolvedValueOnce(researchResult(roundOneNoise));
    mockCallStructured.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            name: 'Ankit Tandon',
            role: 'Global COO',
            linkedin_url: ANKIT_REAL_PROFILE,
            quote: ANKIT_QUOTE,
            source_url: ANKIT_POST_URL,
          },
        ],
      },
      meta: { model: 'test', used_fallback_model: false, purpose: 'discover_contact_candidates', duration_ms: 1, attempts: 1, total_tokens: null },
    });

    const result = await discoverContacts({
      company: 'PRISM',
      workflowSignals: ['high-volume vendor payment and invoice processing operation'],
      existingSources: [],
      companyDomains: [],
    });

    // Only the initial role search ran — no follow-up needed or spent.
    expect(mockResearch).toHaveBeenCalledTimes(1);
    expect(result.proposed[0].linkedin_url).toBe('https://www.linkedin.com/in/ankit-tandon-7455429');
  });

  it('a malformed model-reported URL is dropped, not persisted as-is, and still triggers recovery', async () => {
    mockResearch.mockResolvedValueOnce(researchResult(roundOneNoise));
    mockCallStructured.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            name: 'Ankit Tandon',
            role: 'Global COO',
            // The model hallucinated a non-profile "LinkedIn URL".
            linkedin_url: 'https://www.linkedin.com/company/prism',
            quote: ANKIT_QUOTE,
            source_url: ANKIT_POST_URL,
          },
        ],
      },
      meta: { model: 'test', used_fallback_model: false, purpose: 'discover_contact_candidates', duration_ms: 1, attempts: 1, total_tokens: null },
    });
    mockResearch.mockResolvedValueOnce(
      researchResult([...roundOneNoise, source({ url: ANKIT_REAL_PROFILE, title: 'Ankit Tandon - Global COO - PRISM | LinkedIn' })]),
    );

    const result = await discoverContacts({
      company: 'PRISM',
      workflowSignals: ['high-volume vendor payment and invoice processing operation'],
      existingSources: [],
      companyDomains: [],
    });

    // The bad URL was normalized away, and the follow-up search still ran
    // and found the real one.
    expect(mockResearch).toHaveBeenCalledTimes(2);
    expect(result.proposed[0].linkedin_url).toBe('https://www.linkedin.com/in/ankit-tandon-7455429');
  });
});
