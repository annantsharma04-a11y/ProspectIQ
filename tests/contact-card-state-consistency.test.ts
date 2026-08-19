import { describe, it, expect } from 'vitest';
import {
  canSelectCandidate,
  candidatePreVerification,
  effectiveIdentityStatus,
  isContactCandidateStatus,
} from '@/lib/contacts/select-ui';
import type { ContactCandidateRow, ContactCandidateStatus } from '@/lib/contacts/types';

// The Sanjay Mehra production report: a candidate card simultaneously showed
// "Pre-verified", "Passed the evidence and profile checks...", AND "This
// candidate was already reviewed and could not be verified (partial). Choose
// another candidate." — with Select still enabled.
//
// Traced to components/ContactCandidates.tsx: the badge and Select button
// were derived from the page's server-rendered `candidates` prop
// (`c.identity_status`), which can be stale, while the "already reviewed"
// message came from a genuinely fresh /select response reporting the
// server's real, current status (PARTIAL) for that exact candidate. Nothing
// in identity verification, pre-verification, or persistence was wrong —
// the server had already correctly written PARTIAL. The UI just kept
// deriving three different signals from two different sources of truth.
//
// The fix (effectiveIdentityStatus, in lib/contacts/select-ui.ts) makes the
// freshest known status win, and every downstream derivation — badge,
// Select eligibility, pre-verification detail — reads from that ONE
// resolved value, exactly as components/ContactCandidates.tsx now does.
// These tests exercise that exact composition without a DOM.

const candidate = (over: Partial<ContactCandidateRow> = {}): ContactCandidateRow => ({
  id: 'c1',
  run_id: 'r1',
  name: 'Sanjay Mehra',
  role: 'VP Finance',
  company: 'Acme',
  linkedin_url: 'https://www.linkedin.com/in/sanjay-mehra',
  reason: 'Public role matches the qualified workflow.',
  evidence: [{ source_url: 'https://a.com', quote: 'Sanjay Mehra is VP Finance at Acme.' }],
  confidence: 78,
  rank_score: 82.5,
  identity_status: 'DISCOVERED',
  identity_verification: null,
  selected_at: null,
  resulting_run_id: null,
  created_at: '2026-08-01T00:00:00Z',
  ...over,
});

/** The exact composition ContactCandidates.tsx now performs per row. */
function cardState(c: ContactCandidateRow, freshStatus: ContactCandidateStatus | null | undefined) {
  const status = effectiveIdentityStatus(c.identity_status, freshStatus);
  const effective = status === c.identity_status ? c : { ...c, identity_status: status };
  return {
    status,
    resolved: status !== 'DISCOVERED',
    selectable: canSelectCandidate(effective),
    preVerification: candidatePreVerification(effective),
  };
}

describe('1. a PARTIAL candidate has no selectable state', () => {
  it('genuinely-persisted PARTIAL: not selectable', () => {
    const c = candidate({ identity_status: 'PARTIAL' });
    const state = cardState(c, null);
    expect(state.selectable).toBe(false);
  });

  it('stale-prop DISCOVERED but a fresh PARTIAL just reported: not selectable', () => {
    // This is the exact reported shape: the prop still says DISCOVERED, but
    // the client just learned (via a /select response) that it's PARTIAL.
    const c = candidate({ identity_status: 'DISCOVERED' });
    const state = cardState(c, 'PARTIAL');
    expect(state.selectable).toBe(false);
  });
});

describe('2. a PARTIAL candidate carries no misleading Pre-verified signal', () => {
  it('the effective status is PARTIAL, not DISCOVERED — resolved, not pending', () => {
    const c = candidate({ identity_status: 'DISCOVERED' });
    const state = cardState(c, 'PARTIAL');
    expect(state.status).toBe('PARTIAL');
    expect(state.resolved).toBe(true);
    // "Pre-verified" is only ever shown when !resolved (the pending branch)
    // — this candidate must never reach that branch.
    expect(!state.resolved).toBe(false);
  });

  it('a candidate that is fresh-reported PARTIAL is indistinguishable from one that was always PARTIAL', () => {
    const staleProp = candidate({ identity_status: 'DISCOVERED' });
    const freshOverride = cardState(staleProp, 'PARTIAL');
    const genuinelyPartial = cardState(candidate({ identity_status: 'PARTIAL' }), null);
    expect(freshOverride.status).toBe(genuinelyPartial.status);
    expect(freshOverride.resolved).toBe(genuinelyPartial.resolved);
    expect(freshOverride.selectable).toBe(genuinelyPartial.selectable);
  });
});

describe('3. a DISCOVERED/eligible candidate keeps Select enabled — unchanged behavior', () => {
  it('no fresh status reported: selectable exactly as before', () => {
    const state = cardState(candidate(), null);
    expect(state.status).toBe('DISCOVERED');
    expect(state.resolved).toBe(false);
    expect(state.selectable).toBe(true);
  });

  it('pre-verification still runs the same real checks on the eligible path', () => {
    const state = cardState(candidate(), null);
    expect(state.preVerification.eligibility).toBe('ELIGIBLE');
  });
});

describe('4. a previously-reviewed candidate remains blocked, whichever signal reported it', () => {
  for (const status of ['AMBIGUOUS', 'FAILED', 'PARTIAL', 'REJECTED', 'VERIFIED'] as const) {
    it(`${status}, from the persisted prop: blocked`, () => {
      const state = cardState(candidate({ identity_status: status }), null);
      expect(state.selectable).toBe(false);
      expect(state.resolved).toBe(true);
    });

    it(`${status}, freshly reported over a stale DISCOVERED prop: blocked`, () => {
      const state = cardState(candidate({ identity_status: 'DISCOVERED' }), status);
      expect(state.selectable).toBe(false);
      expect(state.resolved).toBe(true);
      expect(state.status).toBe(status);
    });
  }
});

describe('5. the existing candidate-selection flow is unchanged', () => {
  it('effectiveIdentityStatus falls back to the persisted status when nothing fresher exists', () => {
    expect(effectiveIdentityStatus('DISCOVERED', null)).toBe('DISCOVERED');
    expect(effectiveIdentityStatus('DISCOVERED', undefined)).toBe('DISCOVERED');
    expect(effectiveIdentityStatus('VERIFIED', null)).toBe('VERIFIED');
  });

  it('effectiveIdentityStatus prefers the fresh status when one is reported', () => {
    expect(effectiveIdentityStatus('DISCOVERED', 'AMBIGUOUS')).toBe('AMBIGUOUS');
  });

  it('isContactCandidateStatus accepts only the real, persisted status values', () => {
    for (const s of ['DISCOVERED', 'PARTIAL', 'VERIFIED', 'AMBIGUOUS', 'FAILED', 'REJECTED']) {
      expect(isContactCandidateStatus(s)).toBe(true);
    }
    expect(isContactCandidateStatus('verified')).toBe(false); // wire-contract lowercase, not a row status
    expect(isContactCandidateStatus('something-else')).toBe(false);
    expect(isContactCandidateStatus(undefined)).toBe(false);
    expect(isContactCandidateStatus(null)).toBe(false);
    expect(isContactCandidateStatus(42)).toBe(false);
  });

  it('canSelectCandidate and candidatePreVerification are untouched — same real checks as before this fix', () => {
    // No LinkedIn URL still blocks selection, exactly as the existing
    // regression (tests/contact-select-ui.test.ts) already covers.
    const state = cardState(candidate({ linkedin_url: null }), null);
    expect(state.selectable).toBe(false);
    expect(state.preVerification.eligibility).not.toBe('ELIGIBLE');
  });
});
