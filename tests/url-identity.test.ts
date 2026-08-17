import { describe, it, expect } from 'vitest';
import {
  linkedInProfileKey,
  isSameLinkedInProfile,
  isSameSource,
  canonicalUrl,
  sourceKey,
} from '@/lib/url-identity';

// The bug this file exists to prevent: a model citing sg.linkedin.com/in/stuti09
// for a profile stored as www.linkedin.com/in/stuti09 was treated as citing an
// unretrieved source, and the legitimate signal was discarded.

describe('linkedInProfileKey — one identity per profile', () => {
  const EQUIVALENT = [
    'https://www.linkedin.com/in/stuti09',
    'https://linkedin.com/in/stuti09',
    'http://www.linkedin.com/in/stuti09',
    'https://sg.linkedin.com/in/stuti09',
    'https://in.linkedin.com/in/stuti09',
    'https://uk.linkedin.com/in/stuti09',
    'https://br.linkedin.com/in/stuti09',
    'www.linkedin.com/in/stuti09',
    'linkedin.com/in/stuti09',
    'https://www.linkedin.com/in/stuti09/',
    'https://www.linkedin.com/in/stuti09///',
    'https://www.linkedin.com/in/stuti09?originalSubdomain=sg',
    'https://www.linkedin.com/in/stuti09?trk=public_profile_topcard',
    'https://www.linkedin.com/in/stuti09#experience',
    'https://sg.linkedin.com/in/stuti09/?trk=x&utm_source=y#top',
    'https://www.linkedin.com/in/STUTI09',
  ];

  it.each(EQUIVALENT)('maps %s to the same profile key', (url) => {
    expect(linkedInProfileKey(url)).toBe('in/stuti09');
  });

  it('treats every equivalent form as the same profile', () => {
    for (const url of EQUIVALENT) {
      expect(isSameLinkedInProfile(url, 'https://www.linkedin.com/in/stuti09')).toBe(true);
    }
  });

  it('collapses every equivalent form to one canonical URL', () => {
    const canonicals = new Set(EQUIVALENT.map(canonicalUrl));
    expect(canonicals.size).toBe(1);
    expect([...canonicals][0]).toBe('https://www.linkedin.com/in/stuti09');
  });

  it('keeps different profiles distinct', () => {
    expect(linkedInProfileKey('https://sg.linkedin.com/in/someone-else')).toBe('in/someone-else');
    expect(isSameLinkedInProfile(
      'https://sg.linkedin.com/in/stuti09',
      'https://www.linkedin.com/in/stuti10',
    )).toBe(false);
  });

  it('returns null for non-profile LinkedIn pages and non-LinkedIn URLs', () => {
    expect(linkedInProfileKey('https://www.linkedin.com/company/mckinsey')).toBeNull();
    expect(linkedInProfileKey('https://www.linkedin.com/jobs/view/123')).toBeNull();
    expect(linkedInProfileKey('https://example.com/in/stuti09')).toBeNull();
    expect(linkedInProfileKey('not a url')).toBeNull();
    expect(linkedInProfileKey('')).toBeNull();
  });

  it('does not conflate a company page with a profile of the same name', () => {
    expect(isSameSource(
      'https://www.linkedin.com/company/mckinsey',
      'https://www.linkedin.com/in/mckinsey',
    )).toBe(false);
  });
});

describe('isSameSource — general URL identity', () => {
  it('ignores scheme, www, trailing slash, fragment and tracking params', () => {
    expect(isSameSource(
      'http://www.reuters.com/article/x/?utm_source=news#top',
      'https://reuters.com/article/x',
    )).toBe(true);
  });

  it('keeps genuinely different pages apart', () => {
    expect(isSameSource('https://reuters.com/a', 'https://reuters.com/b')).toBe(false);
    expect(isSameSource('https://reuters.com/a', 'https://bloomberg.com/a')).toBe(false);
  });

  it('preserves meaningful query parameters', () => {
    expect(isSameSource('https://example.com/p?id=1', 'https://example.com/p?id=2')).toBe(false);
  });

  it('is false when either side is empty', () => {
    expect(isSameSource('', 'https://example.com')).toBe(false);
  });

  it('gives LinkedIn profiles a namespaced key so they cannot collide', () => {
    expect(sourceKey('https://sg.linkedin.com/in/stuti09')).toBe('linkedin:in/stuti09');
  });
});
