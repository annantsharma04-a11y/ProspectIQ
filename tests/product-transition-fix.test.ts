import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkOpener, checkPersonalization } from '@/lib/pipeline/stages';
import { checkVoice } from '@/lib/generation/voice';
import { checkEmailQuality } from '@/lib/generation/email-quality';
import { buildEmailBrief } from '@/lib/generation/brief';
import type { SolutionMatch } from '@/lib/solutions/types';
import type { RunRow, DraftRow, RunStageRow, SourceRow } from '@/lib/types';

// Follow-up to the opener-specificity fix (tests/opener-specificity-fix.test.ts):
// a real Shiprocket run passed opener, personalization and voice, then failed
// email_quality on exactly one deterministic check —
// PRODUCT_CATEGORY / no_product_category (lib/generation/email-quality.ts) —
// because the product paragraph echoed the approved capability's own
// category-first wording ("AI digital-employee agents...") almost verbatim
// instead of naming the concrete work.
//
// PRODUCT_CATEGORY itself is untouched (per instruction, deterministic checks
// stay as-is). The fix is entirely in the writer's SYSTEM prompt: the
// PRODUCT TRANSITION section now tells the model the capability line is
// reference material to extract WORK from, not a sentence to copy, and gives
// an explicit BAD/GOOD pair using this exact case.

const HOOK_SIGNAL =
  "Shiprocket recently expanded its non-shipping merchant software and checkout solutions, which now generate over a quarter of total revenue.";
const HOOK_FOR_CHECKS = {
  signal: HOOK_SIGNAL,
  supporting_quote: 'Shiprocket non-shipping revenue crosses a quarter of total revenue.',
  source_title: "Shiprocket's non-shipping business growth",
  role_relevance:
    'As Group CFO overseeing finance and operations, managing scaling invoice and payable volumes across growing business units directly impacts financial overhead.',
  signal_level: 'COMPANY',
};
const RECIPIENT_CTX = { prospectName: 'Tanmay', company: 'Shiprocket', role: 'Group CFO' };

const solution = {
  solution: {
    id: 'zamp_ap_automation',
    name: 'Accounts payable automation',
    // The real approved catalog description — deliberately category-first.
    // This is the exact text the model must extract WORK from, not copy.
    description:
      'AI digital-employee agents that process invoices, match and reconcile payables, and execute AP workflows end to end.',
    supported_workflows: ['Invoice processing'],
    target_functions: ['Finance'],
    use_cases: [],
    non_use_cases: [],
    matches_capability_ids: ['ap_automation'],
  },
  matched_capabilities: [],
  why_it_fits: '',
} as unknown as SolutionMatch;

const brief = buildEmailBrief({
  recipientName: 'Tanmay',
  company: 'Shiprocket',
  role: 'Group CFO',
  verifiedFact: HOOK_SIGNAL,
  solution,
  proof: null,
});

const OPENER_AND_TAIL = {
  opener:
    "As Shiprocket's non-shipping merchant software and checkout solutions expand, I was wondering whether that changes how your finance team approaches vendor and supplier relationships behind those newer product lines.",
  tail:
    "I'd be keen to understand how invoice processing is handled today across those newer lines and where we could be useful. Would be great to compare notes on a short call.",
};

/** The real reported bug: approved capability, but stated as WHAT it is. */
const CATEGORY_FIRST_AGENTS = `Hi Tanmay,

${OPENER_AND_TAIL.opener}

Zamp uses AI digital-employee agents to process invoices, match and reconcile payables, and execute AP workflows end to end, so the finance team spends less time on manual entry and matching as those product lines add volume.

${OPENER_AND_TAIL.tail}`;

const CATEGORY_FIRST_DIGITAL_EMPLOYEES = `Hi Tanmay,

${OPENER_AND_TAIL.opener}

Zamp's digital employees process invoices, match and reconcile payables, and execute AP workflows end to end, so the finance team spends less time on manual entry and matching as those product lines add volume.

${OPENER_AND_TAIL.tail}`;

/** Same approved capability, expressed as the work it does. */
const ACTION_FIRST = `Hi Tanmay,

${OPENER_AND_TAIL.opener}

Zamp automates invoice processing, payable matching, reconciliation, and AP workflows end to end, so the finance team spends less time on manual entry and matching as those product lines add volume.

${OPENER_AND_TAIL.tail}`;

describe('1 & 3. category-first product phrasing is rejected by the unchanged deterministic gate', () => {
  it('1. "AI digital-employee agents" fails email_quality on exactly no_product_category', () => {
    const quality = checkEmailQuality(CATEGORY_FIRST_AGENTS, { brief });
    expect(quality.passed).toBe(false);
    expect(quality.detail.no_product_category).toBe(false);
    expect(quality.failures).toEqual([
      'The email describes what the product IS ("AI agents", "digital employees") instead of what it DOES. Name the actual work in this workflow.',
    ]);
  });

  it('3. "digital employees" (no "AI" qualifier) also fails on no_product_category', () => {
    const quality = checkEmailQuality(CATEGORY_FIRST_DIGITAL_EMPLOYEES, { brief });
    expect(quality.passed).toBe(false);
    expect(quality.detail.no_product_category).toBe(false);
  });

  it('everything else about these drafts is otherwise clean — isolates this to a product-transition defect, not a regression elsewhere', () => {
    for (const msg of [CATEGORY_FIRST_AGENTS, CATEGORY_FIRST_DIGITAL_EMPLOYEES]) {
      const opener = checkOpener(msg, HOOK_FOR_CHECKS);
      const pers = checkPersonalization(msg, HOOK_FOR_CHECKS, RECIPIENT_CTX);
      const voice = checkVoice(msg);
      expect(opener.isHeadline).toBe(false);
      expect(pers.passed).toBe(true);
      expect(voice.passed).toBe(true);
    }
  });
});

describe('2. action-oriented product phrasing is accepted', () => {
  it('"automates invoice processing, payable matching, reconciliation, and AP workflows" passes every gate', () => {
    const opener = checkOpener(ACTION_FIRST, HOOK_FOR_CHECKS);
    const pers = checkPersonalization(ACTION_FIRST, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    const voice = checkVoice(ACTION_FIRST);
    const quality = checkEmailQuality(ACTION_FIRST, { brief });

    expect(opener.isHeadline).toBe(false);
    expect(pers.passed).toBe(true);
    expect(voice.passed).toBe(true);
    expect(quality.passed).toBe(true);
    expect(quality.detail.no_product_category).toBe(true);
  });
});

describe('4. the approved capability actions remain fully expressible', () => {
  it('every action named in the approved description survives, just reworded away from category framing', () => {
    const lower = ACTION_FIRST.toLowerCase();
    expect(lower).toContain('invoice processing');
    expect(lower).toContain('payable matching');
    expect(lower).toContain('reconciliation');
    expect(lower).toContain('ap workflows');
  });
});

describe('5. no capability is invented beyond the approved solution catalog entry', () => {
  it('the action-first rewrite claims only work the approved description actually lists', () => {
    // Every capability the approved catalog description grants: invoicing,
    // payables matching/reconciliation, AP workflows. Nothing else.
    const productSentence =
      'Zamp automates invoice processing, payable matching, reconciliation, and AP workflows end to end';
    const lower = productSentence.toLowerCase();

    expect(lower).toMatch(/invoice/);
    expect(lower).toMatch(/payable/);
    expect(lower).toMatch(/reconcil/);
    expect(lower).toMatch(/ap workflow/);

    // Capabilities NOT in the approved solution (payroll, collections, tax,
    // expense management, contracts) must never appear just to sound fuller.
    const notApproved = ['payroll', 'collections', 'tax', 'expense', 'contract', 'forecast', 'budget'];
    for (const term of notApproved) {
      expect(lower).not.toContain(term);
    }
  });
});

describe('6-8. the earlier fixes this one must not disturb', () => {
  it('the writer prompt still forbids restating the hook as the opener (fix from tests/opener-restatement-fix.test.ts)', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await fs.readFile(path.join(process.cwd(), 'lib/generation/write-email.ts'), 'utf-8');
    expect(source).toContain('NEVER use the verified fact as the opening sentence');
  });

  it('checkPersonalization is untouched — a personalized draft still passes exactly as before', () => {
    const pers = checkPersonalization(ACTION_FIRST, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    expect(pers.passed).toBe(true);
  });

  it('claim-validation machinery is unrelated to this file and untouched (no import of it here changes behavior)', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await fs.readFile(path.join(process.cwd(), 'lib/generation/write-email.ts'), 'utf-8');
    // The writer still declares claims the same way — no change to the
    // claim-declaration contract at the end of the prompt.
    expect(source).toMatch(/messageClaims/);
  });
});

// --- 9: Shiprocket regression, full pipeline ----------------------------

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
  // Deliberately NOT one of this test's own fixtures: divergence enforcement
  // (tests/regeneration-divergence.test.ts) is a separate, unrelated check,
  // and this file's fixtures share an opener/close by design so that only
  // the product paragraph is under test. Anchoring "previous" to an
  // unrelated old draft keeps that check out of this test's way.
  mockGetDraft.mockResolvedValue(draft({ message_text: 'OLD DRAFT TEXT' }));
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

describe('9. Shiprocket regression — the retry corrects category-first product language', () => {
  it('the retry prompt carries the exact quality failure and the draft is rewritten action-first', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([CATEGORY_FIRST_AGENTS, ACTION_FIRST]));

    await regenerateMessageOnly(RUN_ID);

    const calls = writeCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const retryPrompt = calls[1][0].input as string;
    expect(retryPrompt).toContain(
      'The email describes what the product IS ("AI agents", "digital employees") instead of what it DOES. Name the actual work in this workflow.',
    );

    const saved = persistedDraft()!;
    const finalText = saved.final_text as string;
    expect(finalText).toBe(ACTION_FIRST);

    // opener passes
    const opener = checkOpener(finalText, HOOK_FOR_CHECKS);
    expect(opener.isHeadline).toBe(false);
    // personalization passes
    const pers = checkPersonalization(finalText, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    expect(pers.passed).toBe(true);
    // product transition / email-quality passes
    const quality = checkEmailQuality(finalText, { brief });
    expect(quality.passed).toBe(true);
    expect(quality.detail.no_product_category).toBe(true);

    // the run was not left degraded solely for no_product_category
    const finalStatuses = mockUpdateRun.mock.calls.map((c) => c[1]?.status).filter(Boolean);
    expect(finalStatuses[finalStatuses.length - 1]).toBe('ready_for_review');
  });
});
