import { describe, it, expect } from 'vitest';
import { parseLinkedInUrl, nameHintFromSlug } from '@/lib/linkedin/url';

describe('parseLinkedInUrl — accepted forms', () => {
  const canonical = 'https://www.linkedin.com/in/jane-doe';

  it.each([
    'https://www.linkedin.com/in/jane-doe/',
    'https://linkedin.com/in/jane-doe',
    'http://www.linkedin.com/in/jane-doe/',
    'www.linkedin.com/in/jane-doe',
    'linkedin.com/in/jane-doe',
    '  https://www.linkedin.com/in/jane-doe  ',
    'https://in.linkedin.com/in/jane-doe',
    'https://www.linkedin.com/in/jane-doe?originalSubdomain=in',
    'https://www.linkedin.com/in/JANE-DOE',
  ])('normalizes %s', (input) => {
    const result = parseLinkedInUrl(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized_url).toBe(canonical);
    expect(result.slug).toBe('jane-doe');
  });

  it('keeps LinkedIn disambiguation suffixes in the slug', () => {
    const result = parseLinkedInUrl('https://www.linkedin.com/in/jane-doe-1a2b3c4');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe('jane-doe-1a2b3c4');
    expect(result.name_hint).toBe('Jane Doe');
  });

  it('handles percent-encoded non-Latin slugs', () => {
    const result = parseLinkedInUrl('https://www.linkedin.com/in/%D8%A7%D8%AD%D9%85%D8%AF-ali');
    expect(result.ok).toBe(true);
  });
});

describe('parseLinkedInUrl — rejected forms', () => {
  it('rejects an empty value', () => {
    expect(parseLinkedInUrl('').ok).toBe(false);
    expect(parseLinkedInUrl(null).ok).toBe(false);
  });

  it('rejects a non-LinkedIn host', () => {
    const result = parseLinkedInUrl('https://example.com/in/jane-doe');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not a linkedin\.com URL/i);
  });

  it('rejects a company page with a specific message', () => {
    const result = parseLinkedInUrl('https://www.linkedin.com/company/acme');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/company page/i);
  });

  it('rejects a legacy /pub/ URL', () => {
    const result = parseLinkedInUrl('https://www.linkedin.com/pub/jane-doe/1/2/3');
    expect(result.ok).toBe(false);
  });

  it('rejects a profile URL with no slug', () => {
    expect(parseLinkedInUrl('https://www.linkedin.com/in/').ok).toBe(false);
  });

  it('rejects a feed URL', () => {
    expect(parseLinkedInUrl('https://www.linkedin.com/feed/').ok).toBe(false);
  });

  it('rejects unparseable text', () => {
    expect(parseLinkedInUrl('not a url at all').ok).toBe(false);
  });

  it('rejects reserved slugs', () => {
    expect(parseLinkedInUrl('https://www.linkedin.com/in/me').ok).toBe(false);
  });
});

describe('nameHintFromSlug', () => {
  it('drops numeric and hex disambiguation segments', () => {
    expect(nameHintFromSlug('john-smith-84a12f')).toBe('John Smith');
    expect(nameHintFromSlug('john-smith-123')).toBe('John Smith');
  });

  it('returns null when nothing name-like remains', () => {
    expect(nameHintFromSlug('12345678')).toBeNull();
  });
});
