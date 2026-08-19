import { describe, it, expect } from 'vitest';
import { matchApprovedProof } from '@/lib/proof/match';
import type { ApprovedProof } from '@/lib/proof/types';
import { matchApprovedSolution } from '@/lib/solutions/match';
import type { ZampSolution } from '@/lib/solutions/types';
import type { CompanyFit, EvidenceItem, ProspectFit, TargetQualification } from '@/lib/qualification/types';

// Wiring proof for the THREE capability/solution pairs this deployment
// actually has configured:
//
//   ap_automation → zamp_ap_automation
//   chargebacks   → zamp_chargebacks
//   kyc_kyb       → zamp_kyc_kyb
//
// ─────────────────────────────────────────────────────────────────────────
// THE STATEMENTS BELOW ARE TEST FIXTURES, NOT CUSTOMER EVIDENCE.
//
// No approved proof statements have been supplied for these three
// capabilities. Rather than invent customer results to fill the gap, these
// use obviously-synthetic placeholders: the customers are named "Fixture
// Customer", and every statement says so in its own text. They exercise the
// ID wiring and the selection rules — nothing here asserts that any real
// customer achieved any real outcome, and none of it ships in a catalog.
//
// When real approved statements arrive, they replace the placeholder strings
// here and go into ZAMP_PROOF_CATALOG; the assertions do not change.
// ─────────────────────────────────────────────────────────────────────────

const AP_PROOF: ApprovedProof = {
  id: 'proof_ap_invoice_processing',
  customer: 'Fixture Customer A',
  workflow: 'invoice processing and payables matching',
  capability_id: 'ap_automation',
  approved_statement: 'FIXTURE STATEMENT (not a real customer result) — invoice processing proof.',
  is_public: true,
};

const CHARGEBACK_PROOF: ApprovedProof = {
  id: 'proof_chargeback_evidence',
  customer: 'Fixture Customer B',
  workflow: 'chargeback case evidence assembly',
  capability_id: 'chargebacks',
  approved_statement: 'FIXTURE STATEMENT (not a real customer result) — chargeback evidence proof.',
  is_public: true,
};

const KYC_PROOF: ApprovedProof = {
  id: 'proof_kyc_verification_review',
  customer: 'Fixture Customer C',
  workflow: 'customer and business verification checks',
  capability_id: 'kyc_kyb',
  approved_statement: 'FIXTURE STATEMENT (not a real customer result) — KYC/KYB verification proof.',
  is_public: true,
};

const PROOF_CATALOG = [AP_PROOF, CHARGEBACK_PROOF, KYC_PROOF];

/** Mirrors the three entries configured in ZAMP_SOLUTION_CATALOG, plus proof ids. */
const SOLUTIONS: ZampSolution[] = [
  {
    id: 'zamp_ap_automation',
    name: 'Accounts payable automation',
    description: 'Agents that process invoices, match and reconcile payables, and execute AP workflows end to end.',
    supported_workflows: ['Invoice processing', 'Payables matching and reconciliation', 'End-to-end AP workflow execution'],
    target_functions: ['Finance', 'Accounts Payable'],
    use_cases: ['Meaningful invoice or vendor-payment volume'],
    non_use_cases: ['Consumer billing'],
    matches_capability_ids: ['ap_automation'],
    proof_point_ids: ['proof_ap_invoice_processing'],
  },
  {
    id: 'zamp_chargebacks',
    name: 'Chargeback and dispute handling',
    description: 'Agents that assemble evidence and work chargeback and payment-dispute cases through to resolution.',
    supported_workflows: ['Chargeback case evidence assembly', 'Payment dispute resolution workflows'],
    target_functions: ['Payments', 'Disputes'],
    use_cases: ['Card or online payments at consumer scale'],
    non_use_cases: ['B2B invoicing'],
    matches_capability_ids: ['chargebacks'],
    proof_point_ids: ['proof_chargeback_evidence'],
  },
  {
    id: 'zamp_kyc_kyb',
    name: 'KYC / KYB onboarding and compliance',
    description: 'Agents that run customer and business verification checks and the review workflows around them.',
    supported_workflows: ['Customer and business verification checks', 'Verification review workflows'],
    target_functions: ['Compliance', 'Onboarding'],
    use_cases: ['Onboarding under regulatory obligation'],
    non_use_cases: ['Unregulated consumer signup'],
    matches_capability_ids: ['kyc_kyb'],
    proof_point_ids: ['proof_kyc_verification_review'],
  },
];

const ev = (url: string): EvidenceItem => ({ url, quote: 'A verified excerpt.' });

const prospectFit = (): ProspectFit =>
  ({
    score: 80, classification: 'HIGH', role: 'CFO', seniority: 'C-level',
    relevance_reason: 'Owns finance.', decision_authority: 'HIGH', product_relevance: 'HIGH',
    why_this_person: [], why_not_this_person: [], missing_information: [],
    evidence_basis: 'OBSERVED', evidence: [ev('https://example.com/p')],
  }) as ProspectFit;

function qualification(
  matches: { id: string; name: string; signal: string; strength: number; basis: 'OBSERVED' | 'INFERRED' }[],
): TargetQualification {
  const company = {
    score: 80, classification: 'HIGH', industry: 'Commerce', company_size: '1,000+',
    relevant_workflows: [], fit_reasons: [], missing_information: [],
    evidence_basis: 'OBSERVED', evidence_adjustment: null,
    capability_matches: matches.map((m) => ({
      capability_id: m.id, capability_name: m.name, company_signal: m.signal,
      fit_strength: m.strength, basis: m.basis, reason: 'x',
      evidence: m.basis === 'OBSERVED' ? [ev('https://example.com/c')] : [],
    })),
  } as unknown as CompanyFit;
  return { prospect_fit: prospectFit(), company_fit: company } as unknown as TargetQualification;
}

/** The full production chain: verified capability → solution → proof. */
function chain(
  matches: Parameters<typeof qualification>[0],
  proofCatalog = PROOF_CATALOG,
  solutions = SOLUTIONS,
) {
  const solution = matchApprovedSolution(qualification(matches), solutions);
  return { solution, proof: matchApprovedProof(solution, proofCatalog) };
}

const OBSERVED = (id: string, name: string, signal: string, strength = 80) =>
  [{ id, name, signal, strength, basis: 'OBSERVED' as const }];

describe('ap_automation → zamp_ap_automation → AP proof', () => {
  const { solution, proof } = chain(
    OBSERVED('ap_automation', 'Accounts payable automation', 'processes supplier invoices at volume'),
  );

  it('selects the AP solution', () => {
    expect(solution?.solution.id).toBe('zamp_ap_automation');
  });

  it('selects the AP proof, and only the AP proof', () => {
    expect(proof?.proof.id).toBe('proof_ap_invoice_processing');
    expect(proof?.solution_id).toBe('zamp_ap_automation');
    expect(proof?.matched_on.capability_id).toBe('ap_automation');
  });

  it('preserves the approved statement exactly', () => {
    expect(proof?.proof.approved_statement).toBe(AP_PROOF.approved_statement);
  });
});

describe('chargebacks → zamp_chargebacks → chargeback proof', () => {
  const { solution, proof } = chain(
    OBSERVED('chargebacks', 'Chargeback and dispute handling', 'high volume of consumer payment disputes'),
  );

  it('selects the chargeback solution and its own proof', () => {
    expect(solution?.solution.id).toBe('zamp_chargebacks');
    expect(proof?.proof.id).toBe('proof_chargeback_evidence');
    expect(proof?.matched_on.capability_id).toBe('chargebacks');
  });

  it('preserves the approved statement exactly', () => {
    expect(proof?.proof.approved_statement).toBe(CHARGEBACK_PROOF.approved_statement);
  });
});

describe('kyc_kyb → zamp_kyc_kyb → KYC/KYB proof', () => {
  const { solution, proof } = chain(
    OBSERVED('kyc_kyb', 'KYC / KYB onboarding and compliance', 'onboards merchants under regulatory checks'),
  );

  it('selects the KYC solution and its own proof', () => {
    expect(solution?.solution.id).toBe('zamp_kyc_kyb');
    expect(proof?.proof.id).toBe('proof_kyc_verification_review');
    expect(proof?.matched_on.capability_id).toBe('kyc_kyb');
  });

  it('preserves the approved statement exactly', () => {
    expect(proof?.proof.approved_statement).toBe(KYC_PROOF.approved_statement);
  });
});

describe('a proof never crosses to an unrelated capability', () => {
  it('an AP company never receives the chargeback or KYC proof', () => {
    const { proof } = chain(OBSERVED('ap_automation', 'Accounts payable automation', 'invoice volume'));
    expect(proof?.proof.id).not.toBe('proof_chargeback_evidence');
    expect(proof?.proof.id).not.toBe('proof_kyc_verification_review');
  });

  it('a solution listing a foreign proof id still selects nothing', () => {
    // zamp_ap_automation misconfigured to point at the KYC proof: the
    // capability filter rejects it rather than sending the wrong evidence.
    const misconfigured = SOLUTIONS.map((s) =>
      s.id === 'zamp_ap_automation' ? { ...s, proof_point_ids: ['proof_kyc_verification_review'] } : s,
    );
    const { solution, proof } = chain(
      OBSERVED('ap_automation', 'Accounts payable automation', 'invoice volume'),
      PROOF_CATALOG,
      misconfigured,
    );

    expect(solution?.solution.id).toBe('zamp_ap_automation');
    expect(proof).toBeNull();
  });
});

describe('the safety rules hold for the configured three', () => {
  it('an inferred-only capability selects no solution and no proof', () => {
    const solution = matchApprovedSolution(
      qualification([{ id: 'ap_automation', name: 'AP', signal: 'assumed from sector', strength: 99, basis: 'INFERRED' }]),
      SOLUTIONS,
    );
    expect(solution).toBeNull();
    expect(matchApprovedProof(solution, PROOF_CATALOG)).toBeNull();
  });

  it('a solution with no proof_point_ids returns null rather than a substitute', () => {
    const stripped = SOLUTIONS.map((s) => ({ ...s, proof_point_ids: [] }));
    const { solution, proof } = chain(
      OBSERVED('ap_automation', 'Accounts payable automation', 'invoice volume'),
      PROOF_CATALOG,
      stripped,
    );
    expect(solution).not.toBeNull();
    expect(proof).toBeNull();
  });

  it('an empty proof catalog returns null rather than a substitute', () => {
    const { proof } = chain(OBSERVED('ap_automation', 'AP', 'invoice volume'), []);
    expect(proof).toBeNull();
  });

  it('a bigger statistic on an unverified capability never wins', () => {
    // chargebacks INFERRED at 99 vs ap_automation OBSERVED at 40.
    const { solution, proof } = chain([
      { id: 'ap_automation', name: 'Accounts payable automation', signal: 'invoice processing observed', strength: 40, basis: 'OBSERVED' },
      { id: 'chargebacks', name: 'Chargeback and dispute handling', signal: 'assumed from sector', strength: 99, basis: 'INFERRED' },
    ]);

    expect(solution?.solution.id).toBe('zamp_ap_automation');
    expect(proof?.proof.id).toBe('proof_ap_invoice_processing');
  });

  it('selection is deterministic across repeated calls', () => {
    const ids = new Set(
      Array.from({ length: 20 }, () =>
        chain(OBSERVED('kyc_kyb', 'KYC / KYB onboarding and compliance', 'merchant verification'))
          .proof?.proof.id,
      ),
    );
    expect(ids.size).toBe(1);
  });
});

describe('existing solution matching is unaffected by proof configuration', () => {
  it('adding proof_point_ids changes no solution decision', () => {
    const withoutProofIds = SOLUTIONS.map((s) => {
      const copy = { ...s };
      delete copy.proof_point_ids;
      return copy;
    });

    for (const capability of ['ap_automation', 'chargebacks', 'kyc_kyb']) {
      const before = matchApprovedSolution(qualification(OBSERVED(capability, capability, 'signal')), withoutProofIds);
      const after = matchApprovedSolution(qualification(OBSERVED(capability, capability, 'signal')), SOLUTIONS);

      expect(after?.solution.id).toBe(before?.solution.id);
      expect(after?.why_it_fits).toBe(before?.why_it_fits);
      expect(after?.matched_capabilities).toEqual(before?.matched_capabilities);
    }
  });
});
