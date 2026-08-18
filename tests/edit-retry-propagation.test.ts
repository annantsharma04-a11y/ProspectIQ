import { describe, it, expect } from 'vitest';
import { resolveIdentity } from '@/lib/research/identity';
import { classifyFailure } from '@/lib/pipeline/failure-classification';
import type { LinkedInProfile } from '@/lib/linkedin/profile';

// Does an Edit & Retry actually CHANGE what the pipeline reasons about?
//
// A live run reached needs_manual_review on an ambiguous identity, the user
// edited the details, retried — and hit the same failure. Two very different
// explanations were on the table, and they must never be conflated:
//
//   A. the corrected fields were dropped somewhere between the form and the
//      pipeline, so the retry re-ran on the OLD values;
//   B. the corrected fields were genuinely used and the conflict remained.
//
// tests/edit-retry-route.test.ts already pins the write side (what reaches the
// database). These pin the READ side — what the pipeline does with the edited
// values once they are stored — because that is the half that decides between
// A and B, and the half nothing was covering.
//
// The seed below mirrors the real run: a profile that carries a NAME but no
// title, headline or experience at all.

const profileWithoutTitle: LinkedInProfile = {
  name: 'Robert Treadwell',
  headline: null,
  location: 'Ann Arbor',
  about: null,
  currentCompany: { name: 'Revolut', title: null, url: null },
  experience: [],
  education: [],
} as unknown as LinkedInProfile;

const profileWithTitle: LinkedInProfile = {
  ...profileWithoutTitle,
  currentCompany: { name: 'Revolut', title: 'Treasury Director', url: null },
} as unknown as LinkedInProfile;

const seed = (over: Partial<Parameters<typeof resolveIdentity>[1]> = {}) => ({
  slug: 'robert-treadwell-32382814',
  nameHint: 'Robert Treadwell',
  userName: null,
  userCompany: null,
  userTitle: null,
  ...over,
});

describe('edited values reach identity resolution', () => {
  it('uses the edited title when the profile carries none', () => {
    // The real run's shape. The corrected role is NOT dropped here.
    const identity = resolveIdentity(profileWithoutTitle, seed({ userTitle: 'Interim CFO' }));
    expect(identity.role).toBe('Interim CFO');
  });

  it('uses the edited company when the profile carries none', () => {
    const bare = { ...profileWithoutTitle, currentCompany: null } as unknown as LinkedInProfile;
    const identity = resolveIdentity(bare, seed({ userCompany: 'Revolut US' }));
    expect(identity.company).toBe('Revolut US');
  });

  it('uses every edited field when no profile was retrieved at all', () => {
    const identity = resolveIdentity(
      null,
      seed({ userName: 'Jane Kapoor', userCompany: 'Acme', userTitle: 'Head of AP' }),
    );
    expect(identity.full_name).toBe('Jane Kapoor');
    expect(identity.company).toBe('Acme');
    expect(identity.role).toBe('Head of AP');
    expect(identity.basis).toBe('user_hints');
  });

  it('never silently reuses a previous attempt’s values', () => {
    // Same profile, two different edits — the output must track the input.
    const first = resolveIdentity(profileWithoutTitle, seed({ userTitle: 'CFO' }));
    const second = resolveIdentity(profileWithoutTitle, seed({ userTitle: 'Interim CFO' }));

    expect(first.role).toBe('CFO');
    expect(second.role).toBe('Interim CFO');
    expect(second.role).not.toBe(first.role);
  });

  it('leaves resolution unchanged when the user edited nothing', () => {
    const before = resolveIdentity(profileWithTitle, seed());
    const after = resolveIdentity(profileWithTitle, seed());
    expect(after).toEqual(before);
  });
});

describe('the profile still outranks the typed hints — editing cannot overrule evidence', () => {
  // The safety rule this feature must not breach: correcting the input may
  // make verification more precise, never more permissive. A user typing a
  // role does not get to overwrite what the retrieved profile actually says.

  it('keeps the profile’s title even when the user typed a different one', () => {
    const identity = resolveIdentity(profileWithTitle, seed({ userTitle: 'Interim CFO' }));
    expect(identity.role).toBe('Treasury Director');
    expect(identity.basis).toBe('profile');
  });

  it('keeps the profile’s name and company over typed replacements', () => {
    const identity = resolveIdentity(
      profileWithTitle,
      seed({ userName: 'Someone Else', userCompany: 'Another Co' }),
    );
    expect(identity.full_name).toBe('Robert Treadwell');
    expect(identity.company).toBe('Revolut');
  });

  it('an edit never turns an unresolved identity into a resolved one by itself', () => {
    // Hints raise confidence but must not fabricate resolution from nothing.
    const identity = resolveIdentity(null, seed({ userCompany: 'Revolut', userName: null }));
    expect(identity.resolved).toBe(false);
  });

  it('hint-derived identity stays below profile-derived confidence', () => {
    const fromHints = resolveIdentity(null, seed({ userName: 'A', userCompany: 'B' }));
    const fromProfile = resolveIdentity(profileWithTitle, seed());
    expect(fromHints.confidence).toBeLessThan(fromProfile.confidence);
  });
});

describe('the retry is offered on the right terms', () => {
  const ambiguousRun = {
    id: 'r1',
    status: 'needs_manual_review',
    identity_status: 'AMBIGUOUS',
    error: null,
    ai_error_type: null,
    linkedin_url: 'https://www.linkedin.com/in/robert-treadwell-32382814',
    input_name: null,
    input_company: null,
    input_title: 'CFO',
  } as never;

  it('offers the URL alongside the hints, since the URL is what re-anchors identity', () => {
    const c = classifyFailure(ambiguousRun);
    expect(c?.isEditable).toBe(true);
    expect(c?.editableFields).toContain('linkedin_url');
  });

  it('restarts from validate_input so the corrected input is re-read from the top', () => {
    expect(classifyFailure(ambiguousRun)?.retryFromStage).toBe('validate_input');
  });
});
