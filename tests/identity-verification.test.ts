import { describe, it, expect } from 'vitest';
import {
  decideIdentity,
  applyUserSelection,
  selectCandidate,
  valuesAgree,
  IDENTITY_CONFIDENCE_FLOOR,
  CANDIDATE_PLAUSIBILITY_FLOOR,
  accountFields,
  type IdentityCandidate,
  type IdentityConflict,
  type IdentityDecisionInput,
} from '@/lib/identity/types';
import { parseLinkedInUrl } from '@/lib/linkedin/url';
import { combineQualification } from '@/lib/qualification/types';

const PROFILE_URL = 'https://www.linkedin.com/in/example-person';

const candidate = (over: Partial<IdentityCandidate> = {}): IdentityCandidate => ({
  id: 'candidate_1',
  name: 'Alex Rivera',
  role: 'Founder & CEO',
  company: 'Northwind Brokerage',
  location: 'Bengaluru',
  headline: 'Founder at Northwind',
  linkedin_url: PROFILE_URL,
  confidence: 90,
  sources: ['https://example.com/leadership'],
  origin: 'public_research',
  ...over,
});

const input = (over: Partial<IdentityDecisionInput> = {}): IdentityDecisionInput => ({
  profile: {
    name: 'Alex Rivera',
    role: 'Founder & CEO',
    company: 'Northwind Brokerage',
    location: 'Bengaluru',
    linkedin_url: PROFILE_URL,
  },
  hasProfile: true,
  candidates: [candidate({ origin: 'profile_provider' })],
  conflicts: [],
  assessedConfidence: 92,
  missingFields: [],
  ...over,
});

describe('1. corroborated identity → VERIFIED', () => {
  it('proceeds when name, role and company agree across sources', () => {
    const v = decideIdentity(input());
    expect(v.status).toBe('VERIFIED');
    expect(v.proceed).toBe(true);
    expect(v.resolution).toBe('AUTOMATIC');
    expect(v.resolved.company).toBe('Northwind Brokerage');
  });
});

describe('2-3. conflicting identity attributes → AMBIGUOUS', () => {
  const conflict = (field: IdentityConflict['field'], profileValue: string, publicValue: string): IdentityConflict => ({
    field,
    profile_value: profileValue,
    public_value: publicValue,
    explanation: 'Sources describe a different current employer for this name.',
    sources: ['https://example.com/other'],
  });

  it('2. name matches but company conflicts → AMBIGUOUS, no qualification', () => {
    const v = decideIdentity(
      input({ conflicts: [conflict('company', 'Almasons', 'Northwind Brokerage')] }),
    );
    expect(v.status).toBe('AMBIGUOUS');
    expect(v.proceed).toBe(false);
    expect(v.reason).toMatch(/company/i);
  });

  it('3. name matches but role conflicts → AMBIGUOUS', () => {
    const v = decideIdentity(
      input({ conflicts: [conflict('role', 'Software Developer', 'Founder & CEO')] }),
    );
    expect(v.status).toBe('AMBIGUOUS');
    expect(v.proceed).toBe(false);
  });

  it('does not treat a location-only difference as material', () => {
    const v = decideIdentity(input({ conflicts: [conflict('location', 'Pune', 'Bengaluru')] }));
    expect(v.status).toBe('VERIFIED');
  });
});

describe('4-5. partial profiles', () => {
  it('4. partial profile corroborated by public research → VERIFIED', () => {
    // The provider gave a name only; research supplied role and company.
    const v = decideIdentity(
      input({
        profile: {
          name: 'Alex Rivera',
          role: 'Founder & CEO',
          company: 'Northwind Brokerage',
          location: null,
          linkedin_url: PROFILE_URL,
        },
        assessedConfidence: 85,
      }),
    );
    expect(v.status).toBe('VERIFIED');
    expect(v.proceed).toBe(true);
  });

  it('5. partial profile with conflicting public identities → selection is required', () => {
    // Ambiguity between people is resolved by selection, before verification.
    const sel = selectCandidate([
      candidate(),
      candidate({ id: 'candidate_2', role: 'Software Developer', company: 'Almasons', confidence: 62 }),
    ]);
    expect(sel.needs_user_choice).toBe(true);
    expect(sel.selected).toBeNull();
  });

  it('missing material fields with no corroboration → PARTIAL, never a guess', () => {
    const v = decideIdentity(
      input({
        profile: { name: 'Alex Rivera', role: null, company: null, location: null, linkedin_url: PROFILE_URL },
        candidates: [candidate({ origin: 'profile_provider' })],
      }),
    );
    expect(v.status).toBe('PARTIAL');
    expect(v.proceed).toBe(false);
    expect(v.reason).toMatch(/could not establish/i);
  });

  it('weak overall confidence → PARTIAL rather than a hopeful VERIFIED', () => {
    const v = decideIdentity(input({ assessedConfidence: IDENTITY_CONFIDENCE_FLOOR - 1 }));
    expect(v.status).toBe('PARTIAL');
    expect(v.proceed).toBe(false);
  });

  it('no profile and no candidates → FAILED', () => {
    const v = decideIdentity(
      input({
        hasProfile: false,
        candidates: [],
        profile: { name: null, role: null, company: null, location: null, linkedin_url: PROFILE_URL },
        assessedConfidence: 0,
      }),
    );
    expect(v.status).toBe('FAILED');
    expect(v.proceed).toBe(false);
  });
});

describe('6-10. manual candidate selection', () => {
  const twoPeople = () =>
    decideIdentity(
      input({
        candidates: [
          candidate({ id: 'candidate_1', role: 'Founder & CEO', company: 'Northwind Brokerage', confidence: 94 }),
          candidate({ id: 'candidate_2', role: 'Software Developer', company: 'Almasons', confidence: 68 }),
        ],
      }),
    );

  it('a single plausible candidate is selected automatically, with no prompt', () => {
    const sel = selectCandidate([
      candidate({ id: 'candidate_1', confidence: 90 }),
      candidate({ id: 'candidate_2', confidence: CANDIDATE_PLAUSIBILITY_FLOOR - 1 }),
    ]);
    expect(sel.needs_user_choice).toBe(false);
    expect(sel.selection_method).toBe('AUTOMATIC');
    expect(sel.selected?.id).toBe('candidate_1');
  });

  it('verification runs on the selected candidate, not the provider guess', () => {
    const chosen = candidate({ id: 'candidate_2', role: 'Software Developer', company: 'Almasons', confidence: 70 });
    const v = decideIdentity(input({ selected: chosen, selectionMethod: 'USER_CONFIRMED', assessedConfidence: 80 }));
    expect(v.resolved.company).toBe('Almasons');
    expect(v.resolution).toBe('USER_CONFIRMED');
    expect(v.selected_candidate_id).toBe('candidate_2');
  });

  it('a selected candidate that still conflicts is not verified', () => {
    const chosen = candidate({ id: 'candidate_1', confidence: 90 });
    const v = decideIdentity(
      input({
        selected: chosen,
        selectionMethod: 'USER_CONFIRMED',
        conflicts: [
          { field: 'company', profile_value: 'Almasons', public_value: 'Northwind Brokerage', explanation: 'x', sources: [] },
        ],
      }),
    );
    expect(v.status).toBe('AMBIGUOUS');
    expect(v.proceed).toBe(false);
  });

  it('6. multiple people with the same name → candidate list, no silent pick', () => {
    const sel = selectCandidate([
      candidate({ id: 'candidate_1', confidence: 94 }),
      candidate({ id: 'candidate_2', role: 'Software Developer', company: 'Almasons', confidence: 68 }),
    ]);
    expect(sel.needs_user_choice).toBe(true);
    expect(sel.selected).toBeNull();
    expect(sel.plausible).toHaveLength(2);
    // Distinguished by role and company, not name alone.
    expect(sel.plausible.map((c) => c.company)).toEqual(['Northwind Brokerage', 'Almasons']);
  });

  it('7. selecting candidate A makes A the identity used downstream', () => {
    const v = applyUserSelection(twoPeople(), 'candidate_1');
    expect(v.status).toBe('VERIFIED');
    expect(v.proceed).toBe(true);
    expect(v.resolved.company).toBe('Northwind Brokerage');
    expect(v.resolved.role).toBe('Founder & CEO');
  });

  it('8. selecting candidate B makes B the identity used downstream', () => {
    const v = applyUserSelection(twoPeople(), 'candidate_2');
    expect(v.status).toBe('VERIFIED');
    expect(v.proceed).toBe(true);
    expect(v.resolved.company).toBe('Almasons');
    expect(v.resolved.role).toBe('Software Developer');
  });

  it('9. selection is recorded as USER_CONFIRMED and preserves the candidate list', () => {
    const before = twoPeople();
    const after = applyUserSelection(before, 'candidate_1');
    expect(after.resolution).toBe('USER_CONFIRMED');
    expect(after.selected_candidate_id).toBe('candidate_1');
    // The automated finding is not overwritten.
    expect(after.candidates).toHaveLength(before.candidates.length);
    expect(after.conflicts).toEqual(before.conflicts);
  });

  it('10. a selected candidate with an unresolved conflict stays AMBIGUOUS', () => {
    const withConflict = decideIdentity(
      input({
        candidates: [
          candidate({ id: 'candidate_1', company: 'Northwind Brokerage', confidence: 90 }),
          candidate({ id: 'candidate_2', company: 'Almasons', role: 'Software Developer', confidence: 70 }),
        ],
        conflicts: [
          {
            field: 'company',
            profile_value: 'Contoso Systems',
            public_value: 'Fabrikam Holdings',
            explanation: 'Two unrelated employers reported for the same name.',
            sources: ['https://example.com/x'],
          },
        ],
      }),
    );

    const v = applyUserSelection(withConflict, 'candidate_1');
    expect(v.status).toBe('AMBIGUOUS');
    expect(v.proceed).toBe(false);
    expect(v.resolution).toBe('USER_CONFIRMED');
    expect(v.reason).toMatch(/unresolved conflict/i);
  });

  it('rejects a selection that is not among the candidates', () => {
    const v = applyUserSelection(twoPeople(), 'candidate_99');
    expect(v.selected_candidate_id).toBeNull();
    expect(v.reason).toMatch(/not among the candidates/i);
  });

  it('a selected candidate missing material fields is PARTIAL, not VERIFIED', () => {
    const v = applyUserSelection(
      decideIdentity(
        input({
          candidates: [
            candidate({ id: 'candidate_1', company: null, role: null, confidence: 80 }),
            candidate({ id: 'candidate_2', confidence: 70 }),
          ],
        }),
      ),
      'candidate_1',
    );
    expect(v.status).toBe('PARTIAL');
    expect(v.proceed).toBe(false);
  });
});

describe('11-14. identity failure is not qualification failure', () => {
  it('14. an unverified identity never reaches qualification', () => {
    const v = decideIdentity(
      input({ conflicts: [{ field: 'company', profile_value: 'A', public_value: 'B', explanation: 'x', sources: [] }] }),
    );
    // The gate the executor checks.
    expect(v.proceed).toBe(false);
    // It explains that qualification did not start — it does not judge fit.
    expect(v.reason).toMatch(/qualification has not started/i);
    expect(v.reason).not.toMatch(/not qualified|poor fit|not relevant|target audience/i);
  });

  it('11-13. a verified identity leaves qualification free to decide independently', () => {
    const v = decideIdentity(input());
    expect(v.proceed).toBe(true);

    // Qualification still makes its own call on the (now correct) person.
    const prospectFit = {
      score: 20,
      classification: 'LOW' as const,
      role: 'Intern',
      seniority: 'Entry level',
      relevance_reason: 'No ownership of the relevant workflows.',
      decision_authority: 'LOW' as const,
      product_relevance: 'LOW' as const,
      why_this_person: [],
      why_not_this_person: [],
      missing_information: [],
    };
    const companyFit = {
      score: 80,
      classification: 'HIGH' as const,
      industry: 'Brokerage',
      company_size: '1000+',
      relevant_workflows: ['kyc'],
      capability_matches: [],
      fit_reasons: [{ reason: 'Observed verification workflows.', basis: 'OBSERVED' as const, evidence: ['https://example.com/a'] }],
      missing_information: [],
      evidence_basis: 'OBSERVED' as const,
      evidence_adjustment: null,
    };

    const decision = combineQualification(prospectFit, companyFit);
    expect(decision.classification).toBe('NOT_QUALIFIED');
    // Distinct concerns: identity was fine, the target was not.
    expect(decision.reason).toMatch(/not appear sufficiently relevant/i);
  });
});

describe('15. existing URL normalization is unaffected', () => {
  it.each([
    'https://www.linkedin.com/in/example-person',
    'https://in.linkedin.com/in/example-person',
    'https://sg.linkedin.com/in/example-person/',
    'linkedin.com/in/example-person?originalSubdomain=in',
  ])('%s resolves to the same profile identity', (url) => {
    const parsed = parseLinkedInUrl(url);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.slug).toBe('example-person');
    expect(parsed.normalized_url).toBe(PROFILE_URL);
  });
});

describe('valuesAgree', () => {
  it('tolerates legal suffixes and ordering', () => {
    expect(valuesAgree('Northwind Brokerage Pvt Ltd', 'Northwind Brokerage')).toBe(true);
    expect(valuesAgree('Zerodha Broking Limited', 'Zerodha Broking')).toBe(true);
  });

  it('treats genuinely different employers as disagreement', () => {
    expect(valuesAgree('Almasons', 'Northwind Brokerage')).toBe(false);
  });

  it('treats an absent value as nothing to disagree about', () => {
    expect(valuesAgree(null, 'Northwind')).toBe(true);
    expect(valuesAgree('Northwind', '')).toBe(true);
  });
});

describe('13-14. downstream must not redefine a settled identity', () => {
  it('a verified identity is what downstream uses, at its verified confidence', () => {
    const verified = decideIdentity(input());
    expect(verified.status).toBe('VERIFIED');

    // Whatever the later analysis thinks it knows about the person, the
    // verified record is the one the run carries.
    const carried = {
      full_name: verified.resolved.name,
      role: verified.resolved.role,
      company: verified.resolved.company,
      confidence: verified.confidence,
    };
    expect(carried.company).toBe('Northwind Brokerage');
    expect(carried.confidence).toBeGreaterThanOrEqual(IDENTITY_CONFIDENCE_FLOOR);
  });

  it('a user-confirmed identity keeps the confirmed employer', () => {
    const v = applyUserSelection(
      decideIdentity(
        input({
          candidates: [
            candidate({ id: 'candidate_1', company: 'Northwind Brokerage', confidence: 94 }),
            candidate({ id: 'candidate_2', company: 'Almasons', role: 'Software Developer', confidence: 68 }),
          ],
        }),
      ),
      'candidate_2',
    );
    expect(v.resolved.company).toBe('Almasons');
    expect(v.resolution).toBe('USER_CONFIRMED');
    // Company discovery later in the run must not silently overwrite this.
    expect(v.selected_candidate_id).toBe('candidate_2');
  });
});

describe('field accounting is honest about what was checked', () => {
  const full = { name: 'Alex Rivera', role: 'Founder & CEO', company: 'Northwind', location: 'Bengaluru' };

  it('never counts an unavailable field as corroborated', () => {
    // The model claims all four; the candidate only has two.
    const fe = accountFields(
      { name: 'Alex Rivera', role: null, company: null, location: 'Bengaluru' },
      ['name', 'role', 'company', 'location'],
      [],
    );
    expect(fe.available).toEqual(['name', 'location']);
    expect(fe.corroborated).toEqual(['name', 'location']);
    expect(fe.unavailable).toEqual(['role', 'company']);
    expect(fe.summary).toMatch(/2 of 2 identity fields available for verification were corroborated/i);
    expect(fe.summary).toMatch(/role and company unavailable/i);
  });

  it('does not count a conflicting field as corroborated', () => {
    const fe = accountFields(full, ['name', 'role', 'company', 'location'], [
      { field: 'company', profile_value: 'A', public_value: 'B', explanation: 'x', sources: [] },
    ]);
    expect(fe.corroborated).not.toContain('company');
    expect(fe.conflicting).toEqual(['company']);
    expect(fe.summary).toMatch(/3 of 4 identity fields/i);
    expect(fe.summary).toMatch(/company conflicting/i);
  });

  it('reports zero corroborated when nothing is supported', () => {
    const fe = accountFields(full, [], []);
    expect(fe.corroborated).toHaveLength(0);
    expect(fe.summary).toMatch(/0 of 4 identity fields/i);
  });

  it('handles a candidate with nothing at all', () => {
    const fe = accountFields(null, ['name'], []);
    expect(fe.available).toHaveLength(0);
    expect(fe.corroborated).toHaveLength(0);
    expect(fe.unavailable).toHaveLength(4);
  });

  it('the count can never exceed the fields that existed', () => {
    const fe = accountFields({ name: 'A', role: null, company: null, location: null }, ['name', 'role', 'company'], []);
    expect(fe.corroborated.length).toBeLessThanOrEqual(fe.available.length);
    expect(fe.available.length).toBe(1);
  });

  it('the display never implies more than the PARTIAL decision supports', () => {
    // The exact misleading case: strong-sounding counts on a thin candidate.
    const candidate = { name: 'Alex Rivera', role: null, company: null, location: 'Bengaluru' };
    const fe = accountFields(candidate, ['name', 'location'], []);
    const decision = decideIdentity(
      input({
        selected: { id: 'c1', headline: null, linkedin_url: null, confidence: 95, sources: [], origin: 'public_research', ...candidate },
        profile: { ...candidate, linkedin_url: PROFILE_URL },
        assessedConfidence: 95,
      }),
    );
    expect(decision.status).toBe('PARTIAL');
    // The summary shows the gap rather than a bare "corroborated" count.
    expect(fe.summary).toMatch(/role and company unavailable/i);
  });
});

describe('the displayed numbers cannot overstate the decision', () => {
  it('counts the sources that supported verification, not the candidate’s own list', () => {
    const fe = accountFields(
      { name: 'A', role: 'R', company: 'C', location: 'L' },
      ['name', 'role'],
      [],
      ['https://example.com/a', 'https://example.com/b', 'https://example.com/a'],
    );
    expect(fe.supporting_sources).toHaveLength(2);
  });

  it('reports zero supporting sources when none backed the check', () => {
    const fe = accountFields({ name: 'A', role: null, company: null, location: null }, ['name'], []);
    expect(fe.supporting_sources).toHaveLength(0);
    expect(fe.corroborated).toEqual(['name']);
  });
});
