// Source normalization: canonical URLs, deduplication, and credibility tiering.
//
// Pure functions — no network, no LLM. This is what turns a noisy pile of
// search hits into a clean evidence set, and it is fully unit-testable.

import type { SearchHit } from '@/lib/search/types';
import { canonicalUrl, hostOf, sourceKey } from '@/lib/url-identity';

// URL identity lives in lib/url-identity.ts — the one place URLs are compared.
export { canonicalUrl, hostOf, sourceKey };

export type SourceType =
  | 'official'        // the company's own site / newsroom
  | 'press_release'   // wire services
  | 'news_major'      // major business/tech press
  | 'news_trade'      // industry publications
  | 'job_posting'     // ATS and job boards
  | 'database'        // Crunchbase-style aggregators
  | 'social'          // posts, blogs, social platforms
  | 'linkedin'        // LinkedIn itself
  | 'web';            // everything else

/** Credibility weight per tier, used in ranking. */
export const CREDIBILITY: Record<SourceType, number> = {
  official: 0.95,
  press_release: 0.8,
  news_major: 0.9,
  news_trade: 0.75,
  job_posting: 0.7,
  database: 0.65,
  linkedin: 0.6,
  social: 0.4,
  web: 0.45,
};

const MAJOR_NEWS = [
  'reuters.com', 'bloomberg.com', 'wsj.com', 'ft.com', 'cnbc.com', 'forbes.com',
  'techcrunch.com', 'axios.com', 'theinformation.com', 'businessinsider.com',
  'nytimes.com', 'theguardian.com', 'economictimes.indiatimes.com', 'livemint.com',
  'fortune.com', 'apnews.com', 'cnn.com', 'bbc.com', 'inc.com', 'fastcompany.com',
];

const TRADE_NEWS = [
  'venturebeat.com', 'siliconangle.com', 'zdnet.com', 'theverge.com', 'wired.com',
  'protocol.com', 'fintechfutures.com', 'pymnts.com', 'finextra.com', 'yourstory.com',
  'entrackr.com', 'inc42.com', 'techinasia.com', 'eu-startups.com', 'sifted.eu',
];

const WIRES = ['prnewswire.com', 'businesswire.com', 'globenewswire.com', 'newswire.com', 'prweb.com'];

const JOB_BOARDS = [
  'greenhouse.io', 'lever.co', 'workable.com', 'ashbyhq.com', 'indeed.com',
  'glassdoor.com', 'wellfound.com', 'angel.co', 'naukri.com', 'ziprecruiter.com',
];

const DATABASES = ['crunchbase.com', 'pitchbook.com', 'tracxn.com', 'dealroom.co', 'cbinsights.com', 'owler.com'];

const SOCIAL = [
  'twitter.com', 'x.com', 'medium.com', 'substack.com', 'reddit.com', 'facebook.com',
  'instagram.com', 'youtube.com', 'threads.net', 'quora.com',
];

function matchesDomain(host: string, list: string[]): boolean {
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Classify a source. `companyDomains` lets a company's own site outrank press:
 * an announcement on the company newsroom is first-party evidence.
 */
export function classifySource(url: string, companyDomains: string[] = []): SourceType {
  const host = hostOf(url);
  if (!host) return 'web';

  if (host.endsWith('linkedin.com')) {
    return /\/jobs?\//i.test(url) ? 'job_posting' : 'linkedin';
  }
  if (companyDomains.some((d) => d && (host === d || host.endsWith(`.${d}`)))) return 'official';
  if (matchesDomain(host, WIRES)) return 'press_release';
  if (matchesDomain(host, MAJOR_NEWS)) return 'news_major';
  if (matchesDomain(host, TRADE_NEWS)) return 'news_trade';
  if (matchesDomain(host, JOB_BOARDS)) return 'job_posting';
  if (matchesDomain(host, DATABASES)) return 'database';
  if (matchesDomain(host, SOCIAL)) return 'social';
  return 'web';
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'at', 'by',
  'from', 'as', 'is', 'are', 'was', 'were', 'its', 'it', 'that', 'this', 'has', 'have',
]);

export function titleTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Jaccard overlap of two token sets, 0–1. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export interface NormalizedSource {
  url: string;
  canonical_url: string;
  title: string;
  snippet: string;
  source_type: SourceType;
  credibility: number;
  published_date: string | null;
  /** Providers/queries that produced this URL — corroboration evidence. */
  providers: string[];
  queries: string[];
  categories: string[];
  /** Number of distinct near-duplicate results folded into this one. */
  duplicate_count: number;
  retrieved_at: string;
  /** Full page text, present only when the page was successfully scraped. */
  content: string | null;
  /** How the body text was obtained — snippet-only is weaker evidence. */
  fetch_status: 'snippet_only' | 'scraped' | 'scrape_failed';
}

/**
 * How strong the evidence from a source is.
 *   FULL        page retrieved, usable content extracted
 *   SNIPPET     page unavailable, but a meaningful search result remains
 *   UNAVAILABLE nothing usable — cannot support a factual claim
 *
 * Page extraction failing downgrades a source; it never deletes it. That is what
 * keeps research usable when the extraction provider is down.
 */
export type EvidenceLevel = 'FULL' | 'SNIPPET' | 'UNAVAILABLE';

const MEANINGFUL_SNIPPET_CHARS = 40;

/** Minimum stored body length before we will call a source FULL. */
const MIN_FULL_CONTENT_CHARS = 200;

/**
 * The single definition of evidence strength, used by scoring, the claim
 * validator and the UI alike.
 *
 * FULL requires that the target page was actually retrieved AND its body stored.
 * A `scraped` flag with no surviving content is NOT full evidence — that is the
 * case that used to let "the article states…" language rest on a search snippet.
 */
export function evidenceLevel(source: {
  fetch_status: string;
  content: string | null;
  snippet: string;
  title: string;
}): EvidenceLevel {
  const body = (source.content ?? '').trim();
  if (source.fetch_status === 'scraped' && body.length >= MIN_FULL_CONTENT_CHARS) return 'FULL';
  if ((source.snippet ?? '').trim().length >= MEANINGFUL_SNIPPET_CHARS) return 'SNIPPET';
  if ((source.title ?? '').trim().length > 0 && (source.snippet ?? '').trim().length > 0) return 'SNIPPET';
  return 'UNAVAILABLE';
}

/** Weight applied to a source's credibility based on how well we could read it. */
export const EVIDENCE_WEIGHT: Record<EvidenceLevel, number> = {
  FULL: 1.0,
  SNIPPET: 0.75,
  UNAVAILABLE: 0.0,
};

/** Count sources by evidence level — used in stage summaries and the UI. */
export function evidenceBreakdown(sources: NormalizedSource[]): Record<EvidenceLevel, number> {
  const counts: Record<EvidenceLevel, number> = { FULL: 0, SNIPPET: 0, UNAVAILABLE: 0 };
  for (const s of sources) counts[evidenceLevel(s)]++;
  return counts;
}

const NEAR_DUPLICATE_THRESHOLD = 0.82;

/**
 * Collapse search hits into a unique evidence set.
 *
 * Two passes: exact canonical-URL match, then near-duplicate titles from
 * different hosts (syndicated coverage of one event). Independent corroboration
 * is preserved in `providers`/`duplicate_count` rather than thrown away.
 */
export function normalizeAndDedupe(
  hits: SearchHit[],
  companyDomains: string[] = [],
): NormalizedSource[] {
  const retrievedAt = new Date().toISOString();
  const byCanonical = new Map<string, NormalizedSource>();

  for (const hit of hits) {
    if (!hit.url) continue;
    const key = sourceKey(hit.url);
    const existing = byCanonical.get(key);

    if (existing) {
      if (!existing.providers.includes(hit.provider)) existing.providers.push(hit.provider);
      if (!existing.queries.includes(hit.query)) existing.queries.push(hit.query);
      if (!existing.categories.includes(hit.category)) existing.categories.push(hit.category);
      existing.duplicate_count++;
      // Keep the longest snippet and any date we can find.
      if (hit.snippet.length > existing.snippet.length) existing.snippet = hit.snippet;
      if (!existing.published_date && hit.published_date) existing.published_date = hit.published_date;
      continue;
    }

    const type = classifySource(hit.url, companyDomains);
    byCanonical.set(key, {
      url: hit.url,
      canonical_url: canonicalUrl(hit.url),
      title: hit.title,
      snippet: hit.snippet,
      source_type: type,
      credibility: CREDIBILITY[type],
      published_date: hit.published_date,
      providers: [hit.provider],
      queries: [hit.query],
      categories: [hit.category],
      duplicate_count: 0,
      retrieved_at: retrievedAt,
      content: null,
      fetch_status: 'snippet_only',
    });
  }

  // Near-duplicate pass: same story syndicated across outlets.
  const unique: NormalizedSource[] = [];
  for (const candidate of byCanonical.values()) {
    const candidateTokens = titleTokens(candidate.title);
    const twin = unique.find(
      (kept) =>
        similarity(titleTokens(kept.title), candidateTokens) >= NEAR_DUPLICATE_THRESHOLD &&
        hostOf(kept.url) !== hostOf(candidate.url),
    );

    if (!twin) {
      unique.push(candidate);
      continue;
    }

    // Same story: keep the more credible source, fold the other in as corroboration.
    twin.duplicate_count += 1 + candidate.duplicate_count;
    for (const p of candidate.providers) if (!twin.providers.includes(p)) twin.providers.push(p);
    for (const q of candidate.queries) if (!twin.queries.includes(q)) twin.queries.push(q);
    if (!twin.published_date && candidate.published_date) twin.published_date = candidate.published_date;

    if (candidate.credibility > twin.credibility) {
      // Promote the better source into the kept slot, retaining merged counters.
      const merged = { ...candidate, duplicate_count: twin.duplicate_count, providers: twin.providers, queries: twin.queries };
      unique[unique.indexOf(twin)] = merged;
    }
  }

  return unique;
}
