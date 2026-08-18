import { describe, it, expect } from 'vitest';
import {
  reconcileProvenance,
  providerFields,
  fieldProvenance,
  candidateFields,
} from '@/lib/identity/provenance';
import {
  decideIdentity,
  normalizeConflict,
  applyUserSelection,
  type IdentityCandidate,
  type IdentityConflict,
  type IdentityVerification,
} from '@/lib/identity/types';

// Identity fields arrive from four places with four different levels of
// authority, and the pipeline used to flatten all of them into one object
// named `profile` before comparing it against public evidence. That flattening
// caused a live misdiagnosis: a role the DISCOVERY MODEL invented was compared
// against the sources as though the profile provider had returned it, so a run
// was blocked with "public sources disagree with the profile about this
// person's role" — for a profile that contained no role at all.
//
// The rule these lock in: a candidate-derived value may help FIND a person, but
// it never becomes provider evidence, and it never blocks a run on its own.
// Everything with genuine standing keeps blocking exactly as before.

const candidate = (over: Partial<IdentityCandidate> = {}): IdentityCandidate => ({
  id: 'candidate_1',
  name: 'Robert Treadwell',
  role: 'Treasury Director',
  company: 'Revolut',
  location: 'Ann Arbor',
  headline: null,
  linkedin_url: 'https://www.linkedin.com/in/robert-treadwell-32382814',
  confidence: 80,
  sources: [],
  origin: 'public_research',
  ...over,
});

const roleConflict = (over: Partial<IdentityConflict> = {}): IdentityConflict => ({
  field: 'role',
  claimed_value: 'Treasury Director',
  claimed_provenance: 'CANDIDATE',
  public_value: 'Interim US Chief Financial Officer / US Treasurer',
  explanation: 'Sources describe a different title.',
  sources: [],
  ...over,
});

/** The provider profile from the live run: a name and company, and no role. */
const profileWithoutRole = {
  name: 'Robert Treadwell',
  headline: null,
  location: 'Ann Arbor',
  currentCompany: { name: 'Revolut', title: null },
};

const decide = (over: Partial<Parameters<typeof decideIdentity>[0]> = {}) =>
  decideIdentity({
    selected: candidate(),
    selectionMethod: 'AUTOMATIC',
    profile: {
      name: 'Robert Treadwell',
      role: 'Treasury Director',
      company: 'Revolut',
      location: 'Ann Arbor',
      linkedin_url: 'https://www.linkedin.com/in/robert-treadwell-32382814',
    },
    hasProfile: true,
    candidates: [candidate()],
    conflicts: [],
    assessedConfidence: 85,
    missingFields: [],
    ...over,
  });

describe('providerFields reports only what the provider actually returned', () => {
  it('reports a missing role as null rather than borrowing one', () => {
    expect(providerFields(profileWithoutRole).role).toBeNull();
    expect(providerFields(profileWithoutRole).company).toBe('Revolut');
  });

  it('uses the provider’s title when it has one', () => {
    expect(providerFields({ ...profileWithoutRole, currentCompany: { name: 'Revolut', title: 'Treasury Director' } }).role).toBe(
      'Treasury Director',
    );
  });

  it('treats a headline as provider data, since the provider returned it', () => {
    expect(providerFields({ ...profileWithoutRole, headline: 'Finance leader' }).role).toBe('Finance leader');
  });

  it('reports nothing at all when no profile was retrieved', () => {
    expect(providerFields(null)).toEqual({ name: null, role: null, company: null, location: null });
  });
});

describe('fieldProvenance attributes a value to its real source', () => {
  it('provider data is PROFILE', () => {
    expect(fieldProvenance('Treasury Director', 'Interim CFO', 'Treasury Director', false)).toBe('PROFILE');
  });

  it('a value the user supplied is USER_HINT', () => {
    expect(fieldProvenance(null, 'Interim CFO', 'Interim CFO', false)).toBe('USER_HINT');
  });

  it('a value only the model proposed is CANDIDATE', () => {
    expect(fieldProvenance(null, 'Interim CFO', 'Treasury Director', false)).toBe('CANDIDATE');
  });

  it('a model value independent sources confirmed is PUBLIC_EVIDENCE', () => {
    expect(fieldProvenance(null, null, 'Treasury Director', true)).toBe('PUBLIC_EVIDENCE');
  });
});

describe('the observed Robert Treadwell case', () => {
  // OLD role hint: CFO. EDITED role hint: Interim CFO.
  // Provider role: null. Candidate role: Treasury Director.
  // Public evidence: Interim US Chief Financial Officer / US Treasurer.
  const reconciled = reconcileProvenance({
    profileFields: providerFields(profileWithoutRole),
    hints: { name: 'Robert Treadwell', role: 'Interim CFO', company: 'Revolut' },
    candidate: candidateFields(candidate()),
    conflicts: [roleConflict()],
    corroboratedFields: ['name', 'company'],
  });

  it('does not label the model’s role as profile evidence', () => {
    expect(reconciled.conflicts[0].claimed_provenance).toBe('CANDIDATE');
  });

  it('never stores a candidate-derived role under a property named profile_value', () => {
    expect(reconciled.conflicts[0]).not.toHaveProperty('profile_value');
    expect(reconciled.conflicts[0].claimed_value).toBe('Treasury Director');
  });

  it('does not carry the contradicted model role forward as the person’s role', () => {
    expect(reconciled.fields.role).toBeNull();
  });

  it('keeps the name and company the provider did return', () => {
    expect(reconciled.fields.name).toBe('Robert Treadwell');
    expect(reconciled.provenance.company).toBe('PROFILE');
  });

  it('records why the value was demoted, in words a reader can check', () => {
    expect(reconciled.notes.join(' ')).toContain('discovery model');
  });

  it('produces PARTIAL — unestablished — not AMBIGUOUS from a fake profile conflict', () => {
    const verification = decide({
      selected: candidate({ role: null }),
      profile: { ...decide().resolved, role: null },
      conflicts: reconciled.conflicts,
      missingFields: ['role'],
    });

    expect(verification.status).toBe('PARTIAL');
    expect(verification.reason).not.toContain('disagree');
    expect(verification.proceed).toBe(false);
  });
});

describe('public evidence backing the user’s hint settles the field', () => {
  it('adopts the corroborated value instead of failing on the model’s guess', () => {
    const reconciled = reconcileProvenance({
      profileFields: providerFields(profileWithoutRole),
      hints: { name: null, role: 'Interim CFO', company: null },
      candidate: candidateFields(candidate()),
      conflicts: [roleConflict({ public_value: 'Interim CFO' })],
      corroboratedFields: ['name'],
    });

    expect(reconciled.fields.role).toBe('Interim CFO');
    expect(reconciled.corroboratedFields).toContain('role');
    expect(reconciled.provenance.role).toBe('USER_HINT');
  });

  it('a run does not fail merely because the model preferred a different title', () => {
    const verification = decide({
      selected: candidate({ role: 'Interim CFO' }),
      profile: { ...decide().resolved, role: 'Interim CFO' },
      conflicts: [roleConflict({ public_value: 'Interim CFO' , claimed_provenance: 'CANDIDATE' })],
    });

    expect(verification.status).toBe('VERIFIED');
  });
});

describe('nothing that legitimately blocked stops blocking', () => {
  it('a PROFILE role contradicted by sources is still AMBIGUOUS', () => {
    const v = decide({ conflicts: [roleConflict({ claimed_provenance: 'PROFILE' })] });
    expect(v.status).toBe('AMBIGUOUS');
    expect(v.proceed).toBe(false);
  });

  it('a USER_HINT role contradicted by sources is still AMBIGUOUS, and says so honestly', () => {
    const v = decide({ conflicts: [roleConflict({ claimed_provenance: 'USER_HINT' })] });
    expect(v.status).toBe('AMBIGUOUS');
    expect(v.reason).toContain('the details you supplied');
  });

  it('a same-name-different-person finding from a retrieved source still blocks', () => {
    // What recoverIdentityField emits — grounded in a source, not a guess.
    const v = decide({ conflicts: [roleConflict({ claimed_provenance: 'PUBLIC_EVIDENCE' })] });
    expect(v.status).toBe('AMBIGUOUS');
  });

  it('a company conflict from the provider still blocks', () => {
    const v = decide({
      conflicts: [
        roleConflict({ field: 'company', claimed_value: 'Revolut', public_value: 'Monzo', claimed_provenance: 'PROFILE' }),
      ],
    });
    expect(v.status).toBe('AMBIGUOUS');
  });

  it('FAILED is unchanged when there is nothing to work with', () => {
    const v = decide({
      hasProfile: false,
      candidates: [],
      selected: null,
      profile: { name: null, role: null, company: null, location: null, linkedin_url: null },
    });
    expect(v.status).toBe('FAILED');
  });

  it('VERIFIED is unchanged for a complete, corroborated provider profile', () => {
    expect(decide().status).toBe('VERIFIED');
  });

  it('a complete provider profile is untouched by reconciliation', () => {
    const reconciled = reconcileProvenance({
      profileFields: providerFields({ ...profileWithoutRole, currentCompany: { name: 'Revolut', title: 'Treasury Director' } }),
      hints: { name: null, role: null, company: null },
      candidate: candidateFields(candidate()),
      conflicts: [],
      corroboratedFields: ['name', 'role', 'company'],
    });

    expect(reconciled.fields.role).toBe('Treasury Director');
    expect(reconciled.provenance.role).toBe('PROFILE');
    expect(reconciled.notes).toEqual([]);
  });

  it('an edit cannot force an unresolved identity to VERIFIED', () => {
    // Hint supplies a role, but nothing corroborates it and confidence is low.
    const v = decide({
      selected: candidate({ role: 'Interim CFO', company: null }),
      profile: { ...decide().resolved, role: 'Interim CFO', company: null },
      assessedConfidence: 20,
      missingFields: ['company'],
    });
    expect(v.status).not.toBe('VERIFIED');
    expect(v.proceed).toBe(false);
  });

  it('below the confidence floor stays PARTIAL even with no conflicts', () => {
    expect(decide({ assessedConfidence: 30 }).status).toBe('PARTIAL');
  });
});

describe('user selection respects provenance too', () => {
  const base = (conflicts: IdentityConflict[]): IdentityVerification => ({
    ...decide({ conflicts }),
    candidates: [candidate()],
  });

  it('a human choosing a candidate does not clear a real provider conflict', () => {
    // The conflict must be one the chosen candidate matches NEITHER side of —
    // matching a side is how selection legitimately resolves ambiguity.
    const v = applyUserSelection(
      base([
        roleConflict({
          field: 'company',
          claimed_value: 'Acme Holdings',
          public_value: 'Monzo',
          claimed_provenance: 'PROFILE',
        }),
      ]),
      'candidate_1',
    );
    expect(v.status).toBe('AMBIGUOUS');
  });

  it('a model-proposed disagreement does not survive as a blocker on selection', () => {
    const v = applyUserSelection(base([roleConflict({ claimed_provenance: 'CANDIDATE' })]), 'candidate_1');
    expect(v.status).toBe('VERIFIED');
  });
});

describe('runs persisted before provenance existed keep their meaning', () => {
  it('reads a legacy profile_value as a PROFILE claim', () => {
    const legacy = normalizeConflict({
      field: 'role',
      profile_value: 'Treasury Director',
      public_value: 'Interim CFO',
      explanation: 'x',
      sources: [],
    });

    expect(legacy.claimed_value).toBe('Treasury Director');
    expect(legacy.claimed_provenance).toBe('PROFILE');
  });

  it('so a historical AMBIGUOUS run stays AMBIGUOUS', () => {
    const legacy = normalizeConflict({ field: 'role', profile_value: 'A', public_value: 'B', explanation: 'x' });
    expect(decide({ conflicts: [legacy] }).status).toBe('AMBIGUOUS');
  });

  it('prefers the new field when both are somehow present', () => {
    const c = normalizeConflict({ field: 'role', profile_value: 'old', claimed_value: 'new', claimed_provenance: 'CANDIDATE' });
    expect(c.claimed_value).toBe('new');
    expect(c.claimed_provenance).toBe('CANDIDATE');
  });
});
