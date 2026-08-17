import { describe, it, expect } from 'vitest';
import { describeError } from '@/lib/pipeline/stages';

// Regression for the exact failure: find_contact_candidates recorded
// error = "[object Object]" and summary = "Stage failed: [object Object]"
// on a real live run (Ritesh Agarwal / PRISM).
//
// Root cause: `if (error) throw error;` runs throughout
// lib/supabase/queries.ts, but the supabase-js client's `{ data, error }`
// return style hands back a PLAIN PARSED JSON OBJECT for `error` — not an
// actual Error instance (that class is only constructed on the
// throw-on-error code path this codebase does not use). The stage wrapper's
// catch-all did `err instanceof Error ? err.message : String(err)`, and
// String() on a plain object is JavaScript's default coercion: literally the
// text "[object Object]". This was latent in every stage's generic catch;
// find_contact_candidates was the first to hit a genuinely failing database
// write (contact_candidates did not exist in the live database at the time).

describe('describeError never produces the literal string "[object Object]"', () => {
  it('reproduces the exact live failure: a Postgrest schema-cache-miss error', () => {
    // The literal shape PostgREST returns for a missing table (PGRST205),
    // which is what createContactCandidates actually received.
    const real = {
      code: 'PGRST205',
      message: "Could not find the table 'public.contact_candidates' in the schema cache",
      details: null,
      hint: null,
    };
    const message = describeError(real);
    expect(message).not.toBe('[object Object]');
    expect(message).toContain('contact_candidates');
  });

  it('handles a genuine Error instance via .message, unchanged from before', () => {
    expect(describeError(new Error('a real error'))).toBe('a real error');
    expect(describeError(new TypeError('bad type'))).toBe('bad type');
  });

  it('handles a Postgrest-shaped object with message, details and hint', () => {
    const message = describeError({
      code: '42501',
      message: 'permission denied for table runs',
      details: 'RLS policy rejected the insert',
      hint: 'Check your policies',
    });
    expect(message).not.toBe('[object Object]');
    expect(message).toMatch(/permission denied/);
    expect(message).toMatch(/RLS policy rejected/);
    expect(message).toMatch(/Check your policies/);
  });

  it('falls back to the error code when no readable text exists', () => {
    const message = describeError({ code: 'PGRST999' });
    expect(message).not.toBe('[object Object]');
    expect(message).toContain('PGRST999');
  });

  it('never returns the bare object-coercion string for a fully empty object', () => {
    expect(describeError({})).not.toBe('[object Object]');
  });

  it('never returns it for a plain object with unrelated fields either', () => {
    expect(describeError({ foo: 'bar', nested: { a: 1 } })).not.toBe('[object Object]');
  });

  it('is safe for primitives and nullish values', () => {
    expect(describeError('already a string')).toBe('already a string');
    expect(describeError(42)).toBe('42');
    expect(describeError(null)).toBe('null');
    expect(describeError(undefined)).toBe('undefined');
  });

  it('is safe for a value whose JSON.stringify would throw (circular reference)', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
    expect(describeError(circular)).not.toBe('[object Object]');
  });

  it('ignores non-string message/details/hint fields rather than stringifying them badly', () => {
    // A malformed error shape from an unexpected provider response.
    const message = describeError({ message: { nested: true }, code: 'X1' });
    expect(message).not.toBe('[object Object]');
    expect(message).toContain('X1');
  });
});
