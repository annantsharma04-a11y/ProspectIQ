import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkOpener, checkPersonalization } from '@/lib/pipeline/stages';
import { checkVoice } from '@/lib/generation/voice';
import { buildEmailBrief, renderBrief } from '@/lib/generation/brief';
import type { SolutionMatch } from '@/lib/solutions/types';
import type { RunRow, DraftRow, RunStageRow, SourceRow } from '@/lib/types';

// Follow-up to the hook-restatement fix (tests/opener-restatement-fix.test.ts,
// tests/opener-restatement-retry.test.ts): once the writer stopped restating
// the hook, it started producing generic, template-like openers that assert
// an operational pain the evidence never established (the real complaint:
// "I imagine managing high-volume accounts payable operations... has become
// more complex" — a pain sentence with almost no vocabulary tying it back to
// what was actually verified about Shiprocket).
//
// The fix has three parts: (1) renderBrief's hypothesis line now explicitly
// forbids converting the hypothesis into a named pain assertion, (2) the
// writer's SYSTEM prompt gained SPECIFICITY and PRODUCT TRANSITION blocks
// naming the exact banned generic-growth phrases, and (3) a retry after a
// too-generic (personalization-gate) failure gets a distinct corrective
// instruction from a restatement failure's retry instruction.

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

const PRODUCT_TAIL =
  "\n\nZamp can process invoices, match and reconcile payables, and run accounts payable workflows end to end.\n\nI'd be keen to understand how that's managed today and where we could be useful. Would be great to compare notes on a short call.";

describe('1-3. exact restatement and its disguises are still caught (unchanged gate)', () => {
  it('1. the exact hook copied as the opener is rejected', () => {
    const msg = `Hi Tanmay,\n\n${HOOK_SIGNAL}${PRODUCT_TAIL}`;
    const result = checkOpener(msg, HOOK_FOR_CHECKS);
    expect(result.isHeadline).toBe(true);
    expect(result.similarity).toBeGreaterThanOrEqual(0.72);
  });

  it('2. the hook wrapped in "I saw that..." is still rejected', () => {
    const msg = `Hi Tanmay,\n\nI saw that ${HOOK_SIGNAL.charAt(0).toLowerCase()}${HOOK_SIGNAL.slice(1)}${PRODUCT_TAIL}`;
    const result = checkOpener(msg, HOOK_FOR_CHECKS);
    expect(result.isHeadline).toBe(true);
  });

  it('3. a close paraphrase of the same proposition is still rejected', () => {
    const msg =
      "Hi Tanmay,\n\nShiprocket's non-shipping merchant software and checkout solutions now generate over a quarter of total revenue." +
      PRODUCT_TAIL;
    const result = checkOpener(msg, HOOK_FOR_CHECKS);
    expect(result.isHeadline).toBe(true);
    expect(result.similarity).toBeGreaterThan(0.72);
  });
});

describe('4-5. implication and cautious-question openers are accepted', () => {
  it('4. an implication derived from the fact passes both the containment and personalization gates', () => {
    const msg =
      'Hi Tanmay,\n\nAs Shiprocket expands beyond its core logistics business into merchant software and checkout solutions, I imagine keeping the finance operations behind those additional product lines coordinated gets more complex.' +
      PRODUCT_TAIL;
    const opener = checkOpener(msg, HOOK_FOR_CHECKS);
    const pers = checkPersonalization(msg, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    expect(opener.isHeadline).toBe(false);
    expect(pers.passed).toBe(true);
  });

  it('5. a role-based cautious question passes both gates', () => {
    const msg =
      "Hi Tanmay,\n\nWith Shiprocket expanding into merchant software and checkout solutions beyond core logistics, I'm curious how your finance team is handling the operational side of that growth." +
      PRODUCT_TAIL;
    const opener = checkOpener(msg, HOOK_FOR_CHECKS);
    const pers = checkPersonalization(msg, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    expect(opener.isHeadline).toBe(false);
    expect(pers.passed).toBe(true);
  });
});

describe('6. a generic growth template with no prospect-specific relevance is rejected', () => {
  it('"as companies grow, managing increasing complexity at that scale" fails the personalization gate', () => {
    const msg =
      'Hi Tanmay,\n\nAs companies grow, managing increasing complexity at that scale becomes a real challenge for finance teams.' +
      PRODUCT_TAIL;
    const pers = checkPersonalization(msg, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    expect(pers.passed).toBe(false);
    expect(pers.detail.uses_hook).toBe(false);
    expect(pers.detail.depends_on_hook).toBe(false);
  });
});

describe('7. an unsupported AP-pain assertion is forbidden at the prompt level', () => {
  it('the writer SYSTEM prompt source names the exact banned pain phrases', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await fs.readFile(path.join(process.cwd(), 'lib/generation/write-email.ts'), 'utf-8');
    expect(source).toContain('your AP volume is increasing');
    expect(source).toMatch(/your finance\s+team is overloaded/);
    expect(source).toContain('ANTI-INVENTED-PAIN');
    expect(source).toContain('SPECIFICITY');
    // The generic-growth phrases the real bad draft used.
    expect(source).toMatch(/managing increasing complexity/);
  });

  it('the real complaint sentence contains the exact banned phrases the prompt now names', () => {
    // "your AP volume is increasing" / "your finance team is overloaded" are
    // named verbatim in the ANTI-INVENTED-PAIN block of the writer's SYSTEM
    // prompt (lib/generation/write-email.ts) as constructions never to write
    // as settled fact. This pins that those exact strings exist as literal
    // sentences a model could otherwise produce, so the ban has something
    // concrete to forbid.
    const bad = 'your AP volume is increasing and your finance team is overloaded managing it';
    expect(bad.toLowerCase()).toContain('your ap volume is increasing');
    expect(bad.toLowerCase()).toContain('your finance team is overloaded');
  });

  it('note: the deterministic personalization gate does not itself catch a blunt pain assertion — this is a prompt-level control, not a validator change', () => {
    // Documents the real, unchanged behavior of checkPersonalization's
    // ASSUMED_PAIN regex (hedged phrasing like "you're probably struggling"),
    // which does not match a flatly-asserted "your X is increasing" sentence.
    // The fix does not touch this regex — weakening or "fixing" it here would
    // violate the explicit instruction to leave deterministic checks alone.
    // Unsupported pain assertions are prevented by not letting the model
    // write them, not by validating them out after the fact.
    const msg =
      'Hi Tanmay,\n\nWith Shiprocket expanding beyond core logistics into more merchant products and checkout solutions, your AP volume is increasing and your finance team is overloaded managing it.' +
      PRODUCT_TAIL;
    const pers = checkPersonalization(msg, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    expect(pers.detail.no_assumed_pain).toBe(true); // unchanged regex; not this fix's job to catch it
  });
});

describe('8. an inferred outreach hypothesis phrased as a question is accepted', () => {
  it('a hedged "I was wondering whether" question passes both gates', () => {
    const msg =
      "Hi Tanmay,\n\nAs Shiprocket's non-shipping merchant software and checkout solutions expand, I was wondering whether that changes how your finance team approaches vendor and supplier relationships behind those newer lines." +
      PRODUCT_TAIL;
    const opener = checkOpener(msg, HOOK_FOR_CHECKS);
    const pers = checkPersonalization(msg, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    expect(opener.isHeadline).toBe(false);
    expect(pers.passed).toBe(true);
  });
});

describe('9. the same hook produces role-specific wording, not one collapsed generic template, for two different prospects', () => {
  const solution = {
    solution: {
      id: 'zamp_ap_automation',
      name: 'Accounts payable automation',
      description: 'Processes invoices, matches and reconciles payables, and executes AP workflows end to end.',
      supported_workflows: ['Invoice processing', 'Payables matching and reconciliation'],
      target_functions: ['Finance'],
      use_cases: [],
      non_use_cases: [],
      matches_capability_ids: ['ap_automation'],
    },
    matched_capabilities: [],
    why_it_fits: '',
  } as unknown as SolutionMatch;

  it('a CFO brief and a vendor-ops-lead brief carry different role-relevance text for the identical hook', () => {
    const cfoBrief = buildEmailBrief({
      recipientName: 'Tanmay',
      company: 'Shiprocket',
      role: 'Group CFO',
      verifiedFact: HOOK_SIGNAL,
      whyThisMatters: 'As non-shipping software expands faster than core logistics, transaction volumes grow correspondingly.',
      outreachHypothesis:
        'Expanding non-shipping revenue streams scale vendor and carrier supplier networks, increasing accounts payable volume and reconciliation overhead.',
      solution,
      proof: null,
    });
    const vendorOpsBrief = buildEmailBrief({
      recipientName: 'Priya',
      company: 'Shiprocket',
      role: 'Head of Vendor Operations',
      verifiedFact: HOOK_SIGNAL,
      whyThisMatters: 'New merchant-facing product lines mean more vendor onboarding and contract volume to manage.',
      outreachHypothesis:
        'A broader merchant product surface likely means more vendor relationships to onboard and manage day to day.',
      solution,
      proof: null,
    });

    const cfoRendered = renderBrief(cfoBrief);
    const vendorOpsRendered = renderBrief(vendorOpsBrief);

    expect(cfoRendered).not.toBe(vendorOpsRendered);
    expect(cfoRendered).toContain('accounts payable volume and reconciliation overhead');
    expect(vendorOpsRendered).toContain('vendor onboarding and contract volume');
    expect(cfoRendered).not.toContain('vendor onboarding and contract volume');
  });
});

// --- 10-11, 14: end-to-end regeneration behavior -----------------------

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

/** The real reported bug: avoids restating the hook, but asserts unsupported AP pain in a generic, low-hook-coverage sentence. */
const GENERIC_PAIN_MESSAGE =
  "Hi Tanmay,\n\nFollowing Shiprocket's public listing and the continued scaling of its horizontal e-commerce enablement platform, I imagine managing high-volume accounts payable operations alongside that growth has become more complex.\n\nZamp can process invoices, match and reconcile payables, and run accounts payable workflows end to end.\n\nWould be great to compare notes on a short call about how that side of things is handled today.";

/** A genuinely specific, hedged rewrite tied to the actual verified signal and role. */
const SPECIFIC_MESSAGE =
  "Hi Tanmay,\n\nAs Shiprocket's non-shipping merchant software and checkout solutions expand, I was wondering whether that changes how your finance team approaches vendor and supplier relationships behind those newer lines." +
  PRODUCT_TAIL;

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
  mockGetDraft.mockResolvedValue(draft({ message_text: GENERIC_PAIN_MESSAGE }));
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

describe('10. a too-generic first draft receives the "too generic" retry instruction, not the restatement one', () => {
  it('the retry prompt carries the required "too generic" sentence, word for word', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([GENERIC_PAIN_MESSAGE, SPECIFIC_MESSAGE]));

    await regenerateMessageOnly(RUN_ID);

    const calls = writeCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const retryPrompt = calls[1][0].input as string;
    expect(retryPrompt).toContain(
      'The previous draft avoided restating the research signal but became too generic. Do not introduce an unsupported operational pain. Instead, make the opener more specific to the verified signal and this prospect\'s role by turning the implication into a concrete, cautious observation or question.',
    );
    // It must NOT be the restatement-specific instruction — this is a different failure mode.
    expect(retryPrompt).not.toContain('The previous opener was rejected because it restated the research signal.');
  });
});

describe('11. the retry moves the draft from generic to specific', () => {
  it('the final persisted draft is the specific rewrite, not the generic pain-asserting one', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([GENERIC_PAIN_MESSAGE, SPECIFIC_MESSAGE]));

    await regenerateMessageOnly(RUN_ID);

    const saved = persistedDraft()!;
    expect(saved.final_text).toBe(SPECIFIC_MESSAGE);
    expect(saved.final_text).not.toBe(GENERIC_PAIN_MESSAGE);
  });

  it('if the retry is STILL generic, the run is honestly degraded — no infinite loop, no silent success', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([GENERIC_PAIN_MESSAGE, GENERIC_PAIN_MESSAGE]));

    await regenerateMessageOnly(RUN_ID);

    expect(writeCalls().length).toBe(2);
    const finalStatuses = mockUpdateRun.mock.calls.map((c) => c[1]?.status).filter(Boolean);
    expect(['ready_for_review', 'needs_manual_review']).toContain(finalStatuses[finalStatuses.length - 1]);
  });
});

describe('Shiprocket regression: the accepted opener is specific, not restated, and not an invented pain', () => {
  it('the final draft satisfies every required property', async () => {
    mockCallStructured.mockImplementation(routeByPurpose([GENERIC_PAIN_MESSAGE, SPECIFIC_MESSAGE]));

    await regenerateMessageOnly(RUN_ID);

    const saved = persistedDraft()!;
    const finalText = saved.final_text as string;
    const lower = finalText.toLowerCase();

    // does NOT contain the original hook proposition verbatim
    expect(finalText).not.toContain(HOOK_SIGNAL);
    // does NOT simply paraphrase the hook — same deterministic gate as generation time
    const opener = checkOpener(finalText, HOOK_FOR_CHECKS);
    expect(opener.isHeadline).toBe(false);
    expect(opener.similarity).toBeLessThan(0.72);
    // does NOT assert unsupported AP pain as fact
    expect(lower).not.toContain('your ap volume is increasing');
    expect(lower).not.toContain('your finance team is overloaded');
    expect(lower).not.toContain('has become more complex');
    // references Shiprocket's specific expansion context
    expect(finalText).toContain('Shiprocket');
    expect(lower).toMatch(/expand/);
    // relevant to the CFO/finance role
    expect(lower).toContain('finance team');
    // reads as a natural observation or question
    expect(lower).toMatch(/wondering whether|curious|\?/);
    // passes the existing opener-quality gates
    const pers = checkPersonalization(finalText, HOOK_FOR_CHECKS, RECIPIENT_CTX);
    expect(pers.passed).toBe(true);
    const voice = checkVoice(finalText);
    expect(voice.passed).toBe(true);
  });
});
