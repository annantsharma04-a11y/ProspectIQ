// Research engine: search → normalize/dedupe → selectively scrape.
//
// These are the building blocks the pipeline stages compose. The engine keeps
// full telemetry (every query, provider, failure and duration) because the run
// record has to show what actually happened, not a summary of it.

import { runSearches, type SearchOutcome, type SearchQuery } from '@/lib/search';
import { scrapeMany } from './scrape';
import { normalizeAndDedupe, type NormalizedSource } from './normalize';
import { isSameSource } from '@/lib/url-identity';

export interface SearchRound {
  label: string;
  outcomes: SearchOutcome[];
  /** Queries issued vs. queries that came back ok. */
  queries_run: number;
  queries_ok: number;
  hits_before_dedupe: number;
  sources_after_dedupe: number;
}

export interface ResearchResult {
  sources: NormalizedSource[];
  round: SearchRound;
  /** True when at least one provider call failed but we still have results. */
  degraded: boolean;
  /** True when every provider call failed. */
  all_failed: boolean;
}

/**
 * Run a batch of queries and fold the results into a deduped source set.
 * `existing` lets later rounds merge into the set built by earlier rounds.
 */
export async function research(
  label: string,
  queries: SearchQuery[],
  companyDomains: string[] = [],
  existing: NormalizedSource[] = [],
): Promise<ResearchResult> {
  // Different planners can propose the same query; never pay for it twice.
  const seenQueries = new Set<string>();
  const unique = queries.filter((q) => {
    const key = q.query.trim().toLowerCase();
    if (seenQueries.has(key)) return false;
    seenQueries.add(key);
    return true;
  });

  const outcomes = await runSearches(unique);
  const hits = outcomes.flatMap((o) => o.hits);

  const queriesOk = outcomes.filter((o) => o.ok).length;
  const allFailed = outcomes.length > 0 && queriesOk === 0;

  // Re-normalize the union so cross-round duplicates collapse too.
  const existingAsHits = existing.map((s) => ({
    title: s.title,
    url: s.url,
    snippet: s.snippet,
    provider: (s.providers[0] ?? 'tavily') as never,
    published_date: s.published_date,
    provider_score: null,
    query: s.queries[0] ?? '',
    category: (s.categories[0] ?? 'company_news') as never,
  }));

  const merged = normalizeAndDedupe([...existingAsHits, ...hits], companyDomains);

  // Carry scraped bodies across rounds so we never re-scrape the same page.
  for (const source of merged) {
    const prior = existing.find((e) => isSameSource(e.canonical_url, source.canonical_url));
    if (prior?.content) {
      source.content = prior.content;
      source.fetch_status = prior.fetch_status;
    }
  }

  return {
    sources: merged,
    degraded: queriesOk < outcomes.length,
    all_failed: allFailed,
    round: {
      label,
      outcomes,
      queries_run: outcomes.length,
      queries_ok: queriesOk,
      hits_before_dedupe: hits.length,
      sources_after_dedupe: merged.length,
    },
  };
}

/**
 * Scrape the most promising sources for full text. Snippets alone are thin
 * evidence; full pages let the extractor quote real supporting text.
 *
 * Only unscraped sources are fetched, most credible first.
 */
export async function enrichSources(
  sources: NormalizedSource[],
  limit = 6,
): Promise<{ sources: NormalizedSource[]; scraped: number; failed: number }> {
  const candidates = sources
    .filter((s) => s.fetch_status === 'snippet_only')
    .sort((a, b) => scrapePriority(b) - scrapePriority(a))
    .slice(0, limit);

  if (candidates.length === 0) return { sources, scraped: 0, failed: 0 };

  const results = await scrapeMany(candidates.map((s) => s.url));

  let scraped = 0;
  let failed = 0;
  results.forEach((result, i) => {
    const target = sources.find((s) => s.url === candidates[i].url);
    if (!target) return;
    if (result.ok) {
      target.content = result.markdown.slice(0, 20_000);
      target.fetch_status = 'scraped';
      scraped++;
    } else {
      target.fetch_status = 'scrape_failed';
      failed++;
    }
  });

  return { sources, scraped, failed };
}

/** Prefer dated, credible, corroborated sources when spending scrape budget. */
function scrapePriority(s: NormalizedSource): number {
  return s.credibility + (s.published_date ? 0.3 : 0) + Math.min(s.duplicate_count, 3) * 0.1;
}

/**
 * Stopping rule for iterative research: keep going only while the evidence is
 * genuinely thin and we have budget left.
 */
export function needsMoreResearch(
  sources: NormalizedSource[],
  roundsDone: number,
  maxRounds = 3,
): { more: boolean; reason: string } {
  if (roundsDone >= maxRounds) {
    return { more: false, reason: `Reached the ${maxRounds}-round research budget.` };
  }

  const dated = sources.filter((s) => s.published_date);
  const recent = dated.filter((s) => monthsOld(s.published_date!) <= 12);
  const credible = sources.filter((s) => s.credibility >= 0.7);

  if (sources.length === 0) {
    return { more: true, reason: 'No sources found yet; widening the search.' };
  }
  if (recent.length >= 3 && credible.length >= 2) {
    return {
      more: false,
      reason: `Enough evidence: ${recent.length} recent dated sources and ${credible.length} credible sources.`,
    };
  }
  return {
    more: true,
    reason: `Evidence still thin (${recent.length} recent, ${credible.length} credible); running targeted follow-ups.`,
  };
}

export function monthsOld(isoDate: string, now: Date = new Date()): number {
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}
