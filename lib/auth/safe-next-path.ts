// Where a post-login redirect is allowed to send the browser.
//
// `?next=` is attacker-controllable: anyone can hand a user a link to our own
// login page carrying any `next` they like. A check of "starts with /" is NOT
// enough - a protocol-relative URL such as `//evil.com` also starts with `/`,
// and both `redirect()` (which emits it as a Location header) and
// `router.push()` resolve it against the current scheme, navigating the
// freshly-authenticated user off-site. `/\evil.com` is the same trick with a
// backslash, which browsers normalize to `/`.
//
// Only a path that stays inside this application is allowed through; anything
// else silently becomes the fallback. Shared by the login page (server) and
// LoginForm (client) so both sides can never disagree about what is safe.

/** The one destination used whenever `next` is missing or not internal. */
export const DEFAULT_NEXT_PATH = '/';

/**
 * A same-application path safe to redirect to, or the fallback.
 *
 * Accepts ordinary internal paths (`/`, `/history`, `/runs/123?tab=stages`).
 * Rejects absolute URLs, protocol-relative URLs, backslash variants, and
 * anything carrying characters a browser would strip before resolving the
 * URL - a value like a tab-embedded "/evil.com" is refused outright rather
 * than cleaned up and used, since the cleaned form is exactly what would
 * escape.
 */
export function safeNextPath(raw: string | null | undefined, fallback: string = DEFAULT_NEXT_PATH): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;

  // Per the WHATWG URL spec, browsers strip ASCII tab and newline (and CR)
  // from a URL before resolving it, so a tab-embedded "/\t/evil.com" is not
  // protocol-relative as written, but becomes "//evil.com" the moment a
  // browser resolves it. Refuse outright rather than validate a string the
  // browser will not actually use.
  const hasStrippedChars = raw.indexOf('\t') !== -1 || raw.indexOf('\r') !== -1 || raw.indexOf('\n') !== -1;
  if (hasStrippedChars) return fallback;

  // Must be root-relative...
  if (!raw.startsWith('/')) return fallback;
  // ...and must not be protocol-relative ("//host") or its backslash
  // equivalent ("/\host") - both resolve as an absolute URL to another host.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;

  return raw;
}
