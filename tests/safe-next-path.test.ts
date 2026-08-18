import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { safeNextPath, DEFAULT_NEXT_PATH } from '@/lib/auth/safe-next-path';

// Regression test for the login open-redirect finding: `next` query param
// validation only checked `startsWith('/')`, which a protocol-relative URL
// like "//evil.com" also satisfies. Both the server redirect() in
// app/login/page.tsx and the client router.push() in LoginForm.tsx used
// that check, so a crafted /login?next=//evil.com link could send a
// freshly-authenticated user off-site.

describe('safeNextPath — pure validation', () => {
  it('preserves ordinary internal paths', () => {
    expect(safeNextPath('/dashboard')).toBe('/dashboard');
    expect(safeNextPath('/runs/123')).toBe('/runs/123');
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('/history')).toBe('/history');
  });

  it('preserves an internal path carrying a query string or hash', () => {
    expect(safeNextPath('/runs/123?tab=stages')).toBe('/runs/123?tab=stages');
    expect(safeNextPath('/prospects/9#signals')).toBe('/prospects/9#signals');
  });

  it('rejects a protocol-relative URL, falling back to the default', () => {
    expect(safeNextPath('//evil.com')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('//evil.com/phish')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('///evil.com')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects the backslash variant of a protocol-relative URL', () => {
    expect(safeNextPath('/\\evil.com')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects an absolute URL with an explicit scheme', () => {
    expect(safeNextPath('https://evil.com')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('http://evil.com')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('javascript:alert(1)')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects a value that only becomes protocol-relative once a browser strips whitespace', () => {
    // Per the WHATWG URL spec, browsers strip ASCII tab/newline/CR before
    // resolving a URL, so this literal string is not "//evil.com" as
    // written, but IS what a browser would actually navigate to.
    expect(safeNextPath('/\t/evil.com')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('/\n/evil.com')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('/\r/evil.com')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects missing, empty, and non-relative input', () => {
    expect(safeNextPath(null)).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath(undefined)).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('dashboard')).toBe(DEFAULT_NEXT_PATH); // no leading slash
  });

  it('supports a custom fallback', () => {
    expect(safeNextPath('//evil.com', '/login')).toBe('/login');
  });
});

// ─── app/login/page.tsx — the redirect target actually used ────────────────

const mockRedirect = vi.fn();
const mockGetAuthenticatedUser = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: (...a: unknown[]) => mockRedirect(...a),
}));

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: () => mockGetAuthenticatedUser(),
}));

const { default: LoginPage } = await import('@/app/login/page');
const { LoginForm } = await import('@/components/LoginForm');

/** Depth-first search of a React element tree for the first element of `type`. */
function findElement(node: unknown, type: unknown): ReactElement | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as ReactElement & { props?: { children?: unknown } };
  if (el.type === type) return el;
  const children = el.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  return findElement(children, type);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation(() => {
    throw new Error('NEXT_REDIRECT');
  });
});

describe('LoginPage — next redirect target is sanitized', () => {
  it('redirects an already-signed-in user to a valid relative next path', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'user-1' });

    await expect(
      LoginPage({ searchParams: Promise.resolve({ next: '/runs/123' }) }),
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledWith('/runs/123');
  });

  it('refuses to redirect an already-signed-in user to a protocol-relative URL', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'user-1' });

    await expect(
      LoginPage({ searchParams: Promise.resolve({ next: '//evil.com' }) }),
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledWith('/');
  });

  it('passes a sanitized nextPath to LoginForm for a signed-out visitor', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const result = await LoginPage({ searchParams: Promise.resolve({ next: '//evil.com' }) });
    const formEl = findElement(result, LoginForm);

    expect(formEl).not.toBeNull();
    expect((formEl!.props as { nextPath: string }).nextPath).toBe('/');
  });

  it('preserves a valid relative nextPath for a signed-out visitor', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const result = await LoginPage({ searchParams: Promise.resolve({ next: '/dashboard' }) });
    const formEl = findElement(result, LoginForm);

    expect((formEl!.props as { nextPath: string }).nextPath).toBe('/dashboard');
  });
});
