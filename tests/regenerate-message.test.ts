import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunRow, DraftRow, RunStageRow, SourceRow } from '@/lib/types';
import type { IdentityVerification } from '@/lib/identity/types';

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

/**
 * The pipeline now makes two differently-shaped model calls: the research pass
 * (analyze_prospect) and the dedicated email writer (write_outreach_email).
 * Route by the purpose the production code declares, so each call gets the
 * shape it actually expects.
 */
/** A regenerated draft that clears every check on the first attempt. */
const FRESH_MESSAGE = [
  'Hi there, noticed PRISM realigned its finance operations leadership recently.',
  'As that structure settles, keeping vendor payment volume, invoice matching and reconciliation ' +
    'consistent across the finance function takes real coordination between the teams involved.',
  'Zamp can process invoices, match and reconcile payables against purchase orders, flag the ' +
    'exceptions that need a human, and run accounts payable workflows end to end across the group.',
  "I'd be keen to understand how your team handles that today and where we could be useful. " +
    'Would be great to compare notes on a short call.',
].join('\n\n');

function routeByPurpose(analysis: unknown, message: string, claims: unknown[]) {
  return (args: { purpose: string }) => {
    if (args.purpose === 'write_outreach_email') {
      return Promise.resolve({
        data: { subject: 'Invoice processing', message, messageClaims: claims },
        meta: { model: 'test', used_fallback_model: false, purpose: 'write_outreach_email', duration_ms: 1, attempts: 1, total_tokens: null },
      });
    }
    // The editorial pass returns the draft unchanged, which chooseDraft()
    // treats as "no edit" and keeps the written version.
    if (args.purpose === 'edit_outreach_email') {
      return Promise.resolve({
        data: { message, changed: false, messageClaims: claims },
        meta: { model: 'test', used_fallback_model: false, purpose: 'edit_outreach_email', duration_ms: 1, attempts: 1, total_tokens: null },
      });
    }
    return Promise.resolve(analysis);
  };
}

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
      // Updated for the Phase 3 quality bar (checkEmailQuality): 3-4
      // paragraphs, 90-130 words, product described as work, collaborative
      // close, no em dash. The opening clause is unchanged, because it is a
      // paraphrase of the hook rather than a restatement of it.
      suggestedMessage: [
        'Hi there, noticed PRISM realigned its finance operations leadership recently.',
        'As that structure settles, keeping vendor payment volume, invoice matching and reconciliation ' +
          'consistent across the finance function takes real coordination between the teams involved.',
        'Zamp can process invoices, match and reconcile payables against purchase orders, flag the ' +
          'exceptions that need a human, and run accounts payable workflows end to end across the group.',
        "I'd be keen to understand how your team handles that today and where we could be useful. " +
          'Would be great to compare notes on a short call.',
      ].join('\n\n'),
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
    mockCallStructured.mockImplementation(routeByPurpose(goodModelResponse(), FRESH_MESSAGE, []));

    await regenerateMessageOnly(RUN_ID);

    // The rewrite now goes to the dedicated writer, carrying the run's settled
    // brief plus the instruction — not back to the research corpus.
    const write = mockCallStructured.mock.calls.map((c) => c[0]).find((c) => c.purpose === 'write_outreach_email');
    expect(write).toBeDefined();
    expect(write!.input).toContain('EMAIL BRIEF');
    expect(write!.input).toMatch(/REWRITE/);
    expect(write!.input).toMatch(/genuinely different version/i);
    // The prior draft was NOT reused — the model was asked to write anew.
    expect(write!.input).not.toContain('OLD DRAFT TEXT');
  });

  it('does not re-run research, qualification, or signal extraction', async () => {
    mockCallStructured.mockImplementation(routeByPurpose(goodModelResponse(), FRESH_MESSAGE, []));

    await regenerateMessageOnly(RUN_ID);

    // Only the hook/generate_message/draft/sources rehydration path ran —
    // sources are read exactly once (by rehydrate()), never re-fetched or
    // re-searched, regardless of how many model calls the quality gate makes.
    expect(mockListSources).toHaveBeenCalledTimes(1);
    // One write plus one editorial pass; a quality failure may add one retry.
    expect(mockCallStructured.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockCallStructured.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('saves a genuinely new draft — deletes the old one, creates a new one with the fresh text', async () => {
    mockCallStructured.mockImplementation(routeByPurpose(goodModelResponse(), FRESH_MESSAGE, []));

    await regenerateMessageOnly(RUN_ID);

    expect(mockDeleteDrafts).toHaveBeenCalledWith(RUN_ID);
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    const created = mockCreateDraft.mock.calls[0][0];
    expect(created.message_text).toContain('vendor payment volume');
    expect(created.message_text).not.toBe('OLD DRAFT TEXT');
    expect(created.hook_signal_id).toBe('signal-1'); // carried over from the prior draft
  });

  it('runs claim validation on the new draft', async () => {
    mockCallStructured.mockImplementation(routeByPurpose(goodModelResponse(), FRESH_MESSAGE, []));

    await regenerateMessageOnly(RUN_ID);

    expect(mockUpdateDraft).toHaveBeenCalled();
    const patch = mockUpdateDraft.mock.calls[0][1];
    expect(patch.validation_status).toBeDefined();
  });

  it('finalizes the run to a real terminal status, not left running', async () => {
    mockCallStructured.mockImplementation(routeByPurpose(goodModelResponse(), FRESH_MESSAGE, []));

    await regenerateMessageOnly(RUN_ID);

    const statuses = mockUpdateRun.mock.calls.map((c) => c[1]?.status).filter(Boolean);
    expect(statuses[0]).toBe('running');
    const finalStatus = statuses[statuses.length - 1];
    expect(['ready_for_review', 'needs_manual_review']).toContain(finalStatus);
  });
});

describe('regenerateMessageOnly — failure and precondition handling', () => {
  it('when the model returns no usable text, the existing draft is preserved and the run status is restored', async () => {
    // The writer is what produces the email now, so an unusable rewrite is an
    // empty message from write_outreach_email.
    mockCallStructured.mockImplementation(routeByPurpose(goodModelResponse(), '', []));

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

// ─── identity is not re-litigated on a message-only regenerate ──────────────
//
// The live smoke test found: a run with a genuinely VERIFIED, high-confidence
// identity — established through the full identity-verification subsystem,
// via public-web corroboration, with no direct LinkedIn profile and no typed
// hints — was demoted to `needs_manual_review` after Regenerate Message, even
// though the regenerated message and its solution match were both correct.
//
// Root cause: `rehydrate()` rebuilds `ctx.identity` from nothing but the
// stored profile and typed hints via `resolveIdentity()`, which has no way to
// see the run's own persisted `identity_verification`. A profile-less,
// hint-less run reports `resolved: false` regardless of what verification
// actually concluded, and `readyForReviewStage` reads exactly that field.
//
// Fix: `rehydrateForMessageRegeneration()` now reconciles `ctx.identity`
// against `ctx.identityVerification` (`reconcileIdentityForRegeneration()` in
// lib/pipeline/execute.ts) before anything downstream runs.

const identityVerification = (over: Partial<IdentityVerification> = {}): IdentityVerification =>
  ({
    status: 'VERIFIED',
    confidence: 92,
    resolution: 'AUTOMATIC',
    resolved: {
      name: 'Priya Raman',
      role: 'VP Finance Operations',
      company: 'Bluewave Freight',
      location: null,
      linkedin_url: null,
    },
    candidates: [],
    conflicts: [],
    missing_fields: [],
    reason: 'Corroborated across multiple independent public sources.',
    proceed: true,
    selected_candidate_id: null,
    ...over,
  }) as IdentityVerification;

// A message crafted to clear every real, unmodified quality gate — see
// tests/solution-fit-e2e.test.ts, where this exact pairing was verified
// against checkPersonalization/checkOpener/checkVoice directly.
const VERIFIED_HOOK_SIGNAL = 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.';
// Updated for the Phase 3 quality bar, same as tests/solution-fit-e2e.ts. The
// old text described the product as "AI agents that handle...", which
// checkEmailQuality() now correctly rejects as product-category language.
const CLEAN_MESSAGE = [
  "Priya, saw Bluewave pulling its regional vendor invoicing into one workflow this quarter.",
  "Consolidations like that usually mean someone has to standardize invoice matching and reconciliation " +
    "across the merged entities before it settles into a routine process.",
  "Zamp can process invoices, match and reconcile payables against purchase orders, and run accounts " +
    "payable automation end to end across those entities.",
  "I'd be keen to understand how the transition is being handled today and where we could be useful. " +
    "Would be great to compare notes on a short call whenever it suits.",
].join("\n\n");

const verifiedRunSelectHookStage = (): RunStageRow =>
  ({
    ...selectHookStage(),
    output: {
      selected: {
        signal: VERIFIED_HOOK_SIGNAL,
        why_it_matters: 'Consolidation projects like this typically drive AP process changes.',
        signal_level: 'COMPANY',
        role_relevance: 'As VP Finance Operations, Priya now owns the consolidated AP workflow across entities.',
        outreach_rationale: 'The consolidation is actively underway, a timely, concrete reason to reach out.',
        source_url: HOOK_SOURCE_URL,
        source_title: 'Bluewave Freight AP Consolidation Update',
        supporting_quote: VERIFIED_HOOK_SIGNAL,
        evidence_level: 'FULL',
        published_date: '2026-08-01',
        composite_score: 84,
      },
      confidence: 80,
    },
  }) as RunStageRow;

function cleanModelResponse(overrides: Record<string, unknown> = {}) {
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
      suggestedMessage: CLEAN_MESSAGE,
      messageClaims: [
        {
          claim: VERIFIED_HOOK_SIGNAL,
          type: 'COMPANY_FACT',
          verdict: 'SUPPORTED',
          evidence_url: HOOK_SOURCE_URL,
          explanation: 'Matches the retrieved source content verbatim.',
        },
      ],
      confidence: 80,
      informationRequests: [],
      ...overrides,
    },
    meta: { model: 'test', used_fallback_model: false, purpose: 'analyze_prospect', duration_ms: 1, attempts: 1, total_tokens: null },
  };
}

describe('regenerateMessageOnly — identity is reused, not re-litigated', () => {
  it('a VERIFIED, profile-less, hint-less run stays ready_for_review after a clean regeneration', async () => {
    mockGetRun.mockResolvedValue(
      run({
        // The exact conditions that fooled a fresh resolveIdentity() call:
        // no direct profile, no typed hints — identity was established
        // entirely through the identity-verification subsystem instead.
        linkedin_profile: null,
        input_name: null,
        input_company: null,
        input_title: null,
        identity_verification: identityVerification(),
        selected_hook: VERIFIED_HOOK_SIGNAL,
      }),
    );
    mockGetStage.mockImplementation((_runId: string, name: string) => {
      if (name === 'select_hook') return Promise.resolve(verifiedRunSelectHookStage());
      if (name === 'generate_message') return Promise.resolve(generateMessageStageRow());
      return Promise.resolve(null);
    });
    mockGetDraft.mockResolvedValue(draft({ message_text: 'OLD DRAFT TEXT' }));
    mockListSources.mockResolvedValue([
      source({ content: 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.' }),
    ]);
    mockCallStructured.mockImplementation(routeByPurpose(cleanModelResponse(), CLEAN_MESSAGE, []));

    await regenerateMessageOnly(RUN_ID);

    // The clean message cleared every gate on the first attempt — no forced
    // internal retry, so the identity fix is what's under test here, not a
    // lucky pass on a second try.
    // Exactly one write and one edit — no forced regeneration.
    const purposes = mockCallStructured.mock.calls.map((c) => (c[0] as { purpose: string }).purpose);
    expect(purposes.filter((p) => p === 'write_outreach_email')).toHaveLength(1);

    const statuses = mockUpdateRun.mock.calls.map((c) => c[1]);
    const final = statuses[statuses.length - 1];
    expect(final.status).toBe('ready_for_review');
    expect(final.error).toBeNull();
  });

  it('a genuinely AMBIGUOUS identity still results in manual review, even with a clean regeneration', async () => {
    mockGetRun.mockResolvedValue(
      run({
        linkedin_profile: null,
        input_name: null,
        input_company: null,
        input_title: null,
        identity_verification: identityVerification({
          status: 'AMBIGUOUS',
          proceed: false,
          reason: 'Multiple plausible candidates; a human never confirmed which one this is.',
        }),
        selected_hook: VERIFIED_HOOK_SIGNAL,
      }),
    );
    mockGetStage.mockImplementation((_runId: string, name: string) => {
      if (name === 'select_hook') return Promise.resolve(verifiedRunSelectHookStage());
      if (name === 'generate_message') return Promise.resolve(generateMessageStageRow());
      return Promise.resolve(null);
    });
    mockGetDraft.mockResolvedValue(draft({ message_text: 'OLD DRAFT TEXT' }));
    mockListSources.mockResolvedValue([
      source({ content: 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.' }),
    ]);
    mockCallStructured.mockImplementation(routeByPurpose(cleanModelResponse(), CLEAN_MESSAGE, []));

    await regenerateMessageOnly(RUN_ID);

    const statuses = mockUpdateRun.mock.calls.map((c) => c[1]);
    const final = statuses[statuses.length - 1];
    expect(final.status).toBe('needs_manual_review');
  });

  it('a FAILED identity verification still results in manual review', async () => {
    mockGetRun.mockResolvedValue(
      run({
        linkedin_profile: null,
        input_name: null,
        input_company: null,
        input_title: null,
        identity_verification: identityVerification({
          status: 'FAILED',
          proceed: false,
          reason: 'No corroborating evidence could be found for this person.',
        }),
        selected_hook: VERIFIED_HOOK_SIGNAL,
      }),
    );
    mockGetStage.mockImplementation((_runId: string, name: string) => {
      if (name === 'select_hook') return Promise.resolve(verifiedRunSelectHookStage());
      if (name === 'generate_message') return Promise.resolve(generateMessageStageRow());
      return Promise.resolve(null);
    });
    mockGetDraft.mockResolvedValue(draft({ message_text: 'OLD DRAFT TEXT' }));
    mockListSources.mockResolvedValue([
      source({ content: 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.' }),
    ]);
    mockCallStructured.mockImplementation(routeByPurpose(cleanModelResponse(), CLEAN_MESSAGE, []));

    await regenerateMessageOnly(RUN_ID);

    const statuses = mockUpdateRun.mock.calls.map((c) => c[1]);
    const final = statuses[statuses.length - 1];
    expect(final.status).toBe('needs_manual_review');
  });

  it('with no persisted identity_verification at all, behavior is unchanged (pre-existing runs)', async () => {
    // `identity_verification: null` is exactly the default `run()` fixture
    // used throughout this file — reconciliation must no-op, not throw.
    mockGetRun.mockResolvedValue(
      run({
        linkedin_profile: null,
        input_name: null,
        input_company: null,
        input_title: null,
        identity_verification: null,
        selected_hook: VERIFIED_HOOK_SIGNAL,
      }),
    );
    mockGetStage.mockImplementation((_runId: string, name: string) => {
      if (name === 'select_hook') return Promise.resolve(verifiedRunSelectHookStage());
      if (name === 'generate_message') return Promise.resolve(generateMessageStageRow());
      return Promise.resolve(null);
    });
    mockGetDraft.mockResolvedValue(draft({ message_text: 'OLD DRAFT TEXT' }));
    mockListSources.mockResolvedValue([
      source({ content: 'Bluewave Freight is consolidating vendor invoicing across three regional entities this quarter.' }),
    ]);
    mockCallStructured.mockImplementation(routeByPurpose(cleanModelResponse(), CLEAN_MESSAGE, []));

    await expect(regenerateMessageOnly(RUN_ID)).resolves.not.toThrow();
  });
});
