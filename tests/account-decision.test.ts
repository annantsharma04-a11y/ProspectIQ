import { describe, it, expect } from 'vitest';
import {
  accountDecisionState,
  accountDecisionPending,
  accountDecisionRecord,
  accountHeld,
  continuationPath,
  contactDiscoveryUnlockedByDecision,
  needsAccountDecision,
  outreachAllowedByDecision,
  withAccountDecision,
} from '@/lib/qualification/account-decision';
import {
  combineQualification,
  companyFitState,
  prospectFitState,
  type CompanyFit,
  type EvidenceItem,
  type ProspectFit,
  type QualificationAction,
  type TargetQualification,
} from '@/lib/qualification/types';
import { contactDiscoveryApplicable } from '@/lib/pipeline/stages';
import { buildCommandCenterSummary } from '@/lib/dashboard/command-center';
import type { RunRow } from '@/lib/types';

// A BORDERLINE company is not an evidence problem — more research does not
// resolve it, because the question is commercial, not factual. So the run
// pauses and asks a person: is this account worth pursuing?
//
// The whole risk of a feature like this is that "let me decide" quietly
// becomes "let me through". These tests exist mostly to prove it did not:
// continuing records a judgment about the ACCOUNT and nothing else, and every
// gate that stood before a decision still stands after one.

const ev = (url: string): EvidenceItem => ({ url, quote: 'A verified excerpt.' });

/** OBSERVED evidence and a passing score — a genuinely qualified side. */
const strongProspect = (over: Partial<ProspectFit> = {}): ProspectFit =>
  ({
    score: 80,
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
    evidence: [ev('https://example.com/prospect')],
    ...over,
  }) as ProspectFit;

const strongCompany = (over: Partial<CompanyFit> = {}): CompanyFit =>
  ({
    score: 80,
    classification: 'HIGH',
    industry: 'Logistics',
    company_size: '1,000+',
    relevant_workflows: ['accounts payable'],
    capability_matches: [],
    fit_reasons: [{ reason: 'Runs a large AP operation.', basis: 'OBSERVED', evidence: [ev('https://example.com/co')] }],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence_adjustment: null,
    ...over,
  }) as CompanyFit;

/** Plausible but never directly observed — exactly what BORDERLINE means here. */
const borderlineCompany = () => strongCompany({ score: 55, classification: 'MEDIUM', evidence_basis: 'INFERRED' });
const borderlineProspect = () => strongProspect({ score: 55, classification: 'MEDIUM', evidence_basis: 'INFERRED' });
const unqualifiedCompany = () => strongCompany({ score: 20, classification: 'LOW', evidence_basis: 'UNKNOWN' });
const unqualifiedProspect = () => strongProspect({ score: 20, classification: 'LOW', evidence_basis: 'UNKNOWN' });

/** Build a real TargetQualification through the REAL matrix — never hand-rolled. */
function qualify(prospect: ProspectFit, company: CompanyFit): TargetQualification {
  return { prospect_fit: prospect, company_fit: company, ...combineQualification(prospect, company) };
}

const borderlineWithQualifiedContact = () => qualify(strongProspect(), borderlineCompany());
const borderlineWithBorderlineContact = () => qualify(borderlineProspect(), borderlineCompany());
const fullyQualified = () => qualify(strongProspect(), strongCompany());
const companyNotQualified = () => qualify(strongProspect(), unqualifiedCompany());

const decided = (q: TargetQualification, choice: 'CONTINUED' | 'HELD') =>
  withAccountDecision(q, choice, 'user-1');

// ─── 1-10. qualification / decision ──────────────────────────────────────────

describe('1. BORDERLINE company + QUALIFIED contact requires a human decision', () => {
  it('lands in the matrix cell that pauses', () => {
    const q = borderlineWithQualifiedContact();
    expect(companyFitState(q.company_fit)).toBe('BORDERLINE');
    expect(prospectFitState(q.prospect_fit)).toBe('QUALIFIED');
    expect(q.action).toBe<QualificationAction>('EXPLORATORY_OUTREACH');
  });

  it('reports REQUIRED until a person answers', () => {
    const q = borderlineWithQualifiedContact();
    expect(needsAccountDecision(q)).toBe(true);
    expect(accountDecisionState(q)).toBe('REQUIRED');
    expect(accountDecisionPending(q)).toBe(true);
  });

  it('continuing pursues THIS contact rather than searching for another', () => {
    expect(continuationPath(borderlineWithQualifiedContact())).toBe('OUTREACH');
  });
});

describe('2. BORDERLINE + QUALIFIED + CONTINUE allows the outreach workflow', () => {
  const q = decided(borderlineWithQualifiedContact(), 'CONTINUED');

  it('permits signals, hook and message to run', () => {
    expect(accountDecisionState(q)).toBe('CONTINUED');
    expect(outreachAllowedByDecision(q)).toBe(true);
  });

  it('does not open contact discovery — the contact is already well evidenced', () => {
    expect(contactDiscoveryUnlockedByDecision(q)).toBe(false);
    expect(contactDiscoveryApplicable(q)).toBe(false);
  });
});

describe('3. BORDERLINE + QUALIFIED + HOLD produces no downstream outreach', () => {
  const q = decided(borderlineWithQualifiedContact(), 'HELD');

  it('blocks outreach', () => {
    expect(accountHeld(q)).toBe(true);
    expect(outreachAllowedByDecision(q)).toBe(false);
  });

  it('blocks contact discovery too', () => {
    expect(contactDiscoveryApplicable(q)).toBe(false);
  });
});

describe('4. BORDERLINE company + BORDERLINE contact requires a human decision', () => {
  const q = borderlineWithBorderlineContact();

  it('lands in the second pausing cell', () => {
    expect(companyFitState(q.company_fit)).toBe('BORDERLINE');
    expect(prospectFitState(q.prospect_fit)).toBe('BORDERLINE');
    expect(q.action).toBe<QualificationAction>('EXPLORATORY_OUTREACH_IF_SIGNAL');
    expect(accountDecisionState(q)).toBe('REQUIRED');
  });

  it('continuing means finding a better contact, not pitching this one', () => {
    expect(continuationPath(q)).toBe('FIND_CONTACT');
  });
});

describe('5. BORDERLINE + BORDERLINE + CONTINUE allows contact discovery', () => {
  const q = decided(borderlineWithBorderlineContact(), 'CONTINUED');

  it('opens the existing find_contact_candidates flow', () => {
    expect(contactDiscoveryUnlockedByDecision(q)).toBe(true);
    // The production predicate the stage itself runs — not a reimplementation.
    expect(contactDiscoveryApplicable(q)).toBe(true);
  });

  it('does NOT also generate outreach to the borderline contact', () => {
    // The person asked for a better contact; the message belongs to the run
    // created from whichever candidate they go on to select.
    expect(outreachAllowedByDecision(q)).toBe(false);
  });
});

describe('6. BORDERLINE + BORDERLINE + HOLD blocks contact discovery', () => {
  const q = decided(borderlineWithBorderlineContact(), 'HELD');

  it('runs no discovery and no outreach', () => {
    expect(contactDiscoveryApplicable(q)).toBe(false);
    expect(outreachAllowedByDecision(q)).toBe(false);
  });
});

describe('7. a NOT_QUALIFIED company is never offered a human override', () => {
  const q = companyNotQualified();

  it('is DO_NOT_CONTACT, and asks for no decision', () => {
    expect(q.action).toBe<QualificationAction>('DO_NOT_CONTACT');
    expect(needsAccountDecision(q)).toBe(false);
    expect(accountDecisionState(q)).toBe('NONE');
    expect(continuationPath(q)).toBeNull();
  });

  it('cannot be continued into outreach even if a record is forced onto it', () => {
    // Belt and braces: a hand-forged decision on a below-floor account must
    // still not unlock anything. The floor is not a human's to move.
    const forged = decided(q, 'CONTINUED');
    expect(accountDecisionState(forged)).toBe('NONE');
    expect(contactDiscoveryUnlockedByDecision(forged)).toBe(false);
  });

  it('still reports proceed:false, exactly as before', () => {
    expect(q.proceed).toBe(false);
  });
});

describe('8. a QUALIFIED company behaves exactly as it did before', () => {
  const q = fullyQualified();

  it('asks for no decision and proceeds on the evidence alone', () => {
    expect(q.action).toBe<QualificationAction>('TARGET_DIRECTLY');
    expect(accountDecisionState(q)).toBe('NONE');
    expect(q.proceed).toBe(true);
    expect(outreachAllowedByDecision(q)).toBe(true);
  });

  it('renders no decision affordance for the qualified-company contact cells', () => {
    for (const cell of [
      qualify(borderlineProspect(), strongCompany()),
      qualify(unqualifiedProspect(), strongCompany()),
    ]) {
      expect(needsAccountDecision(cell)).toBe(false);
    }
  });
});

describe('9. continuing does NOT change the qualification', () => {
  const before = borderlineWithQualifiedContact();
  const after = decided(before, 'CONTINUED');

  it('the company is still BORDERLINE', () => {
    expect(companyFitState(after.company_fit)).toBe('BORDERLINE');
    expect(after.classification).toBe('BORDERLINE');
  });

  it('every field the matrix produced is byte-identical', () => {
    const { human_account_decision, ...rest } = after;
    expect(rest).toEqual(before);
    expect(human_account_decision).toBeTruthy();
  });

  it('scores, evidence basis and proceed are untouched', () => {
    expect(after.company_fit.score).toBe(before.company_fit.score);
    expect(after.company_fit.evidence_basis).toBe(before.company_fit.evidence_basis);
    expect(after.proceed).toBe(before.proceed);
    expect(after.action).toBe(before.action);
  });

  it('holding does not change it either', () => {
    const held = decided(before, 'HELD');
    expect(held.classification).toBe('BORDERLINE');
    expect(companyFitState(held.company_fit)).toBe('BORDERLINE');
  });
});

describe('10. HOLD is a terminal human-held state', () => {
  const q = decided(borderlineWithBorderlineContact(), 'HELD');

  it('reports HELD, and nothing downstream is permitted', () => {
    expect(accountDecisionState(q)).toBe('HELD');
    expect(accountHeld(q)).toBe(true);
    expect(accountDecisionPending(q)).toBe(false);
    expect(outreachAllowedByDecision(q)).toBe(false);
    expect(contactDiscoveryApplicable(q)).toBe(false);
  });
});

// ─── 11-13. persistence ──────────────────────────────────────────────────────

describe('11-12. the decision persists with the run', () => {
  it('records the choice, the time and who made it', () => {
    const at = new Date('2026-08-19T10:00:00.000Z');
    const q = withAccountDecision(borderlineWithQualifiedContact(), 'CONTINUED', 'user-42', at);
    const record = accountDecisionRecord(q);

    expect(record).toEqual({
      decision: 'CONTINUED',
      decided_at: '2026-08-19T10:00:00.000Z',
      decided_by: 'user-42',
    });
  });

  it('survives the JSON round-trip the runs.qualification column performs', () => {
    // The decision lives inside an existing jsonb column, so this IS the
    // storage format — a reload, a navigation and reopening the run all read
    // back exactly this.
    const q = decided(borderlineWithBorderlineContact(), 'CONTINUED');
    const reloaded = JSON.parse(JSON.stringify(q)) as TargetQualification;

    expect(accountDecisionState(reloaded)).toBe('CONTINUED');
    expect(continuationPath(reloaded)).toBe('FIND_CONTACT');
    expect(contactDiscoveryApplicable(reloaded)).toBe(true);
    expect(accountDecisionRecord(reloaded)?.decided_by).toBe('user-1');
  });

  it('a run with no decision reads as REQUIRED rather than crashing', () => {
    const bare = JSON.parse(JSON.stringify(borderlineWithQualifiedContact())) as TargetQualification;
    expect(accountDecisionState(bare)).toBe('REQUIRED');
  });

  it('a run predating the feature is unaffected', () => {
    expect(accountDecisionState(null)).toBe('NONE');
    expect(accountDecisionState(undefined)).toBe('NONE');
    expect(outreachAllowedByDecision(null)).toBe(true);
  });
});

describe('13. the Command Center reflects the decision', () => {
  const run = (q: TargetQualification): RunRow =>
    ({
      id: `run-${Math.random()}`,
      status: 'needs_manual_review',
      qualification: q,
      company_name: 'Acme',
      prospect_name: 'Jane Kapoor',
      sender_name: null,
    }) as unknown as RunRow;

  it('REQUIRED reads as "Account decision needed"', () => {
    const s = buildCommandCenterSummary([run(borderlineWithQualifiedContact())], 10);
    expect(s.exploratory[0].label).toBe('Account decision needed');
  });

  it('CONTINUED reads as "Account continued"', () => {
    const s = buildCommandCenterSummary([run(decided(borderlineWithQualifiedContact(), 'CONTINUED'))], 10);
    expect(s.exploratory[0].label).toBe('Account continued');
  });

  it('HELD reads as "Account held"', () => {
    const s = buildCommandCenterSummary([run(decided(borderlineWithQualifiedContact(), 'HELD'))], 10);
    expect(s.exploratory[0].label).toBe('Account held');
  });

  it('a qualified account keeps its ordinary action label', () => {
    const s = buildCommandCenterSummary([run(fullyQualified())], 10);
    expect(s.exploratory).toHaveLength(0);
  });
});

// ─── 14-18. pipeline safety ──────────────────────────────────────────────────

describe('14. nothing downstream may run before the decision', () => {
  const q = borderlineWithQualifiedContact();

  it('outreach is blocked while REQUIRED', () => {
    expect(outreachAllowedByDecision(q)).toBe(false);
  });

  it('contact discovery is blocked while REQUIRED', () => {
    expect(contactDiscoveryApplicable(q)).toBe(false);
    expect(contactDiscoveryApplicable(borderlineWithBorderlineContact())).toBe(false);
  });
});

describe('15. CONTINUE resumes only the correct path', () => {
  it('a well-evidenced contact continues to outreach, not to a contact search', () => {
    const q = decided(borderlineWithQualifiedContact(), 'CONTINUED');
    expect(outreachAllowedByDecision(q)).toBe(true);
    expect(contactDiscoveryApplicable(q)).toBe(false);
  });

  it('a borderline contact continues to a contact search, not to outreach', () => {
    const q = decided(borderlineWithBorderlineContact(), 'CONTINUED');
    expect(contactDiscoveryApplicable(q)).toBe(true);
    expect(outreachAllowedByDecision(q)).toBe(false);
  });
});

describe('16. HOLD dispatches neither discovery nor message generation', () => {
  for (const [label, q] of [
    ['borderline + qualified', borderlineWithQualifiedContact()],
    ['borderline + borderline', borderlineWithBorderlineContact()],
  ] as const) {
    it(`${label}: both paths closed`, () => {
      const held = decided(q, 'HELD');
      expect(outreachAllowedByDecision(held)).toBe(false);
      expect(contactDiscoveryApplicable(held)).toBe(false);
    });
  }
});

describe('17-18. the pipeline shape is unchanged', () => {
  it('still has exactly the 14 permanent stages, in the same order', async () => {
    const { STAGE_ORDER } = await import('@/lib/types');
    expect(STAGE_ORDER).toEqual([
      'validate_input',
      'identify_prospect',
      'resolve_candidate',
      'verify_identity',
      'research_prospect',
      'research_company',
      'qualify_prospect',
      'qualify_company',
      'find_contact_candidates',
      'collect_signals',
      'evaluate_signals',
      'select_hook',
      'generate_message',
      'validate_claims',
      'ready_for_review',
    ]);
  });

  it('adds no stage for the decision — the pause is a gate, not a stage', async () => {
    const { STAGE_ORDER } = await import('@/lib/types');
    expect(STAGE_ORDER.some((s) => s.includes('account') || s.includes('decision'))).toBe(false);
  });

  it('find_contact_candidates remains conditional, not unconditional', () => {
    // Still false for the cells it was always false for.
    expect(contactDiscoveryApplicable(fullyQualified())).toBe(false);
    expect(contactDiscoveryApplicable(companyNotQualified())).toBe(false);
    expect(contactDiscoveryApplicable(null)).toBe(false);
    // Still true for the two cells it was always true for.
    expect(contactDiscoveryApplicable(qualify(borderlineProspect(), strongCompany()))).toBe(true);
    expect(contactDiscoveryApplicable(qualify(unqualifiedProspect(), strongCompany()))).toBe(true);
  });
});

// ─── 19-23. discovery and verification are not weakened ──────────────────────

describe('19-23. continuing does not relax candidate verification', () => {
  it('19. continue on borderline+borderline is what opens discovery — nothing else', () => {
    expect(contactDiscoveryApplicable(borderlineWithBorderlineContact())).toBe(false);
    expect(contactDiscoveryApplicable(decided(borderlineWithBorderlineContact(), 'CONTINUED'))).toBe(true);
  });

  it('20-21. pre-verification decides selectability, and knows nothing about the decision', async () => {
    const { canSelectCandidate } = await import('@/lib/contacts/select-ui');
    // A candidate that is otherwise fully selectable — so each assertion below
    // fails for the ONE reason it names, not incidentally for a missing field.
    const base = {
      id: 'c1',
      name: 'Jane Kapoor',
      role: 'Head of AP',
      company: 'Acme',
      reason: 'Owns AP.',
      linkedin_url: 'https://www.linkedin.com/in/jane-kapoor',
      evidence: [
        { source_url: 'https://example.com/a', quote: 'Jane Kapoor, Head of AP at Acme.' },
      ],
      identity_status: 'DISCOVERED',
    };
    expect(canSelectCandidate(base as never)).toBe(true);

    // Ambiguous — already resolved to a non-selectable state.
    expect(canSelectCandidate({ ...base, identity_status: 'AMBIGUOUS' } as never)).toBe(false);
    // Invalid — no LinkedIn URL for identity verification to work against.
    expect(canSelectCandidate({ ...base, linkedin_url: null } as never)).toBe(false);
    // Unevidenced — nothing ties this person to the company.
    expect(canSelectCandidate({ ...base, evidence: [] } as never)).toBe(false);
  });

  it('22-23. the account decision cannot mark an identity verified', async () => {
    const { decideIdentity } = await import('@/lib/identity/types');
    const verification = decideIdentity({
      selected: null,
      selectionMethod: null,
      profile: { name: null, role: null, company: null, location: null, linkedin_url: null },
      hasProfile: false,
      candidates: [],
      conflicts: [],
      assessedConfidence: 0,
      missingFields: ['company', 'role'],
    });

    // Identity verification takes no account-decision input at all — there is
    // no argument a continued account could travel in on.
    expect(verification.status).toBe('FAILED');
    expect(verification.proceed).toBe(false);
  });
});

// ─── 24-28. evidence and outreach safety ─────────────────────────────────────

describe('24. continuing does not promote INFERRED evidence to OBSERVED', () => {
  it('the company keeps the basis the evidence earned', () => {
    const q = decided(borderlineWithQualifiedContact(), 'CONTINUED');
    expect(q.company_fit.evidence_basis).toBe('INFERRED');
    expect(companyFitState(q.company_fit)).toBe('BORDERLINE');
  });

  it('and the ceiling that produced the borderline score still applies', async () => {
    const { applyEvidenceDiscipline, INFERRED_ONLY_CEILING } = await import('@/lib/qualification/types');
    const inflated = applyEvidenceDiscipline(
      strongCompany({ score: 95, evidence_basis: 'INFERRED', capability_matches: [] }),
    );
    expect(inflated.score).toBeLessThanOrEqual(INFERRED_ONLY_CEILING);
  });
});

describe('25-27. the outreach gates are untouched by a decision', () => {
  it('25. no verified hook still means no message', async () => {
    const { gateHook } = await import('@/lib/ranking/rank');

    // The model proposed nothing usable. The gate must report insufficient
    // evidence and select no hook — and it takes no account-decision argument,
    // so a continued account has no way to influence this at all.
    const selection = gateHook([], {
      index: null,
      reason: 'Nothing verifiable.',
      confidence: 0,
      alternatives: [],
      insufficient: true,
      insufficientReason: 'No verified signal survived.',
    });

    expect(selection.selected_index).toBeNull();
    expect(selection.insufficient_evidence).toBe(true);
  });

  it('26. no approved solution match still invents nothing', async () => {
    const { matchApprovedSolution } = await import('@/lib/solutions/match');
    expect(matchApprovedSolution(decided(borderlineWithQualifiedContact(), 'CONTINUED'))).toBeNull();
  });

  it('27. claim validation is not reachable from the decision module', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('lib/qualification/account-decision.ts', 'utf8'),
    );
    for (const forbidden of ['factcheck', 'validateClaims', 'generateMessage', 'verifyHooks']) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe('28. a decision reaches nothing but its own field', () => {
  it('writes exactly one key, and it is the decision record', () => {
    const before = borderlineWithBorderlineContact();
    const after = decided(before, 'CONTINUED');

    const added = Object.keys(after).filter((k) => !(k in before));
    expect(added).toEqual(['human_account_decision']);
  });

  it('never mutates the qualification it was given', () => {
    const before = borderlineWithQualifiedContact();
    const snapshot = JSON.parse(JSON.stringify(before));
    decided(before, 'HELD');
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot);
  });

  it('the matrix itself never reads a decision', () => {
    // combineQualification's inputs are the two fits and nothing else, so a
    // decision provably cannot influence which cell a run lands in.
    expect(combineQualification.length).toBe(2);
  });
});
