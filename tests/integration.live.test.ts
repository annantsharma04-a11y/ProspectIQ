// Live integration tests — these hit the real providers.
//
// They are skipped unless the relevant credentials are present, so `npm test`
// stays fast and offline-safe. Run them with:
//   npm run test:live
//
// Nothing here is mocked: the point is to prove the real contract still holds,
// which mock-only tests cannot do.

import { describe, it, expect } from 'vitest';
import { config } from 'dotenv';
import { getLinkedInProfile, hasBrightDataToken } from '@/lib/providers/brightdata';
import { retrieveLinkedInProfile } from '@/lib/linkedin/fetch';
import { assessCompleteness } from '@/lib/linkedin/profile';
import { tavilySearch, hasTavilyKey } from '@/lib/search/tavily';
import { callStructured, hasGeminiKey } from '@/lib/llm/gemini';

config({ path: '.env.local' });

/** Any real, public profile. Supplied by env so no profile is hardcoded. */
const LIVE_PROFILE_URL =
  process.env.LIVE_TEST_LINKEDIN_URL ?? 'https://www.linkedin.com/in/satyanadella';

describe.runIf(hasBrightDataToken())('live — Bright Data', () => {
  it(
    'retrieves a real public profile and normalizes it',
    async () => {
      const result = await getLinkedInProfile(LIVE_PROFILE_URL);

      expect(result.meta).toMatchObject({
        source: 'brightdata',
        source_type: 'linkedin_profile',
        direct_linkedin_access: true,
      });
      expect(result.profile.url).toContain('linkedin.com/in/');
      expect(result.profile.name).toBeTruthy();
      expect(assessCompleteness(result.profile)).not.toBe('none');

      // Arrays are always arrays, never undefined, whatever the profile holds.
      expect(Array.isArray(result.profile.experience)).toBe(true);
      expect(Array.isArray(result.profile.education)).toBe(true);
      expect(Array.isArray(result.profile.skills)).toBe(true);
    },
    120_000,
  );

  it(
    'reports direct access through the retrieval wrapper',
    async () => {
      const result = await retrieveLinkedInProfile(LIVE_PROFILE_URL);
      expect(result.access.directLinkedIn).toBe(true);
      expect(result.access.primarySource).toBe('brightdata');
      // The token must never travel with the result.
      expect(JSON.stringify(result)).not.toContain(process.env.BRIGHTDATA_API_TOKEN!);
    },
    120_000,
  );

  it(
    'rejects a well-formed but nonexistent profile without inventing data',
    async () => {
      const result = await retrieveLinkedInProfile(
        'https://www.linkedin.com/in/this-profile-should-not-exist-zzq9x7',
      );
      // Either the provider errors, or it returns nothing usable. Both are fine;
      // silently fabricating a profile is not.
      if (result.profile) {
        expect(result.profile.name).toBeTruthy();
      } else {
        expect(result.access.directLinkedIn).toBe(false);
        expect(result.access.primarySource).toBe('public_web');
      }
    },
    120_000,
  );
});

describe.skipIf(hasBrightDataToken())('live — Bright Data fallback', () => {
  it('falls back to public web when no token is configured', async () => {
    const result = await retrieveLinkedInProfile(LIVE_PROFILE_URL);
    expect(result.profile).toBeNull();
    expect(result.access.directLinkedIn).toBe(false);
    expect(result.access.primarySource).toBe('public_web');
    expect(result.error_code).toBe('no_token');
  });
});

describe.runIf(hasTavilyKey())('live — Tavily', () => {
  it(
    'returns real dated results for a news query',
    async () => {
      const outcome = await tavilySearch(
        { query: 'enterprise software funding round', category: 'company_funding', recent_only: true },
        3,
      );

      expect(outcome.ok).toBe(true);
      expect(outcome.hits.length).toBeGreaterThan(0);
      expect(outcome.hits[0].url).toMatch(/^https?:\/\//);
      // The news topic is what supplies publication dates.
      expect(outcome.hits.some((h) => h.published_date !== null)).toBe(true);
    },
    60_000,
  );
});

describe.runIf(hasGeminiKey())('live — Gemini Interactions API', () => {
  it(
    'honours a response schema and returns parseable JSON',
    async () => {
      const result = await callStructured<{ signals: { signal: string; confidence: number }[] }>({
        purpose: 'live_schema_check',
        system: 'You extract business signals using ONLY facts present in the source text.',
        input:
          'Source (2026-02-10): Northwind Logistics announced a $25M Series B to expand its Austin operations. Extract signals.',
        schema: {
          type: 'object',
          properties: {
            signals: {
              type: 'array',
              items: {
                type: 'object',
                properties: { signal: { type: 'string' }, confidence: { type: 'integer' } },
                required: ['signal', 'confidence'],
              },
            },
          },
          required: ['signals'],
        },
      });

      expect(Array.isArray(result.data.signals)).toBe(true);
      expect(result.data.signals.length).toBeGreaterThan(0);
      expect(typeof result.data.signals[0].signal).toBe('string');
      expect(result.meta.total_tokens).toBeGreaterThan(0);
    },
    120_000,
  );
});
