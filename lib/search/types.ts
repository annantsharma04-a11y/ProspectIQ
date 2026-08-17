// Provider-neutral search contracts. Everything downstream of /search works in
// terms of SearchHit, so adding or losing a provider changes nothing else.

export type SearchProvider = 'tavily' | 'tavily_news' | 'brave_web' | 'brave_news';

/**
 * Why a query was issued. Recorded on every hit so the run record shows which
 * line of enquiry produced the evidence.
 */
export type QueryCategory =
  | 'prospect_identity'
  | 'prospect_company'
  | 'prospect_activity'
  | 'company_news'
  | 'company_funding'
  | 'company_hiring'
  | 'company_product'
  | 'company_strategy'
  | 'followup';

export interface SearchQuery {
  query: string;
  category: QueryCategory;
  /** News-topic searches carry publication dates; general ones usually don't. */
  recent_only?: boolean;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  provider: SearchProvider;
  /** ISO date (YYYY-MM-DD) when the provider reported one, else null. */
  published_date: string | null;
  /** Provider's own relevance score, when available. */
  provider_score: number | null;
  query: string;
  category: QueryCategory;
}

/**
 * One query's result. `ok:false` is a real, recorded failure — never silently
 * turned into an empty success.
 */
export interface SearchOutcome {
  query: string;
  category: QueryCategory;
  provider: SearchProvider;
  ok: boolean;
  hits: SearchHit[];
  error: string | null;
  duration_ms: number;
}

/** Normalize provider date strings (RFC 1123, ISO, etc.) to YYYY-MM-DD. */
export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Reject implausible dates rather than trusting a bad parse.
  const year = d.getUTCFullYear();
  if (year < 1990 || year > new Date().getUTCFullYear() + 1) return null;
  return d.toISOString().slice(0, 10);
}
