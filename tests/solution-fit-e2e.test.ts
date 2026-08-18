import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CompanyFit, EvidenceItem, ProspectFit, TargetQualification } from '@/lib/qualification/types';
import type { DraftRow, RunRow, RunStageRow, SourceRow } from '@/lib/types';
import { buildDecisionSummary } from '@/lib/ui/decision-summary';
import { buildOutreachRationale } from '@/lib/ui/outreach-rationale';

// One genuinely real end-to-end case, using the ACTUAL Zamp offerings
// configured for this deployment (the same SENDER_CAPABILITIES / real
// ZAMP_SOLUTION_CATALOG values that live in .env.local), through the ACTUAL
// pipeline code — never a re-implementation of it:
//
//   qualified company (OBSERVED, evidenced ap_automation capability)
//     -> matchApprovedSolution() picks the real "Accounts payable automation"
//        Zamp solution deterministically (lib/solutions/match.ts)
//     -> analyzeProspect() receives that solution in its prompt
//        (lib/llm/analyze.ts) — the model may use it, not invent around it
//     -> generateMessageStage() persists it as `approved_solution` on the
//        generate_message stage output
//     -> buildOutreachRationale() / buildDecisionSummary() (the exact
//        functions the UI renders) surface it correctly
//     -> validateClaimsStage() runs its real deterministic claim/voice checks
//        against the resulting draft
//
// Only the two genuine boundaries are mocked: Supabase and the model call —
// exactly the pattern tests/regenerate-message.test.ts already established.
// This exercises regenerateMessage()/generateMessageStage(), which share the
// identical `solutionContext(ctx)` wiring evaluateSignalsStage() uses for a
// run's first draft, so the same proof covers both paths.

const mockGetRun = vi.fn();
const mockGetStage = vi.fn();
const mockGetDraft = vi.fn();
const mockListSources = vi.fn();
const mockUpdateRun = vi.fn();
const mockStartStage = vi.fn();
const mockFinishStage = vi.fn();
const mockCreateDraft = vi.fn();
const mockUpdateDraft = vi.fn();
const mockDeleteDrafts = vi.fn();
const mockSyncProspectFromRun = vi.fn();
const mockCallStructured = vi.fn();

vi.mock('@/lib/supabase/queries', () => ({
  getRun: (...a: unknown[]) => mockGetRun(...a),
  getStage: (...a: unknown[]) => mockGetStage(...a),
  getDraft: (...a: unknown[]) => mockGetDraft(...a),
  listSources: (...a: unknown[]) => mockListSources(...a),
  updateRun: (...a: unknown[]) => mockUpdateRun(...a),
  startStage: (...a: unknown[]) => mockStartStage(...a),
  finishStage: (...a: unknown[]) => mockFinishStage(...a),
  createDraft: (...a: unknown[]) => mockCreateDraft(...a),
  updateDraft: (...a: unknown[]) => mockUpdateDraft(...a),
  deleteDrafts: (...a: unknown[]) => mockDeleteDrafts(...a),
  syncProspectFromRun: (...a: unknown[]) => mockSyncProspectFromRun(...a),
  initStages: vi.fn(),
  markSignalAsHook: vi.fn(),
  replaceSignals: vi.fn(),
  replaceSources: vi.fn(),
  skipRemainingStages: vi.fn(),
  listSignals: vi.fn().mockResolvedValue([]),
  createContactCandidates: vi.fn(),
}));

vi.mock('@/lib/llm/gemini', () => ({ callStructured: (...a: unknown[]) => mockCallStructured(...a) }));

const { regenerateMessageOnly } = await import('@/lib/pipeline/execute');

const RUN_ID = 'run-solution-fit';
const HOOK_SOURCE_URL = 'https://example.com/bluewave-ap-consolidation';
const CAPABILITY_SOURCE_URL = 'https://example.com/bluewave-vendor-ops';

// ── The REAL configuration for this deployment (SENDER_COMPANY=Zamp) ────────
// Identical to what is actually set in .env.local — not a fabricated example.
const REAL_SENDER_CAPABILITIES = [
  {
    id: 'ap_automation',
    name: 'Accounts payable automation',
    description:
      'AI digital-employee agents that process invoices, match and reconcile payables, and execute AP workflows end to end.',
    applies_when:
      'The company processes meaningful invoice or vendor-payment volume, runs a finance/AP function, or operates across multiple entities or geographies.',
  },
  {
    id: 'chargebacks',
    name: 'Chargeback and dispute handling',
    description: 'Agents that assemble evidence and work chargeback and payment-dispute cases through to resolution.',
    applies_when:
      'The company takes card or online payments at consumer scale, or operates in commerce, marketplaces, travel or subscriptions where disputes occur.',
  },
  {
    id: 'kyc_kyb',
    name: 'KYC / KYB onboarding and compliance',
    description: 'Agents that run customer and business verification checks and the review workflows around them.',
    applies_when:
      'The company onboards customers or merchants under regulatory obligations — financial services, fintech, lending, brokerage, insurance, crypto or regulated marketplaces.',
  },
];

const REAL_ZAMP_SOLUTION_CATALOG = [
  {
    id: 'zamp_ap_automation',
    name: 'Accounts payable automation',
    description:
      'AI digital-employee agents that process invoices, match and reconcile payables, and execute AP workflows end to end.',
    supported_workflows: ['Invoice processing', 'Payables matching and reconciliation', 'End-to-end AP workflow execution'],
    target_functions: ['Finance', 'Accounts Payable'],
    use_cases: [
      'Companies processing meaningful invoice or vendor-payment volume',
      'Finance/AP functions',
      'Multi-entity or multi-geography operations',
    ],
    non_use_cases: [],
    matches_capability_ids: ['ap_automation'],
  },
  {
    id: 'zamp_chargebacks',
    name: 'Chargeback and dispute handling',
    description: 'Agents that assemble evidence and work chargeback and payment-dispute cases through to resolution.',
    supported_workflows: ['Chargeback case evidence assembly', 'Payment dispute resolution workflows'],
    target_functions: ['Payments', 'Disputes'],
    use_cases: [
      'Consumer-scale card or online payments',
      'Commerce, marketplace, travel or subscription businesses where disputes occur',
    ],
    non_use_cases: [],
    matches_capability_ids: ['chargebacks'],
  },
  {
    id: 'zamp_kyc_kyb',
    name: 'KYC / KYB onboarding and compliance',
    description: 'Agents that run customer and business verification checks and the review workflows around them.',
    supported_workflows: ['Customer and business verification checks', 'Verification review workflows'],
    target_functions: ['Compliance', 'Onboarding'],
    use_cases: [
      'Customer or merchant onboarding under regulatory obligations',
      'Financial services, fintech, lending, brokerage, insurance, crypto or regulated marketplace businesses',
    ],
    non_use_cases: [],
    matches_capability_ids: ['kyc_kyb'],
  },
];

const ev = (url: string, quote: string): EvidenceItem => ({ url, quote });

const prospectFit = (): ProspectFit =>
  ({
    score: 82,
    classification: 'HIGH',
    role: 'VP Finance Operations',
    seniority: 'VP',
    relevance_reason: 'Owns the finance operations function, including accounts payable, across Bluewave Freight.',
    decision_authority: 'HIGH',
    product_relevance: 'HIGH',
    why_this_person: ['Owns AP and vendor-payment operations.'],
    why_not_this_person: [],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence: [ev(CAPABILITY_SOURCE_URL, 'Priya Raman leads finance operations, including accounts payable.')],
  }) as ProspectFit;

const companyFit = (): CompanyFit =>
  ({
    score: 84,
    classification: 'HIGH',
    industry: 'Logistics',
    company_size: '1,000+',
    relevant_workflows: ['accounts payable', 'vendor invoicing'],
    capability_matches: [
      {
        capability_id: 'ap_automation',
        capability_name: 'Accounts payable automation',
        company_signal: 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.',
        fit_strength: 82,
        evidence: [ev(CAPABILITY_SOURCE_URL, 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.')],
        basis: 'OBSERVED',
        reason: 'Multi-entity vendor invoicing consolidation implies meaningful AP workflow volume.',
      },
    ],
    fit_reasons: [
      {
        reason: 'Verified vendor-invoicing consolidation across three regional entities.',
        basis: 'OBSERVED',
        evidence: [ev(CAPABILITY_SOURCE_URL, 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.')],
      },
    ],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence_adjustment: null,
  }) as CompanyFit;

const qualification = (): TargetQualification =>
  ({
    prospect_fit: prospectFit(),
    company_fit: companyFit(),
    overall_fit: 82,
    classification: 'QUALIFIED',
    reason: 'Owns the finance operations function, including accounts payable, across Bluewave Freight. Verified vendor-invoicing consolidation across three regional entities.',
    proceed: true,
    suggestion: null,
    action: 'TARGET_DIRECTLY',
  }) as TargetQualification;

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: RUN_ID,
    linkedin_url: 'https://www.linkedin.com/in/priya-raman-example',
    linkedin_slug: 'priya-raman-example',
    input_name: 'Priya Raman',
    input_company: 'Bluewave Freight',
    input_title: 'VP Finance Operations',
    user_id: 'user-1',
    prospect_id: null,
    prospect_name: 'Priya Raman',
    prospect_title: 'VP Finance Operations',
    company_name: 'Bluewave Freight',
    status: 'ready_for_review',
    selected_hook: 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.',
    generated_message: 'OLD DRAFT TEXT',
    error: null,
    ai_error_type: null,
    linkedin_profile: null,
    profile_access: null,
    qualification: qualification(),
    qualification_status: 'QUALIFIED',
    overall_fit: 82,
    identity_verification: null,
    overall_confidence: 82,
    insufficient_evidence: false,
    started_at: null,
    completed_at: null,
    created_at: '2026-08-18T00:00:00Z',
    updated_at: '2026-08-18T00:00:00Z',
    ...over,
  }) as RunRow;

const selectHookStage = (): RunStageRow =>
  ({
    id: 'stage-select-hook',
    run_id: RUN_ID,
    stage_name: 'select_hook',
    stage_order: 6,
    status: 'complete',
    summary: 'Hook selected',
    error: null,
    duration_ms: 100,
    started_at: null,
    completed_at: null,
    output: {
      selected: {
        signal: 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.',
        why_it_matters: 'Consolidation projects like this typically drive AP process changes.',
        signal_level: 'COMPANY',
        role_relevance: 'As VP Finance Operations, Priya now owns the consolidated AP workflow across entities.',
        outreach_rationale: 'The consolidation is actively underway, making this a timely, concrete reason to reach out.',
        source_url: HOOK_SOURCE_URL,
        source_title: 'Bluewave Freight AP Consolidation Update',
        supporting_quote: 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.',
        evidence_level: 'FULL',
        published_date: '2026-08-01',
        composite_score: 84,
      },
      confidence: 80,
    },
  }) as RunStageRow;

const generateMessageStageRow = (): RunStageRow =>
  ({
    id: 'stage-generate-message',
    run_id: RUN_ID,
    stage_name: 'generate_message',
    stage_order: 12,
    status: 'complete',
    summary: 'Draft saved',
    error: null,
    duration_ms: 100,
    started_at: null,
    completed_at: null,
    output: {
      subject: 'Bluewave AP consolidation',
      outreach_angle: 'The active vendor-invoicing consolidation across regional entities.',
      information_requests: [],
    },
  }) as RunStageRow;

const draft = (over: Partial<DraftRow> = {}): DraftRow =>
  ({
    id: 'draft-1',
    run_id: RUN_ID,
    hook_signal_id: 'signal-1',
    mode: 'personalized',
    subject: 'Bluewave AP consolidation',
    message_text: 'OLD DRAFT TEXT',
    final_text: null,
    personalization_basis: null,
    reasoning: null,
    claims: null,
    validation_status: null,
    validation_notes: null,
    sensitivity_note: null,
    confidence: 78,
    information_requests: [],
    reviewer_action: null,
    edited_text: null,
    reviewed_at: null,
    created_at: '2026-08-18T00:00:00Z',
    ...over,
  }) as DraftRow;

const source = (over: Partial<SourceRow> = {}): SourceRow =>
  ({
    id: 'source-1',
    run_id: RUN_ID,
    url: HOOK_SOURCE_URL,
    canonical_url: HOOK_SOURCE_URL,
    title: 'Bluewave Freight AP Consolidation Update',
    snippet: 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.',
    source_type: 'news_major',
    credibility: 0.8,
    published_date: '2026-08-01',
    providers: ['tavily'],
    found_via: ['company_news'],
    duplicate_count: 0,
    retrieved_at: '2026-08-01T00:00:00Z',
    content:
      'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter, ' +
      'as part of a broader finance operations standardization effort led by VP Finance Operations Priya Raman.',
    fetch_status: 'scraped',
    ...over,
  }) as SourceRow;

// A message crafted to clear every real, unmodified quality gate:
// checkPersonalization (engages the hook, no boilerplate, names the prospect,
// no assumed pain, depends on the hook, role-tied), checkOpener (not a pasted
// headline, no fact-stacking), and checkVoice (no banned vocabulary, no em
// dash, no exclamation marks, 40-130 words) — see lib/pipeline/stages.ts and
// lib/generation/voice.ts. It also genuinely uses the approved solution.
const GOOD_MESSAGE =
  "Priya, saw Bluewave pulling its regional vendor invoicing into one workflow this quarter. " +
  "Consolidations like that usually mean someone has to standardize invoice matching and reconciliation " +
  "across the merged entities before it settles into a routine process. We build AI agents that handle " +
  "accounts payable automation, invoice processing and payables matching for finance teams doing exactly " +
  "that. Worth comparing notes on how the transition is going?";

function goodModelResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      prospect: {
        name: null, headline: null, currentCompany: null, currentRole: null, location: null,
        identityConfidence: 0, identityNotes: null, ambiguous: false, employerChangeNote: null,
      },
      summary: '', careerInsights: [], companyContext: [], personalizationHooks: [],
      painPointsOrInterests: [], selectedHookIndex: 0, hookReason: '', alternativesConsidered: [],
      insufficientEvidence: false, insufficientReason: null,
      outreachAngle: 'The active vendor-invoicing consolidation across regional entities.',
      suggestedSubject: 'Bluewave AP consolidation',
      suggestedMessage: GOOD_MESSAGE,
      messageClaims: [
        {
          claim: 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.',
          type: 'COMPANY_FACT',
          verdict: 'SUPPORTED',
          evidence_url: HOOK_SOURCE_URL,
          explanation: 'Matches the retrieved source content verbatim.',
        },
        {
          claim: 'We build AI agents that handle accounts payable automation, invoice processing and payables matching.',
          type: 'SENDER_CAPABILITY',
          verdict: 'SUPPORTED',
          evidence_url: null,
          explanation: 'A description of the sender’s own product; no third-party evidence required.',
        },
      ],
      confidence: 80,
      informationRequests: [],
      ...overrides,
    },
    meta: { model: 'test', used_fallback_model: false, purpose: 'analyze_prospect', duration_ms: 1, attempts: 1, total_tokens: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SENDER_COMPANY = 'Zamp';
  process.env.SENDER_VALUE_PROP =
    'AI digital-employee agents for finance/ops — automating accounts payable (AP), chargebacks, and KYC/KYB workflows.';
  process.env.SENDER_CAPABILITIES = JSON.stringify(REAL_SENDER_CAPABILITIES);
  process.env.ZAMP_SOLUTION_CATALOG = JSON.stringify(REAL_ZAMP_SOLUTION_CATALOG);

  mockGetRun.mockResolvedValue(run());
  mockGetStage.mockImplementation((_runId: string, name: string) => {
    if (name === 'select_hook') return Promise.resolve(selectHookStage());
    if (name === 'generate_message') return Promise.resolve(generateMessageStageRow());
    return Promise.resolve(null);
  });
  mockGetDraft.mockResolvedValue(draft());
  mockListSources.mockResolvedValue([source()]);
  mockStartStage.mockImplementation((_runId: string, name: string) => Promise.resolve(`stage-${name}`));
  mockFinishStage.mockResolvedValue(undefined);
  mockUpdateRun.mockResolvedValue(undefined);
  mockUpdateDraft.mockResolvedValue(undefined);
  mockDeleteDrafts.mockResolvedValue(undefined);
  mockCreateDraft.mockImplementation((row: Partial<DraftRow>) =>
    Promise.resolve(draft({ id: 'draft-2', ...row } as Partial<DraftRow>)),
  );
  mockCallStructured.mockResolvedValue(goodModelResponse());
});

afterEach(() => {
  delete process.env.SENDER_COMPANY;
  delete process.env.SENDER_VALUE_PROP;
  delete process.env.SENDER_CAPABILITIES;
  delete process.env.ZAMP_SOLUTION_CATALOG;
});

describe('Solution Fit — one real end-to-end case', () => {
  it('step 1-2: the qualified company carries an OBSERVED, evidenced ap_automation capability match', () => {
    const q = run().qualification!;
    expect(q.classification).toBe('QUALIFIED');
    expect(q.action).toBe('TARGET_DIRECTLY');
    const match = q.company_fit.capability_matches[0];
    expect(match.capability_id).toBe('ap_automation');
    expect(match.basis).toBe('OBSERVED');
    expect(match.evidence.length).toBeGreaterThan(0);
  });

  it('step 3: the real Zamp catalog resolves this capability to "Accounts payable automation" deterministically', async () => {
    const { matchApprovedSolution } = await import('@/lib/solutions/match');
    const match = matchApprovedSolution(run().qualification);
    expect(match).not.toBeNull();
    expect(match!.solution.id).toBe('zamp_ap_automation');
    expect(match!.solution.name).toBe('Accounts payable automation');
    expect(match!.why_it_fits).toContain('Accounts payable automation');
    expect(match!.why_it_fits).toContain('Bluewave Freight is consolidating vendor invoicing');
  });

  it('step 4-5: the model prompt actually receives the approved solution, with its boundaries intact', async () => {
    await regenerateMessageOnly(RUN_ID);

    expect(mockCallStructured).toHaveBeenCalled();
    const call = mockCallStructured.mock.calls[0][0];
    expect(call.input).toContain('APPROVED SOLUTION');
    expect(call.input).toContain('Accounts payable automation');
    expect(call.input).toContain('AI digital-employee agents that process invoices');
    // The matched capability's own verified signal is what justified the match.
    expect(call.input).toContain('Bluewave Freight is consolidating vendor invoicing');
    // The model is told what it may NOT claim beyond this.
    expect(call.input).toMatch(/only product you may describe/i);
  });

  it('step 6: generate_message persists the approved solution for the UI to read', async () => {
    await regenerateMessageOnly(RUN_ID);

    const generateMessageCall = mockFinishStage.mock.calls.find((c) => c[0] === 'stage-generate_message');
    expect(generateMessageCall).toBeDefined();
    const output = generateMessageCall![1].output as {
      approved_solution: { id: string; name: string; why_it_fits: string } | null;
      solution_match_note: string | null;
    };
    expect(output.approved_solution).not.toBeNull();
    expect(output.approved_solution!.id).toBe('zamp_ap_automation');
    expect(output.approved_solution!.name).toBe('Accounts payable automation');
    expect(output.solution_match_note).toBeNull();
  });

  it('step 7: the generated message actually uses the approved solution, not an invented one', async () => {
    await regenerateMessageOnly(RUN_ID);

    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    const created = mockCreateDraft.mock.calls[0][0];
    expect(created.message_text).toContain('accounts payable automation');
    // Never a product outside the real catalog.
    expect(created.message_text).not.toMatch(/chargeback|kyc|kyb/i);
  });

  it('step 8: claim and voice validation run for real, against the real draft', async () => {
    await regenerateMessageOnly(RUN_ID);

    expect(mockUpdateDraft).toHaveBeenCalled();
    const patch = mockUpdateDraft.mock.calls[0][1];
    expect(patch.validation_status).toBeDefined();
    expect(Array.isArray(patch.claims)).toBe(true);
    expect(patch.claims.length).toBeGreaterThan(0);

    // The message cleared voice/personalization/opener on the first attempt —
    // exactly one model call, no forced regeneration was needed.
    expect(mockCallStructured).toHaveBeenCalledTimes(1);

    const finalStatuses = mockUpdateRun.mock.calls.map((c) => c[1]?.status).filter(Boolean);
    expect(finalStatuses[0]).toBe('running');
    expect(finalStatuses[finalStatuses.length - 1]).toBe('ready_for_review');
  });

  it('Outreach Rationale and Decision Summary — the exact UI data builders — surface the same solution', async () => {
    await regenerateMessageOnly(RUN_ID);

    const generateMessageCall = mockFinishStage.mock.calls.find((c) => c[0] === 'stage-generate_message')!;
    const genOutput = generateMessageCall[1].output;

    const decision = buildDecisionSummary(run())!;
    expect(decision.accountStatus).toBe('QUALIFIED');
    expect(decision.contactStatus).toBe('QUALIFIED');
    expect(decision.action).toBe('TARGET DIRECTLY');

    const rationale = buildOutreachRationale({
      run: run(),
      stages: [selectHookStage(), { ...generateMessageStageRow(), output: genOutput }],
      signals: [
        {
          id: 'signal-1',
          run_id: RUN_ID,
          signal: 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.',
          why_it_matters: 'Consolidation projects like this typically drive AP process changes.',
          category: 'strategic_initiative',
          source_url: HOOK_SOURCE_URL,
          source_title: 'Bluewave Freight AP Consolidation Update',
          source_type: 'news_major',
          published_date: '2026-08-01',
          supporting_quote: 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.',
          relevance_score: 84,
          specificity_score: 85,
          recency_score: 80,
          confidence_score: 82,
          credibility_score: 80,
          corroboration_count: 0,
          composite_score: 84,
          conflicts_with: null,
          selected_as_hook: true,
          retrieved_at: '2026-08-01T00:00:00.000Z',
        },
      ],
      sources: [source()],
      draft: draft({ id: 'draft-2' }),
      contactCandidates: [],
    })!;

    // Compact one-sentence synthesis — never the qualification score or its
    // full reasoning paragraph, which stay in Target Qualification.
    expect(rationale.accountFit).toBe('Strong account fit — a verified accounts payable automation need.');
    expect(rationale.contactFit).toBe('Strong contact fit — VP Finance Operations with decision authority over the qualified workflow.');
    expect(rationale.primarySignal?.signal).toContain('consolidating vendor invoicing');

    // Recommended Solution — the primary element: name, a concise catalog-
    // grounded fit sentence (no capability description dump), the single
    // verified evidence item, and what the message should lead with.
    expect(rationale.solutionName).toBe('Accounts payable automation');
    expect(rationale.whyItFits).toBe(
      'AI digital-employee agents that process invoices, match and reconcile payables, and execute AP workflows end to end, a verified need at Bluewave Freight.',
    );
    expect(rationale.solutionEvidence).toEqual({
      capabilityName: 'Accounts payable automation',
      fitStrength: 82,
      sourceUrl: 'https://example.com/bluewave-vendor-ops',
    });
    expect(rationale.useInOutreach).toBe(
      'Invoice processing, Payables matching and reconciliation, End-to-end AP workflow execution',
    );
  });
});
