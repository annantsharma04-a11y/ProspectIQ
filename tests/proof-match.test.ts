import { describe, it, expect, afterEach } from 'vitest';
import { matchApprovedProof, proofForPrompt } from '@/lib/proof/match';
import { getProofCatalog } from '@/lib/proof/catalog';
import { NO_PROOF_MATCH_MESSAGE, type ApprovedProof } from '@/lib/proof/types';
import { matchApprovedSolution } from '@/lib/solutions/match';
import type { ZampSolution } from '@/lib/solutions/types';
import type { CompanyFit, EvidenceItem, ProspectFit, TargetQualification } from '@/lib/qualification/types';

// Approved customer proof is the most dangerous thing this app can put in an
// email: a factual claim about a named third party, sent to a stranger, in
// writing. So the matcher gets no judgment of its own — it filters and sorts,
// and every ordering rule reads OUR evidence about the prospect's company,
// never a number inside the proof.
//
// The rule these exist to pin down: RELEVANCE BEATS MAGNITUDE. A marketing
// lead gets the campaign proof, not the chargeback proof, however much larger
// the chargeback figure is.

const ev = (url: string): EvidenceItem => ({ url, quote: 'A verified excerpt.' });

const CAMPAIGN_PROOF: ApprovedProof = {
  id: 'proof_campaign',
  customer: 'Northwind Retail',
  workflow: 'campaign setup and marketing operations',
  capability_id: 'campaign_ops',
  approved_statement: 'Northwind Retail cut campaign setup time from three days to four hours.',
  is_public: true,
};

// Deliberately the biggest number in the catalog, and deliberately irrelevant
// to a marketing workflow — the trap the ordering rule has to refuse.
const CHARGEBACK_PROOF: ApprovedProof = {
  id: 'proof_chargeback',
  customer: 'Fenwick Payments',
  workflow: 'chargeback and dispute handling',
  capability_id: 'chargebacks',
  approved_statement: 'Fenwick Payments recovered 96% of disputed transactions automatically.',
  is_public: true,
};

const AP_PROOF: ApprovedProof = {
  id: 'proof_ap',
  customer: 'Calder Foods',
  workflow: 'accounts payable invoice processing',
  capability_id: 'ap_automation',
  approved_statement: 'Calder Foods processes supplier invoices without manual matching.',
  is_public: true,
};

const AP_PROOF_SECONDARY: ApprovedProof = {
  id: 'proof_ap_2',
  customer: 'Halloway Group',
  workflow: 'supplier onboarding',
  capability_id: 'ap_automation',
  approved_statement: 'Halloway Group onboards new suppliers without a manual review queue.',
  is_public: true,
};

const PRIVATE_PROOF: ApprovedProof = {
  id: 'proof_private',
  customer: 'Undisclosed Bank',
  workflow: 'accounts payable invoice processing',
  capability_id: 'ap_automation',
  approved_statement: 'A large bank automated its payables end to end.',
  is_public: false,
};

const CATALOG = [CAMPAIGN_PROOF, CHARGEBACK_PROOF, AP_PROOF, AP_PROOF_SECONDARY, PRIVATE_PROOF];

const solution = (over: Partial<ZampSolution> = {}): ZampSolution => ({
  id: 'ap_suite',
  name: 'AP Automation Suite',
  description: 'Automates payables.',
  supported_workflows: ['accounts payable'],
  target_functions: ['Finance'],
  use_cases: ['High invoice volume'],
  non_use_cases: ['Consumer billing'],
  matches_capability_ids: ['ap_automation'],
  proof_point_ids: ['proof_ap'],
  ...over,
});

const prospectFit = (): ProspectFit =>
  ({
    score: 80, classification: 'HIGH', role: 'VP Finance', seniority: 'VP',
    relevance_reason: 'Owns AP.', decision_authority: 'HIGH', product_relevance: 'HIGH',
    why_this_person: [], why_not_this_person: [], missing_information: [],
    evidence_basis: 'OBSERVED', evidence: [ev('https://example.com/p')],
  }) as ProspectFit;

/** Build a real qualification, then a real solution match — never a hand-made one. */
function qualificationWith(
  matches: { id: string; name: string; signal: string; strength: number; basis: 'OBSERVED' | 'INFERRED' }[],
): TargetQualification {
  const company = {
    score: 80, classification: 'HIGH', industry: 'Retail', company_size: '1,000+',
    relevant_workflows: [], fit_reasons: [], missing_information: [],
    evidence_basis: 'OBSERVED', evidence_adjustment: null,
    capability_matches: matches.map((m) => ({
      capability_id: m.id,
      capability_name: m.name,
      company_signal: m.signal,
      fit_strength: m.strength,
      basis: m.basis,
      reason: 'x',
      // An INFERRED match carries no verified evidence — the same shape
      // applyEvidenceDiscipline() produces.
      evidence: m.basis === 'OBSERVED' ? [ev('https://example.com/c')] : [],
    })),
  } as unknown as CompanyFit;

  return { prospect_fit: prospectFit(), company_fit: company } as unknown as TargetQualification;
}

const AP_OBSERVED = [
  { id: 'ap_automation', name: 'Accounts Payable Automation', signal: 'processes supplier invoices at volume', strength: 90, basis: 'OBSERVED' as const },
];

const matchFor = (q: TargetQualification, catalog: ZampSolution[]) => matchApprovedSolution(q, catalog);

afterEach(() => {
  delete process.env.ZAMP_PROOF_CATALOG;
});

describe('positive — a verified capability returns its approved proof', () => {
  it('returns the proof the solution lists for the verified capability', () => {
    const sol = matchFor(qualificationWith(AP_OBSERVED), [solution()]);
    const proof = matchApprovedProof(sol, CATALOG);

    expect(proof?.proof.id).toBe('proof_ap');
    expect(proof?.proof.customer).toBe('Calder Foods');
    expect(proof?.solution_id).toBe('ap_suite');
  });

  it('carries the verified capability that justified it', () => {
    const proof = matchApprovedProof(matchFor(qualificationWith(AP_OBSERVED), [solution()]), CATALOG);

    expect(proof?.matched_on).toEqual({
      capability_id: 'ap_automation',
      capability_name: 'Accounts Payable Automation',
      company_signal: 'processes supplier invoices at volume',
      fit_strength: 90,
    });
  });

  it('records WHY, assembled from matched data rather than generated', () => {
    const proof = matchApprovedProof(matchFor(qualificationWith(AP_OBSERVED), [solution()]), CATALOG);

    expect(proof?.selection_basis).toBe('WORKFLOW_MATCH');
    expect(proof?.why_this_proof).toContain('Calder Foods');
    expect(proof?.why_this_proof).toContain('accounts payable invoice processing');
  });

  it('the statement is passed through byte-for-byte, never rewritten', () => {
    const proof = matchApprovedProof(matchFor(qualificationWith(AP_OBSERVED), [solution()]), CATALOG);

    expect(proof?.proof.approved_statement).toBe(AP_PROOF.approved_statement);
    expect(proofForPrompt(proof!).approved_statement).toBe(AP_PROOF.approved_statement);
  });

  it('the prompt projection exposes no ingredient a model could recompose', () => {
    const projected = proofForPrompt(matchApprovedProof(matchFor(qualificationWith(AP_OBSERVED), [solution()]), CATALOG)!);

    // No metric, outcome, or is_public field to reassemble a new sentence from.
    expect(Object.keys(projected).sort()).toEqual(['approved_statement', 'customer', 'id', 'workflow']);
  });
});

describe('multiple proofs — relevance beats magnitude', () => {
  it('picks the workflow match over a merely-shared capability', () => {
    // Both proofs are for the verified capability; only one names the workflow.
    const sol = matchFor(qualificationWith(AP_OBSERVED), [
      solution({ proof_point_ids: ['proof_ap_2', 'proof_ap'] }),
    ]);
    const proof = matchApprovedProof(sol, CATALOG);

    // proof_ap_2 is listed FIRST, so order alone would have chosen it.
    expect(proof?.proof.id).toBe('proof_ap');
    expect(proof?.selection_basis).toBe('WORKFLOW_MATCH');
  });

  it('NEVER picks a bigger number from an unrelated workflow', () => {
    // The marketing case from the brief: campaign workflow verified, and a
    // far more impressive chargeback statistic sitting in the same catalog.
    const campaignSolution = solution({
      id: 'campaign_suite',
      matches_capability_ids: ['campaign_ops'],
      proof_point_ids: ['proof_chargeback', 'proof_campaign'],
    });
    const q = qualificationWith([
      { id: 'campaign_ops', name: 'Campaign Operations', signal: 'runs high-frequency marketing campaign setup', strength: 70, basis: 'OBSERVED' },
    ]);

    const proof = matchApprovedProof(matchFor(q, [campaignSolution]), CATALOG);

    expect(proof?.proof.id).toBe('proof_campaign');
    expect(proof?.proof.customer).toBe('Northwind Retail');
    // The 96% statistic never had a route in: its capability was not verified.
    expect(proof?.proof.approved_statement).not.toContain('96%');
  });

  it('prefers the MORE specifically relevant workflow when both overlap', () => {
    // Both proofs share vocabulary with the signal — proof_ap_2 only via the
    // incidental word "supplier", proof_ap via "invoice"/"processing" as well.
    // Listing the weaker one first proves overlap size, not order, decides.
    const q = qualificationWith([
      { id: 'ap_automation', name: 'Accounts Payable Automation', signal: 'supplier invoice processing at volume', strength: 80, basis: 'OBSERVED' },
    ]);
    const sol = solution({ proof_point_ids: ['proof_ap_2', 'proof_ap'] });
    const proof = matchApprovedProof(matchFor(q, [sol]), CATALOG);

    expect(proof?.proof.id).toBe('proof_ap');
    expect(proof?.selection_basis).toBe('WORKFLOW_MATCH');
  });

  it('breaks a same-tier tie on the strength of OUR evidence, not the proof', () => {
    const twoCapabilities = qualificationWith([
      { id: 'ap_automation', name: 'Accounts Payable Automation', signal: 'invoice volume', strength: 40, basis: 'OBSERVED' },
      { id: 'campaign_ops', name: 'Campaign Operations', signal: 'campaign volume', strength: 95, basis: 'OBSERVED' },
    ]);
    const combined = solution({
      matches_capability_ids: ['ap_automation', 'campaign_ops'],
      proof_point_ids: ['proof_ap', 'proof_campaign'],
    });

    const proof = matchApprovedProof(matchFor(twoCapabilities, [combined]), CATALOG);

    // Both are CAPABILITY_MATCH-or-better; the stronger VERIFIED capability wins.
    expect(proof?.matched_on.capability_id).toBe('campaign_ops');
    expect(proof?.matched_on.fit_strength).toBe(95);
  });

  it('falls back to catalog order when tier and strength are equal', () => {
    const q = qualificationWith([
      { id: 'ap_automation', name: 'Payables', signal: 'invoices', strength: 60, basis: 'OBSERVED' },
    ]);
    // Neither proof's workflow overlaps "Payables"/"invoices", so both are
    // CAPABILITY_MATCH at identical strength — order decides.
    const sol = solution({ proof_point_ids: ['proof_ap_2', 'proof_ap'] });
    const proof = matchApprovedProof(matchFor(q, [sol]), CATALOG);

    expect(proof?.selection_basis).toBe('CAPABILITY_MATCH');
    expect(proof?.proof.id).toBe('proof_ap_2');
  });
});

describe('wrong workflow — never selected', () => {
  it('a proof for a capability this company was not verified to have is excluded', () => {
    const sol = solution({ proof_point_ids: ['proof_chargeback'] });
    expect(matchApprovedProof(matchFor(qualificationWith(AP_OBSERVED), [sol]), CATALOG)).toBeNull();
  });

  it('listing an unrelated proof cannot smuggle it in alongside a valid one', () => {
    const sol = solution({ proof_point_ids: ['proof_chargeback', 'proof_ap'] });
    const proof = matchApprovedProof(matchFor(qualificationWith(AP_OBSERVED), [sol]), CATALOG);

    expect(proof?.proof.id).toBe('proof_ap');
  });
});

describe('no proof — returns null, never a substitute', () => {
  it('a solution with no proof ids yields nothing', () => {
    const sol = solution({ proof_point_ids: [] });
    expect(matchApprovedProof(matchFor(qualificationWith(AP_OBSERVED), [sol]), CATALOG)).toBeNull();
  });

  it('a solution predating the field yields nothing', () => {
    const sol = solution();
    delete (sol as { proof_point_ids?: string[] }).proof_point_ids;
    expect(matchApprovedProof(matchFor(qualificationWith(AP_OBSERVED), [sol]), CATALOG)).toBeNull();
  });

  it('an id that is not in the catalog yields nothing', () => {
    const sol = solution({ proof_point_ids: ['proof_does_not_exist'] });
    expect(matchApprovedProof(matchFor(qualificationWith(AP_OBSERVED), [sol]), CATALOG)).toBeNull();
  });

  it('a non-public reference is excluded rather than anonymised', () => {
    const sol = solution({ proof_point_ids: ['proof_private'] });
    expect(matchApprovedProof(matchFor(qualificationWith(AP_OBSERVED), [sol]), CATALOG)).toBeNull();
  });

  it('there is a message for the no-proof case, so nothing has to be invented', () => {
    expect(NO_PROOF_MATCH_MESSAGE).toContain('No approved customer proof');
  });
});

describe('no solution means no proof', () => {
  it('null solution match yields null', () => {
    expect(matchApprovedProof(null, CATALOG)).toBeNull();
    expect(matchApprovedProof(undefined, CATALOG)).toBeNull();
  });

  it('a company with no qualifying solution never reaches a proof', () => {
    const sol = solution({ matches_capability_ids: ['something_else'] });
    const solutionMatch = matchFor(qualificationWith(AP_OBSERVED), [sol]);

    expect(solutionMatch).toBeNull();
    expect(matchApprovedProof(solutionMatch, CATALOG)).toBeNull();
  });
});

describe('inferred capabilities never qualify for proof', () => {
  it('an inferred-only capability produces no solution, and therefore no proof', () => {
    const inferred = qualificationWith([
      { id: 'ap_automation', name: 'Accounts Payable Automation', signal: 'assumed from industry', strength: 90, basis: 'INFERRED' },
    ]);
    const solutionMatch = matchFor(inferred, [solution()]);

    expect(solutionMatch).toBeNull();
    expect(matchApprovedProof(solutionMatch, CATALOG)).toBeNull();
  });

  it('a mixed company gets proof ONLY for the observed capability', () => {
    const mixed = qualificationWith([
      { id: 'ap_automation', name: 'Accounts Payable Automation', signal: 'invoice processing observed', strength: 50, basis: 'OBSERVED' },
      { id: 'chargebacks', name: 'Chargebacks', signal: 'assumed from sector', strength: 99, basis: 'INFERRED' },
    ]);
    const sol = solution({
      matches_capability_ids: ['ap_automation', 'chargebacks'],
      proof_point_ids: ['proof_chargeback', 'proof_ap'],
    });

    const proof = matchApprovedProof(matchFor(mixed, [sol]), CATALOG);

    // The inferred chargeback capability had the higher strength AND the
    // bigger statistic. Neither counts for anything.
    expect(proof?.proof.id).toBe('proof_ap');
    expect(proof?.matched_on.capability_id).toBe('ap_automation');
  });
});

describe('determinism', () => {
  it('the same input always produces the same proof', () => {
    const q = qualificationWith([
      { id: 'ap_automation', name: 'Accounts Payable Automation', signal: 'invoice processing', strength: 80, basis: 'OBSERVED' },
      { id: 'campaign_ops', name: 'Campaign Operations', signal: 'campaign setup', strength: 80, basis: 'OBSERVED' },
    ]);
    const sol = solution({
      matches_capability_ids: ['ap_automation', 'campaign_ops'],
      proof_point_ids: ['proof_ap', 'proof_campaign'],
    });

    const results = Array.from({ length: 20 }, () => matchApprovedProof(matchFor(q, [sol]), CATALOG));
    const ids = new Set(results.map((r) => r?.proof.id));

    expect(ids.size).toBe(1);
    expect(results.every((r) => r?.why_this_proof === results[0]?.why_this_proof)).toBe(true);
  });

  it('does not mutate the catalog it was given', () => {
    const catalog = CATALOG.map((p) => ({ ...p }));
    const snapshot = JSON.stringify(catalog);
    matchApprovedProof(matchFor(qualificationWith(AP_OBSERVED), [solution()]), catalog);

    expect(JSON.stringify(catalog)).toBe(snapshot);
  });
});

describe('the catalog refuses malformed configuration', () => {
  it('falls back to the placeholder rather than inventing a customer', () => {
    process.env.ZAMP_PROOF_CATALOG = 'not json at all';
    expect(getProofCatalog()[0].id).toBe('example_proof');
  });

  it('drops an entry missing any required field', () => {
    process.env.ZAMP_PROOF_CATALOG = JSON.stringify([
      { id: 'good', customer: 'A', workflow: 'w', capability_id: 'c', approved_statement: 's', is_public: true },
      { id: 'no_statement', customer: 'B', workflow: 'w', capability_id: 'c', is_public: true },
      { id: 'blank_customer', customer: '   ', workflow: 'w', capability_id: 'c', approved_statement: 's', is_public: true },
    ]);

    const catalog = getProofCatalog();
    expect(catalog.map((p) => p.id)).toEqual(['good']);
  });

  it('an all-invalid catalog falls back rather than returning nothing usable', () => {
    process.env.ZAMP_PROOF_CATALOG = JSON.stringify([{ id: 'broken' }]);
    expect(getProofCatalog()[0].id).toBe('example_proof');
  });

  it('reads a well-formed catalog through unchanged', () => {
    process.env.ZAMP_PROOF_CATALOG = JSON.stringify([AP_PROOF]);
    expect(getProofCatalog()).toEqual([AP_PROOF]);
  });
});
