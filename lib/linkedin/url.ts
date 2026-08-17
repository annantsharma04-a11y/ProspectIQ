// LinkedIn profile URL parsing, validation and normalization.
//
// This module never fetches anything. It only decides whether a string is a
// public LinkedIn *profile* URL and reduces it to a canonical form plus the
// profile slug, so downstream research has a stable identifier to work from.

export interface LinkedInParseSuccess {
  ok: true;
  /** Canonical form: https://www.linkedin.com/in/<slug> */
  normalized_url: string;
  /** The /in/ slug, lowercased, e.g. "jane-doe-1a2b3c". */
  slug: string;
  /**
   * Best-effort human name derived from the slug. This is a GUESS used only to
   * seed search queries — never presented as verified profile data.
   */
  name_hint: string | null;
}

export interface LinkedInParseFailure {
  ok: false;
  error: string;
}

export type LinkedInParseResult = LinkedInParseSuccess | LinkedInParseFailure;

/** Hosts we accept, including country subdomains like in./uk./br. */
const LINKEDIN_HOST = /^(?:[a-z]{2,3}\.)?linkedin\.com$/;

/** Slugs LinkedIn uses for non-profile pages that share the /in/ shape. */
const RESERVED_SLUGS = new Set(['edit', 'me', 'unavailable']);

/**
 * Accepts the messy forms people actually paste:
 *   https://www.linkedin.com/in/name/
 *   https://linkedin.com/in/name
 *   http://www.linkedin.com/in/name/
 *   www.linkedin.com/in/name
 *   linkedin.com/in/name?originalSubdomain=in
 *   in.linkedin.com/in/name
 */
export function parseLinkedInUrl(raw: string | null | undefined): LinkedInParseResult {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { ok: false, error: 'LinkedIn profile URL is required.' };
  }

  // Add a scheme if the user pasted a bare host, so URL() can parse it.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: `"${trimmed}" is not a valid URL.` };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!LINKEDIN_HOST.test(host)) {
    return {
      ok: false,
      error: `"${trimmed}" is not a linkedin.com URL. Paste a public profile link like https://www.linkedin.com/in/jane-doe.`,
    };
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const inIndex = segments.findIndex((s) => s.toLowerCase() === 'in');

  if (inIndex === -1) {
    const kind = segments[0]?.toLowerCase();
    if (kind === 'company' || kind === 'school' || kind === 'showcase') {
      return {
        ok: false,
        error: 'That is a LinkedIn company page, not a personal profile. Use a /in/ profile URL.',
      };
    }
    if (kind === 'pub') {
      return {
        ok: false,
        error: 'That is a legacy /pub/ LinkedIn URL. Use the current /in/ profile URL.',
      };
    }
    return {
      ok: false,
      error: 'LinkedIn URL must point to a profile, e.g. https://www.linkedin.com/in/jane-doe.',
    };
  }

  const rawSlug = segments[inIndex + 1];
  if (!rawSlug) {
    return { ok: false, error: 'LinkedIn URL is missing the profile name after /in/.' };
  }

  let slug: string;
  try {
    slug = decodeURIComponent(rawSlug).toLowerCase();
  } catch {
    slug = rawSlug.toLowerCase();
  }

  if (RESERVED_SLUGS.has(slug)) {
    return {
      ok: false,
      error: `"/in/${slug}" is not a public profile URL. Paste the profile's own link.`,
    };
  }

  // LinkedIn slugs are letters/digits/hyphens, plus unicode for non-Latin names.
  if (slug.length < 3 || /[\s/?#]/.test(slug)) {
    return { ok: false, error: `"${slug}" is not a valid LinkedIn profile name.` };
  }

  return {
    ok: true,
    normalized_url: `https://www.linkedin.com/in/${slug}`,
    slug,
    name_hint: nameHintFromSlug(slug),
  };
}

/**
 * "jane-doe-1a2b3c4" -> "Jane Doe". Trailing hash segments LinkedIn appends for
 * uniqueness are dropped. Returns null when the slug carries no usable name.
 */
export function nameHintFromSlug(slug: string): string | null {
  const parts = slug
    .split('-')
    .filter(Boolean)
    // Drop LinkedIn's disambiguation suffixes: pure digits, or hex-ish blobs.
    .filter((p) => !/^\d+$/.test(p) && !/^[0-9a-f]{6,}$/i.test(p));

  const words = parts.filter((p) => /[a-zÀ-￿]/i.test(p));
  if (words.length === 0) return null;

  return words
    .slice(0, 4)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
