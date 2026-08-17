// The single authoritative way to decide whether two URLs mean the same thing.
//
// Every URL comparison in the app goes through `sourceKey()`. Comparing raw URL
// strings is a bug: the same LinkedIn profile is served from www.linkedin.com,
// sg.linkedin.com, in.linkedin.com and bare linkedin.com, and a model citing one
// form while we stored another must not be treated as citing an unknown source.
//
// Two levels of identity:
//   linkedInProfileKey() — "in/<slug>" for any LinkedIn profile URL, else null.
//   sourceKey()          — a stable key for ANY url, LinkedIn-aware.

/** Tracking parameters that create false "distinct" URLs. */
const TRACKING_PARAMS =
  /^(utm_|fbclid|gclid|mc_|ref|ref_src|source|igshid|si|spm|trk|trackingId|originalSubdomain|rcm|lipi|licu)/i;

/** linkedin.com, with or without a country/locale subdomain (sg., in., uk., www.). */
const LINKEDIN_HOST = /(^|\.)linkedin\.com$/;

function toUrl(raw: string): URL | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

export function isLinkedInHost(hostname: string): boolean {
  return LINKEDIN_HOST.test(hostname.toLowerCase());
}

/**
 * Stable identity for a LinkedIn *profile* URL, independent of country
 * subdomain, scheme, casing, trailing slash, query string or fragment.
 *
 *   https://www.linkedin.com/in/stuti09      -> "in/stuti09"
 *   https://sg.linkedin.com/in/stuti09/      -> "in/stuti09"
 *   http://in.linkedin.com/in/Stuti09?x=1#y  -> "in/stuti09"
 *
 * Returns null for non-LinkedIn URLs and for LinkedIn URLs that are not
 * profiles (company pages, jobs, posts), which must stay distinct from each other.
 */
export function linkedInProfileKey(raw: string): string | null {
  const url = toUrl(raw);
  if (!url || !isLinkedInHost(url.hostname)) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const inIndex = segments.findIndex((s) => s.toLowerCase() === 'in');
  if (inIndex === -1) return null;

  const rawSlug = segments[inIndex + 1];
  if (!rawSlug) return null;

  let slug: string;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    slug = rawSlug;
  }
  slug = slug.toLowerCase().trim();
  if (!slug) return null;

  return `in/${slug}`;
}

/** True when both URLs point at the same LinkedIn profile. */
export function isSameLinkedInProfile(a: string, b: string): boolean {
  const keyA = linkedInProfileKey(a);
  return keyA !== null && keyA === linkedInProfileKey(b);
}

/**
 * Canonical display/dedup form for any URL: https, no www, no fragment, no
 * tracking params, no trailing slash. LinkedIn profiles additionally collapse
 * their country subdomain so every locale maps to one canonical address.
 */
export function canonicalUrl(raw: string): string {
  const url = toUrl(raw);
  if (!url) return (raw ?? '').trim().toLowerCase();

  url.hash = '';
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }

  // Every locale of a LinkedIn profile is one canonical profile URL.
  const profileKey = linkedInProfileKey(raw);
  if (profileKey) return `https://www.linkedin.com/${profileKey}`;

  // Other LinkedIn pages: drop the locale subdomain but keep the path.
  if (isLinkedInHost(url.hostname)) url.hostname = 'linkedin.com';

  let path = url.pathname.replace(/\/+$/, '');
  if (path === '') path = '/';
  url.pathname = path;

  return url.toString();
}

/**
 * THE comparison key. Use this anywhere two URLs are checked for sameness —
 * source dedup, evidence verification, model citations, claim provenance.
 */
export function sourceKey(raw: string): string {
  const profileKey = linkedInProfileKey(raw);
  if (profileKey) return `linkedin:${profileKey}`;
  return canonicalUrl(raw).toLowerCase();
}

/** True when two URLs refer to the same underlying source. */
export function isSameSource(a: string, b: string): boolean {
  if (!a || !b) return false;
  return sourceKey(a) === sourceKey(b);
}

/** Bare hostname, without www. Used for display and domain classification. */
export function hostOf(raw: string): string {
  const url = toUrl(raw);
  return url ? url.hostname.toLowerCase().replace(/^www\./, '') : '';
}
