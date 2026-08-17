// Tavily search client (primary provider).
//
// Isolated by contract: a failure returns ok:false with the reason attached,
// so one dead query degrades a stage instead of throwing out of the pipeline.

import {
  toIsoDate,
  type SearchHit,
  type SearchOutcome,
  type SearchProvider,
  type SearchQuery,
} from './types';

const ENDPOINT = 'https://api.tavily.com/search';
const TIMEOUT_MS = 20_000;

export function hasTavilyKey(): boolean {
  return Boolean(process.env.TAVILY_API_KEY);
}

export async function tavilySearch(q: SearchQuery, maxResults = 6): Promise<SearchOutcome> {
  const provider: SearchProvider = q.recent_only ? 'tavily_news' : 'tavily';
  const startedAt = Date.now();
  const base = {
    query: q.query,
    category: q.category,
    provider,
    duration_ms: 0,
  } as const;

  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    return { ...base, ok: false, hits: [], error: 'TAVILY_API_KEY is not configured', duration_ms: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query: q.query,
        search_depth: 'basic',
        max_results: maxResults,
        // The news topic is what surfaces published_date; general search does not.
        ...(q.recent_only ? { topic: 'news', days: 365 } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ...base,
        ok: false,
        hits: [],
        error: `Tavily HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        duration_ms: Date.now() - startedAt,
      };
    }

    const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const hits: SearchHit[] = (json.results ?? [])
      .map((r) => ({
        title: String(r.title ?? '').trim(),
        url: String(r.url ?? '').trim(),
        snippet: String(r.content ?? '').trim(),
        provider,
        published_date: toIsoDate(r.published_date as string | undefined),
        provider_score: r.score != null ? Number(r.score) : null,
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
      error: isAbort ? `Tavily timed out after ${TIMEOUT_MS}ms` : `Tavily failed: ${String(err)}`,
      duration_ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
