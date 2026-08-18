import { describe, it, expect } from 'vitest';
import {
  belongsToStage,
  displayDate,
  evidenceKindOf,
  findSourceByUrl,
  mentionsProspect,
  rankSources,
  stageNeedsSources,
  topSources,
} from '@/lib/research/top-sources';
import type { SignalRow, SourceRow } from '@/lib/types';

// Two properties matter most here, and both are ways the list could quietly
// mislead a reviewer:
//
//   * A company source must never appear under person research, or vice versa.
//     The split comes from the same `found_via` categories the pipeline used to
//     build its queries, not from a guess about the URL.
//   * "Used as evidence" must come from the stored signals only. Inferring it
//     from rank would put an evidence badge on something no verification ever
//     accepted.

const NOW = new Date('2026-08-17T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

let seq = 0;
const source = (over: Partial<SourceRow> = {}): SourceRow => {
  seq += 1;
  const url = over.url ?? `https://example${seq}.com/a`;
  return {
    id: `s${seq}`,
    run_id: 'run-1',
    url,
    canonical_url: over.canonical_url ?? url,
    title: `Source ${seq}`,
    snippet: null,
    source_type: 'web',
    credibility: 0.5,
    published_date: null,
    retrieved_at: ago(1),
    fetch_status: 'snippet_only',
    providers: ['tavily'],
    found_via: ['company_news'],
    duplicate_count: 0,
    content: null,
    content_chars: null,
    ...over,
  } as SourceRow;
};

const signal = (source_url: string): SignalRow =>
  ({ id: `sig-${source_url}`, run_id: 'run-1', signal: 's', source_url }) as SignalRow;

describe('person and company sources never cross over', () => {
  const person = source({ found_via: ['prospect_activity'] });
  const personIdentity = source({ found_via: ['prospect_identity'] });
  const personCompany = source({ found_via: ['prospect_company'] });
  const company = source({ found_via: ['company_hiring'] });
  const both = source({ found_via: ['prospect_activity', 'company_news'] });

  it('assigns by the category prefix the pipeline itself used', () => {
    expect(belongsToStage(person, 'research_prospect')).toBe(true);
    expect(belongsToStage(person, 'research_company')).toBe(false);
    expect(belongsToStage(company, 'research_company')).toBe(true);
    expect(belongsToStage(company, 'research_prospect')).toBe(false);
  });

  it('treats prospect_company as person research, matching the query builder', () => {
    // The pipeline builds prospect_* queries for research_prospect, and
    // prospect_company is one of them: it is "who does this person work for",
    // not company news.
    expect(belongsToStage(personCompany, 'research_prospect')).toBe(true);
    expect(belongsToStage(personCompany, 'research_company')).toBe(false);
  });

  it('a source found by both kinds of query appears in both, because it was', () => {
    expect(belongsToStage(both, 'research_prospect')).toBe(true);
    expect(belongsToStage(both, 'research_company')).toBe(true);
  });

  it('excludes the other stage entirely when ranking', () => {
    const all = [person, personIdentity, company];
    const p = rankSources(all, 'research_prospect', [], NOW);
    const c = rankSources(all, 'research_company', [], NOW);

    expect(p.map((r) => r.source.id).sort()).toEqual([person.id, personIdentity.id].sort());
    expect(c.map((r) => r.source.id)).toEqual([company.id]);
  });

  it('a source with no categories belongs to neither stage', () => {
    const orphan = source({ found_via: [] });
    expect(belongsToStage(orphan, 'research_prospect')).toBe(false);
    expect(belongsToStage(orphan, 'research_company')).toBe(false);
    expect(rankSources([orphan], 'research_company', [], NOW)).toEqual([]);
  });
});

describe('ranking is deterministic and prefers stronger evidence', () => {
  it('ranks full text above an otherwise identical snippet', () => {
    const full = source({ url: 'https://a.com/1', fetch_status: 'scraped' });
    const snip = source({ url: 'https://b.com/1', fetch_status: 'snippet_only' });
    const ranked = rankSources([snip, full], 'research_company', [], NOW);
    expect(ranked[0].source.id).toBe(full.id);
    expect(ranked[0].evidence).toBe('full');
    expect(ranked[1].evidence).toBe('snippet');
  });

  it('ranks a verified evidence source above an unused one', () => {
    const used = source({ url: 'https://a.com/1' });
    const unused = source({ url: 'https://b.com/1' });
    const ranked = rankSources([unused, used], 'research_company', [signal(used.url)], NOW);
    expect(ranked[0].source.id).toBe(used.id);
    expect(ranked[0].usedAsEvidence).toBe(true);
    expect(ranked[1].usedAsEvidence).toBe(false);
  });

  it('prefers higher credibility when nothing else differs', () => {
    const strong = source({ url: 'https://a.com/1', credibility: 0.9 });
    const weak = source({ url: 'https://b.com/1', credibility: 0.4 });
    expect(rankSources([weak, strong], 'research_company', [], NOW)[0].source.id).toBe(strong.id);
  });

  it('prefers a recent dated source over an old one', () => {
    const fresh = source({ url: 'https://a.com/1', published_date: ago(3) });
    const old = source({ url: 'https://b.com/1', published_date: ago(300) });
    expect(rankSources([old, fresh], 'research_company', [], NOW)[0].source.id).toBe(fresh.id);
  });

  it('gives no recency credit to an undated or future-dated source', () => {
    const undated = source({ url: 'https://a.com/1' });
    const future = source({ url: 'https://b.com/1', published_date: ago(-30) });
    const ranked = rankSources([undated, future], 'research_company', [], NOW);
    expect(ranked[0].score).toBe(ranked[1].score);
  });

  it('counts corroboration, but caps how far it can carry a source', () => {
    const many = source({ url: 'https://a.com/1', duplicate_count: 50 });
    const fullText = source({ url: 'https://b.com/1', fetch_status: 'scraped' });
    // 3 duplicates max × 3 points = 9, which cannot outweigh full text at 25.
    expect(rankSources([many, fullText], 'research_company', [], NOW)[0].source.id).toBe(fullText.id);
  });

  it('is stable: identical inputs give identical order', () => {
    const list = [
      source({ url: 'https://c.com/1' }),
      source({ url: 'https://a.com/1' }),
      source({ url: 'https://b.com/1' }),
    ];
    const first = rankSources(list, 'research_company', [], NOW).map((r) => r.source.id);
    const second = rankSources([...list].reverse(), 'research_company', [], NOW).map((r) => r.source.id);
    expect(first).toEqual(second);
  });
});

describe('evidence labelling comes from stored data only', () => {
  it('maps fetch status to the displayed evidence kind', () => {
    expect(evidenceKindOf(source({ fetch_status: 'scraped' }))).toBe('full');
    expect(evidenceKindOf(source({ fetch_status: 'snippet_only' }))).toBe('snippet');
    expect(evidenceKindOf(source({ fetch_status: 'scrape_failed' }))).toBe('unavailable');
    expect(evidenceKindOf(source({ fetch_status: null }))).toBe('snippet');
  });

  it('marks evidence from the signal URLs, never from position', () => {
    const first = source({ url: 'https://a.com/1', credibility: 0.9, fetch_status: 'scraped' });
    const second = source({ url: 'https://b.com/1', credibility: 0.4 });
    // The top-ranked source is NOT the one evidence was taken from.
    const ranked = rankSources([first, second], 'research_company', [signal(second.url)], NOW);
    const top = ranked.find((r) => r.source.id === first.id)!;
    const other = ranked.find((r) => r.source.id === second.id)!;
    expect(top.usedAsEvidence).toBe(false);
    expect(other.usedAsEvidence).toBe(true);
  });

  it('matches evidence across trivial URL differences', () => {
    const s = source({ url: 'https://a.com/story?utm_source=x', canonical_url: 'https://a.com/story' });
    const ranked = rankSources([s], 'research_company', [signal('https://a.com/story')], NOW);
    expect(ranked[0].usedAsEvidence).toBe(true);
  });

  it('marks nothing when no signals survived', () => {
    const ranked = rankSources([source(), source()], 'research_company', [], NOW);
    expect(ranked.every((r) => !r.usedAsEvidence)).toBe(true);
  });
});

describe('the displayed shortlist', () => {
  it('spreads across domains rather than letting one publisher fill it', () => {
    const dominant = Array.from({ length: 5 }, (_, i) =>
      source({ url: `https://big.com/${i}`, credibility: 0.9, fetch_status: 'scraped' }),
    );
    const others = [
      source({ url: 'https://small-a.com/1', credibility: 0.5 }),
      source({ url: 'https://small-b.com/1', credibility: 0.5 }),
    ];
    const picked = topSources(rankSources([...dominant, ...others], 'research_company', [], NOW), 4);

    expect(picked).toHaveLength(4);
    expect(new Set(picked.map((p) => p.domain)).size).toBe(3);
    expect(picked.filter((p) => p.domain === 'big.com')).toHaveLength(2);
  });

  it('fills remaining slots from the same domain when there is nothing else', () => {
    const only = Array.from({ length: 6 }, (_, i) => source({ url: `https://one.com/${i}` }));
    const picked = topSources(rankSources(only, 'research_company', [], NOW), 4);
    expect(picked).toHaveLength(4);
    expect(new Set(picked.map((p) => p.source.id)).size).toBe(4);
  });

  it('returns everything when there are fewer sources than slots', () => {
    const picked = topSources(rankSources([source(), source()], 'research_company', [], NOW), 4);
    expect(picked).toHaveLength(2);
  });

  it('handles the zero-source case', () => {
    expect(rankSources([], 'research_company', [], NOW)).toEqual([]);
    expect(topSources([], 4)).toEqual([]);
  });
});

describe('missing metadata is shown as missing, never invented', () => {
  it('returns null for an absent or unparseable date', () => {
    expect(displayDate(null)).toBeNull();
    expect(displayDate('not-a-date')).toBeNull();
    expect(displayDate('2026-08-12T00:00:00Z')).toMatch(/2026/);
  });

  it('ranks a source with no title, leaving the title empty for the UI', () => {
    const untitled = source({ title: null, url: 'https://a.com/x' });
    const ranked = rankSources([untitled], 'research_company', [], NOW);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].source.title).toBeNull();
    expect(ranked[0].domain).toBe('a.com');
  });

  it('still ranks a source missing credibility and date', () => {
    const sparse = source({ credibility: null, published_date: null });
    const ranked = rankSources([sparse], 'research_company', [], NOW);
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it('exposes the stored URL unchanged for linking', () => {
    const url = 'https://economictimes.com/article?id=7';
    const ranked = rankSources([source({ url })], 'research_company', [], NOW);
    expect(ranked[0].source.url).toBe(url);
  });
});

// ─── regression: research_prospect must not surface generic, unrelated ──────
// high-credibility news over real coverage of the person. Live case: a
// Kannan Ganesan (Myntra CFO) run's `prospect_activity` search padded a thin
// result set with a BBC "King Charles, Starmer and Iran" video and a Forbes
// "iPhone 18 Pro" article — both real, both genuinely retrieved, both scored
// 0.9 credibility (BBC/Forbes are high-authority domains), so pure
// credibility/freshness ranking put them ABOVE the actual CFO-appointment
// coverage. Neither has anything to do with Kannan Ganesan.

describe('research_prospect excludes sources unrelated to the actual person (Kannan Ganesan regression)', () => {
  const bbcNoise = source({
    found_via: ['prospect_activity'],
    credibility: 0.9,
    fetch_status: 'scraped',
    title: 'King Charles, Starmer and Iran: My five-minute interview with Trump - BBC',
    snippet: null,
    url: 'https://www.bbc.com/news/videos/c624yr5p3kpo',
  });
  const forbesNoise = source({
    found_via: ['prospect_activity'],
    credibility: 0.9,
    fetch_status: 'scraped',
    title: "Here's When Apple Will Reveal Its iPhone 18 Pro Special Event - Forbes",
    snippet: null,
    url: 'https://www.forbes.com/sites/x/heres-when-apple-will-reveal-its-iphone-18-pro',
  });
  const cfoAppointment = source({
    found_via: ['prospect_company'],
    credibility: 0.45,
    fetch_status: 'scraped',
    title: 'Myntra appoints Kannan Ganesan as Chief Financial Officer',
    snippet: 'Kannan Ganesan joins Myntra as CFO, succeeding Abhishek Gupta.',
    url: 'https://www.peoplematters.in/news/appointments/myntra-appoints-kannan-ganesan-as-cfo',
  });
  const linkedinProfile = source({
    found_via: ['prospect_identity'],
    credibility: 0.6,
    fetch_status: 'scraped',
    title: 'Kannan Ganesan — LinkedIn profile',
    snippet: null,
    url: 'https://www.linkedin.com/in/kannan-ganesan-0368408',
  });

  const prospect = { name: 'Kannan Ganesan', slug: 'kannan-ganesan-0368408' };

  it('excludes the unrelated high-credibility sources entirely', () => {
    expect(mentionsProspect(bbcNoise, prospect)).toBe(false);
    expect(mentionsProspect(forbesNoise, prospect)).toBe(false);
  });

  it('keeps sources that actually name the person', () => {
    expect(mentionsProspect(cfoAppointment, prospect)).toBe(true);
  });

  it("keeps the person's own LinkedIn profile even though the title alone doesn't repeat the full name distinctively", () => {
    expect(mentionsProspect(linkedinProfile, prospect)).toBe(true);
  });

  it('rankSources() for research_prospect drops the noise and ranks real coverage instead', () => {
    const ranked = rankSources(
      [bbcNoise, forbesNoise, cfoAppointment, linkedinProfile],
      'research_prospect',
      [],
      NOW,
      prospect,
    );
    const urls = ranked.map((r) => r.source.url);
    expect(urls).not.toContain(bbcNoise.url);
    expect(urls).not.toContain(forbesNoise.url);
    expect(urls).toContain(cfoAppointment.url);
    expect(urls).toContain(linkedinProfile.url);
  });

  it('without a prospect context, falls back to the prior unfiltered behavior (backward compatible)', () => {
    const ranked = rankSources([bbcNoise, forbesNoise, cfoAppointment], 'research_prospect', [], NOW);
    expect(ranked.map((r) => r.source.url)).toContain(bbcNoise.url);
  });

  it('does not gate research_company sources by the prospect at all', () => {
    const companyNoise = source({ found_via: ['company_news'], title: 'Unrelated company news' });
    const ranked = rankSources([companyNoise], 'research_company', [], NOW, prospect);
    expect(ranked).toHaveLength(1);
  });

  it('a name with no matching tokens anywhere in a real source is excluded too, not just obviously unrelated ones', () => {
    const wrongPerson = source({
      found_via: ['prospect_activity'],
      title: 'Seema Verma Appointed as Chief Executive Officer at eDAS',
      snippet: null,
    });
    expect(mentionsProspect(wrongPerson, prospect)).toBe(false);
  });
});

// ─── regression: the stage detail PAGE must actually fetch sources for ──────
// collect_signals, or TopSources always renders "No sources retrieved" no
// matter how many rows the run has. Live case: /runs/[id]/stages/collect_
// signals showed "49 sources ready" in the summary text (from the stage's
// OWN recorded output) right above a "No sources retrieved" TopSources card —
// because the page's data-fetching only requested `listSources`/`listSignals`
// for research_prospect/research_company, never for collect_signals, so
// `sources`/`signals` were hardcoded to `[]` regardless of what existed.

describe('stageNeedsSources — which stage pages must fetch sources/signals', () => {
  it('requires sources for both research stages and collect_signals', () => {
    expect(stageNeedsSources('research_prospect')).toBe(true);
    expect(stageNeedsSources('research_company')).toBe(true);
    expect(stageNeedsSources('collect_signals')).toBe(true);
  });

  it('does not require sources for stages whose detail is fully self-contained in their own output', () => {
    for (const stage of ['validate_input', 'identify_prospect', 'qualify_prospect', 'select_hook', 'generate_message', 'validate_claims', 'ready_for_review']) {
      expect(stageNeedsSources(stage)).toBe(false);
    }
  });
});

describe('collect_signals shows the full consolidated evidence set', () => {
  it('includes sources found via either the prospect or the company research', () => {
    const prospectSource = source({ found_via: ['prospect_activity'] });
    const companySource = source({ found_via: ['company_news'] });
    expect(belongsToStage(prospectSource, 'collect_signals')).toBe(true);
    expect(belongsToStage(companySource, 'collect_signals')).toBe(true);
  });

  it('includes a source with no found_via category at all', () => {
    const bare = source({ found_via: [] });
    expect(belongsToStage(bare, 'collect_signals')).toBe(true);
  });

  it('ranks and marks "used as evidence" exactly like the research stages do', () => {
    const used = source({ found_via: ['prospect_activity'] });
    const unused = source({ found_via: ['company_news'] });
    const ranked = rankSources([used, unused], 'collect_signals', [signal(used.url)], NOW);
    expect(ranked).toHaveLength(2);
    expect(ranked.find((r) => r.source.id === used.id)?.usedAsEvidence).toBe(true);
    expect(ranked.find((r) => r.source.id === unused.id)?.usedAsEvidence).toBe(false);
  });
});

// ─── per-signal source lookup (evaluate_signals candidate list) ────────────────

describe('findSourceByUrl — resolving a citation back to its persisted source', () => {
  it('finds the source by exact URL match', () => {
    const s = source({ url: 'https://a.com/article' });
    expect(findSourceByUrl([s], 'https://a.com/article')).toBe(s);
  });

  it('matches through identity, not string equality (locale subdomain, tracking params)', () => {
    const s = source({
      url: 'https://www.linkedin.com/in/jane-doe',
      canonical_url: 'https://www.linkedin.com/in/jane-doe',
    });
    expect(findSourceByUrl([s], 'https://sg.linkedin.com/in/jane-doe?trk=public_profile')).toBe(s);
  });

  it('returns null for a URL not among this run\'s persisted sources — never invents one', () => {
    const s = source({ url: 'https://a.com/article' });
    expect(findSourceByUrl([s], 'https://not-retrieved.example.com/x')).toBeNull();
  });

  it('returns null for a missing or empty URL', () => {
    const s = source({ url: 'https://a.com/article' });
    expect(findSourceByUrl([s], null)).toBeNull();
    expect(findSourceByUrl([s], undefined)).toBeNull();
    expect(findSourceByUrl([s], '')).toBeNull();
  });

  it('returns null against an empty source list', () => {
    expect(findSourceByUrl([], 'https://a.com/article')).toBeNull();
  });
});
