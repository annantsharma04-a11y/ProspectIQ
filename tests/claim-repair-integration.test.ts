import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunRow, DraftRow, RunStageRow, SourceRow } from '@/lib/types';

// The unit tests already pin repairMessage / verifyRepairSafety / validateClaims
// individually. What they cannot show is that validateClaimsStage actually
// WIRES them together: detects the blocking claim, calls repair, safety-checks
// the result, revalidates it, and persists the right text.
//
// So this drives the REAL stage through regenerateMessageOnly() — the same
// two-boundary mocking (Supabase + model) tests/regenerate-message.test.ts
// established, no parallel implementation. It also covers the regeneration
// wiring requirement in the same pass: if repair runs here, it runs for
// regenerated drafts by construction.

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

const RUN_ID = 'run-1';
const SOURCE_URL = 'https://example.com/prism-finance-ops';
const FABRICATED_URL = 'https://invented.example.com/ipo-story';

const HOOK_SIGNAL = 'PRISM announced a leadership realignment across finance operations.';

/** The draft the model first produces: one unsupported external-event claim. */
const DIRTY_MESSAGE =
  'Hi Priya, PRISM announced plans for its public offering last quarter. You now lead finance ' +
  'operations there, which covers vendor payment volume and reconciliation work. We build agents ' +
  'that assemble payables evidence and work exceptions through to resolution. Curious how the new ' +
  'structure is handling that volume today, and whether it would be useful to compare notes on a short call.';

/** The same draft with the unsupported sentence removed. Nothing else changed. */
const REPAIRED_MESSAGE =
  'Hi Priya, you now lead finance operations at PRISM, which covers vendor payment volume and ' +
  'reconciliation work. We build agents that assemble payables evidence and work exceptions through ' +
  'to resolution. Curious how the new structure is handling that volume today, and whether it would ' +
  'be useful to compare notes on a short call.';

const SUPPORTED_CLAIM = {
  claim: 'Priya Nair leads finance operations at PRISM.',
  type: 'PROSPECT_FACT',
  verdict: 'SUPPORTED',
  evidence_url: SOURCE_URL,
  explanation: 'Stated by the cited source.',
};
const UNSUPPORTED_CLAIM = {
  claim: 'PRISM announced plans for its public offering.',
  type: 'EXTERNAL_EVENT',
  verdict: 'UNSUPPORTED',
  evidence_url: null,
  explanation: 'No retrieved source mentions an offering.',
};
const PRODUCT_CLAIM = {
  claim: 'We build agents that assemble payables evidence.',
  type: 'SENDER_CAPABILITY',
  verdict: 'SUPPORTED',
  evidence_url: null,
  explanation: 'Describes the sender offering.',
};

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: RUN_ID,
    linkedin_url: 'https://www.linkedin.com/in/priya-nair',
    linkedin_slug: 'priya-nair',
    input_name: 'Priya Nair',
    input_company: 'PRISM',
    input_title: 'Head of Finance Operations',
    user_id: 'user-1',
    prospect_id: null,
    status: 'ready_for_review',
    selected_hook: HOOK_SIGNAL,
    generated_message: 'OLD DRAFT TEXT',
    error: null,
    ai_error_type: null,
    linkedin_profile: null,
    profile_access: null,
    qualification: null,
    identity_verification: null,
    overall_confidence: 70,
    insufficient_evidence: false,
    started_at: null,
    completed_at: null,
    created_at: '2026-08-19T00:00:00Z',
    updated_at: '2026-08-19T00:00:00Z',
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
        signal: HOOK_SIGNAL,
        why_it_matters: 'Signals fresh finance-org investment.',
        signal_level: 'COMPANY',
        role_relevance: 'They own the reorganized finance function.',
        outreach_rationale: 'A recent change is a natural reason to make contact.',
        source_url: SOURCE_URL,
        source_title: 'PRISM finance operations realignment',
        supporting_quote: 'PRISM has realigned its finance operations leadership.',
        evidence_level: 'FULL',
        published_date: '2026-08-01',
        composite_score: 82,
      },
      confidence: 78,
    },
  }) as RunStageRow;

const generateMessageStageRow = (): RunStageRow =>
  ({
    id: 'stage-generate-message',
    run_id: RUN_ID,
    stage_name: 'generate_message',
    stage_order: 7,
    status: 'complete',
    summary: 'Draft saved',
    error: null,
    duration_ms: 100,
    started_at: null,
    completed_at: null,
    output: { subject: 'Finance operations at PRISM', outreach_angle: 'The realignment.', information_requests: [] },
  }) as RunStageRow;

const draft = (over: Partial<DraftRow> = {}): DraftRow =>
  ({
    id: 'draft-1',
    run_id: RUN_ID,
    hook_signal_id: 'signal-1',
    mode: 'personalized',
    subject: 'Finance operations at PRISM',
    message_text: 'OLD DRAFT TEXT',
    final_text: null,
    personalization_basis: null,
    reasoning: null,
    claims: null,
    validation_status: null,
    validation_notes: null,
    sensitivity_note: null,
    confidence: 70,
    information_requests: [],
    reviewer_action: null,
    edited_text: null,
    reviewed_at: null,
    created_at: '2026-08-19T00:00:00Z',
    ...over,
  }) as DraftRow;

const source = (): SourceRow =>
  ({
    id: 'source-1',
    run_id: RUN_ID,
    url: SOURCE_URL,
    canonical_url: SOURCE_URL,
    title: 'PRISM finance operations realignment',
    snippet: 'PRISM has realigned its finance operations leadership.',
    source_type: 'news_major',
    credibility: 0.8,
    published_date: '2026-08-01',
    providers: ['tavily'],
    found_via: ['company_news'],
    duplicate_count: 0,
    retrieved_at: '2026-08-01T00:00:00Z',
    content: 'PRISM has realigned its finance operations leadership. Priya Nair leads finance operations.',
    fetch_status: 'scraped',
    ...({} as Record<string, unknown>),
  }) as SourceRow;

function analysisResponse() {
  return {
    data: {
      prospect: {
        name: 'Priya Nair', headline: null, currentCompany: 'PRISM', currentRole: 'Head of Finance Operations',
        location: null, identityConfidence: 80, identityNotes: null, ambiguous: false, employerChangeNote: null,
      },
      summary: '', careerInsights: [], companyContext: [], personalizationHooks: [],
      painPointsOrInterests: [], selectedHookIndex: 0, hookReason: '', alternativesConsidered: [],
      insufficientEvidence: false, insufficientReason: null,
      outreachAngle: 'The finance operations realignment.',
      suggestedSubject: 'Finance operations at PRISM',
      suggestedMessage: DIRTY_MESSAGE,
      messageClaims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM, PRODUCT_CLAIM],
      confidence: 78,
      informationRequests: [],
    },
    meta: { model: 'test', used_fallback_model: false, purpose: 'analyze_prospect', duration_ms: 1, attempts: 1, total_tokens: null },
  };
}

const repairResponse = (body: Record<string, unknown>) => ({
  data: body,
  meta: { model: 'test', used_fallback_model: false, purpose: 'repair_unsupported_claims', duration_ms: 1, attempts: 1, total_tokens: null },
});

/** Route each mocked model call by the purpose the production code declares. */
function routeModel(repair: Record<string, unknown> | null) {
  mockCallStructured.mockImplementation((args: { purpose: string }) => {
    if (args.purpose === 'repair_unsupported_claims') {
      if (!repair) return Promise.reject(new Error('model unavailable'));
      return Promise.resolve(repairResponse(repair));
    }
    // The email itself now comes from the dedicated writer, which is what
    // produces the draft carrying the unsupported claim under test.
    if (args.purpose === 'write_outreach_email') {
      return Promise.resolve({
        data: {
          subject: 'Finance operations at PRISM',
          message: DIRTY_MESSAGE,
          messageClaims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM, PRODUCT_CLAIM],
        },
        meta: { model: 'test', used_fallback_model: false, purpose: 'write_outreach_email', duration_ms: 1, attempts: 1, total_tokens: null },
      });
    }
    return Promise.resolve(analysisResponse());
  });
}

/** The draft row as validateClaimsStage persisted it. */
function persistedDraft(): Record<string, unknown> | null {
  const call = mockUpdateDraft.mock.calls.at(-1);
  return call ? (call[1] as Record<string, unknown>) : null;
}

/** The validate_claims stage output as it was recorded. */
function validateStageOutput(): Record<string, unknown> | null {
  for (const [, payload] of [...mockFinishStage.mock.calls].reverse()) {
    const p = payload as { output?: Record<string, unknown> };
    if (p?.output && 'auto_repair' in p.output) return p.output;
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRun.mockResolvedValue(run());
  mockGetStage.mockImplementation((_r: string, name: string) => {
    if (name === 'select_hook') return Promise.resolve(selectHookStage());
    if (name === 'generate_message') return Promise.resolve(generateMessageStageRow());
    return Promise.resolve(null);
  });
  mockGetDraft.mockResolvedValue(draft());
  mockListSources.mockResolvedValue([source()]);
  mockStartStage.mockResolvedValue('new-stage-id');
  mockFinishStage.mockResolvedValue(undefined);
  mockUpdateRun.mockResolvedValue(undefined);
  mockUpdateDraft.mockResolvedValue(undefined);
  mockDeleteDrafts.mockResolvedValue(undefined);
  mockCreateDraft.mockImplementation((row: Partial<DraftRow>) =>
    Promise.resolve(draft({ id: 'draft-2', ...row } as Partial<DraftRow>)),
  );
});

describe('Test 1 — validateClaimsStage repairs a flagged draft end to end', () => {
  beforeEach(() =>
    routeModel({
      message: REPAIRED_MESSAGE,
      claims: [SUPPORTED_CLAIM, PRODUCT_CLAIM],
      removed_claims: [UNSUPPORTED_CLAIM.claim],
    }),
  );

  it('calls the repair model exactly once, through the real stage', async () => {
    await regenerateMessageOnly(RUN_ID);

    const repairCalls = mockCallStructured.mock.calls.filter(
      (c) => (c[0] as { purpose: string }).purpose === 'repair_unsupported_claims',
    );
    expect(repairCalls).toHaveLength(1);
  });

  it('accepts the repair and records why', async () => {
    await regenerateMessageOnly(RUN_ID);
    const output = validateStageOutput();

    expect(output).not.toBeNull();
    expect(output!.auto_repair).toMatchObject({ attempted: true, accepted: true, rejected_reason: null });
    expect((output!.auto_repair as { unsupported_before: string[] }).unsupported_before).toContain(
      UNSUPPORTED_CLAIM.claim,
    );
  });

  it('persists the REPAIRED text as final_text', async () => {
    await regenerateMessageOnly(RUN_ID);
    const saved = persistedDraft();

    expect(saved!.final_text).toBe(REPAIRED_MESSAGE);
  });

  it('the persisted draft no longer contains the unsupported claim', async () => {
    await regenerateMessageOnly(RUN_ID);
    const finalText = persistedDraft()!.final_text as string;

    expect(finalText.toLowerCase()).not.toContain('public offering');
    // and the good material survived
    expect(finalText).toContain('finance operations');
    expect(finalText).toContain('payables evidence');
  });

  it('is no longer flagged, and no unsupported claim is persisted', async () => {
    await regenerateMessageOnly(RUN_ID);
    const saved = persistedDraft()!;

    expect(saved.validation_status).not.toBe('flagged');
    const claims = saved.claims as { verdict: string }[];
    expect(claims.some((c) => c.verdict === 'UNSUPPORTED')).toBe(false);
  });

  it('persists the auto-revised marker the UI keys on', async () => {
    await regenerateMessageOnly(RUN_ID);
    expect(persistedDraft()!.validation_notes as string).toContain('[auto-revised]');
  });
});

describe('Test 2 — an unsafe repair is rejected and the flagged state survives', () => {
  it('rejects a repair citing a source that was never retrieved', async () => {
    routeModel({
      message: REPAIRED_MESSAGE,
      claims: [{ ...SUPPORTED_CLAIM, evidence_url: FABRICATED_URL }, PRODUCT_CLAIM],
    });

    await regenerateMessageOnly(RUN_ID);
    const output = validateStageOutput()!;

    expect(output.auto_repair).toMatchObject({ attempted: true, accepted: false });
    expect((output.auto_repair as { rejected_reason: string }).rejected_reason).toContain('never retrieved');
  });

  it('rejects a repair that introduces another unsupported world claim', async () => {
    routeModel({
      message:
        'Hi Priya, PRISM is preparing a major funding round this year. You now lead finance operations ' +
        'there, which covers vendor payment volume and reconciliation work. We build agents that assemble ' +
        'payables evidence and work exceptions through to resolution. Curious how the new structure is ' +
        'handling that volume today, and whether it would be useful to compare notes on a short call.',
      claims: [
        SUPPORTED_CLAIM,
        { claim: 'PRISM is preparing a major funding round.', type: 'EXTERNAL_EVENT', verdict: 'SUPPORTED', evidence_url: SOURCE_URL, explanation: '' },
        PRODUCT_CLAIM,
      ],
    });

    await regenerateMessageOnly(RUN_ID);
    const output = validateStageOutput()!;

    // Marked SUPPORTED by the model, but it is a NEW world-claim — code refuses
    // to take the model's word for it.
    expect(output.auto_repair).toMatchObject({ attempted: true, accepted: false });
    expect((output.auto_repair as { rejected_reason: string }).rejected_reason).toContain('new factual claim');
  });

  it('keeps the ORIGINAL flagged draft when repair is rejected', async () => {
    routeModel({
      message: REPAIRED_MESSAGE,
      claims: [{ ...SUPPORTED_CLAIM, evidence_url: FABRICATED_URL }, PRODUCT_CLAIM],
    });

    await regenerateMessageOnly(RUN_ID);
    const saved = persistedDraft()!;

    expect(saved.validation_status).toBe('flagged');
    expect(saved.final_text).toBe(DIRTY_MESSAGE);
    expect(saved.validation_notes as string).not.toContain('[auto-revised]');
    const claims = saved.claims as { verdict: string }[];
    expect(claims.some((c) => c.verdict === 'UNSUPPORTED')).toBe(true);
  });

  it('a repair-model failure is survivable and leaves the flagged state intact', async () => {
    routeModel(null); // repair call rejects

    await regenerateMessageOnly(RUN_ID);
    const saved = persistedDraft()!;
    const output = validateStageOutput()!;

    expect(output.auto_repair).toMatchObject({ attempted: true, accepted: false });
    expect(saved.validation_status).toBe('flagged');
    expect(saved.final_text).toBe(DIRTY_MESSAGE);
  });

  it('never attempts more than one repair, whatever the outcome', async () => {
    routeModel({ message: REPAIRED_MESSAGE, claims: [{ ...SUPPORTED_CLAIM, evidence_url: FABRICATED_URL }] });

    await regenerateMessageOnly(RUN_ID);

    const repairCalls = mockCallStructured.mock.calls.filter(
      (c) => (c[0] as { purpose: string }).purpose === 'repair_unsupported_claims',
    );
    expect(repairCalls).toHaveLength(1);
  });
});

// Control: proves the assertions above are not passing vacuously. If a clean
// draft also reported attempted:true, every "repair happened" assertion in
// this file would be meaningless.
describe('control — a clean draft takes no repair path at all', () => {
  it('makes no repair call and records attempted:false', async () => {
    mockCallStructured.mockImplementation((args: { purpose: string }) => {
      if (args.purpose === 'repair_unsupported_claims') {
        throw new Error('repair must not be called for a clean draft');
      }
      if (args.purpose === 'write_outreach_email') {
        // Same draft, but the offending claim is simply not in it.
        return Promise.resolve({
          data: {
            subject: 'Finance operations at PRISM',
            message: REPAIRED_MESSAGE,
            messageClaims: [SUPPORTED_CLAIM, PRODUCT_CLAIM],
          },
          meta: { model: 'test', used_fallback_model: false, purpose: 'write_outreach_email', duration_ms: 1, attempts: 1, total_tokens: null },
        });
      }
      return Promise.resolve(analysisResponse());
    });

    await regenerateMessageOnly(RUN_ID);

    const repairCalls = mockCallStructured.mock.calls.filter(
      (c) => (c[0] as { purpose: string }).purpose === 'repair_unsupported_claims',
    );
    expect(repairCalls).toHaveLength(0);

    const output = validateStageOutput()!;
    expect(output.auto_repair).toMatchObject({ attempted: false, accepted: false });
    expect(persistedDraft()!.validation_status).not.toBe('flagged');
    expect(persistedDraft()!.validation_notes as string).not.toContain('[auto-revised]');
  });
});

describe('regeneration wiring', () => {
  it('regenerateMessageOnly runs the same repair path as a normal run', async () => {
    routeModel({ message: REPAIRED_MESSAGE, claims: [SUPPORTED_CLAIM, PRODUCT_CLAIM] });

    await regenerateMessageOnly(RUN_ID);

    // The repair happened inside validate_claims during a REGENERATION, which
    // is the wiring this assertion exists to prove.
    expect(validateStageOutput()!.auto_repair).toMatchObject({ attempted: true, accepted: true });
    expect(persistedDraft()!.final_text).toBe(REPAIRED_MESSAGE);
  });
});
