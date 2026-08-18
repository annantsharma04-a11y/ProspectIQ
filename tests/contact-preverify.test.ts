import { describe, it, expect } from 'vitest';
import { preVerifyCandidate, isSelectable } from '@/lib/contacts/preverify';
import { canSelectCandidate } from '@/lib/contacts/select-ui';
import type { ContactCandidateRow } from '@/lib/contacts/types';

// Regression tests for the reported failure: a contact candidate appeared in
// "Suggested contacts" with an ENABLED Select button labelled "Not yet
// verified", the human selected it, and only THEN did the full identity
// verification discover a conflict — after a paid research round had already
// been spent. Pre-verification (lib/contacts/preverify.ts) moves the cheap,
// deterministic half of that judgment in FRONT of the button.
//
// What is deliberately NOT tested as "removed": the full identity
// verification after selection. It still runs, unchanged — see the
// "selected candidate still receives full identity verification" block at
// the bottom, and tests/select-candidate-race.test.ts.

const candidate = (over: Partial<ContactCandidateRow> = {}): ContactCandidateRow =>
  ({
    id: 'c1',
    run_id: 'r1',
    name: 'Jane Kapoor',
    role: 'VP Finance',
    company: 'Acme Logistics',
    linkedin_url: 'https://www.linkedin.com/in/jane-kapoor',
    reason: 'Public role matches the qualified workflow.',
    evidence: [
      { source_url: 'https://news.example.com/acme-finance', quote: 'Jane Kapoor is VP Finance at Acme Logistics.' },
    ],
    confidence: 78,
    rank_score: 82.5,
    identity_status: 'DISCOVERED',
    identity_verification: null,
    selected_at: null,
    resulting_run_id: null,
    created_at: '2026-08-01T00:00:00Z',
    ...over,
  }) as ContactCandidateRow;

// ─── 1. verified candidate → selectable ─────────────────────────────────────

describe('1. a fully consistent candidate is ELIGIBLE and selectable', () => {
  it('passes every check', () => {
    const result = preVerifyCandidate(candidate());
    expect(result.eligibility).toBe('ELIGIBLE');
    expect(result.blockedReason).toBeNull();
    expect(result.checks.name_present).toBe(true);
    expect(result.checks.evidence_present).toBe(true);
    expect(result.checks.linkedin_url_valid).toBe(true);
    expect(result.checks.name_in_evidence).toBe(true);
    expect(result.checks.company_in_evidence).toBe(true);
    expect(result.checks.name_matches_profile).toBe(true);
  });

  it('is selectable through the Select-button gate', () => {
    expect(isSelectable(candidate())).toBe(true);
    expect(canSelectCandidate(candidate())).toBe(true);
  });

  it('normalizes the profile URL so the caller need not re-parse it', () => {
    const result = preVerifyCandidate(candidate({ linkedin_url: 'linkedin.com/in/Jane-Kapoor/' }));
    expect(result.normalizedUrl).toBe('https://www.linkedin.com/in/jane-kapoor');
  });
});

// ─── 2. ambiguous / conflicting candidate → NOT selectable ──────────────────

describe('2. a candidate whose evidence names someone else is blocked', () => {
  // The reported failure in miniature: a real, retrieved quote that genuinely
  // exists in a real source — but describes a different person.
  const wrongPerson = candidate({
    evidence: [
      { source_url: 'https://news.example.com/acme-finance', quote: 'Rahul Mehta is VP Finance at Acme Logistics.' },
    ],
  });

  it('is NEEDS_VERIFICATION, not ELIGIBLE', () => {
    const result = preVerifyCandidate(wrongPerson);
    expect(result.eligibility).toBe('NEEDS_VERIFICATION');
    expect(result.checks.name_in_evidence).toBe(false);
    expect(result.blockedReason).toMatch(/does not name this person/i);
  });

  it('has Select disabled', () => {
    expect(canSelectCandidate(wrongPerson)).toBe(false);
  });

  it('is still shown (NEEDS_VERIFICATION is not EXCLUDED), so a human can judge it', () => {
    expect(preVerifyCandidate(wrongPerson).eligibility).not.toBe('EXCLUDED');
  });

  it('a candidate already resolved by the server is never selectable, whatever pre-verification says', () => {
    for (const status of ['VERIFIED', 'AMBIGUOUS', 'FAILED', 'PARTIAL', 'REJECTED'] as const) {
      expect(canSelectCandidate(candidate({ identity_status: status }))).toBe(false);
    }
  });
});

// ─── 3. invalid LinkedIn URL → rejected ─────────────────────────────────────

describe('3. an unusable profile URL EXCLUDES the candidate', () => {
  it('rejects a missing URL', () => {
    const result = preVerifyCandidate(candidate({ linkedin_url: null }));
    expect(result.eligibility).toBe('EXCLUDED');
    expect(result.checks.linkedin_url_valid).toBe(false);
    expect(result.blockedReason).toMatch(/no public linkedin profile url/i);
  });

  it('rejects a non-profile LinkedIn URL', () => {
    // A company page is a real LinkedIn URL but not a person to verify.
    const result = preVerifyCandidate(candidate({ linkedin_url: 'https://www.linkedin.com/company/acme' }));
    expect(result.eligibility).toBe('EXCLUDED');
    expect(result.checks.linkedin_url_valid).toBe(false);
  });

  it('rejects a non-LinkedIn URL entirely', () => {
    expect(preVerifyCandidate(candidate({ linkedin_url: 'https://example.com/jane' })).eligibility).toBe('EXCLUDED');
  });

  it('rejects a reserved LinkedIn slug', () => {
    // "edit" is one of parseLinkedInUrl's RESERVED_SLUGS — a real /in/ URL
    // shape that is nonetheless not a person's public profile.
    expect(preVerifyCandidate(candidate({ linkedin_url: 'https://www.linkedin.com/in/edit' })).eligibility).toBe(
      'EXCLUDED',
    );
  });

  it('blocks a profile URL belonging to a different person than the name', () => {
    const result = preVerifyCandidate(candidate({ linkedin_url: 'https://www.linkedin.com/in/rahul-mehta' }));
    expect(result.eligibility).toBe('NEEDS_VERIFICATION');
    expect(result.checks.name_matches_profile).toBe(false);
    expect(result.blockedReason).toMatch(/does not match this person/i);
  });

  it('does not penalise an opaque vanity slug that carries no real name', () => {
    // "in/xk8f2p" implies nothing either way — an unknown is not a conflict,
    // and must not block an otherwise well-evidenced candidate.
    const result = preVerifyCandidate(candidate({ linkedin_url: 'https://www.linkedin.com/in/xk8f2p' }));
    expect(result.checks.name_matches_profile).toBeNull();
    expect(result.eligibility).toBe('ELIGIBLE');
  });

  it('still catches a name-like slug belonging to a different person', () => {
    // The precision above must not cost us the actual conflict signal.
    const result = preVerifyCandidate(candidate({ linkedin_url: 'https://www.linkedin.com/in/rahul-mehta-4a2b91' }));
    expect(result.checks.name_matches_profile).toBe(false);
    expect(result.eligibility).toBe('NEEDS_VERIFICATION');
  });
});

// ─── 4. company mismatch → blocked ──────────────────────────────────────────

describe('4. evidence that does not tie the person to this company is blocked', () => {
  const otherCompany = candidate({
    evidence: [
      { source_url: 'https://news.example.com/other', quote: 'Jane Kapoor is VP Finance at Northwind Trading.' },
    ],
  });

  it('is NEEDS_VERIFICATION with the company check failed', () => {
    const result = preVerifyCandidate(otherCompany);
    expect(result.eligibility).toBe('NEEDS_VERIFICATION');
    expect(result.checks.company_in_evidence).toBe(false);
    expect(result.blockedReason).toMatch(/does not tie this person to this company/i);
  });

  it('has Select disabled', () => {
    expect(canSelectCandidate(otherCompany)).toBe(false);
  });

  it('ignores generic corporate suffixes when matching, so "Ltd" alone never counts as a match', () => {
    const suffixOnly = candidate({
      company: 'Acme Technologies Pvt Ltd',
      evidence: [
        { source_url: 'https://news.example.com/x', quote: 'Jane Kapoor joined a Pvt Ltd company as VP Finance.' },
      ],
    });
    expect(preVerifyCandidate(suffixOnly).checks.company_in_evidence).toBe(false);
  });

  it('matches on the distinctive part of a company name', () => {
    const distinctive = candidate({
      company: 'Acme Logistics Pvt Ltd',
      evidence: [
        { source_url: 'https://news.example.com/x', quote: 'Jane Kapoor is VP Finance at Acme, the logistics firm.' },
      ],
    });
    expect(preVerifyCandidate(distinctive).checks.company_in_evidence).toBe(true);
  });
});

// ─── 5. role conflict → blocked ─────────────────────────────────────────────

describe('5. a role that does not own the qualified workflow is blocked', () => {
  const targetRoles = ['CFO', 'VP Finance', 'Controller', 'Head of Accounts Payable'];

  it('accepts a role that matches a functional owner', () => {
    const result = preVerifyCandidate(candidate({ role: 'VP Finance' }), { targetRoles });
    expect(result.checks.role_consistent).toBe(true);
    expect(result.eligibility).toBe('ELIGIBLE');
  });

  it('blocks a role from an unrelated function', () => {
    const recruiter = candidate({
      role: 'Recruiting Manager',
      evidence: [
        {
          source_url: 'https://news.example.com/x',
          quote: 'Jane Kapoor is Recruiting Manager at Acme Logistics.',
        },
      ],
    });
    const result = preVerifyCandidate(recruiter, { targetRoles });
    expect(result.eligibility).toBe('NEEDS_VERIFICATION');
    expect(result.checks.role_consistent).toBe(false);
    expect(result.blockedReason).toMatch(/does not match an owner of the qualified workflow/i);
  });

  it('skips the role check when no target roles are supplied, rather than failing it', () => {
    // At Select time the persisted row does not carry the run's target roles,
    // and rankCandidates() already applied the same gate upstream — so an
    // unknown here must not be treated as a conflict.
    const result = preVerifyCandidate(candidate({ role: 'Recruiting Manager' }));
    expect(result.checks.role_consistent).toBeNull();
    expect(result.eligibility).toBe('ELIGIBLE');
  });

  it('uses the same loose matching rankCandidates() uses ("Vice President of Finance" ≈ "VP Finance")', () => {
    const spelledOut = candidate({
      role: 'Vice President of Finance',
      evidence: [
        {
          source_url: 'https://news.example.com/x',
          quote: 'Jane Kapoor is Vice President of Finance at Acme Logistics.',
        },
      ],
    });
    expect(preVerifyCandidate(spelledOut, { targetRoles }).checks.role_consistent).toBe(true);
  });
});

// ─── missing name / missing evidence → EXCLUDED ─────────────────────────────

describe('a candidate with nothing to verify against is EXCLUDED, not merely blocked', () => {
  it('excludes a candidate with no name', () => {
    const result = preVerifyCandidate(candidate({ name: null }));
    expect(result.eligibility).toBe('EXCLUDED');
    expect(result.checks.name_present).toBe(false);
  });

  it('excludes a candidate with no evidence at all', () => {
    const result = preVerifyCandidate(candidate({ evidence: [] }));
    expect(result.eligibility).toBe('EXCLUDED');
    expect(result.checks.evidence_present).toBe(false);
    expect(result.blockedReason).toMatch(/no supporting evidence/i);
  });

  it('treats an evidence item with an empty quote as no evidence', () => {
    const result = preVerifyCandidate(
      candidate({ evidence: [{ source_url: 'https://a.com', quote: '   ' }] }),
    );
    expect(result.eligibility).toBe('EXCLUDED');
    expect(result.checks.evidence_present).toBe(false);
  });
});

// ─── 6/7. the guarantees that must NOT change ───────────────────────────────

describe('6. pre-verification never substitutes for full identity verification', () => {
  it('an ELIGIBLE candidate is still only DISCOVERED — it is not marked VERIFIED', () => {
    // ELIGIBLE means "honest to offer the button", never "identity proven".
    // The row stays DISCOVERED so the select route still runs the full
    // verifySelectedCandidate/decideIdentity pass before anything downstream.
    const c = candidate();
    expect(preVerifyCandidate(c).eligibility).toBe('ELIGIBLE');
    expect(c.identity_status).toBe('DISCOVERED');
    expect(canSelectCandidate(c)).toBe(true);
  });

  it('is pure and deterministic — no network, no model, same answer every time', () => {
    const c = candidate();
    const a = preVerifyCandidate(c);
    const b = preVerifyCandidate(c);
    expect(a).toEqual(b);
  });
});

describe('7. a blocked candidate can never reach downstream outreach', () => {
  it('every non-ELIGIBLE outcome disables Select, which is the only path to a run', () => {
    const blocked = [
      candidate({ linkedin_url: null }), // EXCLUDED
      candidate({ evidence: [] }), // EXCLUDED
      candidate({ name: null }), // EXCLUDED
      candidate({ evidence: [{ source_url: 'https://a.com', quote: 'Someone Else at Acme Logistics.' }] }), // NEEDS_VERIFICATION
      candidate({ linkedin_url: 'https://www.linkedin.com/in/rahul-mehta' }), // NEEDS_VERIFICATION
    ];
    for (const c of blocked) {
      expect(preVerifyCandidate(c).eligibility).not.toBe('ELIGIBLE');
      expect(canSelectCandidate(c)).toBe(false);
    }
  });

  it('always names the failed check, so a blocked candidate is never silently missing', () => {
    for (const c of [candidate({ linkedin_url: null }), candidate({ evidence: [] })]) {
      expect(preVerifyCandidate(c).blockedReason).toBeTruthy();
    }
  });
});
