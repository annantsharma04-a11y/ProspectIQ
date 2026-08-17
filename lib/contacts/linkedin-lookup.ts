// Deterministic LinkedIn profile lookup for a discovered contact candidate.
//
// Root cause this exists to fix: contactDiscoveryQueries() searches by ROLE
// ("PRISM" "Global COO"), never by the person's NAME — so once the model
// extracts "Ankit Tandon" from a leadership-announcement post, there is no
// follow-up search giving him a chance to have his own profile page found,
// even when one genuinely exists and is publicly indexed. The model correctly
// refused to invent a URL it was never shown; the gap was that it was never
// shown one to find. This runs ONE targeted, name-specific search per
// still-unresolved candidate — the same pattern verifyIdentityStage and the
// /select route already use (identityQueries scoped to a specific person) —
// and extracts a URL from the results with NO model call: a plain, auditable
// match against retrieved page titles.

import { parseLinkedInUrl } from '@/lib/linkedin/url';
import { titleTokens } from '@/lib/research/normalize';
import type { NormalizedSource } from '@/lib/research/normalize';

/**
 * Find THIS candidate's own LinkedIn profile URL among retrieved sources.
 *
 * Never infers, never invents — a match requires both:
 *   1. The source itself is a genuine LinkedIn PROFILE URL. Reuses the exact
 *      same parseLinkedInUrl() the rest of the app validates every submitted
 *      URL with, so a company page, a post, or a job listing is rejected
 *      identically here.
 *   2. Every token of the candidate's name appears in that page's own title
 *      (what the search provider returned for it — typically LinkedIn's own
 *      "Name - Role - Company | LinkedIn" page title). This is what stops a
 *      same-named but different person's profile from being accepted, and
 *      what makes the match auditable: the reason a URL was chosen is "the
 *      retrieved page is titled with this exact name," nothing inferred.
 *
 * No match returns null — a candidate stays unselectable rather than getting
 * a guessed URL, exactly as before this fix.
 */
export function findLinkedInUrlForCandidate(name: string, sources: NormalizedSource[]): string | null {
  const nameTokens = [...titleTokens(name)];
  if (nameTokens.length === 0) return null;

  for (const s of sources) {
    const parsed = parseLinkedInUrl(s.canonical_url || s.url);
    if (!parsed.ok) continue; // not a personal profile URL at all

    const pageTokens = titleTokens(s.title);
    if (nameTokens.every((t) => pageTokens.has(t))) {
      return parsed.normalized_url;
    }
  }
  return null;
}
