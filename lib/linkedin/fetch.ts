// LinkedIn profile retrieval.
//
// Routing is explicit: a LinkedIn profile URL goes to Bright Data, the
// dedicated LinkedIn provider. It is never sent to Firecrawl — Firecrawl
// refuses linkedin.com by policy (HTTP 403 "we do not support this site"), so
// trying it first would just burn a request to learn something already known.
//
// Policy, unchanged: no authentication, no cookies, no session replay, no
// CAPTCHA solving, no browser automation, no homemade scraper. We call a
// compliant provider API, and when it cannot deliver we say so and fall back to
// public-web research rather than fabricating profile data.

import {
  BrightDataError,
  getLinkedInProfile,
  hasBrightDataToken,
} from '@/lib/providers/brightdata';
import {
  type LinkedInProfile,
  type ProfileAccess,
  type ProfileSourceMeta,
} from './profile';

export interface LinkedInRetrievalResult {
  profile: LinkedInProfile | null;
  access: ProfileAccess;
  meta: ProfileSourceMeta | null;
  /** Machine-readable failure code, for stage output and tests. */
  error_code: string | null;
  duration_ms: number;
}

/**
 * Fetch the profile for a validated LinkedIn URL.
 *
 * Never throws: a provider failure becomes a recorded fallback so the pipeline
 * can continue on public-web research with the limitation made explicit.
 */
export async function retrieveLinkedInProfile(
  normalizedUrl: string,
): Promise<LinkedInRetrievalResult> {
  const startedAt = Date.now();

  if (!hasBrightDataToken()) {
    return fallback(
      'LinkedIn profile retrieval is not configured (BRIGHTDATA_API_TOKEN is missing), so the profile was not read. Research below comes from public web and news sources.',
      'no_token',
      startedAt,
    );
  }

  try {
    const result = await getLinkedInProfile(normalizedUrl);

    return {
      profile: result.profile,
      meta: result.meta,
      error_code: null,
      duration_ms: result.duration_ms,
      access: {
        directLinkedIn: true,
        primarySource: 'brightdata',
        profileCompleteness: result.completeness,
        reason:
          result.completeness === 'partial'
            ? 'The profile was retrieved but some sections were empty; public web research supplements it.'
            : null,
      },
    };
  } catch (err) {
    if (err instanceof BrightDataError) {
      return fallback(
        `Direct profile retrieval unavailable: ${err.message} Falling back to public web research.`,
        err.code,
        startedAt,
      );
    }
    // Unexpected shapes are reported generically — never echo provider internals.
    return fallback(
      'Direct profile retrieval failed unexpectedly. Falling back to public web research.',
      'upstream_error',
      startedAt,
    );
  }
}

function fallback(reason: string, code: string, startedAt: number): LinkedInRetrievalResult {
  return {
    profile: null,
    meta: null,
    error_code: code,
    duration_ms: Date.now() - startedAt,
    access: {
      directLinkedIn: false,
      primarySource: 'public_web',
      profileCompleteness: 'none',
      reason,
    },
  };
}
