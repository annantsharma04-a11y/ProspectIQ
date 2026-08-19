import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkOpener, checkPersonalization } from '@/lib/pipeline/stages';
import { checkVoice } from '@/lib/generation/voice';
import { checkEmailQuality, MIN_EMAIL_WORDS, MAX_EMAIL_WORDS } from '@/lib/generation/email-quality';
import { buildEmailBrief } from '@/lib/generation/brief';
import type { SolutionMatch } from '@/lib/solutions/types';
import type { RunRow, DraftRow, RunStageRow, SourceRow } from '@/lib/types';

// Follow-up to the product-transition fix (tests/product-transition-fix.test.ts):
// a real Shiprocket run passed every other check and failed email_quality on
// exactly one thing — an 88-word body, under the 90-word minimum. The generic
// repairDirective retry ("EMAIL QUALITY FAILURES: ...") does not tell the
// model HOW to add words without inventing a pain or padding with filler,
// which is exactly what a too-short draft needs to hear. The fix adds a
// dedicated retry instruction for the word-count-only failure case, and a
// LENGTH block in the writer's SYSTEM prompt explaining what is allowed to
// grow a short draft (specificity, role relevance, clarity, CTA context) and
// what is not (padding, a second CTA, hook repetition, invented pain).
//
// MIN_EMAIL_WORDS/MAX_EMAIL_WORDS (90/130) are untouched — this file proves
// the existing boundaries still hold exactly, then proves the NEW retry
// routing on top of them.

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

/** Exactly 88 words — the real reported case. Fails word_count only. */
const SHORT_88 = `Hi Tanmay,

As Shiprocket's non-shipping merchant software and checkout solutions continue expanding quite rapidly, I was wondering whether that changes how your finance team approaches vendor and supplier relationships behind those newer product lines and their day to day operations.

Zamp automates invoice processing, payable matching, reconciliation, and AP workflows end to end for finance teams handling that kind of growing transaction volume.

I'd be keen to understand how invoice processing is handled today and where we could be useful. Would be great to compare notes on a short call.`;

/** 107 words — inside the 100-115 target. Passes every gate. */
const EXPANDED_107 = `Hi Tanmay,

With Shiprocket expanding into merchant software and checkout solutions beyond core logistics, I was wondering whether onboarding new merchant categories adds meaningfully to the invoice and payables volume your finance team already handles, and whether that changes how vendor relationships get managed day to day.

Zamp automates invoice processing, payable matching, reconciliation, and AP workflows end to end, so the finance team spends less time on manual entry and matching as those product lines add volume.

I'd be keen to understand how invoice processing is handled today across those newer lines and where we could be useful. Would be great to compare notes on a short call.`;

function nWordBody(n: number): string {
  const words = Array.from({ length: n }, (_, i) => `word${i}`);
  return `Hi Tanmay,\n\n${words.join(' ')}.\n\nBest,\nSender`;
}

describe('1. an 88-word draft fails on word_count, isolated from every other check', () => {
  it('checkEmailQuality flags exactly the word-count failure', () => {
    const quality = checkEmailQuality(SHORT_88, { brief });
    expect(quality.wordCount).toBe(88);
    expect(quality.passed).toBe(false);
    expect(quality.detail.word_count).toBe(false);
    expect(quality.failures).toEqual([
      'The email body is 88 words. The structure needs 90-130; aim for 100-115.',
    ]);
  });

  it('opener, personalization and voice all pass on the same draft', () => {
    const opener = checkOpener(SHORT_88, HOOK_FOR_CHECKS);
    const pers = checkPersonalization(SHORT_88, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    const voice = checkVoice(SHORT_88);
    expect(opener.isHeadline).toBe(false);
    expect(pers.passed).toBe(true);
    expect(voice.passed).toBe(true);
  });
});

describe('2. a 100-115 word draft has no word-count failure', () => {
  it('the 107-word expansion passes every gate, including word_count', () => {
    expect(EXPANDED_107.trim().length).toBeGreaterThan(0);
    const opener = checkOpener(EXPANDED_107, HOOK_FOR_CHECKS);
    const pers = checkPersonalization(EXPANDED_107, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    const voice = checkVoice(EXPANDED_107);
    const quality = checkEmailQuality(EXPANDED_107, { brief });

    expect(quality.wordCount).toBeGreaterThanOrEqual(100);
    expect(quality.wordCount).toBeLessThanOrEqual(115);
    expect(quality.detail.word_count).toBe(true);
    expect(quality.passed).toBe(true);
    expect(opener.isHeadline).toBe(false);
    expect(pers.passed).toBe(true);
    expect(voice.passed).toBe(true);
  });
});

describe('3-6. the 90/130-word boundaries are exactly where the check already draws them', () => {
  it('3. 89 words still fails', () => {
    const q = checkEmailQuality(nWordBody(89), { brief: null });
    expect(q.wordCount).toBe(89);
    expect(q.detail.word_count).toBe(false);
  });

  it('4. 90 words passes the word-count check', () => {
    const q = checkEmailQuality(nWordBody(90), { brief: null });
    expect(q.wordCount).toBe(90);
    expect(q.detail.word_count).toBe(true);
  });

  it('5. 130 words passes the word-count check', () => {
    const q = checkEmailQuality(nWordBody(130), { brief: null });
    expect(q.wordCount).toBe(130);
    expect(q.detail.word_count).toBe(true);
  });

  it('6. 131 words fails', () => {
    const q = checkEmailQuality(nWordBody(131), { brief: null });
    expect(q.wordCount).toBe(131);
    expect(q.detail.word_count).toBe(false);
  });

  it('MIN_EMAIL_WORDS and MAX_EMAIL_WORDS are unchanged (90/130) — the thresholds this fix must not weaken', () => {
    expect(MIN_EMAIL_WORDS).toBe(90);
    expect(MAX_EMAIL_WORDS).toBe(130);
  });
});

// --- 7-10: end-to-end regeneration behavior -----------------------------

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
  // An unrelated old draft, so divergence enforcement (a separate, untouched
  // check) never becomes the bottleneck in these word-count-focused tests.
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

describe('1 (integration). the retry prompt carries the dedicated word-count instruction', () => {
  it('an 88-word first draft gets the exact expansion instruction, word for word', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([SHORT_88, EXPANDED_107]));

    await regenerateMessageOnly(RUN_ID);

    const calls = writeCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const retryPrompt = calls[1][0].input as string;
    expect(retryPrompt).toContain(
      'The previous draft is below the required 90-word minimum. Expand it naturally to approximately 100–115 words by adding substantive, prospect-specific context or a clearer role-relevant question. Do not repeat the research hook, invent a business pain, or add generic filler.',
    );
  });
});

describe('7. the word-count branch does not replace the opener-restatement branch', () => {
  it('a restating opener that is otherwise a WELL-SIZED draft (no quality failure at all) gets only the restatement instruction — the word-count branch does not fire when quality already passed', async () => {
    const restatingButWellSized = `Hi Tanmay,

${HOOK_SIGNAL}

Zamp automates invoice processing, payable matching, reconciliation, and AP workflows end to end, so the finance team spends less time on manual entry and matching as those product lines add volume across the business.

I'd be keen to understand how invoice processing is handled today across those newer lines and where we could be useful, and whether that changes how vendor relationships get managed. Would be great to compare notes on a short call.`;
    mockCallStructured.mockImplementation(routeByPurpose([restatingButWellSized, EXPANDED_107]));

    await regenerateMessageOnly(RUN_ID);

    const retryPrompt = writeCalls()[1][0].input as string;
    expect(retryPrompt).toContain(
      'The previous opener was rejected because it restated the research signal. Do not rewrite the same sentence. Do not paraphrase the hook. Start from the implication for the prospect\'s role instead.',
    );
    expect(retryPrompt).not.toContain('below the required 90-word minimum');
  });

  it('when a draft is BOTH restating and short, the retry legitimately carries both dedicated instructions — one branch is not swallowed by the other', async () => {
    const shortAndRestating =
      `Hi Tanmay,\n\n${HOOK_SIGNAL}\n\nZamp automates invoice processing, payable matching, reconciliation, and AP workflows end to end.\n\nWorth a chat?`;
    mockCallStructured.mockImplementation(routeByPurpose([shortAndRestating, EXPANDED_107]));

    await regenerateMessageOnly(RUN_ID);

    const retryPrompt = writeCalls()[1][0].input as string;
    expect(retryPrompt).toContain('The previous opener was rejected because it restated the research signal.');
    expect(retryPrompt).toContain('below the required 90-word minimum');
  });
});

describe('8. the word-count retry does not introduce unsupported pain', () => {
  it('the SYSTEM prompt LENGTH guidance explicitly forbids inventing a pain to add length', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await fs.readFile(path.join(process.cwd(), 'lib/generation/write-email.ts'), 'utf-8');
    expect(source).toContain('LENGTH:');
    expect(source).toMatch(/do not invent an operational pain/i);
  });

  it('the accepted expansion fixture itself carries no assumed-pain assertion', () => {
    const pers = checkPersonalization(EXPANDED_107, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    expect(pers.detail.no_assumed_pain).toBe(true);
  });
});

describe('9. the word-count retry does not introduce hook repetition', () => {
  it('the retry directive itself never quotes the hook text', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([SHORT_88, EXPANDED_107]));

    await regenerateMessageOnly(RUN_ID);

    const retryPrompt = writeCalls()[1][0].input as string;
    // The directive text is generic and short — it must not embed the hook.
    const directiveOnly = retryPrompt.split('REGENERATION —')[1] ?? retryPrompt;
    expect(directiveOnly.split('below the required 90-word minimum')[1]?.slice(0, 400) ?? '').not.toContain(
      HOOK_SIGNAL,
    );
  });

  it('the accepted expansion fixture does not restate the hook', () => {
    const opener = checkOpener(EXPANDED_107, HOOK_FOR_CHECKS);
    expect(opener.isHeadline).toBe(false);
  });
});

describe('10. Shiprocket regression — the retry reaches ready_for_review once the second draft is 100-115 words', () => {
  it('the final persisted draft is the expanded, passing rewrite', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([SHORT_88, EXPANDED_107]));

    await regenerateMessageOnly(RUN_ID);

    const saved = persistedDraft()!;
    const finalText = saved.final_text as string;
    expect(finalText).toBe(EXPANDED_107);

    const opener = checkOpener(finalText, HOOK_FOR_CHECKS);
    const pers = checkPersonalization(finalText, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    const voice = checkVoice(finalText);
    const quality = checkEmailQuality(finalText, { brief });
    expect(opener.isHeadline).toBe(false);
    expect(pers.passed).toBe(true);
    expect(voice.passed).toBe(true);
    expect(quality.passed).toBe(true);
    expect(quality.wordCount).toBeGreaterThanOrEqual(100);
    expect(quality.wordCount).toBeLessThanOrEqual(115);

    const finalStatuses = mockUpdateRun.mock.calls.map((c) => c[1]?.status).filter(Boolean);
    expect(finalStatuses[finalStatuses.length - 1]).toBe('ready_for_review');
  });

  it('if the retry is STILL short, the run degrades honestly — one regeneration only, no loop', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([SHORT_88, SHORT_88]));

    await regenerateMessageOnly(RUN_ID);

    expect(writeCalls().length).toBe(2);
    const finalStatuses = mockUpdateRun.mock.calls.map((c) => c[1]?.status).filter(Boolean);
    expect(['ready_for_review', 'needs_manual_review']).toContain(finalStatuses[finalStatuses.length - 1]);
  });
});
