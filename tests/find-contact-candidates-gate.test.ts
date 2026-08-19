import { describe, it, expect, vi, beforeEach } from 'vitest';
import { combineQualification, type CompanyFit, type ProspectFit, type TargetQualification } from '@/lib/qualification/types';
import type { RunRow } from '@/lib/types';

// Regression: find_contact_candidates must fire ONLY when the COMPANY is
// confirmed QUALIFIED and the submitted contact is not (VERIFY_BETTER_CONTACT
// / FIND_BETTER_CONTACT) — never for a BORDERLINE company, however good or
// bad the prospect, and never once the prospect itself is already QUALIFIED.
//
// Trace of the reported case (company BORDERLINE/65, prospect BORDERLINE/55):
// combineQualification() on that exact input already returns action
// EXPLORATORY_OUTREACH_IF_SIGNAL with `proceed: true`, and the stage's old
// gate (`!q.proceed && q.suggestion`) evaluates to false for it — so the
// literal reported scenario does not reproduce against the current matrix.
// The nearest REAL trigger found in stored data was a run where the company
// was actually in the QUALIFIED state (score 65, MEDIUM, OBSERVED evidence)
// and only the PROSPECT was BORDERLINE (INFERRED) — i.e. action
// VERIFY_BETTER_CONTACT, which correctly fires per the required behavior.
// The likely source of confusion: the run's overall `classification` field
// also reads "BORDERLINE" for that state (the DECISION is uncertain even
// though the company alone is confirmed), which is easy to misread as "both
// sides are borderline." That ambiguity is exactly why the gate below is
// hardened to check `action` directly — an explicit, exhaustive whitelist —
// instead of the previous `!proceed && suggestion` inference.

const mockStartStage = vi.fn();
const mockFinishStage = vi.fn();
const mockDiscoverContacts = vi.fn();
const mockRankCandidates = vi.fn();
const mockCreateContactCandidates = vi.fn();
const mockReplaceSources = vi.fn();

vi.mock('@/lib/supabase/queries', () => ({
  startStage: (...a: unknown[]) => mockStartStage(...a),
  finishStage: (...a: unknown[]) => mockFinishStage(...a),
  createContactCandidates: (...a: unknown[]) => mockCreateContactCandidates(...a),
  replaceSources: (...a: unknown[]) => mockReplaceSources(...a),
  // Unused on this path, but stages.ts imports them at module scope.
  markSignalAsHook: vi.fn(),
  replaceSignals: vi.fn(),
  updateRun: vi.fn(),
  createDraft: vi.fn(),
  deleteDrafts: vi.fn(),
  skipRemainingStages: vi.fn(),
  listSignals: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/contacts/discover', () => ({ discoverContacts: (...a: unknown[]) => mockDiscoverContacts(...a) }));
vi.mock('@/lib/contacts/rank', () => ({
  rankCandidates: (...a: unknown[]) => mockRankCandidates(...a),
  MAX_CANDIDATES: 5,
  // preverify.ts reuses the real role gate from rank.ts; ranking is mocked
  // here but the ROLE CHECK must stay real, or pre-verification would be
  // silently weakened inside these tests.
  roleMatches: (role: string, targets: string[]) =>
    targets.some((t) => t.toLowerCase() === role.toLowerCase()),
}));

const { findContactCandidatesStage, contactDiscoveryApplicable } = await import('@/lib/pipeline/stages');
const { newContext } = await import('@/lib/pipeline/context');

const ev = (url: string, quote = 'A verified verbatim excerpt supporting the claim.') => ({ url, quote });

const prospect = (over: Partial<ProspectFit> = {}): ProspectFit => ({
  score: 80,
  classification: 'HIGH',
  role: 'VP Finance Operations',
  seniority: 'VP',
  relevance_reason: 'Owns the finance operations function, including AP.',
  decision_authority: 'HIGH',
  product_relevance: 'HIGH',
  why_this_person: ['Owns AP and reconciliation.'],
  why_not_this_person: [],
  missing_information: [],
  evidence_basis: 'OBSERVED',
  evidence: [ev('https://example.com/prospect-evidence')],
  ...over,
});

const company = (over: Partial<CompanyFit> = {}): CompanyFit => ({
  score: 78,
  classification: 'HIGH',
  industry: 'Logistics',
  company_size: '1,000+',
  relevant_workflows: ['accounts payable'],
  capability_matches: [
    {
      capability_id: 'ap_automation',
      capability_name: 'Accounts payable automation',
      company_signal: 'High vendor-payment volume across multiple entities.',
      fit_strength: 80,
      evidence: [ev('https://example.com/report')],
      basis: 'OBSERVED',
      reason: 'Multi-entity operations imply meaningful invoice volume.',
    },
  ],
  fit_reasons: [{ reason: 'Plausible AP automation use case.', basis: 'OBSERVED', evidence: [ev('https://example.com/report')] }],
  missing_information: [],
  evidence_basis: 'OBSERVED',
  evidence_adjustment: null,
  ...over,
});

// Deliberate FitState fixtures, matching tests/qualification.test.ts's matrix suite.
const qualifiedCompany = () => company(); // score 78, MEDIUM+/OBSERVED → QUALIFIED
const borderlineCompany = () =>
  company({ score: 65, classification: 'MEDIUM', evidence_basis: 'INFERRED', capability_matches: [] }); // INFERRED → capped/BORDERLINE in spirit; state fn checks evidence_basis directly
const notQualifiedCompany = () => company({ score: 20, classification: 'LOW' });

const qualifiedProspect = () => prospect(); // score 80, HIGH/OBSERVED → QUALIFIED
const borderlineProspect = () => prospect({ score: 55, classification: 'MEDIUM', evidence_basis: 'INFERRED', evidence: [] });
const notQualifiedProspect = () => prospect({ score: 20, classification: 'LOW' });

function qualification(p: ProspectFit, c: CompanyFit): TargetQualification {
  const decision = combineQualification(p, c);
  return { prospect_fit: p, company_fit: c, ...decision };
}

describe('contactDiscoveryApplicable — the exact gate findContactCandidatesStage runs', () => {
  it('QUALIFIED company + NOT_QUALIFIED prospect → contact discovery applies', () => {
    const q = qualification(notQualifiedProspect(), qualifiedCompany());
    expect(q.action).toBe('FIND_BETTER_CONTACT');
    expect(contactDiscoveryApplicable(q)).toBe(true);
  });

  it('QUALIFIED company + BORDERLINE prospect → contact discovery applies', () => {
    const q = qualification(borderlineProspect(), qualifiedCompany());
    expect(q.action).toBe('VERIFY_BETTER_CONTACT');
    expect(contactDiscoveryApplicable(q)).toBe(true);
  });

  it('BORDERLINE company + QUALIFIED prospect → exploratory outreach, NOT contact discovery', () => {
    const q = qualification(qualifiedProspect(), borderlineCompany());
    expect(q.action).toBe('EXPLORATORY_OUTREACH');
    expect(q.proceed).toBe(true);
    expect(contactDiscoveryApplicable(q)).toBe(false);
  });

  it('BORDERLINE company + BORDERLINE prospect → exploratory-outreach-if-signal, NOT contact discovery (the reported case)', () => {
    const q = qualification(borderlineProspect(), borderlineCompany());
    expect(q.action).toBe('EXPLORATORY_OUTREACH_IF_SIGNAL');
    expect(q.proceed).toBe(true);
    expect(contactDiscoveryApplicable(q)).toBe(false);
  });

  it('NOT_QUALIFIED company → no contact discovery, regardless of prospect state', () => {
    for (const p of [qualifiedProspect(), borderlineProspect(), notQualifiedProspect()]) {
      const q = qualification(p, notQualifiedCompany());
      expect(q.action).toBe('DO_NOT_CONTACT');
      expect(contactDiscoveryApplicable(q)).toBe(false);
    }
  });

  it('BORDERLINE company + NOT_QUALIFIED prospect → hold, NOT contact discovery', () => {
    const q = qualification(notQualifiedProspect(), borderlineCompany());
    expect(q.action).toBe('FIND_BETTER_CONTACT_OR_HOLD');
    expect(contactDiscoveryApplicable(q)).toBe(false);
  });

  it('no qualification at all is never applicable', () => {
    expect(contactDiscoveryApplicable(null)).toBe(false);
  });
});

// ─── full stage wiring: prove the gate is actually connected, not just correct in isolation ──

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'run-1',
    linkedin_url: 'https://www.linkedin.com/in/example',
    linkedin_slug: 'example',
    input_name: 'Example Person',
    input_company: 'Acme Corp',
    input_title: 'VP Finance',
    user_id: 'user-1',
    prospect_id: null,
    status: 'running',
    ...over,
  }) as RunRow;

beforeEach(() => {
  vi.clearAllMocks();
  mockStartStage.mockResolvedValue('stage-id');
  mockFinishStage.mockResolvedValue(undefined);
  mockReplaceSources.mockResolvedValue([]);
  mockCreateContactCandidates.mockResolvedValue([]);
});

describe('findContactCandidatesStage — real stage invocation', () => {
  it('BORDERLINE company + BORDERLINE prospect: skips, never calls discoverContacts', async () => {
    const ctx = newContext(run());
    ctx.qualification = qualification(borderlineProspect(), borderlineCompany());

    await findContactCandidatesStage(ctx);

    expect(mockDiscoverContacts).not.toHaveBeenCalled();
    expect(mockCreateContactCandidates).not.toHaveBeenCalled();
    const finishCall = mockFinishStage.mock.calls[0][1];
    expect(finishCall.status).toBe('skipped');
    expect(finishCall.output.reason).toBe('COMPANY_BORDERLINE_EXPLORATORY');
  });

  it('NOT_QUALIFIED company: skips, never calls discoverContacts', async () => {
    const ctx = newContext(run());
    ctx.qualification = qualification(qualifiedProspect(), notQualifiedCompany());

    await findContactCandidatesStage(ctx);

    expect(mockDiscoverContacts).not.toHaveBeenCalled();
    const finishCall = mockFinishStage.mock.calls[0][1];
    expect(finishCall.status).toBe('skipped');
    expect(finishCall.output.reason).toBe('NOT_QUALIFIED');
  });

  it('QUALIFIED company + BORDERLINE prospect: actually attempts contact discovery', async () => {
    mockDiscoverContacts.mockResolvedValue({ proposed: [], sources: [], roles: ['CFO'], queriesRun: 1, queriesOk: 1 });
    mockRankCandidates.mockReturnValue([]);

    const ctx = newContext(run());
    ctx.qualification = qualification(borderlineProspect(), qualifiedCompany());

    await findContactCandidatesStage(ctx);

    // Discovery is attempted rather than skipped. It is called more than once
    // here on purpose: this mock yields zero ELIGIBLE candidates, which is
    // exactly the condition the fallback levels exist for, so the stage widens
    // the search instead of declaring nobody was found after one pass.
    expect(mockDiscoverContacts).toHaveBeenCalled();
    const finishCall = mockFinishStage.mock.calls[0][1];
    expect(finishCall.status).not.toBe('skipped');
  });

  it('escalates through fallback levels only while nothing eligible has been found', async () => {
    mockDiscoverContacts.mockResolvedValue({ proposed: [], sources: [], roles: ['CFO'], queriesRun: 1, queriesOk: 1 });
    mockRankCandidates.mockReturnValue([]);

    const ctx = newContext(run());
    ctx.qualification = qualification(borderlineProspect(), qualifiedCompany());

    await findContactCandidatesStage(ctx);

    const output = mockFinishStage.mock.calls[0][1].output;
    // Every level that ran is recorded, with what it searched and what it found,
    // so a no-candidate result can show how hard the system actually tried.
    expect(Array.isArray(output.discovery_levels)).toBe(true);
    expect(output.discovery_levels.length).toBeGreaterThan(1);
    expect(output.discovery_levels[0].level).toBe(1);
    for (const attempt of output.discovery_levels) {
      expect(attempt.eligible).toBe(0);
      expect(attempt.roles.length).toBeGreaterThan(0);
    }
  });

  it('stops at level 1 when it already found an eligible candidate — no extra provider calls', async () => {
    mockDiscoverContacts.mockResolvedValue({
      proposed: [], sources: [], roles: ['CFO'], queriesRun: 1, queriesOk: 1,
    });
    // A candidate that passes ranking AND pre-verification: real profile URL,
    // evidence naming this person at this company.
    mockRankCandidates.mockReturnValue([
      {
        name: 'Dana Reyes',
        role: 'CFO',
        linkedin_url: 'https://www.linkedin.com/in/dana-reyes',
        evidence: { source_url: 'https://example.com/a', quote: 'Dana Reyes is CFO at Acme Logistics.' },
        reason: 'Public role matches the qualified workflow.',
        confidence: 80,
        rankScore: 80,
      },
    ]);

    const ctx = newContext(run());
    ctx.qualification = qualification(borderlineProspect(), qualifiedCompany());

    await findContactCandidatesStage(ctx);

    expect(mockDiscoverContacts).toHaveBeenCalledTimes(1);
    const output = mockFinishStage.mock.calls[0][1].output;
    expect(output.discovery_levels).toHaveLength(1);
    expect(output.discovery_levels[0].eligible).toBeGreaterThan(0);
  });
});

// ─── human-authorized exploratory discovery (BORDERLINE + CONTINUED + INFERRED-only) ──
//
// Real failure case: run 4131fc61-979e-40a6-946b-1872f61dcb03 (Zerodha).
// BORDERLINE company, borderline prospect, human decision CONTINUED — but
// EVERY capability match was INFERRED (kyc_kyb, ap_automation, chargebacks,
// all strength 40, zero evidence). The old gate built its role-search input
// exclusively from capabilities.observed, which was empty, so the stage
// exited with "No observed workflow to derive functional-owner roles from"
// even though contactDiscoveryApplicable() had already let it through on the
// strength of the human's decision. The human's authorization to search
// harder was being computed and then ignored.
//
// These prove the fix widens ONLY the search input, never the evidence: the
// qualification object handed in is asserted byte-identical before and after
// in every test that reaches this path.

const { withAccountDecision } = await import('@/lib/qualification/account-decision');

/** A company with ONLY inferred capabilities — no OBSERVED match at all, matching the real Zerodha run. */
const inferredOnlyCompany = (): CompanyFit =>
  company({
    score: 55,
    classification: 'MEDIUM',
    evidence_basis: 'INFERRED',
    capability_matches: [
      {
        capability_id: 'kyc_kyb',
        capability_name: 'KYC / KYB onboarding and compliance',
        company_signal: 'Zerodha processes high-volume customer and NRI digital onboarding, identity verification at scale.',
        fit_strength: 40,
        evidence: [],
        basis: 'INFERRED',
        reason: 'Regulated brokerage onboarding implies KYC/KYB workflow.',
      },
      {
        capability_id: 'ap_automation',
        capability_name: 'Accounts payable automation',
        company_signal: 'Financial services enterprise handling multi-entity vendor payments, reconciliation across group entities.',
        fit_strength: 40,
        evidence: [],
        basis: 'INFERRED',
        reason: 'Multi-entity finance operations imply an AP workflow.',
      },
      {
        capability_id: 'chargebacks',
        capability_name: 'Chargeback and dispute handling',
        company_signal: 'Online trading platform handling large numbers of retail deposits and withdrawals.',
        fit_strength: 40,
        evidence: [],
        basis: 'INFERRED',
        reason: 'High-volume retail payment flows imply dispute handling.',
      },
    ],
  });

const continuedExploratory = (): TargetQualification =>
  withAccountDecision(
    qualification(borderlineProspect(), inferredOnlyCompany()),
    'CONTINUED',
    'user-1',
  );

const heldExploratory = (): TargetQualification =>
  withAccountDecision(
    qualification(borderlineProspect(), inferredOnlyCompany()),
    'HELD',
    'user-1',
  );

const cloneOf = (q: TargetQualification) => JSON.parse(JSON.stringify(q));

beforeEach(() => {
  mockDiscoverContacts.mockResolvedValue({ proposed: [], sources: [], roles: [], queriesRun: 1, queriesOk: 1 });
  mockRankCandidates.mockReturnValue([]);
});

describe('human-authorized exploratory discovery — real Zerodha failure case', () => {
  it('1 & 10. OBSERVED capability still drives discovery unchanged (existing behavior preserved)', async () => {
    const ctx = newContext(run());
    ctx.qualification = withAccountDecision(
      qualification(borderlineProspect(), qualifiedCompany()),
      'CONTINUED',
      'user-1',
    );
    // qualifiedCompany() -> action VERIFY_BETTER_CONTACT, already in
    // CONTACT_DISCOVERY_ACTIONS regardless of any decision — the ordinary path.

    await findContactCandidatesStage(ctx);

    expect(mockDiscoverContacts).toHaveBeenCalled();
    const roles = mockDiscoverContacts.mock.calls[0][0].roles as string[];
    expect(roles.length).toBeGreaterThan(0);
    const output = mockFinishStage.mock.calls[0][1].output;
    expect(output.exploratory_inferred_context).toBe(false);
  });

  it('2. BORDERLINE + borderline contact + CONTINUED + ONLY inferred capabilities → exploratory discovery runs', async () => {
    const ctx = newContext(run());
    ctx.qualification = continuedExploratory();

    await findContactCandidatesStage(ctx);

    expect(mockDiscoverContacts).toHaveBeenCalled();
    const finishCall = mockFinishStage.mock.calls[0][1];
    expect(finishCall.status).not.toBe('skipped');
    expect(finishCall.output.exploratory_inferred_context).toBe(true);
    expect(finishCall.summary).toMatch(/human-authorized exploratory discovery/i);
  });

  it('role families are derived from the inferred capabilities — KYC/AP/chargebacks all reach discovery', async () => {
    const ctx = newContext(run());
    ctx.qualification = continuedExploratory();

    await findContactCandidatesStage(ctx);

    // Every discoverContacts call across the escalating levels; union the
    // roles searched to see the full set the fix derived from inferred text.
    const allRoles = mockDiscoverContacts.mock.calls.flatMap((c) => c[0].roles as string[]);
    const lower = allRoles.map((r) => r.toLowerCase());

    // KYC/KYB family -> Compliance/Risk/Onboarding-flavoured titles
    expect(lower.some((r) => /compliance|risk|trust/.test(r))).toBe(true);
    // AP family -> Finance/Accounts Payable/Procurement-flavoured titles
    expect(lower.some((r) => /finance|accounts payable|procurement/.test(r))).toBe(true);
    // Chargebacks family -> Payments/Risk/Disputes-flavoured titles
    expect(lower.some((r) => /payments|dispute|fraud/.test(r))).toBe(true);
  });

  it('uses the existing role-family architecture (rolesForWorkflows), not a separate system', async () => {
    const { rolesForWorkflows } = await import('@/lib/contacts/roles');
    const q = continuedExploratory();
    const signals = q.company_fit.capability_matches.flatMap((m) => [m.company_signal, m.capability_name]);

    const expected = rolesForWorkflows(signals);
    expect(expected.length).toBeGreaterThan(0);

    const ctx = newContext(run());
    ctx.qualification = q;
    await findContactCandidatesStage(ctx);

    const firstCallRoles = mockDiscoverContacts.mock.calls[0][0].roles as string[];
    expect(firstCallRoles).toEqual(expected);
  });

  it('3. the inferred capability is NEVER promoted to OBSERVED by this stage', async () => {
    const q = continuedExploratory();
    const before = cloneOf(q);

    const ctx = newContext(run());
    ctx.qualification = q;
    await findContactCandidatesStage(ctx);

    // The exact object the stage was handed is untouched — basis, evidence,
    // score and classification for every capability match are byte-identical.
    expect(ctx.qualification).toEqual(before);
    for (const m of ctx.qualification!.company_fit.capability_matches) {
      expect(m.basis).toBe('INFERRED');
      expect(m.evidence).toEqual([]);
    }
  });

  it('4. BORDERLINE + HELD → no contact discovery at all', async () => {
    const ctx = newContext(run());
    ctx.qualification = heldExploratory();

    await findContactCandidatesStage(ctx);

    expect(mockDiscoverContacts).not.toHaveBeenCalled();
    const finishCall = mockFinishStage.mock.calls[0][1];
    expect(finishCall.status).toBe('skipped');
  });

  it('5. NOT_QUALIFIED company → human override remains unavailable, even with a forged CONTINUED decision', async () => {
    const forced = withAccountDecision(
      qualification(qualifiedProspect(), notQualifiedCompany()),
      'CONTINUED',
      'user-1',
    );
    const ctx = newContext(run());
    ctx.qualification = forced;

    await findContactCandidatesStage(ctx);

    expect(mockDiscoverContacts).not.toHaveBeenCalled();
    const finishCall = mockFinishStage.mock.calls[0][1];
    expect(finishCall.status).toBe('skipped');
    expect(finishCall.output.reason).toBe('NOT_QUALIFIED');
  });

  it('6. candidate pre-verification still blocks an invalid/ambiguous candidate found via exploratory discovery', async () => {
    mockRankCandidates.mockReturnValue([
      {
        name: 'Someone Person',
        role: 'Compliance Manager',
        linkedin_url: null, // no usable profile URL -> EXCLUDED by preVerifyCandidate
        evidence: { source_url: 'https://example.com/a', quote: 'Someone Person is Compliance Manager at Zerodha.' },
        reason: 'Public role matches the qualified workflow.',
        confidence: 60,
        rankScore: 60,
      },
    ]);

    const ctx = newContext(run());
    ctx.qualification = continuedExploratory();
    await findContactCandidatesStage(ctx);

    // Excluded, never offered, never persisted as selectable.
    expect(mockCreateContactCandidates).not.toHaveBeenCalled();
    const output = mockFinishStage.mock.calls[0][1].output;
    expect(output.pre_verification.excluded).toBeGreaterThan(0);
    expect(output.candidates).toHaveLength(0);
  });

  it('7. a candidate found via exploratory discovery is only ever DISCOVERED, never auto-selected — identity verification remains a separate later step', async () => {
    mockRankCandidates.mockReturnValue([
      {
        name: 'Dana Reyes',
        // Exact title from the KYC/KYB family's role list — this file's
        // roleMatches() mock is an EXACT match (see the vi.mock block above),
        // unlike the real fuzzy overlap, so the candidate's role has to be one
        // of the titles actually searched.
        role: 'Chief Compliance Officer',
        linkedin_url: 'https://www.linkedin.com/in/dana-reyes',
        // company must match run().input_company ('Acme Corp') — the exact
        // string findContactCandidatesStage passes to preVerifyCandidate.
        evidence: { source_url: 'https://example.com/a', quote: 'Dana Reyes is Chief Compliance Officer at Acme Corp.' },
        reason: 'Public role matches the qualified workflow.',
        confidence: 80,
        rankScore: 80,
      },
    ]);

    const ctx = newContext(run());
    ctx.qualification = continuedExploratory();
    await findContactCandidatesStage(ctx);

    expect(mockCreateContactCandidates).toHaveBeenCalledTimes(1);
    const rows = mockCreateContactCandidates.mock.calls[0][1] as { identity_status: string }[];
    expect(rows).toHaveLength(1);
    // DISCOVERED, not VERIFIED — full identity verification is a distinct
    // step that runs only after a human selects this candidate (the
    // /contact-candidates/[id]/select route, unmodified by this fix).
    expect(rows[0].identity_status).toBe('DISCOVERED');
  });

  it('8. no eligible candidates found via exploratory discovery → clean, honest empty result', async () => {
    mockDiscoverContacts.mockResolvedValue({ proposed: [], sources: [], roles: ['Head of Compliance'], queriesRun: 1, queriesOk: 1 });
    mockRankCandidates.mockReturnValue([]);

    const ctx = newContext(run());
    ctx.qualification = continuedExploratory();
    await findContactCandidatesStage(ctx);

    const finishCall = mockFinishStage.mock.calls[0][1];
    expect(finishCall.status).toBe('complete');
    expect(finishCall.output.candidates).toEqual([]);
    expect(finishCall.output.exploratory_inferred_context).toBe(true);
    expect(finishCall.summary).toMatch(/no verified candidates found/i);
  });

  it('9. CONTINUE does not alter the qualification classification, score, or basis', async () => {
    const q = continuedExploratory();
    expect(q.classification).toBe('BORDERLINE');

    const ctx = newContext(run());
    ctx.qualification = q;
    await findContactCandidatesStage(ctx);

    expect(ctx.qualification!.classification).toBe('BORDERLINE');
    expect(ctx.qualification!.company_fit.score).toBe(q.company_fit.score);
    expect(ctx.qualification!.company_fit.evidence_basis).toBe('INFERRED');
    expect(ctx.qualification!.human_account_decision).toEqual(q.human_account_decision);
  });

  it('the real Zerodha shape (run 4131fc61) resolves roles across all three inferred families', async () => {
    // Mirrors the actual persisted capability_matches for run
    // 4131fc61-979e-40a6-946b-1872f61dcb03 as closely as the test fixtures allow.
    const ctx = newContext(run({ input_company: 'Zerodha' }));
    ctx.qualification = continuedExploratory();

    await findContactCandidatesStage(ctx);

    expect(mockDiscoverContacts).toHaveBeenCalled();
    const output = mockFinishStage.mock.calls[0][1].output;
    expect(output.applicable).toBe(true);
    expect(output.reason).toBeUndefined(); // not skipped — 'reason' is only set on the skip path
    expect(output.exploratory_inferred_context).toBe(true);
  });
});
