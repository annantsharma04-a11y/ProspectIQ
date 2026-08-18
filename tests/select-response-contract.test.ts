import { describe, it, expect } from 'vitest';
import {
  interpretSelectResponse,
  selectionStatusFor,
  UNREADABLE_RESPONSE_MESSAGE,
  VERIFIED_MESSAGE,
} from '@/lib/contacts/select-ui';

// Regression tests for the reported bug: a candidate shown as eligible with an
// enabled Select button produced, on click:
//
//     "Could not verify this candidate (HTTP 200). Try again."
//
// The request had SUCCEEDED. The route's idempotent already-resolved path
// returned HTTP 200 carrying `resulting_run_id` — while the client looked for
// `run_id`, a `message` and an `error`, found none of the three, and fell
// through to a fallback that reported the HTTP code as a verification verdict.
//
// The rule these lock in: HTTP status answers "did the request work"; the body
// answers "was the candidate verified". Neither may be inferred from the other.

describe('selectionStatusFor — persisted status → wire vocabulary', () => {
  it('maps every identity status', () => {
    expect(selectionStatusFor('VERIFIED')).toBe('verified');
    expect(selectionStatusFor('AMBIGUOUS')).toBe('ambiguous');
    expect(selectionStatusFor('FAILED')).toBe('failed');
    expect(selectionStatusFor('PARTIAL')).toBe('partial');
  });

  it('treats anything not yet resolved as blocked rather than inventing a verdict', () => {
    expect(selectionStatusFor('DISCOVERED')).toBe('blocked');
    expect(selectionStatusFor('REJECTED')).toBe('blocked');
  });
});

// ─── 1. HTTP 200 + successful verification → success ────────────────────────

describe('1. HTTP 200/201 with a verified body → success', () => {
  it('navigates using the explicit contract', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 201,
      body: { ok: true, status: 'verified', runId: 'run-new', message: VERIFIED_MESSAGE },
    });
    expect(outcome).toEqual({ type: 'navigate', runId: 'run-new', message: VERIFIED_MESSAGE });
  });

  it('still navigates for the legacy body shape (run_id, no explicit status)', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 201,
      body: { run_id: 'run-legacy', identity_status: 'VERIFIED' },
    });
    expect(outcome.type).toBe('navigate');
  });
});

// ─── 2. HTTP 200 + verification failure → candidate-specific, not HTTP ──────

describe('2. HTTP 200 with a verification-failure body is NOT reported as an HTTP error', () => {
  it('reports the candidate-specific message for AMBIGUOUS', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 200,
      body: {
        ok: false,
        status: 'ambiguous',
        runId: null,
        message: 'Candidate could not be verified because public sources conflict about their identity or current role. Choose another candidate.',
      },
    });

    expect(outcome.type).toBe('message');
    if (outcome.type !== 'message') throw new Error('unreachable');
    // 'info', not 'error': the REQUEST worked; the candidate did not verify.
    expect(outcome.kind).toBe('info');
    expect(outcome.message).toMatch(/public sources conflict/i);
    // The exact regression: no HTTP code masquerading as a verdict.
    expect(outcome.message).not.toMatch(/HTTP/);
  });

  it('never emits the old "(HTTP 200)" phrasing for any verification verdict', () => {
    for (const status of ['ambiguous', 'failed', 'partial', 'blocked'] as const) {
      const outcome = interpretSelectResponse({
        ok: true,
        status: 200,
        body: { ok: false, status, message: `Candidate could not be verified (${status}).` },
      });
      if (outcome.type !== 'message') throw new Error('unreachable');
      expect(outcome.message).not.toMatch(/HTTP 200/);
    }
  });

  it('falls back to a candidate-specific sentence when a verdict body carries no message', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 200,
      body: { ok: false, status: 'failed' },
    });
    if (outcome.type !== 'message') throw new Error('unreachable');
    expect(outcome.message).toMatch(/could not be verified/i);
    expect(outcome.message).toMatch(/Choose another candidate/i);
    expect(outcome.message).not.toMatch(/HTTP/);
  });
});

// ─── the exact reported payload ─────────────────────────────────────────────

describe('the exact already-resolved payload that caused the bug', () => {
  it('OLD shape (resulting_run_id, no message) no longer produces the HTTP-200 error', () => {
    // Precisely what the route used to return: 200, resulting_run_id, no
    // run_id, no message, no error.
    const outcome = interpretSelectResponse({
      ok: true,
      status: 200,
      body: { identity_status: 'VERIFIED', resulting_run_id: 'run-existing', already_resolved: true },
    });

    // It is a completed selection, so it navigates to the run that exists.
    expect(outcome).toEqual({ type: 'navigate', runId: 'run-existing', message: VERIFIED_MESSAGE });
  });

  it('NEW shape: an already-resolved VERIFIED candidate navigates to its run', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 200,
      body: {
        ok: true,
        status: 'verified',
        runId: 'run-existing',
        message: 'This candidate was already verified. Opening the research run that was created for them.',
        already_resolved: true,
      },
    });
    expect(outcome.type).toBe('navigate');
  });

  it('NEW shape: an already-resolved AMBIGUOUS candidate explains itself instead of erroring', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 200,
      body: {
        ok: false,
        status: 'ambiguous',
        runId: null,
        message: 'This candidate was already reviewed and could not be verified (ambiguous). Choose another candidate.',
        already_resolved: true,
      },
    });
    if (outcome.type !== 'message') throw new Error('unreachable');
    expect(outcome.kind).toBe('info');
    expect(outcome.message).toMatch(/already reviewed/i);
    expect(outcome.message).not.toMatch(/HTTP/);
  });
});

// ─── 5. PARTIAL follows the existing identity policy ────────────────────────

describe('5. PARTIAL is reported like any other non-proceeding verdict', () => {
  it('is an info message, never a navigate and never a transport error', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 200,
      body: { ok: false, status: 'partial', message: 'Independent evidence was partial for this person.' },
    });
    expect(outcome.type).toBe('message');
    if (outcome.type !== 'message') throw new Error('unreachable');
    expect(outcome.kind).toBe('info');
  });

  it('does not invent a new policy: no run is offered for a partial verdict', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 200,
      // Even if a stale run id were present, `status: 'partial'` is not
      // 'verified', so it must not navigate.
      body: { ok: false, status: 'partial', runId: 'run-should-not-be-used' },
    });
    expect(outcome.type).toBe('message');
  });
});

// ─── 7. malformed response → safe client error ──────────────────────────────

describe('7. a malformed response produces a safe, honest client error', () => {
  it('an unreadable 200 body is a transport problem, NOT a verification verdict', () => {
    const outcome = interpretSelectResponse({ ok: true, status: 200, body: {} });
    if (outcome.type !== 'message') throw new Error('unreachable');
    expect(outcome.kind).toBe('error');
    expect(outcome.message).toBe(UNREADABLE_RESPONSE_MESSAGE);
    // The bug in one assertion: never claim the candidate failed verification
    // when we simply could not read the response.
    expect(outcome.message).not.toMatch(/could not verify this candidate/i);
  });

  it('ignores an unrecognised status value rather than trusting it', () => {
    const outcome = interpretSelectResponse({
      ok: true,
      status: 200,
      body: { ok: false, status: 'not-a-real-status' },
    });
    if (outcome.type !== 'message') throw new Error('unreachable');
    expect(outcome.message).toBe(UNREADABLE_RESPONSE_MESSAGE);
  });

  it('treats a blank message as absent rather than rendering an empty bubble', () => {
    const outcome = interpretSelectResponse({ ok: true, status: 200, body: { message: '   ' } });
    if (outcome.type !== 'message') throw new Error('unreachable');
    expect(outcome.message.trim().length).toBeGreaterThan(0);
  });
});

// ─── transport failures stay transport failures ─────────────────────────────

describe('HTTP 4xx/5xx are transport/server errors, described as such', () => {
  it('a 500 with no body reports the request failing, not the candidate', () => {
    const outcome = interpretSelectResponse({ ok: false, status: 500, body: {} });
    if (outcome.type !== 'message') throw new Error('unreachable');
    expect(outcome.kind).toBe('error');
    expect(outcome.message).toMatch(/request failed \(HTTP 500\)/i);
    expect(outcome.message).not.toMatch(/could not verify this candidate/i);
  });

  it('a 422 pre-verification block surfaces its specific reason', () => {
    const outcome = interpretSelectResponse({
      ok: false,
      status: 422,
      body: {
        ok: false,
        status: 'blocked',
        message: 'Candidate could not be verified. Choose another candidate. The cited evidence does not name this person.',
      },
    });
    if (outcome.type !== 'message') throw new Error('unreachable');
    expect(outcome.kind).toBe('error');
    expect(outcome.message).toMatch(/does not name this person/i);
  });

  it('a 429 rate limit is reported from its own error field', () => {
    const outcome = interpretSelectResponse({
      ok: false,
      status: 429,
      body: { error: 'Rate limit exceeded. Try again later.' },
    });
    if (outcome.type !== 'message') throw new Error('unreachable');
    expect(outcome.message).toMatch(/rate limit/i);
  });
});
