// Search dispatcher: fans a batch of queries across every configured provider
// and returns every outcome, successes and failures alike.
//
// Callers see the failures. Nothing here converts a dead provider into a quiet
// empty result — the research stage needs the difference to report honestly.

import { braveSearch, hasBraveKey } from './brave';
import { tavilySearch, hasTavilyKey } from './tavily';
import type { SearchOutcome, SearchQuery } from './types';

export * from './types';
export { hasTavilyKey } from './tavily';
export { hasBraveKey } from './brave';

export function configuredProviders(): string[] {
  const providers: string[] = [];
  if (hasTavilyKey()) providers.push('tavily');
  if (hasBraveKey()) providers.push('brave');
  return providers;
}

/**
 * Run every query against every configured provider, concurrently.
 * Returns one SearchOutcome per (query × provider).
 */
export async function runSearches(
  queries: SearchQuery[],
  maxResultsPerQuery = 6,
): Promise<SearchOutcome[]> {
  if (queries.length === 0) return [];

  const tasks: Promise<SearchOutcome>[] = [];
  for (const q of queries) {
    if (hasTavilyKey()) tasks.push(tavilySearch(q, maxResultsPerQuery));
    if (hasBraveKey()) tasks.push(braveSearch(q, maxResultsPerQuery));
  }

  if (tasks.length === 0) {
    // No provider configured at all: surface it as a failed outcome per query
    // rather than pretending the searches ran and found nothing.
    return queries.map((q) => ({
      query: q.query,
      category: q.category,
      provider: 'tavily' as const,
      ok: false,
      hits: [],
      error: 'No search provider configured (set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY)',
      duration_ms: 0,
    }));
  }

  return Promise.all(tasks);
}
