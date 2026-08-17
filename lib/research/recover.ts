// Targeted recovery of cited-but-unretrieved sources.
//
// The analysis sometimes proposes a legitimate hook while citing a URL that the
// research pass never fetched. Rejecting outright loses real signal; trusting
// the citation would be worse. So we do the only safe thing: go and fetch the
// page, and then run exactly the same verification everything else goes through.
//
//   model citation → retrieve → evidence → verify → qualify
//
// The citation itself is never evidence. Recovery only adds a source to the
// evidence set; it grants no standing of its own, and a recovered page whose
// content does not support the quote still fails verification.

import { scrapeUrl } from './scrape';
import { canonicalUrl, classifySource, CREDIBILITY, type NormalizedSource } from './normalize';
import { isSameSource } from '@/lib/url-identity';

/** Cap on how many missing citations we will chase in one run. */
const MAX_RECOVERY_ATTEMPTS = 5;

export interface RecoveryAttempt {
  url: string;
  ok: boolean;
  /** User-facing outcome. Provider detail stays in `error`. */
  outcome: string;
  error: string | null;
  content_chars: number | null;
  duration_ms: number;
}

export interface RecoveryResult {
  recovered: NormalizedSource[];
  attempts: RecoveryAttempt[];
}

/** Citations referenced by candidate hooks that we never actually retrieved. */
export function findMissingCitations(
  citedUrls: (string | null | undefined)[],
  sources: NormalizedSource[],
): string[] {
  const missing = new Map<string, string>();

  for (const raw of citedUrls) {
    const url = (raw ?? '').trim();
    if (!url) continue;

    // Only real http(s) URLs are worth a fetch.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    } catch {
      continue;
    }

    const known = sources.some(
      (s) => isSameSource(s.url, url) || isSameSource(s.canonical_url, url),
    );
    if (known) continue;

    // Deduplicate: one fetch per distinct document.
    const key = canonicalUrl(url);
    if (!missing.has(key)) missing.set(key, url);
  }

  return [...missing.values()];
}

/**
 * Fetch the missing citations and turn the successful ones into sources.
 *
 * Only URLs actually cited by candidate hooks are attempted — never every URL
 * that appears in model output.
 */
export async function recoverCitedSources(
  citedUrls: (string | null | undefined)[],
  sources: NormalizedSource[],
  companyDomains: string[] = [],
): Promise<RecoveryResult> {
  const missing = findMissingCitations(citedUrls, sources).slice(0, MAX_RECOVERY_ATTEMPTS);
  if (missing.length === 0) return { recovered: [], attempts: [] };

  const results = await Promise.all(missing.map((url) => scrapeUrl(url)));

  const recovered: NormalizedSource[] = [];
  const attempts: RecoveryAttempt[] = [];

  results.forEach((result, i) => {
    const url = missing[i];

    if (!result.ok) {
      attempts.push({
        url,
        ok: false,
        outcome: result.blocked
          ? 'Source could not be retrieved; the site does not permit automated access.'
          : 'Source could not be retrieved.',
        error: result.error,
        content_chars: null,
        duration_ms: result.duration_ms,
      });
      return;
    }

    const type = classifySource(url, companyDomains);
    recovered.push({
      url,
      canonical_url: canonicalUrl(url),
      title: `Recovered citation — ${new URL(url).hostname.replace(/^www\./, '')}`,
      snippet: result.markdown.slice(0, 400),
      source_type: type,
      credibility: CREDIBILITY[type],
      published_date: null,
      // Marked so a reviewer can see this source entered late, by citation.
      providers: ['citation_recovery'],
      queries: [],
      categories: ['followup'],
      duplicate_count: 0,
      retrieved_at: new Date().toISOString(),
      content: result.markdown.slice(0, 20_000),
      fetch_status: 'scraped',
    });

    attempts.push({
      url,
      ok: true,
      outcome: 'Source retrieved and added to the evidence set for verification.',
      error: null,
      content_chars: result.markdown.length,
      duration_ms: result.duration_ms,
    });
  });

  return { recovered, attempts };
}
