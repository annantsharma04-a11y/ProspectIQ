// Bright Data — the LinkedIn profile provider.
//
// Server-side only. The API token is read from BRIGHTDATA_API_TOKEN at call
// time and never leaves this module: it is not returned, not logged, and not
// included in any error surfaced to the client.
//
// Endpoint (official Web Scraper API, synchronous single-lookup form):
//   POST https://api.brightdata.com/datasets/v3/scrape
//        ?dataset_id=<LinkedIn people profiles dataset>&format=json
//   body: [{ "url": "https://www.linkedin.com/in/<slug>" }]
//
// We use the synchronous endpoint deliberately — one prospect per request needs
// no trigger/poll job workflow.

import { parseLinkedInUrl } from '@/lib/linkedin/url';
import {
  assessCompleteness,
  type LinkedInEducation,
  type LinkedInExperience,
  type LinkedInProfile,
  type ProfileSourceMeta,
} from '@/lib/linkedin/profile';

const ENDPOINT = 'https://api.brightdata.com/datasets/v3/scrape';
/** LinkedIn "people profiles" dataset. Overridable for other dataset versions. */
export const LINKEDIN_DATASET_ID =
  process.env.BRIGHTDATA_LINKEDIN_DATASET_ID || 'gd_l1viktl72bvl7bjuj0';

const TIMEOUT_MS = Number(process.env.BRIGHTDATA_TIMEOUT_MS ?? 90_000);

export type BrightDataErrorCode =
  | 'no_token'
  | 'invalid_url'
  | 'bad_request'
  | 'unauthorized'
  | 'account_inactive'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'empty_response'
  | 'empty_profile'
  | 'malformed_response'
  | 'upstream_error';

/**
 * A failure that is safe to show a user. `message` never contains the token,
 * the Authorization header, or raw provider internals.
 */
export class BrightDataError extends Error {
  constructor(
    message: string,
    readonly code: BrightDataErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BrightDataError';
  }
}

export function hasBrightDataToken(): boolean {
  return Boolean(process.env.BRIGHTDATA_API_TOKEN);
}

export interface ProfileFetchResult {
  profile: LinkedInProfile;
  meta: ProfileSourceMeta;
  completeness: ReturnType<typeof assessCompleteness>;
  duration_ms: number;
}

/**
 * Retrieve a public LinkedIn profile through Bright Data.
 *
 * Throws BrightDataError on every failure path so callers can decide between
 * degrading to public-web research and failing the run. It never returns
 * fabricated or partially-invented profile data.
 */
export async function getLinkedInProfile(profileUrl: string): Promise<ProfileFetchResult> {
  // Validate before spending an API call.
  const parsed = parseLinkedInUrl(profileUrl);
  if (!parsed.ok) {
    throw new BrightDataError(parsed.error, 'invalid_url');
  }

  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) {
    throw new BrightDataError(
      'LinkedIn profile retrieval is not configured (BRIGHTDATA_API_TOKEN is missing).',
      'no_token',
    );
  }

  const url = `${ENDPOINT}?dataset_id=${encodeURIComponent(LINKEDIN_DATASET_ID)}&format=json`;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Log the request without the token or headers.
  console.info(`[brightdata] fetching profile /in/${parsed.slug} (dataset ${LINKEDIN_DATASET_ID})`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ url: parsed.normalized_url }]),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new BrightDataError(
        `LinkedIn profile retrieval timed out after ${TIMEOUT_MS / 1000}s.`,
        'timeout',
      );
    }
    // Deliberately does not interpolate the underlying error, which can echo
    // request details back out.
    throw new BrightDataError('Could not reach the LinkedIn profile provider.', 'upstream_error');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Account-level problems arrive as a 400 with a plain-text body ("Customer
    // is not active"), which is very different from a bad request for this URL.
    // Read it so the operator gets an actionable message instead of a generic one.
    const body = await res.text().catch(() => '');
    throw errorForStatus(res.status, body);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new BrightDataError(
      'The LinkedIn profile provider returned a response that could not be parsed.',
      'malformed_response',
    );
  }

  const record = firstRecord(payload);
  if (!record) {
    throw new BrightDataError(
      'The LinkedIn profile provider returned no profile data for this URL.',
      'empty_response',
    );
  }

  // A per-record error (private/removed profile) comes back inside a 200.
  const recordError = pickString(record, ['error', 'warning', 'error_code']);
  if (recordError && !pickString(record, ['name', 'full_name'])) {
    throw new BrightDataError(
      `The LinkedIn profile could not be retrieved (${recordError}).`,
      'not_found',
    );
  }

  const profile = normalizeProfile(record, parsed.normalized_url);
  const completeness = assessCompleteness(profile);

  if (completeness === 'none') {
    throw new BrightDataError(
      'The LinkedIn profile provider returned a record with no usable profile fields.',
      'empty_profile',
    );
  }

  console.info(
    `[brightdata] profile /in/${parsed.slug} retrieved: completeness=${completeness}, ` +
      `experience=${profile.experience.length}, education=${profile.education.length}`,
  );

  return {
    profile,
    meta: {
      source: 'brightdata',
      source_type: 'linkedin_profile',
      direct_linkedin_access: true,
      retrieved_at: new Date().toISOString(),
    },
    completeness,
    duration_ms: Date.now() - startedAt,
  };
}

function errorForStatus(status: number, body = ''): BrightDataError {
  // The body here is a provider status message, never our credentials.
  if (/customer is not active|account (is )?(not active|suspended|inactive)/i.test(body)) {
    return new BrightDataError(
      'The Bright Data account is not active for scraping — activate billing on the account to enable LinkedIn profile retrieval.',
      'account_inactive',
      status,
    );
  }
  if (/insufficient|balance|quota|credit/i.test(body)) {
    return new BrightDataError(
      'The Bright Data account has no remaining scraping balance or quota.',
      'account_inactive',
      status,
    );
  }

  switch (status) {
    case 400:
      return new BrightDataError(
        'The LinkedIn profile provider rejected the request for this URL.',
        'bad_request',
        400,
      );
    case 401:
    case 403:
      return new BrightDataError(
        'LinkedIn profile retrieval was not authorized. Check the Bright Data account and token.',
        'unauthorized',
        status,
      );
    case 404:
      return new BrightDataError(
        'The LinkedIn profile provider could not find this profile.',
        'not_found',
        404,
      );
    case 429:
      return new BrightDataError(
        'LinkedIn profile retrieval hit the provider rate limit. Try again shortly.',
        'rate_limited',
        429,
      );
    default:
      return new BrightDataError(
        `The LinkedIn profile provider returned an error (HTTP ${status}).`,
        'upstream_error',
        status,
      );
  }
}

/** The sync endpoint returns an array; some responses wrap it in an object. */
function firstRecord(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) {
    const first = payload.find((r) => r && typeof r === 'object');
    return (first as Record<string, unknown>) ?? null;
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['data', 'results', 'result']) {
      if (Array.isArray(obj[key])) return firstRecord(obj[key]);
    }
    return Object.keys(obj).length > 0 ? obj : null;
  }
  return null;
}

// ─── normalization ───────────────────────────────────────────────────────────
//
// Bright Data's field names vary across dataset versions and by profile, so
// every field is read through a tolerant lookup over known aliases. Anything
// absent becomes null / [] rather than a guess.

/**
 * Map a raw Bright Data record onto the internal schema.
 * Exported for fixture-driven tests.
 */
export function normalizeProfile(
  raw: Record<string, unknown>,
  fallbackUrl: string,
): LinkedInProfile {
  const experience = normalizeExperience(raw);
  const currentFromExperience = experience.find((e) => !e.endDate) ?? experience[0] ?? null;

  const companyName =
    pickString(raw, ['current_company_name']) ??
    pickString(asRecord(raw.current_company), ['name', 'company_name', 'title']) ??
    currentFromExperience?.company ??
    null;

  const companyTitle =
    pickString(asRecord(raw.current_company), ['title', 'position', 'role']) ??
    pickString(raw, ['position', 'current_position', 'job_title']) ??
    currentFromExperience?.title ??
    null;

  const companyUrl =
    pickString(asRecord(raw.current_company), ['link', 'url', 'company_url']) ??
    pickString(raw, ['current_company_link', 'current_company_url']) ??
    null;

  const currentCompany =
    companyName || companyTitle || companyUrl
      ? { name: companyName, title: companyTitle, url: companyUrl }
      : null;

  return {
    url: pickString(raw, ['url', 'input_url', 'profile_url', 'linkedin_url']) ?? fallbackUrl,
    name: pickString(raw, ['name', 'full_name', 'fullName']),
    headline: pickString(raw, ['position', 'headline', 'title', 'sub_title']),
    about: pickString(raw, ['about', 'summary', 'bio', 'description']),
    location: normalizeLocation(raw),
    currentCompany,
    experience,
    education: normalizeEducation(raw),
    skills: normalizeSkills(raw),
    posts: normalizeArray(raw, ['posts', 'activity', 'recent_posts']),
    followers: pickNumber(raw, ['followers', 'followers_count', 'follower_count']),
    connections: pickNumber(raw, ['connections', 'connections_count', 'connection_count']),
  };
}

function normalizeLocation(raw: Record<string, unknown>): string | null {
  const direct = pickString(raw, ['location', 'city_full', 'geo_location']);
  if (direct) return direct;

  const city = pickString(raw, ['city']);
  const country = pickString(raw, ['country_code', 'country']);
  return [city, country].filter(Boolean).join(', ') || null;
}

function normalizeExperience(raw: Record<string, unknown>): LinkedInExperience[] {
  const items = normalizeArray(raw, ['experience', 'experiences', 'positions', 'work_experience']);

  return items
    .map((item) => {
      const e = asRecord(item);
      if (!e) return null;
      return {
        company: pickString(e, ['company', 'company_name', 'organization', 'subtitle']),
        title: pickString(e, ['title', 'position', 'role']),
        location: pickString(e, ['location', 'city']),
        startDate: pickString(e, ['start_date', 'starts_at', 'start', 'date_start']),
        endDate: pickString(e, ['end_date', 'ends_at', 'end', 'date_end']),
        description: pickString(e, ['description', 'summary', 'description_html']),
      } satisfies LinkedInExperience;
    })
    .filter((e): e is LinkedInExperience => e !== null && (Boolean(e.company) || Boolean(e.title)));
}

function normalizeEducation(raw: Record<string, unknown>): LinkedInEducation[] {
  const items = normalizeArray(raw, ['education', 'educations', 'educations_details', 'schools']);

  return items
    .map((item) => {
      const e = asRecord(item);
      if (!e) return null;
      return {
        institution: pickString(e, ['title', 'institution', 'school', 'school_name', 'name']),
        degree: pickString(e, ['degree', 'degree_name']),
        fieldOfStudy: pickString(e, ['field', 'field_of_study', 'fieldOfStudy', 'major']),
        startDate: pickString(e, ['start_year', 'start_date', 'starts_at']),
        endDate: pickString(e, ['end_year', 'end_date', 'ends_at']),
      } satisfies LinkedInEducation;
    })
    .filter((e): e is LinkedInEducation => e !== null && Boolean(e.institution));
}

function normalizeSkills(raw: Record<string, unknown>): string[] {
  const items = normalizeArray(raw, ['skills', 'skill', 'top_skills']);
  const out: string[] = [];

  for (const item of items) {
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
      continue;
    }
    const rec = asRecord(item);
    const name = rec ? pickString(rec, ['name', 'title', 'skill']) : null;
    if (name) out.push(name);
  }

  // Some versions return a comma-separated string instead of an array.
  if (out.length === 0) {
    const asString = pickString(raw, ['skills']);
    if (asString) return asString.split(',').map((s) => s.trim()).filter(Boolean);
  }

  return [...new Set(out)];
}

function normalizeArray(raw: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = raw[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(raw: Record<string, unknown> | null, keys: string[]): string | null {
  if (!raw) return null;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function pickNumber(raw: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/[,+]/g, ''));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}
