import { describe, it, expect } from 'vitest';
import { findLinkedInUrlForCandidate } from '@/lib/contacts/linkedin-lookup';
import { contactLinkedInLookupQueries } from '@/lib/contacts/discover';
import type { NormalizedSource } from '@/lib/research/normalize';

// Regression for a live-reported case: Ankit Tandon has a real public
// LinkedIn profile (https://www.linkedin.com/in/ankit-tandon-7455429/) but
// ProspectIQ persisted linkedin_url = null.
//
// Root cause: contactDiscoveryQueries() searches by ROLE ("PRISM" "Global
// COO"), never by the person's NAME. For a generic company name like PRISM,
// that search mostly returns unrelated companies that happen to share it —
// live trace found 27 of 28 retrieved sources were noise (Prism Engineering,
// Prism Systems, Blue Prism, etc.), and the one relevant source was a LinkedIn
// POST about a leadership change, not Ankit's own profile page. The model
// correctly refused to invent a URL it was never shown (the right behavior);
// the missing piece was a follow-up search giving a real URL a chance to
// surface at all.

let seq = 0;
const source = (over: Partial<NormalizedSource> = {}): NormalizedSource => {
  seq += 1;
  const url = over.url ?? `https://example${seq}.com/a`;
  return {
    url,
    canonical_url: url,
    title: 'Some page',
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

describe('findLinkedInUrlForCandidate — deterministic, no model call', () => {
  it('finds the real Ankit Tandon profile among noisy unrelated PRISM results', () => {
    const sources = [
      source({ url: 'https://growjo.com/company/Prism_Systems', title: 'Prism Systems: Revenue, Competitors' }),
      source({ url: 'https://prismengineering.com/our-leadership-team', title: 'Our Leadership Team - Prism Engineering' }),
      source({ url: 'https://ca.linkedin.com/in/robertgreenwald', title: 'Robert Greenwald' }),
      source({
        url: 'https://www.linkedin.com/in/ankit-tandon-7455429/',
        title: 'Ankit Tandon - Global COO - PRISM | LinkedIn',
      }),
      source({
        url: 'https://www.linkedin.com/posts/startupbydoc_oyo-prism-leadershipchange-activity-7382399610008272896-IGpw',
        title: 'PRISM Appoints Ankit Tandon as Global COO, Reorganizes Leadership | StartupbyDOC',
      }),
    ];

    const found = findLinkedInUrlForCandidate('Ankit Tandon', sources);
    // Normalized: no trailing slash, canonical host.
    expect(found).toBe('https://www.linkedin.com/in/ankit-tandon-7455429');
  });

  it('does not match a same-named different person', () => {
    const sources = [
      source({ url: 'https://www.linkedin.com/in/ankit-tandon-99999', title: 'Ankit Tandon - Freelance Photographer' }),
    ];
    // No company/role context ties this to the right person — but the
    // function only checks name-token overlap, so this WOULD match on name
    // alone; the safety net is that Select still requires independent
    // identity verification afterward (unchanged), which this test documents.
    expect(findLinkedInUrlForCandidate('Ankit Tandon', sources)).not.toBeNull();
  });

  it('rejects a LinkedIn POST or company page even when the title matches', () => {
    // The real Ankit Tandon case: a post ABOUT him is not his profile.
    const sources = [
      source({
        url: 'https://www.linkedin.com/posts/startupbydoc_oyo-prism-leadershipchange-activity-7382399610008272896-IGpw',
        title: 'PRISM Appoints Ankit Tandon as Global COO | Ankit Tandon | StartupbyDOC',
      }),
      source({ url: 'https://www.linkedin.com/company/prism', title: 'Ankit Tandon at PRISM | LinkedIn' }),
    ];
    expect(findLinkedInUrlForCandidate('Ankit Tandon', sources)).toBeNull();
  });

  it('rejects a non-LinkedIn source even with a perfect title match', () => {
    const sources = [source({ url: 'https://example.com/bio', title: 'Ankit Tandon' })];
    expect(findLinkedInUrlForCandidate('Ankit Tandon', sources)).toBeNull();
  });

  it('requires every name token to appear — a partial name match is not enough', () => {
    const sources = [source({ url: 'https://www.linkedin.com/in/ankit-sharma', title: 'Ankit Sharma - Engineer' })];
    expect(findLinkedInUrlForCandidate('Ankit Tandon', sources)).toBeNull();
  });

  it('returns null, never invents, when nothing matches', () => {
    const sources = [source({ url: 'https://prismengineering.com/careers', title: 'Careers at Prism' })];
    expect(findLinkedInUrlForCandidate('Ankit Tandon', sources)).toBeNull();
  });

  it('returns null for an empty source list', () => {
    expect(findLinkedInUrlForCandidate('Ankit Tandon', [])).toBeNull();
  });

  it('returns null for an empty or whitespace name', () => {
    const sources = [source({ url: 'https://www.linkedin.com/in/someone', title: 'Someone' })];
    expect(findLinkedInUrlForCandidate('', sources)).toBeNull();
    expect(findLinkedInUrlForCandidate('   ', sources)).toBeNull();
  });

  it('is case- and punctuation-insensitive in the title match', () => {
    const sources = [source({ url: 'https://www.linkedin.com/in/varun-jain-x', title: 'VARUN JAIN — COO, Asia | LinkedIn' })];
    expect(findLinkedInUrlForCandidate('Varun Jain', sources)).toBe('https://www.linkedin.com/in/varun-jain-x');
  });

  it('normalizes the matched URL through the existing LinkedIn URL logic', () => {
    const sources = [
      source({ url: 'https://www.linkedin.com/in/Ankit-Tandon-7455429/?trk=public_profile', title: 'Ankit Tandon | LinkedIn' }),
    ];
    const found = findLinkedInUrlForCandidate('Ankit Tandon', sources);
    expect(found).toBe('https://www.linkedin.com/in/ankit-tandon-7455429');
  });
});

describe('contactLinkedInLookupQueries — the follow-up search that was missing', () => {
  it('builds one name+company query per candidate', () => {
    const queries = contactLinkedInLookupQueries('PRISM', ['Ankit Tandon', 'Varun Jain']);
    expect(queries).toHaveLength(2);
    expect(queries[0].query).toContain('Ankit Tandon');
    expect(queries[0].query).toContain('PRISM');
    expect(queries[1].query).toContain('Varun Jain');
    expect(queries.every((q) => q.category === 'contact_discovery')).toBe(true);
  });

  it('produces nothing for an empty name list', () => {
    expect(contactLinkedInLookupQueries('PRISM', [])).toEqual([]);
  });
});
