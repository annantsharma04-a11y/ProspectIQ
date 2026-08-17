import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getLinkedInProfile,
  normalizeProfile,
  BrightDataError,
  hasBrightDataToken,
} from '@/lib/providers/brightdata';
import { retrieveLinkedInProfile } from '@/lib/linkedin/fetch';
import { assessCompleteness, renderProfile } from '@/lib/linkedin/profile';
import { scrapeUrl } from '@/lib/research/scrape';
import fixture from './fixtures/brightdata-profile.json';

const TOKEN = 'test-token-do-not-log-1234567890';
const PROFILE_URL = 'https://www.linkedin.com/in/dana-example';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  process.env.BRIGHTDATA_API_TOKEN = TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.BRIGHTDATA_API_TOKEN;
});

// ─── normalization (fixture-driven) ──────────────────────────────────────────

describe('normalizeProfile — sanitized Bright Data fixture', () => {
  const profile = normalizeProfile(fixture as Record<string, unknown>, PROFILE_URL);

  it('maps the core identity fields', () => {
    expect(profile.name).toBe('Dana Example');
    expect(profile.headline).toBe('VP Finance Operations at Northwind Logistics');
    expect(profile.about).toContain('Finance operations leader');
    expect(profile.url).toBe(PROFILE_URL);
  });

  it('builds a location from city and country when no location field exists', () => {
    expect(profile.location).toBe('Austin, US');
  });

  it('maps the current company, url and title', () => {
    expect(profile.currentCompany).toEqual({
      name: 'Northwind Logistics',
      title: 'VP Finance Operations',
      url: 'https://www.linkedin.com/company/northwind-logistics',
    });
  });

  it('maps experience in order with null for an ongoing role', () => {
    expect(profile.experience).toHaveLength(2);
    expect(profile.experience[0]).toMatchObject({
      company: 'Northwind Logistics',
      title: 'VP Finance Operations',
      startDate: '2024-03',
      endDate: null,
    });
    expect(profile.experience[1].company).toBe('Cascade Freight');
  });

  it('maps education across the provider field aliases', () => {
    expect(profile.education[0]).toMatchObject({
      institution: 'University of Texas at Austin',
      degree: 'BBA',
      fieldOfStudy: 'Accounting',
    });
  });

  it('flattens skill objects and removes duplicates', () => {
    expect(profile.skills).toEqual(['Accounts Payable', 'Process Automation']);
  });

  it('parses numeric fields', () => {
    expect(profile.followers).toBe(4213);
    expect(profile.connections).toBe(500);
  });

  it('grades a rich profile as full', () => {
    expect(assessCompleteness(profile)).toBe('full');
  });
});

describe('normalizeProfile — incomplete and hostile records', () => {
  it('normalizes every missing field to null or [] and never invents data', () => {
    const profile = normalizeProfile({}, PROFILE_URL);
    expect(profile).toEqual({
      url: PROFILE_URL,
      name: null,
      headline: null,
      about: null,
      location: null,
      currentCompany: null,
      experience: [],
      education: [],
      skills: [],
      posts: [],
      followers: null,
      connections: null,
    });
    expect(assessCompleteness(profile)).toBe('none');
  });

  it('grades a name-only record as partial', () => {
    const profile = normalizeProfile({ name: 'Dana Example' }, PROFILE_URL);
    expect(assessCompleteness(profile)).toBe('partial');
  });

  it('derives the current company from experience when the field is absent', () => {
    const profile = normalizeProfile(
      { name: 'Dana', experience: [{ company: 'Northwind', title: 'VP', end_date: null }] },
      PROFILE_URL,
    );
    expect(profile.currentCompany?.name).toBe('Northwind');
    expect(profile.currentCompany?.title).toBe('VP');
  });

  it('survives wrong types without throwing', () => {
    const profile = normalizeProfile(
      { name: 42, experience: 'not-an-array', skills: 'AP, Reconciliation', education: null },
      PROFILE_URL,
    );
    expect(profile.name).toBe('42');
    expect(profile.experience).toEqual([]);
    expect(profile.skills).toEqual(['AP', 'Reconciliation']);
  });

  it('drops experience entries with neither company nor title', () => {
    const profile = normalizeProfile(
      { name: 'Dana', experience: [{ location: 'Austin' }, { company: 'Real Co' }] },
      PROFILE_URL,
    );
    expect(profile.experience).toHaveLength(1);
  });
});

// ─── request shape ───────────────────────────────────────────────────────────

describe('getLinkedInProfile — request', () => {
  it('calls the documented sync scrape endpoint with the URL in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([fixture]));
    vi.stubGlobal('fetch', fetchMock);

    await getLinkedInProfile('linkedin.com/in/dana-example');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://api.brightdata.com/datasets/v3/scrape');
    expect(url).toContain('dataset_id=gd_l1viktl72bvl7bjuj0');
    expect(init.method).toBe('POST');
    // The messy input form is normalized before it reaches the provider.
    expect(JSON.parse(init.body)).toEqual([{ url: PROFILE_URL }]);
  });

  it('rejects a non-LinkedIn URL without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getLinkedInProfile('https://example.com/in/dana')).rejects.toMatchObject({
      code: 'invalid_url',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails cleanly when the token is missing, without calling out', async () => {
    delete process.env.BRIGHTDATA_API_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getLinkedInProfile(PROFILE_URL)).rejects.toMatchObject({ code: 'no_token' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hasBrightDataToken()).toBe(false);
  });
});

// ─── error paths ─────────────────────────────────────────────────────────────

describe('getLinkedInProfile — provider errors', () => {
  it.each([
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'upstream_error'],
    [502, 'upstream_error'],
  ])('maps HTTP %i to %s', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'x' }, status)));
    await expect(getLinkedInProfile(PROFILE_URL)).rejects.toMatchObject({ code });
  });

  it('distinguishes an inactive account from a bad request', async () => {
    // Bright Data returns this as a 400 with a plain-text body.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Customer is not active',
        json: async () => ({}),
      } as unknown as Response),
    );

    const err = await getLinkedInProfile(PROFILE_URL).catch((e: BrightDataError) => e);
    expect((err as BrightDataError).code).toBe('account_inactive');
    expect((err as Error).message).toMatch(/activate billing/i);
  });

  it('reports an exhausted balance as an account problem', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'insufficient balance',
        json: async () => ({}),
      } as unknown as Response),
    );

    const err = await getLinkedInProfile(PROFILE_URL).catch((e: BrightDataError) => e);
    expect((err as BrightDataError).code).toBe('account_inactive');
  });

  it('reports a timeout rather than hanging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
    await expect(getLinkedInProfile(PROFILE_URL)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('treats an empty array as an empty response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([])));
    await expect(getLinkedInProfile(PROFILE_URL)).rejects.toMatchObject({ code: 'empty_response' });
  });

  it('classifies a timestamp/input-only record as empty_profile', async () => {
    // This is exactly what Bright Data returns for a slug it cannot collect.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse([{ timestamp: '2026-08-15T18:58:04.906Z', input: { url: PROFILE_URL } }]),
      ),
    );
    await expect(getLinkedInProfile(PROFILE_URL)).rejects.toMatchObject({ code: 'empty_profile' });
  });

  it('surfaces a per-record provider error inside a 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse([{ error: 'dead_page', input_url: PROFILE_URL }])),
    );
    await expect(getLinkedInProfile(PROFILE_URL)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports unparseable JSON as malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      } as unknown as Response),
    );
    await expect(getLinkedInProfile(PROFILE_URL)).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  it('unwraps a { data: [...] } envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [fixture] })));
    const result = await getLinkedInProfile(PROFILE_URL);
    expect(result.profile.name).toBe('Dana Example');
    expect(result.meta).toMatchObject({
      source: 'brightdata',
      source_type: 'linkedin_profile',
      direct_linkedin_access: true,
    });
  });
});

// ─── secret hygiene ──────────────────────────────────────────────────────────

describe('secret hygiene', () => {
  it('never puts the token in the request URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([fixture]));
    vi.stubGlobal('fetch', fetchMock);
    await getLinkedInProfile(PROFILE_URL);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(TOKEN);
  });

  it('never includes the token in any error message', async () => {
    for (const status of [400, 401, 404, 429, 500]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: TOKEN }, status)));
      const err = await getLinkedInProfile(PROFILE_URL).catch((e: BrightDataError) => e);
      expect(err).toBeInstanceOf(BrightDataError);
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });

  it('never logs the token', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...args) => void logged.push(args.join(' ')));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([fixture])));

    await getLinkedInProfile(PROFILE_URL);

    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('keeps the token out of the fallback result surfaced to the UI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: TOKEN }, 401)));
    const result = await retrieveLinkedInProfile(PROFILE_URL);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

// ─── fallback behaviour ──────────────────────────────────────────────────────

describe('retrieveLinkedInProfile — fallback to public web', () => {
  it('reports direct access on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([fixture])));
    const result = await retrieveLinkedInProfile(PROFILE_URL);

    expect(result.profile?.name).toBe('Dana Example');
    expect(result.access).toMatchObject({
      directLinkedIn: true,
      primarySource: 'brightdata',
      profileCompleteness: 'full',
    });
  });

  it('falls back without fabricating profile data when the provider fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500)));
    const result = await retrieveLinkedInProfile(PROFILE_URL);

    expect(result.profile).toBeNull();
    expect(result.access).toMatchObject({
      directLinkedIn: false,
      primarySource: 'public_web',
      profileCompleteness: 'none',
    });
    expect(result.access.reason).toMatch(/public web research/i);
    expect(result.error_code).toBe('upstream_error');
  });

  it('falls back when the token is missing, and never throws', async () => {
    delete process.env.BRIGHTDATA_API_TOKEN;
    const result = await retrieveLinkedInProfile(PROFILE_URL);
    expect(result.profile).toBeNull();
    expect(result.error_code).toBe('no_token');
    expect(result.access.directLinkedIn).toBe(false);
  });

  it('marks a thin profile as partial rather than claiming full data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ name: 'Dana Example' }])));
    const result = await retrieveLinkedInProfile(PROFILE_URL);
    expect(result.access.profileCompleteness).toBe('partial');
    expect(result.access.reason).toMatch(/some sections were empty/i);
  });
});

// ─── routing ─────────────────────────────────────────────────────────────────

describe('routing — LinkedIn never goes to Firecrawl', () => {
  it('short-circuits a LinkedIn URL without calling Firecrawl', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await scrapeUrl('https://www.linkedin.com/in/dana-example');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.error).toMatch(/not fetched via Firecrawl/i);
    delete process.env.FIRECRAWL_API_KEY;
  });
});

// ─── prompt rendering ────────────────────────────────────────────────────────

describe('renderProfile', () => {
  it('includes retrieved facts and omits absent sections', () => {
    const rendered = renderProfile(normalizeProfile(fixture as Record<string, unknown>, PROFILE_URL));
    expect(rendered).toContain('Dana Example');
    expect(rendered).toContain('Northwind Logistics');
    expect(rendered).toContain('experience:');

    const sparse = renderProfile(normalizeProfile({ name: 'Dana' }, PROFILE_URL));
    expect(sparse).not.toContain('experience:');
    expect(sparse).not.toContain('education:');
  });
});
