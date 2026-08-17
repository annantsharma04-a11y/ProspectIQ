// Brave Search client (optional second provider).
//
// Only used when BRAVE_SEARCH_API_KEY is set. Running two providers widens
// coverage and gives the dedup step independent corroboration for a URL.

import {
  toIsoDate,
  type SearchHit,
  type SearchOutcome,
  type SearchProvider,
  type SearchQuery,
} from './types';

const WEB_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const NEWS_ENDPOINT = 'https://api.search.brave.com/res/v1/news/search';
const TIMEOUT_MS = 20_000;

export function hasBraveKey(): boolean {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY);
}

export async function braveSearch(q: SearchQuery, maxResults = 6): Promise<SearchOutcome> {
  const useNews = Boolean(q.recent_only);
  const provider: SearchProvider = useNews ? 'brave_news' : 'brave_web';
  const startedAt = Date.now();
  const base = { query: q.query, category: q.category, provider } as const;

  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) {
    return { ...base, ok: false, hits: [], error: 'BRAVE_SEARCH_API_KEY is not configured', duration_ms: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = new URL(useNews ? NEWS_ENDPOINT : WEB_ENDPOINT);
    url.searchParams.set('q', q.query);
    url.searchParams.set('count', String(maxResults));
    url.searchParams.set('country', 'us');
    url.searchParams.set('search_lang', 'en');

    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    });

    if (!res.ok) {
      return {
        ...base,
        ok: false,
        hits: [],
        error: `Brave HTTP ${res.status}`,
        duration_ms: Date.now() - startedAt,
      };
    }

    const json = (await res.json()) as {
      web?: { results?: Array<Record<string, unknown>> };
      results?: Array<Record<string, unknown>>;
    };
    const raw = json.web?.results ?? json.results ?? [];

    const hits: SearchHit[] = raw
      .map((r) => ({
        title: String(r.title ?? '').trim(),
        url: String(r.url ?? '').trim(),
        snippet: String(r.description ?? '').trim(),
        provider,
        published_date: toIsoDate((r.page_age as string) ?? (r.age as string) ?? undefined),
        provider_score: null,
        query: q.query,
        category: q.category,
      }))
      .filter((h) => h.url.length > 0);

    return { ...base, ok: true, hits, error: null, duration_ms: Date.now() - startedAt };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ...base,
      ok: false,
      hits: [],
      error: isAbort ? `Brave timed out after ${TIMEOUT_MS}ms` : `Brave failed: ${String(err)}`,
      duration_ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
