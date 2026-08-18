import { describe, it, expect } from 'vitest';
import { matchApprovedSolution, solutionForPrompt } from '@/lib/solutions/match';
import { NO_SOLUTION_MATCH_MESSAGE, type ZampSolution } from '@/lib/solutions/types';
import type { CapabilityMatch, CompanyFit, EvidenceItem, ProspectFit, TargetQualification } from '@/lib/qualification/types';

// Solution matching must be pure code: same inputs, same solution, every
// time — this file exists to prove the LLM is never in that loop.

const ev = (url: string): EvidenceItem => ({ url, quote: 'A verified verbatim excerpt.' });

const capability = (over: Partial<CapabilityMatch> = {}): CapabilityMatch => ({
  capability_id: 'ap_automation',
  capability_name: 'Accounts payable automation',
  company_signal: 'High vendor-payment volume across multiple entities.',
  fit_strength: 80,
  evidence: [ev('https://example.com/report')],
  basis: 'OBSERVED',
  reason: 'Multi-entity operations imply meaningful invoice volume.',
  ...over,
});

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

const companyFit = (matches: CapabilityMatch[]): CompanyFit =>
  ({
    score: 80,
    classification: 'HIGH',
    industry: 'Logistics',
    company_size: '1,000+',
    relevant_workflows: ['accounts payable'],
    capability_matches: matches,
    fit_reasons: [],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence_adjustment: null,
  }) as CompanyFit;

const qualification = (matches: CapabilityMatch[]): TargetQualification =>
  ({
    prospect_fit: prospectFit(),
    company_fit: companyFit(matches),
    overall_fit: 80,
    classification: 'QUALIFIED',
    reason: 'Strong evidenced fit.',
    proceed: true,
    suggestion: null,
    action: 'TARGET_DIRECTLY',
  }) as TargetQualification;

const AP_SOLUTION: ZampSolution = {
  id: 'ap_suite',
  name: 'AP Automation Suite',
  description: 'Automates invoice capture, matching and vendor payments.',
  supported_workflows: ['accounts payable'],
  target_functions: ['Finance', 'Accounts Payable'],
  use_cases: ['High-volume multi-entity invoice processing.'],
  non_use_cases: ['Consumer payments.', 'Payroll.'],
  matches_capability_ids: ['ap_automation'],
};

const KYC_SOLUTION: ZampSolution = {
  id: 'kyc_suite',
  name: 'KYC Verification Suite',
  description: 'Automates identity and business verification.',
  supported_workflows: ['kyc'],
  target_functions: ['Compliance', 'Risk'],
  use_cases: ['Onboarding verification at scale.'],
  non_use_cases: ['Accounts payable.'],
  matches_capability_ids: ['kyc_verification'],
};

const CATALOG = [AP_SOLUTION, KYC_SOLUTION];

describe('matchApprovedSolution — deterministic, code-only matching', () => {
  it('matches a verified OBSERVED capability to the solution that declares it', () => {
    const q = qualification([capability()]);
    const match = matchApprovedSolution(q, CATALOG);

    expect(match).not.toBeNull();
    expect(match!.solution.id).toBe('ap_suite');
    expect(match!.matched_capabilities).toHaveLength(1);
    expect(match!.matched_capabilities[0].capability_id).toBe('ap_automation');
  });

  it('returns null when no capability is OBSERVED', () => {
    const q = qualification([capability({ basis: 'INFERRED' })]);
    expect(matchApprovedSolution(q, CATALOG)).toBeNull();
  });

  it('returns null when an OBSERVED capability has no surviving evidence', () => {
    // Mirrors applyEvidenceDiscipline: an "OBSERVED" claim with nothing
    // verified is not trustworthy enough to recommend a product from.
    const q = qualification([capability({ basis: 'OBSERVED', evidence: [] })]);
    expect(matchApprovedSolution(q, CATALOG)).toBeNull();
  });

  it('returns null when the verified capability has no solution in the catalog', () => {
    const q = qualification([capability({ capability_id: 'something_unlisted' })]);
    expect(matchApprovedSolution(q, CATALOG)).toBeNull();
  });

  it('returns null when qualification itself is null', () => {
    expect(matchApprovedSolution(null, CATALOG)).toBeNull();
  });

  it('picks the solution with the strongest evidenced fit when multiple capabilities are observed', () => {
    const q = qualification([
      capability({ capability_id: 'ap_automation', fit_strength: 40 }),
      capability({
        capability_id: 'kyc_verification',
        capability_name: 'KYC verification',
        company_signal: 'Regulated onboarding flow observed.',
        fit_strength: 90,
      }),
    ]);
    const match = matchApprovedSolution(q, CATALOG);
    expect(match!.solution.id).toBe('kyc_suite');
  });

  it('never invents a solution outside the catalog, however strong the signal', () => {
    const q = qualification([capability({ capability_id: 'ap_automation', fit_strength: 100 })]);
    const match = matchApprovedSolution(q, []); // empty catalog
    expect(match).toBeNull();
  });

  it('is deterministic: identical input always produces identical output', () => {
    const q = qualification([capability()]);
    const first = matchApprovedSolution(q, CATALOG);
    const second = matchApprovedSolution(q, CATALOG);
    expect(first).toEqual(second);
  });

  it('why_it_fits cites the actual verified company signal, not invented text', () => {
    const q = qualification([capability({ company_signal: 'Three-entity AP consolidation observed in Q2.' })]);
    const match = matchApprovedSolution(q, CATALOG);
    expect(match!.why_it_fits).toContain('Three-entity AP consolidation observed in Q2.');
    expect(match!.why_it_fits).toContain('AP Automation Suite');
  });
});

describe('NO_SOLUTION_MATCH_MESSAGE', () => {
  it('is the fixed sentence the product spec requires', () => {
    expect(NO_SOLUTION_MATCH_MESSAGE).toBe('No specific solution match established.');
  });
});

describe('solutionForPrompt — the prompt-safe projection', () => {
  it('carries name, description, boundaries and matched capability names only', () => {
    const q = qualification([capability()]);
    const match = matchApprovedSolution(q, CATALOG)!;
    const projected = solutionForPrompt(match);

    expect(projected).toEqual({
      id: 'ap_suite',
      name: 'AP Automation Suite',
      description: 'Automates invoice capture, matching and vendor payments.',
      target_functions: ['Finance', 'Accounts Payable'],
      use_cases: ['High-volume multi-entity invoice processing.'],
      non_use_cases: ['Consumer payments.', 'Payroll.'],
      matched_on: ['Accounts payable automation'],
    });
  });

  it('includes non_use_cases so the model is told what NOT to claim', () => {
    const q = qualification([capability({ capability_id: 'kyc_verification' })]);
    // Re-map this capability onto the KYC solution for this assertion.
    const catalogWithApOnKyc: ZampSolution[] = [
      { ...AP_SOLUTION, matches_capability_ids: ['kyc_verification'] },
    ];
    const match = matchApprovedSolution(q, catalogWithApOnKyc)!;
    expect(solutionForPrompt(match).non_use_cases).toEqual(['Consumer payments.', 'Payroll.']);
  });
});
