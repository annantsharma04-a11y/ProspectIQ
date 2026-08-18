import { describe, it, expect } from 'vitest';
import { buildDecisionSummary } from '@/lib/ui/decision-summary';
import type { CompanyFit, EvidenceItem, ProspectFit, QualificationAction, TargetQualification } from '@/lib/qualification/types';
import type { RunRow } from '@/lib/types';

// The Decision Summary is a thin, evidence-preserving relabeling of what
// combineQualification() (lib/qualification/types.ts) already decided — these
// tests exist to prove it never disagrees with that source of truth, for
// every one of the seven matrix cells collapsed onto the five product actions.

const ev = (url: string): EvidenceItem => ({ url, quote: 'A verified excerpt.' });

const prospectFit = (over: Partial<ProspectFit> = {}): ProspectFit =>
  ({
    score: 80,
    classification: 'HIGH',
    role: 'VP Finance',
    seniority: 'VP',
    relevance_reason: 'Owns AP.',
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
    industry: 'Logistics',
    company_size: '1,000+',
    relevant_workflows: ['accounts payable'],
    capability_matches: [],
    fit_reasons: [],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence_adjustment: null,
    ...over,
  }) as CompanyFit;

const qualification = (
  action: QualificationAction,
  prospect: ProspectFit,
  company: CompanyFit,
  reason = 'Evidence-based reason text.',
): TargetQualification =>
  ({
    prospect_fit: prospect,
    company_fit: company,
    overall_fit: Math.min(prospect.score, company.score),
    classification: 'QUALIFIED',
    reason,
    proceed: true,
    suggestion: null,
    action,
  }) as TargetQualification;

const QUALIFIED_PROSPECT = prospectFit();
const BORDERLINE_PROSPECT = prospectFit({ score: 50, classification: 'MEDIUM', evidence_basis: 'INFERRED' });
const NOT_QUALIFIED_PROSPECT = prospectFit({ score: 10, classification: 'LOW' });

const QUALIFIED_COMPANY = companyFit();
const BORDERLINE_COMPANY = companyFit({ score: 50, classification: 'MEDIUM', evidence_basis: 'INFERRED' });
const NOT_QUALIFIED_COMPANY = companyFit({ score: 10, classification: 'LOW' });

const run = (q: TargetQualification | null): Pick<RunRow, 'qualification'> => ({ qualification: q });

describe('buildDecisionSummary', () => {
  it('returns null before qualification has run', () => {
    expect(buildDecisionSummary(run(null))).toBeNull();
  });

  it('TARGET_DIRECTLY → account QUALIFIED, contact QUALIFIED, "TARGET DIRECTLY"', () => {
    const q = qualification('TARGET_DIRECTLY', QUALIFIED_PROSPECT, QUALIFIED_COMPANY, 'Strong evidenced fit on both sides.');
    const s = buildDecisionSummary(run(q))!;
    expect(s.accountStatus).toBe('QUALIFIED');
    expect(s.contactStatus).toBe('QUALIFIED');
    expect(s.action).toBe('TARGET DIRECTLY');
    expect(s.reason).toBe('Strong evidenced fit on both sides.');
  });

  it('VERIFY_BETTER_CONTACT → account QUALIFIED, contact BORDERLINE, "VERIFY BETTER CONTACT"', () => {
    const q = qualification('VERIFY_BETTER_CONTACT', BORDERLINE_PROSPECT, QUALIFIED_COMPANY);
    const s = buildDecisionSummary(run(q))!;
    expect(s.accountStatus).toBe('QUALIFIED');
    expect(s.contactStatus).toBe('BORDERLINE');
    expect(s.action).toBe('VERIFY BETTER CONTACT');
  });

  it('FIND_BETTER_CONTACT → account QUALIFIED, contact NOT_QUALIFIED, "FIND BETTER CONTACT"', () => {
    const q = qualification('FIND_BETTER_CONTACT', NOT_QUALIFIED_PROSPECT, QUALIFIED_COMPANY);
    const s = buildDecisionSummary(run(q))!;
    expect(s.accountStatus).toBe('QUALIFIED');
    expect(s.contactStatus).toBe('NOT_QUALIFIED');
    expect(s.action).toBe('FIND BETTER CONTACT');
  });

  it('FIND_BETTER_CONTACT_OR_HOLD collapses onto the same "FIND BETTER CONTACT" action', () => {
    const q = qualification('FIND_BETTER_CONTACT_OR_HOLD', NOT_QUALIFIED_PROSPECT, BORDERLINE_COMPANY);
    const s = buildDecisionSummary(run(q))!;
    expect(s.action).toBe('FIND BETTER CONTACT');
  });

  it('EXPLORATORY_OUTREACH → account BORDERLINE, contact QUALIFIED, "EXPLORATORY OUTREACH"', () => {
    const q = qualification('EXPLORATORY_OUTREACH', QUALIFIED_PROSPECT, BORDERLINE_COMPANY);
    const s = buildDecisionSummary(run(q))!;
    expect(s.accountStatus).toBe('BORDERLINE');
    expect(s.contactStatus).toBe('QUALIFIED');
    expect(s.action).toBe('EXPLORATORY OUTREACH');
  });

  it('EXPLORATORY_OUTREACH_IF_SIGNAL collapses onto the same "EXPLORATORY OUTREACH" action', () => {
    const q = qualification('EXPLORATORY_OUTREACH_IF_SIGNAL', BORDERLINE_PROSPECT, BORDERLINE_COMPANY);
    const s = buildDecisionSummary(run(q))!;
    expect(s.action).toBe('EXPLORATORY OUTREACH');
  });

  it('DO_NOT_CONTACT → account NOT_QUALIFIED, "DO NOT CONTACT", regardless of contact state', () => {
    const q = qualification('DO_NOT_CONTACT', QUALIFIED_PROSPECT, NOT_QUALIFIED_COMPANY, 'No meaningful use case found.');
    const s = buildDecisionSummary(run(q))!;
    expect(s.accountStatus).toBe('NOT_QUALIFIED');
    expect(s.action).toBe('DO NOT CONTACT');
    expect(s.reason).toBe('No meaningful use case found.');
  });

  it('never invents a reason — always the exact string from qualification', () => {
    const q = qualification('TARGET_DIRECTLY', QUALIFIED_PROSPECT, QUALIFIED_COMPANY, 'Exact evidence sentence.');
    expect(buildDecisionSummary(run(q))!.reason).toBe('Exact evidence sentence.');
  });
});
