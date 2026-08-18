import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunRow, DraftRow, RunStageRow, SourceRow } from '@/lib/types';

// regenerateMessageOnly() end-to-end, fully mocked at the two real boundaries
// (Supabase and the model) — no network, no cost, fully repeatable. Exercises
// the REAL rehydration (restoring the already-selected hook from the
// select_hook stage's own persisted output, not re-deriving it), the REAL
// forced rewrite call, and the REAL generate_message / validate_claims /
// ready_for_review stages, unmodified.

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
  // Unused on this path, but stages.ts imports them at module scope.
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
const HOOK_SOURCE_URL = 'https://example.com/prism-leadership';

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: RUN_ID,
    linkedin_url: 'https://www.linkedin.com/in/example',
    linkedin_slug: 'example',
    input_name: null,
    input_company: null,
    input_title: null,
    user_id: 'user-1',
    prospect_id: null,
    status: 'ready_for_review',
    selected_hook: 'PRISM announced a leadership realignment across finance operations.',
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
        signal: 'PRISM announced a leadership realignment across finance operations.',
        why_it_matters: 'Signals fresh finance-org investment.',
        signal_level: 'COMPANY',
        role_relevance: 'They now own the reorganized finance function.',
        outreach_rationale: 'Recent change creates a natural reason to reach out.',
        source_url: HOOK_SOURCE_URL,
        source_title: 'PRISM Leadership Realignment',
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
    output: {
      subject: 'Quick question about PRISM finance ops',
      outreach_angle: 'The recent finance leadership realignment.',
      information_requests: [],
    },
  }) as RunStageRow;

const draft = (over: Partial<DraftRow> = {}): DraftRow =>
  ({
    id: 'draft-1',
    run_id: RUN_ID,
    hook_signal_id: 'signal-1',
    mode: 'personalized',
    subject: 'Quick question about PRISM finance ops',
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
    created_at: '2026-08-18T00:00:00Z',
    ...over,
  }) as DraftRow;

const source = (over: Partial<SourceRow> = {}): SourceRow =>
  ({
    id: 'source-1',
    run_id: RUN_ID,
    url: HOOK_SOURCE_URL,
    canonical_url: HOOK_SOURCE_URL,
    title: 'PRISM Leadership Realignment',
    snippet: 'PRISM has realigned its finance operations leadership.',
    source_type: 'news_major',
    credibility: 0.8,
    published_date: '2026-08-01',
    providers: ['tavily'],
    found_via: ['company_news'],
    duplicate_count: 0,
    retrieved_at: '2026-08-01T00:00:00Z',
    content: 'PRISM has realigned its finance operations leadership, elevating a new COO.',
    fetch_status: 'scraped',
    ...over,
  }) as SourceRow;

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
      outreachAngle: 'The recent finance leadership realignment.',
      suggestedSubject: 'Quick question about PRISM finance ops',
      suggestedMessage:
        'Hi there, noticed PRISM realigned its finance operations leadership recently — curious how the ' +
        'new structure is handling vendor payment volume. Worth a quick chat?',
      messageClaims: [],
      confidence: 78,
      informationRequests: [],
      ...overrides,
    },
    meta: { model: 'test', used_fallback_model: false, purpose: 'analyze_prospect', duration_ms: 1, attempts: 1, total_tokens: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRun.mockResolvedValue(run());
  mockGetStage.mockImplementation((_runId: string, name: string) => {
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

describe('regenerateMessageOnly — reuses the selected hook, forces a fresh model call', () => {
  it('calls the model with a rewrite instruction, not a plain re-ask', async () => {
    // generateMessageStage's own pre-existing one-retry-on-failed-checks policy
    // can add a second model call after ours — same response both times.
    mockCallStructured.mockResolvedValue(goodModelResponse());

    await regenerateMessageOnly(RUN_ID);

    expect(mockCallStructured).toHaveBeenCalled();
    const call = mockCallStructured.mock.calls[0][0];
    expect(call.input).toContain('REWRITE INSTRUCTION');
    expect(call.input).toMatch(/genuinely different version/i);
    // The prior draft was NOT reused — the model was asked to write anew.
    expect(call.input).not.toContain('OLD DRAFT TEXT');
  });

  it('does not re-run research, qualification, or signal extraction', async () => {
    mockCallStructured.mockResolvedValue(goodModelResponse());

    await regenerateMessageOnly(RUN_ID);

    // Only the hook/generate_message/draft/sources rehydration path ran —
    // sources are read exactly once (by rehydrate()), never re-fetched or
    // re-searched, regardless of how many model calls the quality gate makes.
    expect(mockListSources).toHaveBeenCalledTimes(1);
    expect(mockCallStructured.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockCallStructured.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('saves a genuinely new draft — deletes the old one, creates a new one with the fresh text', async () => {
    const fresh = goodModelResponse();
    mockCallStructured.mockResolvedValueOnce(fresh);

    await regenerateMessageOnly(RUN_ID);

    expect(mockDeleteDrafts).toHaveBeenCalledWith(RUN_ID);
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    const created = mockCreateDraft.mock.calls[0][0];
    expect(created.message_text).toContain('vendor payment volume');
    expect(created.message_text).not.toBe('OLD DRAFT TEXT');
    expect(created.hook_signal_id).toBe('signal-1'); // carried over from the prior draft
  });

  it('runs claim validation on the new draft', async () => {
    mockCallStructured.mockResolvedValueOnce(goodModelResponse());

    await regenerateMessageOnly(RUN_ID);

    expect(mockUpdateDraft).toHaveBeenCalled();
    const patch = mockUpdateDraft.mock.calls[0][1];
    expect(patch.validation_status).toBeDefined();
  });

  it('finalizes the run to a real terminal status, not left running', async () => {
    mockCallStructured.mockResolvedValueOnce(goodModelResponse());

    await regenerateMessageOnly(RUN_ID);

    const statuses = mockUpdateRun.mock.calls.map((c) => c[1]?.status).filter(Boolean);
    expect(statuses[0]).toBe('running');
    const finalStatus = statuses[statuses.length - 1];
    expect(['ready_for_review', 'needs_manual_review']).toContain(finalStatus);
  });
});

describe('regenerateMessageOnly — failure and precondition handling', () => {
  it('when the model returns no usable text, the existing draft is preserved and the run status is restored', async () => {
    mockCallStructured.mockResolvedValueOnce(goodModelResponse({ suggestedMessage: '' }));

    await expect(regenerateMessageOnly(RUN_ID)).rejects.toThrow(/could not produce a new draft/i);

    expect(mockDeleteDrafts).not.toHaveBeenCalled();
    expect(mockCreateDraft).not.toHaveBeenCalled();
    const statuses = mockUpdateRun.mock.calls.map((c) => c[1]);
    // First call marks it running; the final call restores the ORIGINAL status
    // (ready_for_review, from the run() fixture) rather than degrading to 'failed'.
    expect(statuses[0].status).toBe('running');
    expect(statuses[statuses.length - 1].status).toBe('ready_for_review');
    expect(statuses[statuses.length - 1].error).toMatch(/could not produce/i);
  });

  it('refuses to regenerate when there is no selected hook to preserve', async () => {
    mockGetStage.mockImplementation((_runId: string, name: string) => {
      if (name === 'select_hook') return Promise.resolve({ ...selectHookStage(), output: { selected: null } });
      return Promise.resolve(null);
    });

    await expect(regenerateMessageOnly(RUN_ID)).rejects.toThrow(/no verified hook/i);

    expect(mockCallStructured).not.toHaveBeenCalled();
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });
});
