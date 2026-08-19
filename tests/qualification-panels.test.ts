import { describe, it, expect } from 'vitest';
import { buildQualificationPanels } from '@/lib/ui/qualification-panels';
import { accountDecisionState } from '@/lib/qualification/account-decision';
import { combineQualification, type CompanyFit, type EvidenceItem, type ProspectFit, type TargetQualification } from '@/lib/qualification/types';

// The Stage 8 UI clarity fix: company fit, contact fit, and the overall
// decision are three distinct axes, but the old panel showed only company
// fit (its own classification/score) next to the overall decision
// (classification/overall_fit) with no label distinguishing which was which
// — read together as one contradictory statement about the company itself.
// lib/ui/qualification-panels.ts (companion to lib/ui/decision-summary.ts)
// adds no new judgment: it only relabels companyFitState/prospectFitState
// and the matrix's own action/reason, so it can never disagree with the
// Decision Summary or Account Decision panels shown elsewhere on the page.
//
// These tests prove the exact reported case (company QUALIFIED, contact
// BORDERLINE, overall BORDERLINE, action VERIFY_BETTER_CONTACT) is now
// distinguishable, and that the three other matrix shapes the task called
// out are unaffected — including that the REAL, untouched
// accountDecisionState() still gates the Account Decision panel exactly as
// before.

const ev = (url: string): EvidenceItem => ({ url, quote: 'A verified excerpt.' });

const prospectFit = (over: Partial<ProspectFit> = {}): ProspectFit =>
  ({
    score: 80,
    classification: 'HIGH',
    role: 'VP Finance',
    seniority: 'VP',
    relevance_reason: 'Owns the qualified workflow.',
    decision_authority: 'HIGH',
    product_relevance: 'HIGH',
    why_this_person: [],
    why_not_this_person: [],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence: [ev('https://example.com/prospect')],
    ...over,
  }) as ProspectFit;

const companyFit = (over: Partial<CompanyFit> = {}): CompanyFit =>
  ({
    score: 80,
    classification: 'HIGH',
    industry: 'E-commerce',
    company_size: '1,000+',
    relevant_workflows: ['accounts payable'],
    capability_matches: [],
    fit_reasons: [{ reason: 'Plausible use case.', basis: 'OBSERVED', evidence: [ev('https://example.com/company')] }],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence_adjustment: null,
    ...over,
  }) as CompanyFit;

function qualification(p: ProspectFit, c: CompanyFit): TargetQualification {
  const decision = combineQualification(p, c);
  return { prospect_fit: p, company_fit: c, ...decision };
}

describe('1. QUALIFIED company + BORDERLINE contact — the real Dushyant Gaur / AJIO shape', () => {
  // company_fit 60/MEDIUM/OBSERVED, prospect_fit 45/MEDIUM/INFERRED — the
  // exact persisted values from the audited run.
  const q = qualification(
    prospectFit({ score: 45, classification: 'MEDIUM', evidence_basis: 'INFERRED' }),
    companyFit({ score: 60, classification: 'MEDIUM', evidence_basis: 'OBSERVED' }),
  );

  it('company is clearly shown as QUALIFIED', () => {
    const panels = buildQualificationPanels(q);
    expect(panels.company.state).toBe('QUALIFIED');
    expect(panels.company.score).toBe(60);
    expect(panels.company.evidenceBasis).toBe('OBSERVED');
  });

  it('contact is clearly shown as BORDERLINE, distinct from the company', () => {
    const panels = buildQualificationPanels(q);
    expect(panels.contact.state).toBe('BORDERLINE');
    expect(panels.contact.score).toBe(45);
    expect(panels.contact.evidenceBasis).toBe('INFERRED');
    // The two axes must never collapse to the same state just because they
    // are shown side by side.
    expect(panels.contact.state).not.toBe(panels.company.state);
  });

  it('overall is clearly shown as BORDERLINE, using the weaker (contact) score', () => {
    const panels = buildQualificationPanels(q);
    expect(panels.overall.classification).toBe('BORDERLINE');
    expect(panels.overall.score).toBe(45);
  });

  it('the action clearly says to find/verify a better contact', () => {
    const panels = buildQualificationPanels(q);
    expect(panels.overall.action).toBe('VERIFY_BETTER_CONTACT');
  });

  it('no Account Decision is needed — flagged explicitly, and the real gate agrees', () => {
    const panels = buildQualificationPanels(q);
    expect(panels.noAccountDecisionNeeded).toBe(true);
    // The actual, untouched gate that controls whether the Account Decision
    // panel renders at all agrees: nothing is required here.
    expect(accountDecisionState(q)).toBe('NONE');
  });
});

describe('2. BORDERLINE company + QUALIFIED contact', () => {
  const q = qualification(
    prospectFit({ score: 80, classification: 'HIGH', evidence_basis: 'OBSERVED' }),
    companyFit({ score: 55, classification: 'MEDIUM', evidence_basis: 'INFERRED' }),
  );

  it('company is clearly shown as BORDERLINE', () => {
    const panels = buildQualificationPanels(q);
    expect(panels.company.state).toBe('BORDERLINE');
  });

  it('Account Decision Required remains visible — the real gate is untouched', () => {
    const panels = buildQualificationPanels(q);
    // This is NOT the "no decision needed" case — the company itself is borderline.
    expect(panels.noAccountDecisionNeeded).toBe(false);
    expect(accountDecisionState(q)).toBe('REQUIRED');
  });
});

describe('3. BORDERLINE company + BORDERLINE contact', () => {
  const q = qualification(
    prospectFit({ score: 55, classification: 'MEDIUM', evidence_basis: 'INFERRED' }),
    companyFit({ score: 55, classification: 'MEDIUM', evidence_basis: 'INFERRED' }),
  );

  it('company, contact and overall states remain three distinct, correctly-labeled reads', () => {
    const panels = buildQualificationPanels(q);
    expect(panels.company.state).toBe('BORDERLINE');
    expect(panels.contact.state).toBe('BORDERLINE');
    expect(panels.overall.classification).toBe('BORDERLINE');
    // Same label in this particular case, but each came from its own
    // independent computation (companyFitState vs prospectFitState vs the
    // matrix's own classification) — not one value copied into three slots.
    expect(panels.company.score).toBe(55);
    expect(panels.contact.score).toBe(55);
  });

  it('the Continue/Hold decision remains required — this IS the borderline-company case', () => {
    const panels = buildQualificationPanels(q);
    expect(panels.noAccountDecisionNeeded).toBe(false);
    expect(accountDecisionState(q)).toBe('REQUIRED');
  });
});

describe('4. NOT_QUALIFIED company — existing behavior unchanged', () => {
  const q = qualification(
    prospectFit({ score: 80, classification: 'HIGH', evidence_basis: 'OBSERVED' }),
    companyFit({ score: 15, classification: 'LOW' }),
  );

  it('company is clearly shown as NOT_QUALIFIED, action is DO_NOT_CONTACT', () => {
    const panels = buildQualificationPanels(q);
    expect(panels.company.state).toBe('NOT_QUALIFIED');
    expect(panels.overall.action).toBe('DO_NOT_CONTACT');
  });

  it('no Account Decision note or panel — nothing to decide on a disqualified company', () => {
    const panels = buildQualificationPanels(q);
    expect(panels.noAccountDecisionNeeded).toBe(false); // not the "qualified company, borderline overall" case
    expect(accountDecisionState(q)).toBe('NONE'); // and the real gate never asks either
  });
});

describe('regression: buildQualificationPanels never disagrees with the matrix it reads', () => {
  it('QUALIFIED company + QUALIFIED contact: overall QUALIFIED, target directly, no decision note', () => {
    const q = qualification(prospectFit(), companyFit());
    const panels = buildQualificationPanels(q);
    expect(panels.company.state).toBe('QUALIFIED');
    expect(panels.contact.state).toBe('QUALIFIED');
    expect(panels.overall.classification).toBe('QUALIFIED');
    expect(panels.overall.action).toBe('TARGET_DIRECTLY');
    expect(panels.noAccountDecisionNeeded).toBe(false);
  });

  it('QUALIFIED company + NOT_QUALIFIED contact: FIND_BETTER_CONTACT, no decision note', () => {
    const q = qualification(
      prospectFit({ score: 20, classification: 'LOW' }),
      companyFit({ score: 60, classification: 'MEDIUM', evidence_basis: 'OBSERVED' }),
    );
    const panels = buildQualificationPanels(q);
    expect(panels.company.state).toBe('QUALIFIED');
    expect(panels.contact.state).toBe('NOT_QUALIFIED');
    expect(panels.overall.action).toBe('FIND_BETTER_CONTACT');
    expect(panels.noAccountDecisionNeeded).toBe(false);
    expect(accountDecisionState(q)).toBe('NONE');
  });
});
