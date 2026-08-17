// Deterministic evidence verification for qualification claims — the
// prospect-fit / company-fit equivalent of lib/signals/verify.ts's hook
// verification.
//
// Root cause this exists to fix: `applyProspectEvidenceDiscipline()` and
// `applyEvidenceDiscipline()` in types.ts only ever checked "did the model
// cite at least one URL that was genuinely retrieved" before trusting an
// OBSERVED label. That check catches a fabricated URL, but not a REAL URL
// attached to a claim its content does not actually support — a CEO's
// generic bio page or a paywalled article whose scraped content is just a
// subscription notice both pass "URL was retrieved" while proving nothing.
// This module closes that gap the same way hooks and contact candidates
// already close it: require a verbatim quote per citation and mechanically
// confirm it appears in that source's actual retrieved content before the
// evidence is allowed to count.

import { isSameSource } from '@/lib/url-identity';
import { quoteAppearsIn } from '@/lib/signals/verify';
import type { NormalizedSource } from '@/lib/research/normalize';
import type { EvidenceItem } from './types';

/** Raw evidence as the model reports it, before verification. */
export interface RawEvidenceItem {
  url?: string | null;
  quote?: string | null;
}

/**
 * Keep only evidence items whose cited URL was genuinely retrieved AND whose
 * quote genuinely appears in that source's content. Everything else is
 * dropped — a dropped item is not "weaker evidence", it is not evidence,
 * exactly like a hook whose quote fails verification.
 */
export function verifyEvidence(items: RawEvidenceItem[] | null | undefined, sources: NormalizedSource[]): EvidenceItem[] {
  const verified: EvidenceItem[] = [];

  for (const item of items ?? []) {
    const url = item?.url?.trim();
    const quote = item?.quote?.trim();
    if (!url || !quote) continue;

    const source = sources.find((s) => isSameSource(s.url, url) || isSameSource(s.canonical_url, url));
    if (!source) continue; // URL was not genuinely retrieved this run

    const body = `${source.title}\n${source.snippet}\n${source.content ?? ''}`;
    if (!quoteAppearsIn(quote, body)) continue; // real source, but does not say this

    verified.push({ url, quote });
  }

  return verified;
}
