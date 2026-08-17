import { describe, it, expect } from 'vitest';
import { canSelectCandidate, interpretSelectResponse, NO_LINKEDIN_MESSAGE } from '@/lib/contacts/select-ui';
import type { ContactCandidateRow } from '@/lib/contacts/types';

// Regression for a live-reported bug: clicking Select appeared to do nothing,
// and candidates showing "No LinkedIn URL" / "Not yet verified" still had an
// enabled Select button. Traced to the client: the server already refused
// (422) a no-LinkedIn selection correctly, but nothing stopped the click from
// being offered in the first place, and a non-success response never
// refreshed the stale candidate list, so the button looked unchanged either
// way. Both are pure decisions, tested directly here.

const candidate = (over: Partial<ContactCandidateRow> = {}): ContactCandidateRow => ({
  id: 'c1',
  run_id: 'r1',
  name: 'Jane Kapoor',
  role: 'VP Finance',
  company: 'Acme',
  linkedin_url: 'https://www.linkedin.com/in/jane-kapoor',
  reason: 'Public role matches the qualified workflow.',
  evidence: [{ source_url: 'https://a.com', quote: 'q' }],
  confidence: 78,
  rank_score: 82.5,
  identity_status: 'DISCOVERED',
  identity_verification: null,
  selected_at: null,
  resulting_run_id: null,
  created_at: '2026-08-01T00:00:00Z',
  ...over,
});

describe('canSelectCandidate — the exact bug from the screenshot', () => {
  it('is selectable: DISCOVERED with a real LinkedIn URL', () => {
    expect(canSelectCandidate(candidate())).toBe(true);
  });

  it('is NOT selectable with no LinkedIn URL, even while still DISCOVERED', () => {
    // This is the live-reproduced case: "No LinkedIn URL" + "Not yet
    // verified" + an enabled button. The button must never be enabled here.
    expect(canSelectCandidate(candidate({ linkedin_url: null }))).toBe(false);
  });

  it('is NOT selectable when the LinkedIn URL is an empty or whitespace string', () => {
    expect(canSelectCandidate(candidate({ linkedin_url: '' }))).toBe(false);
    expect(canSelectCandidate(candidate({ linkedin_url: '   ' }))).toBe(false);
  });

  it('is NOT selectable once VERIFIED — already resolved, nothing left to click', () => {
    expect(canSelectCandidate(candidate({ identity_status: 'VERIFIED' }))).toBe(false);
  });

  it('is NOT selectable for AMBIGUOUS, FAILED, PARTIAL or REJECTED', () => {
    for (const status of ['AMBIGUOUS', 'FAILED', 'PARTIAL', 'REJECTED'] as const) {
      expect(canSelectCandidate(candidate({ identity_status: status }))).toBe(false);
    }
  });

  it('the disabled message names the reason precisely', () => {
    expect(NO_LINKEDIN_MESSAGE).toMatch(/no public profile/i);
    expect(NO_LINKEDIN_MESSAGE).toMatch(/cannot select/i);
  });
});

describe('interpretSelectResponse — every response produces a visible outcome', () => {
  it('a successful VERIFIED response navigates to the new run', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 201,
      body: { run_id: 'run-123', identity_status: 'VERIFIED' },
    });
    expect(outcome).toEqual({ type: 'navigate', runId: 'run-123' });
  });

  it('a 422 (no LinkedIn URL) is an error message, never silently ignored', () => {
    const outcome = interpretSelectResponse({
      ok: false,
      status: 422,
      body: { error: 'This candidate has no public LinkedIn URL, so identity cannot be verified.' },
    });
    expect(outcome).toEqual({
      type: 'message',
      kind: 'error',
      message: 'This candidate has no public LinkedIn URL, so identity cannot be verified.',
    });
  });

  it('an AMBIGUOUS verification (HTTP 200, no run_id) is reported, not treated as success', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 200,
      body: { identity_status: 'AMBIGUOUS', message: 'Identity ambiguous. Choose another candidate or confirm manually.' },
    });
    expect(outcome.type).toBe('message');
    if (outcome.type !== 'message') return;
    expect(outcome.kind).toBe('info');
    expect(outcome.message).toMatch(/ambiguous/i);
  });

  it('a FAILED verification is reported and does not navigate', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 200,
      body: { identity_status: 'FAILED', message: 'Identity failed — independent evidence was not strong enough to proceed automatically.' },
    });
    expect(outcome.type).toBe('message');
  });

  it('a 500 with no message still produces a readable fallback, never blank', () => {
    const outcome = interpretSelectResponse({ ok: false, status: 500, body: {} });
    expect(outcome).toEqual({
      type: 'message',
      kind: 'error',
      message: 'Could not verify this candidate (HTTP 500). Try again.',
    });
  });

  it('a malformed body (run_id present but not a string) does not navigate', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 201,
      body: { run_id: 12345 as unknown as string },
    });
    expect(outcome.type).toBe('message');
  });

  it('ok:true with no run_id and no message still produces a visible outcome', () => {
    const outcome = interpretSelectResponse({ ok: true, status: 200, body: {} });
    expect(outcome.type).toBe('message');
    if (outcome.type !== 'message') return;
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  it('a 429 rate-limit response is surfaced as an error, not swallowed', () => {
    const outcome = interpretSelectResponse({
      ok: false,
      status: 429,
      body: { error: 'Rate limit exceeded. Try again later.' },
    });
    expect(outcome).toEqual({ type: 'message', kind: 'error', message: 'Rate limit exceeded. Try again later.' });
  });
});
