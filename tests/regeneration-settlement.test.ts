import { describe, it, expect } from 'vitest';
import { shouldTreatAsSettled, REGENERATION_SETTLE_GRACE_MS } from '@/components/StageDetail';

// The Stage 13 "Regenerate message" button used to need two clicks: its
// polling loop treated the FIRST non-"running" status read as "done", but
// `regenerateMessageOnly()` does real work (rehydrating the run) before it
// ever writes `status: 'running'` to Postgres — so an early poll could read
// the run's stale PRE-click status and wrongly conclude the job had already
// finished, flipping the button back to idle while the real regeneration was
// still running in the background. shouldTreatAsSettled() is the fix: these
// tests prove it never calls a run "settled" before the job has had a fair
// chance to actually start.

describe('shouldTreatAsSettled', () => {
  it('never settles while the status is genuinely running', () => {
    expect(shouldTreatAsSettled('running', false, 0)).toBe(false);
    expect(shouldTreatAsSettled('running', true, 999_999)).toBe(false);
  });

  it('does NOT settle on a non-running read before the job has had a fair chance to start (the two-click bug)', () => {
    // This is the exact false-positive that caused the bug: the very first
    // poll reads the run's stale pre-click status (not "running") a moment
    // after the click, well inside the grace period, having never observed
    // "running" at all.
    expect(shouldTreatAsSettled('ready_for_review', false, 500)).toBe(false);
    expect(shouldTreatAsSettled('ready_for_review', false, REGENERATION_SETTLE_GRACE_MS - 1)).toBe(false);
  });

  it('settles on a non-running read once running was genuinely observed first', () => {
    expect(shouldTreatAsSettled('ready_for_review', true, 500)).toBe(true);
    expect(shouldTreatAsSettled('needs_manual_review', true, 0)).toBe(true);
  });

  it('settles once the grace period has elapsed even if running was never observed', () => {
    // Covers a job that starts and finishes inside a single poll interval —
    // it should not be stuck "pending" forever just because we never caught
    // it mid-flight.
    expect(shouldTreatAsSettled('ready_for_review', false, REGENERATION_SETTLE_GRACE_MS)).toBe(true);
    expect(shouldTreatAsSettled('ready_for_review', false, REGENERATION_SETTLE_GRACE_MS + 1000)).toBe(true);
  });

  it('treats an unknown/undefined status the same as "not running"', () => {
    expect(shouldTreatAsSettled(undefined, false, 100)).toBe(false);
    expect(shouldTreatAsSettled(undefined, true, 0)).toBe(true);
  });
});
