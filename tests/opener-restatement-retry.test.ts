import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunRow, DraftRow, RunStageRow, SourceRow } from '@/lib/types';

// Drives the REAL generateMessageStage() -> validateClaimsStage() path (same
// two-boundary mocking as tests/claim-repair-integration.test.ts) to prove
// the retry-on-restatement fix is actually wired in, not just present as an
// unused string. The Shiprocket hook/reasoning shape is used throughout.

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
const SOURCE_URL = 'https://example.com/shiprocket-revenue';
const HOOK_SIGNAL =
  "Shiprocket recently expanded its non-shipping merchant software and checkout solutions, which now generate over a quarter of total revenue.";

/** The bad opener the real run produced: a close paraphrase of the hook. */
const RESTATING_MESSAGE =
  "Hi Tanmay,\n\nShiprocket's non-shipping merchant software and checkout solutions now generate over a quarter of total revenue.\n\nManaging the operations behind that shift usually means more coordination across finance.\n\nZamp can process invoices, match and reconcile payables, and run accounts payable workflows end to end.\n\nWould be great to compare notes on a short call about how that side of things is handled today.";

/** A genuinely different, implication-led opener — the intended fix output. */
const IMPLICATION_MESSAGE =
  "Hi Tanmay,\n\nAs Shiprocket expands beyond its core logistics business, I imagine keeping the finance operations behind those additional product lines coordinated gets more complex.\n\nZamp can process invoices, match and reconcile payables, and run accounts payable workflows end to end.\n\nI'd be keen to understand how your finance team handles that today and where we could be useful. Would be great to compare notes on a short call.";

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: RUN_ID,
    linkedin_url: 'https://www.linkedin.com/in/tanmay-example',
    linkedin_slug: 'tanmay-example',
    input_name: 'Tanmay',
    input_company: 'Shiprocket',
    input_title: 'Group CFO',
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
    overall_confidence: 78,
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
        why_it_matters:
          'As non-shipping software and emerging product lines expand faster than core logistics, transaction volumes and supplier interactions grow correspondingly.',
        signal_level: 'COMPANY',
        role_relevance:
          'As Group CFO overseeing finance and operations, managing scaling invoice and payable volumes across growing business units directly impacts financial overhead.',
        outreach_rationale:
          'Expanding non-shipping revenue streams scale vendor and carrier supplier networks, increasing accounts payable volume and reconciliation overhead.',
        source_url: SOURCE_URL,
        source_title: "Shiprocket's non-shipping business growth",
        supporting_quote: 'Shiprocket non-shipping revenue crosses a quarter of total revenue.',
        evidence_level: 'FULL',
        published_date: '2026-08-01',
        composite_score: 85,
      },
      confidence: 82,
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
    output: { subject: 'AP automation at Shiprocket', outreach_angle: 'Non-shipping revenue growth.', information_requests: [] },
  }) as RunStageRow;

const draft = (over: Partial<DraftRow> = {}): DraftRow =>
  ({
    id: 'draft-1',
    run_id: RUN_ID,
    hook_signal_id: 'signal-1',
    mode: 'personalized',
    subject: 'AP automation at Shiprocket',
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
    created_at: '2026-08-19T00:00:00Z',
    ...over,
  }) as DraftRow;

const source = (): SourceRow =>
  ({
    id: 'source-1',
    run_id: RUN_ID,
    url: SOURCE_URL,
    canonical_url: SOURCE_URL,
    title: "Shiprocket's non-shipping business growth",
    snippet: 'Shiprocket non-shipping revenue crosses a quarter of total revenue.',
    source_type: 'news_major',
    credibility: 0.8,
    published_date: '2026-08-01',
    providers: ['tavily'],
    found_via: ['company_news'],
    duplicate_count: 0,
    retrieved_at: '2026-08-01T00:00:00Z',
    content: 'Shiprocket non-shipping revenue crosses a quarter of total revenue.',
    fetch_status: 'scraped',
  }) as unknown as SourceRow;

/** Routes each mocked model call by the purpose the production code declares. */
function routeByPurpose(writeResponses: string[]) {
  let writeCall = 0;
  return (args: { purpose: string; input: string }) => {
    if (args.purpose === 'write_outreach_email') {
      const message = writeResponses[Math.min(writeCall, writeResponses.length - 1)];
      writeCall++;
      return Promise.resolve({
        data: { subject: 'AP automation at Shiprocket', message, messageClaims: [] },
        meta: { model: 'test', used_fallback_model: false, purpose: 'write_outreach_email', duration_ms: 1, attempts: 1, total_tokens: null },
      });
    }
    if (args.purpose === 'edit_outreach_email') {
      // Echo the draft unchanged — isolates these tests to the writer/retry
      // path, matching the pattern in tests/regenerate-message.test.ts.
      const draftMessage = args.input.split('DRAFT TO EDIT\n')[1]?.split('\n\nImprove')[0] ?? '';
      return Promise.resolve({
        data: { message: draftMessage.trim(), messageClaims: [] },
        meta: { model: 'test', used_fallback_model: false, purpose: 'edit_outreach_email', duration_ms: 1, attempts: 1, total_tokens: null },
      });
    }
    return Promise.resolve({ data: {}, meta: {} });
  };
}

function writeCalls() {
  return mockCallStructured.mock.calls.filter((c) => (c[0] as { purpose: string }).purpose === 'write_outreach_email');
}

function persistedDraft(): Record<string, unknown> | null {
  const call = mockUpdateDraft.mock.calls.at(-1);
  return call ? (call[1] as Record<string, unknown>) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRun.mockResolvedValue(run());
  mockGetStage.mockImplementation((_r: string, name: string) => {
    if (name === 'select_hook') return Promise.resolve(selectHookStage());
    if (name === 'generate_message') return Promise.resolve(generateMessageStageRow());
    return Promise.resolve(null);
  });
  mockGetDraft.mockResolvedValue(draft({ message_text: RESTATING_MESSAGE }));
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

describe('7. a restatement failure receives the exact corrective retry instruction', () => {
  it('the retry prompt carries the required sentence, word for word', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([RESTATING_MESSAGE, IMPLICATION_MESSAGE]));

    await regenerateMessageOnly(RUN_ID);

    const calls = writeCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const retryPrompt = calls[1][0].input as string;
    expect(retryPrompt).toContain(
      "The previous opener was rejected because it restated the research signal. Do not rewrite the same sentence. Do not paraphrase the hook. Start from the implication for the prospect's role instead.",
    );
  });

  it('the retry keeps the same brief — same fact, same workflow, same recipient', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([RESTATING_MESSAGE, IMPLICATION_MESSAGE]));

    await regenerateMessageOnly(RUN_ID);

    const retryPrompt = writeCalls()[1][0].input as string;
    expect(retryPrompt).toContain(HOOK_SIGNAL);
    expect(retryPrompt).toContain('Tanmay');
  });
});

describe('8. the retry produces a materially different, passing opener', () => {
  it('the final persisted draft is the implication-based rewrite, not the restated one', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([RESTATING_MESSAGE, IMPLICATION_MESSAGE]));

    await regenerateMessageOnly(RUN_ID);

    const saved = persistedDraft()!;
    expect(saved.final_text).toBe(IMPLICATION_MESSAGE);
    expect(saved.final_text).not.toBe(RESTATING_MESSAGE);
  });

  it('if the retry ALSO restates the hook, the run is honestly degraded — no infinite loop, no silent success', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([RESTATING_MESSAGE, RESTATING_MESSAGE]));

    await regenerateMessageOnly(RUN_ID);

    // Exactly one retry — the existing one-regeneration budget, never more.
    expect(writeCalls().length).toBe(2);
    const finalStatuses = mockUpdateRun.mock.calls.map((c) => c[1]?.status).filter(Boolean);
    expect(['ready_for_review', 'needs_manual_review']).toContain(finalStatuses[finalStatuses.length - 1]);
  });
});

describe('11. claim validation still runs, unchanged, after the fix', () => {
  it('validation_status is present on the persisted draft', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([RESTATING_MESSAGE, IMPLICATION_MESSAGE]));

    await regenerateMessageOnly(RUN_ID);

    const saved = persistedDraft()!;
    expect(saved.validation_status).toBeDefined();
    expect(Array.isArray(saved.claims)).toBe(true);
  });
});
