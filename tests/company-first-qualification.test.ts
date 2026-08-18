import { describe, it, expect } from 'vitest';
import {
  combineQualification,
  companyFitState,
  personRelevance,
  prospectFitState,
  PROSPECT_FIT_FLOOR,
  type CompanyFit,
  type EvidenceItem,
  type ProspectFit,
} from '@/lib/qualification/types';
import { matchApprovedSolution } from '@/lib/solutions/match';
import type { ZampSolution } from '@/lib/solutions/types';

// The company is the HARD ANCHOR; the person is the SOFTER signal.
//
// These lock in two things that must never drift:
//   1. Company fit is decided by company evidence alone. A role — however
//      relevant-sounding — can never qualify a company, and the approved
//      solution catalog is downstream of evidence, never a substitute for it.
//   2. A genuinely qualified account is not discarded because the submitted
//      person's title is imperfect; it routes to finding a better contact,
//      and the ACCOUNT still reads as qualified.

const ev = (url: string): EvidenceItem => ({ url, quote: 'A verified verbatim excerpt.' });

/** Strong, OBSERVED, evidenced AP workflow — the account anchor. */
const observedApCompany = (over: Partial<CompanyFit> = {}): CompanyFit =>
  ({
    score: 84,
    classification: 'HIGH',
    industry: 'Logistics',
    company_size: '1,000+',
    relevant_workflows: ['accounts payable'],
    capability_matches: [
      {
        capability_id: 'ap_automation',
        capability_name: 'Accounts payable automation',
        company_signal: 'Multi-entity vendor invoicing consolidation observed.',
        fit_strength: 88,
        evidence: [ev('https://example.com/ap')],
        basis: 'OBSERVED',
        reason: 'Observed invoice volume across entities.',
      },
    ],
    fit_reasons: [{ reason: 'Verified vendor-invoicing consolidation.', basis: 'OBSERVED', evidence: [ev('https://example.com/ap')] }],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence_adjustment: null,
    ...over,
  }) as CompanyFit;

/** No approved capability was ever observed — nothing for an account to qualify on. */
const noCapabilityCompany = (): CompanyFit =>
  observedApCompany({
    score: 20,
    classification: 'LOW',
    capability_matches: [],
    fit_reasons: [{ reason: 'No observable finance operations at scale.', basis: 'OBSERVED', evidence: [] }],
    evidence_basis: 'UNKNOWN',
  });

const person = (over: Partial<ProspectFit> = {}): ProspectFit =>
  ({
    score: 82,
    classification: 'HIGH',
    role: 'VP Finance',
    seniority: 'VP',
    relevance_reason: 'Owns accounts payable.',
    decision_authority: 'HIGH',
    product_relevance: 'HIGH',
    why_this_person: [],
    why_not_this_person: [],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence: [ev('https://example.com/person')],
    ...over,
  }) as ProspectFit;

// Four person shapes, one per relevance tier.
const STRONG = person();
const REASONABLE = person({ role: 'Financial Analyst', evidence_basis: 'INFERRED', evidence: [], classification: 'MEDIUM', score: 60 });
const WEAK = person({ role: 'Procurement Analyst', score: PROSPECT_FIT_FLOOR - 5, classification: 'MEDIUM', evidence_basis: 'INFERRED', evidence: [] });
const UNRELATED = person({ role: 'Marketing Manager', score: 15, classification: 'LOW', evidence_basis: 'INFERRED', evidence: [] });

// ─── person relevance is a refinement, never a replacement ──────────────────

describe('personRelevance — four tiers over the same fields', () => {
  it('grades each tier', () => {
    expect(personRelevance(STRONG)).toBe('STRONG');
    expect(personRelevance(REASONABLE)).toBe('REASONABLE');
    expect(personRelevance(WEAK)).toBe('WEAK');
    expect(personRelevance(UNRELATED)).toBe('UNRELATED');
  });

  it('stays consistent with prospectFitState — STRONG≡QUALIFIED, REASONABLE≡BORDERLINE', () => {
    expect(prospectFitState(STRONG)).toBe('QUALIFIED');
    expect(prospectFitState(REASONABLE)).toBe('BORDERLINE');
    // WEAK and UNRELATED are the split of the single NOT_QUALIFIED bucket.
    expect(prospectFitState(WEAK)).toBe('NOT_QUALIFIED');
    expect(prospectFitState(UNRELATED)).toBe('NOT_QUALIFIED');
  });

  it('distinguishes "wrong title at a good account" from "wrong function entirely"', () => {
    // The whole point: these used to be indistinguishable.
    expect(personRelevance(WEAK)).not.toBe(personRelevance(UNRELATED));
  });
});

// ─── the account survives an imperfect contact ──────────────────────────────

describe('a qualified account is never discarded over the submitted person', () => {
  for (const [label, p] of [
    ['STRONG', STRONG],
    ['REASONABLE', REASONABLE],
    ['WEAK', WEAK],
    ['UNRELATED', UNRELATED],
  ] as const) {
    it(`observed AP company + ${label} person → the ACCOUNT still reads QUALIFIED`, () => {
      const company = observedApCompany();
      // The account state is computed from company evidence alone and is
      // completely untouched by whoever was submitted.
      expect(companyFitState(company)).toBe('QUALIFIED');

      const decision = combineQualification(p, company);
      // ...and the action routes to a contact fix, never to rejecting the account.
      if (label === 'STRONG') {
        expect(decision.action).toBe('TARGET_DIRECTLY');
      } else if (label === 'REASONABLE') {
        expect(decision.action).toBe('VERIFY_BETTER_CONTACT');
      } else {
        expect(decision.action).toBe('FIND_BETTER_CONTACT');
      }
    });
  }

  it('Example 1 — strong AP evidence + Financial Analyst: company stays qualified', () => {
    const company = observedApCompany();
    expect(companyFitState(company)).toBe('QUALIFIED');
    expect(personRelevance(REASONABLE)).toBe('REASONABLE');
  });

  it('Example 3 — strong AP evidence + Marketing Manager: company qualified, contact unrelated, better contact sought', () => {
    const company = observedApCompany();
    const decision = combineQualification(UNRELATED, company);

    expect(companyFitState(company)).toBe('QUALIFIED');
    expect(personRelevance(UNRELATED)).toBe('UNRELATED');
    expect(decision.action).toBe('FIND_BETTER_CONTACT');
    expect(decision.suggestion).toMatch(/functional owner|decision-maker/i);
  });
});

// ─── the central safety rule ────────────────────────────────────────────────

describe('a relevant person cannot manufacture a relevant company', () => {
  it('Example 6 — Procurement Analyst at a company with NO observed capability → not qualified', () => {
    const company = noCapabilityCompany();
    const procurementAnalyst = person({ role: 'Procurement Analyst' });

    expect(companyFitState(company)).toBe('NOT_QUALIFIED');
    const decision = combineQualification(procurementAnalyst, company);
    expect(decision.action).toBe('DO_NOT_CONTACT');
    expect(decision.proceed).toBe(false);
  });

  it('even a STRONG, fully-evidenced person cannot lift a company with no capability', () => {
    const decision = combineQualification(STRONG, noCapabilityCompany());
    expect(decision.classification).toBe('NOT_QUALIFIED');
    expect(decision.proceed).toBe(false);
  });

  it('company state is computed from company evidence only — the person is not an input', () => {
    const company = observedApCompany();
    // Identical company, four different people → one identical account verdict.
    const states = [STRONG, REASONABLE, WEAK, UNRELATED].map(() => companyFitState(company));
    expect(new Set(states).size).toBe(1);
    expect(states[0]).toBe('QUALIFIED');
  });
});

// ─── the catalog is downstream of evidence, never a substitute ──────────────

const AP_SOLUTION: ZampSolution = {
  id: 'zamp_ap_automation',
  name: 'Accounts payable automation',
  description: 'Processes invoices and reconciles payables end to end.',
  supported_workflows: ['Invoice processing'],
  target_functions: ['Finance', 'Accounts Payable'],
  use_cases: ['High invoice volume'],
  non_use_cases: [],
  matches_capability_ids: ['ap_automation'],
};

describe('the catalog cannot qualify a company or create evidence', () => {
  it('a role in target_functions does NOT produce a solution match on its own', () => {
    // No observed capability anywhere — only a person whose title happens to
    // appear in the solution's target_functions.
    const qualification = {
      prospect_fit: person({ role: 'Finance' }),
      company_fit: noCapabilityCompany(),
    } as never;

    expect(matchApprovedSolution(qualification, [AP_SOLUTION])).toBeNull();
  });

  it('an INFERRED capability produces no solution match, however plausible', () => {
    const inferred = observedApCompany({
      capability_matches: [
        {
          capability_id: 'ap_automation',
          capability_name: 'Accounts payable automation',
          company_signal: 'Plausible from industry context.',
          fit_strength: 80,
          evidence: [],
          basis: 'INFERRED',
          reason: 'Inferred from sector.',
        },
      ],
    });

    expect(matchApprovedSolution({ company_fit: inferred } as never, [AP_SOLUTION])).toBeNull();
  });

  it('an OBSERVED capability with no surviving evidence produces no match', () => {
    const unevidenced = observedApCompany({
      capability_matches: [
        {
          capability_id: 'ap_automation',
          capability_name: 'Accounts payable automation',
          company_signal: 'Claimed observed but nothing verified.',
          fit_strength: 90,
          evidence: [],
          basis: 'OBSERVED',
          reason: 'Unverified.',
        },
      ],
    });

    expect(matchApprovedSolution({ company_fit: unevidenced } as never, [AP_SOLUTION])).toBeNull();
  });

  it('only an OBSERVED, evidenced capability yields the approved solution', () => {
    const match = matchApprovedSolution({ company_fit: observedApCompany() } as never, [AP_SOLUTION]);
    expect(match?.solution.id).toBe('zamp_ap_automation');
  });

  it('an empty catalog yields no match even with perfect evidence', () => {
    expect(matchApprovedSolution({ company_fit: observedApCompany() } as never, [])).toBeNull();
  });
});
