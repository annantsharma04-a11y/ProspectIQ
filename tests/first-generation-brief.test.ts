import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmailBrief } from '@/lib/generation/brief';
import type { NormalizedSource } from '@/lib/research/normalize';
import type { ScoredSignal } from '@/lib/signals/types';

// Phase 4: the FIRST email is now written from the settled brief, not taken
// from the analysis pass.
//
// Why that matters, concretely: analyzeProspect() drafts a message in the same
// call that PROPOSES hooks — before quote verification, scoring, capability
// checks and role-relevance gating have run. When the deterministic gate then
// selected a different hook, the draft had already been written against the
// model's own pick. These pin the new order: gate first, then write.
//
// Asserted against the actual prompt string, as in Phase 2 — a field that is
// passed but never interpolated would satisfy an argument-shape test while
// changing nothing about what the model sees.

const mockCallStructured = vi.fn();
vi.mock('@/lib/llm/gemini', () => ({ callStructured: (...a: unknown[]) => mockCallStructured(...a) }));

const { writeEmailFromBrief } = await import('@/lib/generation/write-email');
const { buildEmailBrief } = await import('@/lib/generation/brief');
const { gateHook, HOOK_THRESHOLD } = await import('@/lib/ranking/rank');

const SOURCE_URL = 'https://example.com/shiprocket-revenue';

const sources = [
  {
    url: SOURCE_URL,
    canonical_url: SOURCE_URL,
    title: 'Shiprocket revenue',
    snippet: 'Shiprocket crossed 2,000 crore in annual operating revenue.',
    content: 'Shiprocket crossed 2,000 crore in annual operating revenue.',
    source_type: 'web',
    credibility: 0.8,
    published_date: '2026-06-01',
    providers: ['tavily'],
    queries: [],
    categories: [],
  } as unknown as NormalizedSource,
];

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
} as never;

const brief = (over: Partial<EmailBrief> = {}): EmailBrief => ({
  ...buildEmailBrief({
    recipientName: 'Tanmay',
    company: 'Shiprocket',
    verifiedFact: 'Shiprocket crossed 2,000 crore in annual operating revenue this year.',
    solution,
    proof: null,
  }),
  ...over,
});

const write = (b: EmailBrief, repairNotes: string | null = null) =>
  writeEmailFromBrief({
    brief: b,
    senderName: 'Annant Sharma',
    senderCompany: 'Zamp',
    outreachContext: 'We build agents for finance operations.',
    sources,
    repairNotes,
  });

const promptSent = () => mockCallStructured.mock.calls[0][0].input as string;
const systemSent = () => mockCallStructured.mock.calls[0][0].system as string;

beforeEach(() => {
  vi.clearAllMocks();
  mockCallStructured.mockResolvedValue({ data: { message: 'draft', messageClaims: [] }, meta: {} });
});

describe('Test 1 — the first generation receives the brief', () => {
  it('is a dedicated writer call, not the research pass', async () => {
    await write(brief());
    expect(mockCallStructured.mock.calls[0][0].purpose).toBe('write_outreach_email');
  });

  it('carries the verified fact, workflow and capability', async () => {
    await write(brief());
    const prompt = promptSent();

    expect(prompt).toContain('EMAIL BRIEF');
    expect(prompt).toContain('Shiprocket crossed 2,000 crore in annual operating revenue this year.');
    expect(prompt).toContain('Invoice processing');
    expect(prompt).toContain('Processes invoices, matches and reconciles payables');
  });

  it('does not re-supply the research corpus for the model to re-plan from', async () => {
    await write(brief());
    const prompt = promptSent();

    // Sources appear only as citable URLs for claim declaration.
    expect(prompt).toContain('SOURCE URLS YOU MAY CITE');
    expect(prompt).toContain('no others exist');
  });

  it('tells the model the decisions are already made', async () => {
    await write(brief());

    expect(promptSent()).toMatch(/do not re-decide them/i);
    expect(systemSent()).toMatch(/You are not choosing between them/i);
  });
});

describe('Test 2 & 3 — only the FINAL gated hook can drive the first email', () => {
  // Hook A scores well but rests on a capability the company was never shown
  // to have; Hook B is the one that survives. This is the real gate from
  // lib/ranking/rank.ts, not a reimplementation.
  const hookA: ScoredSignal = {
    signal: 'Shiprocket is preparing an initial public offering.',
    composite_score: 95,
    signal_level: 'COMPANY',
    role_relevance: 'They lead the finance function that would run it.',
    related_capability_id: 'ipo_readiness',
    conflicts_with: null,
  } as unknown as ScoredSignal;
  const hookB: ScoredSignal = {
    signal: 'Shiprocket crossed 2,000 crore in annual operating revenue this year.',
    composite_score: 70,
    signal_level: 'COMPANY',
    role_relevance: 'They lead the finance function this revenue flows through.',
    related_capability_id: 'ap_automation',
    conflicts_with: null,
  } as unknown as ScoredSignal;

  const observed = new Set(['ap_automation']);

  it('the gate rejects the model’s pick and selects the other hook', () => {
    const selection = gateHook([hookA, hookB], {
      index: 0, // the model wanted Hook A
      reason: 'Most newsworthy.',
      confidence: 90,
      alternatives: [],
      insufficient: false,
      insufficientReason: null,
    }, 'Head of Finance', observed);

    expect(selection.selected_index).toBe(1);
    expect(selection.overridden).toBe(true);
    expect(hookA.composite_score).toBeGreaterThan(HOOK_THRESHOLD); // it lost on evidence, not score
  });

  it('the first-generation prompt carries the GATED hook, not the model’s pick', async () => {
    const selection = gateHook([hookA, hookB], {
      index: 0, reason: 'x', confidence: 90, alternatives: [], insufficient: false, insufficientReason: null,
    }, 'Head of Finance', observed);

    const finalHook = [hookA, hookB][selection.selected_index!];
    await write(brief({ verifiedFact: finalHook.signal }));
    const prompt = promptSent();

    expect(prompt).toContain('crossed 2,000 crore in annual operating revenue');
    // The rejected hook never becomes the email's fact.
    expect(prompt).not.toContain('preparing an initial public offering');
  });

  it('a hook that fails verification cannot become the email’s fact', () => {
    // Same hook, but now nothing was observed — it fails the capability check.
    const selection = gateHook([hookA], {
      index: 0, reason: 'x', confidence: 90, alternatives: [], insufficient: false, insufficientReason: null,
    }, 'Head of Finance', new Set());

    expect(selection.selected_index).toBeNull();
    expect(selection.insufficient_evidence).toBe(true);
    // No hook means briefForContext() returns null and no email is written.
  });
});

describe('Test 4 — no approved proof', () => {
  it('states the absence explicitly rather than staying silent', async () => {
    await write(brief());
    const prompt = promptSent();

    expect(prompt).toContain('Approved proof: NONE');
    expect(prompt).toMatch(/no percentage/i);
  });

  it('introduces no placeholder customer or result', async () => {
    await write(brief());
    const prompt = promptSent();

    for (const banned of ['retailer', '60%', '35%', '100 hours', 'apparel']) {
      expect(prompt.toLowerCase(), banned).not.toContain(banned.toLowerCase());
    }
  });
});

describe('Test 5 — an approved proof', () => {
  const proof = {
    id: 'proof_fixture',
    customer: 'Fixture Customer A',
    workflow: 'invoice processing',
    approved_statement: 'FIXTURE STATEMENT (not a real customer result). Approved invoice proof goes here.',
  };

  it('passes the exact statement through, once, with no catalog', async () => {
    await write(brief({ approvedProof: proof }));
    const prompt = promptSent();

    expect(prompt).toContain(proof.approved_statement);
    expect(prompt.split(proof.approved_statement).length - 1).toBe(1);
    expect(prompt).not.toContain('Approved proof: NONE');
    // No second proof, no catalog to choose from.
    expect(prompt).not.toContain('proof_chargeback');
  });

  it('states the verbatim-or-omit rule', async () => {
    await write(brief({ approvedProof: proof }));
    expect(promptSent()).toMatch(/verbatim or omit/i);
  });
});

describe('Tests 6 & 7 — workflow and implication are settled, not inferred', () => {
  it('the workflow reaches the prompt as a decision, not a question', async () => {
    await write(brief());
    const prompt = promptSent();

    expect(prompt).toMatch(/Workflow \(the ONE workflow this email is about\): Invoice processing/);
    expect(prompt).not.toMatch(/which workflow/i);
  });

  it('the deterministic operational implication reaches the prompt', async () => {
    await write(brief());
    const prompt = promptSent();

    expect(prompt).toContain('Operational implication');
    expect(prompt).toContain('Shiprocket');
    expect(prompt).toMatch(/do NOT add difficulty/i);
  });

  it('with no solution there is no implication, and none is invented', async () => {
    const bare = buildEmailBrief({
      recipientName: 'Tanmay', company: 'Shiprocket',
      verifiedFact: 'Shiprocket crossed 2,000 crore in revenue.', solution: null, proof: null,
    });
    expect(bare.operationalImplication).toBeNull();
    expect(bare.workflow).toBeNull();

    await write(bare);
    const prompt = promptSent();

    expect(prompt).not.toContain('Operational implication');
    expect(prompt).not.toContain('Workflow (');
  });
});

describe('Test 8 — repair-directive rewrite keeps the brief (quality-gate retry, not a user regeneration)', () => {
  const directive = [
    'EMAIL QUALITY FAILURES:',
    '1. The email describes what the product IS instead of what it DOES.',
  ].join('\n');

  it('carries the same fact, workflow and proof, plus the named failures', async () => {
    const proof = {
      id: 'p1', customer: 'Fixture Customer A', workflow: 'invoice processing',
      approved_statement: 'FIXTURE STATEMENT (not a real customer result).',
    };
    await write(brief({ approvedProof: proof }), directive);
    const prompt = promptSent();

    expect(prompt).toContain('EMAIL BRIEF');
    expect(prompt).toContain('crossed 2,000 crore');
    expect(prompt).toContain('Invoice processing');
    expect(prompt).toContain(proof.approved_statement);
    expect(prompt).toContain('EMAIL QUALITY FAILURES');
    expect(prompt).toContain('what the product IS');
  });

  it('forbids reopening the business decisions during a rewrite', async () => {
    await write(brief(), directive);
    const prompt = promptSent();

    expect(prompt).toMatch(/Keep the same fact, the same workflow, the same proof/i);
    expect(prompt).toMatch(/do not look for a new angle/i);
  });

  it('a first generation carries no rewrite framing at all', async () => {
    await write(brief());
    expect(promptSent()).not.toContain('EMAIL QUALITY FAILURES');
    expect(promptSent()).not.toMatch(/REWRITE —/);
  });
});

describe('the writer degrades rather than dead-ends', () => {
  it('returns null when the model fails', async () => {
    mockCallStructured.mockRejectedValue(new Error('unavailable'));
    expect(await write(brief())).toBeNull();
  });

  it('returns null on an empty message', async () => {
    mockCallStructured.mockResolvedValue({ data: { message: '   ', messageClaims: [] }, meta: {} });
    expect(await write(brief())).toBeNull();
  });

  it('carries the writing rules without duplicating them', async () => {
    const { EMAIL_WRITING_RULES } = await import('@/lib/generation/email-rules');
    await write(brief());

    // One shared definition: the writer's system prompt embeds the same rules
    // the analysis prompt uses, rather than a second copy that can drift.
    expect(systemSent()).toContain(EMAIL_WRITING_RULES);
  });
});
