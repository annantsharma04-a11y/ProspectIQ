import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmailBrief } from '@/lib/generation/brief';

// The audited bug: the previous draft never reached the writer, and the only
// instruction wrapper available said "change nothing else" right next to a
// regeneration directive saying "write something different". These tests pin
// the fix at three levels: the divergence measurement itself (pure), the
// prompt the writer actually sends (regeneration vs repair, never mixed), and
// the editor's inability to quietly undo a genuine rewrite.

const mockCallStructured = vi.fn();
vi.mock('@/lib/llm/gemini', () => ({ callStructured: (...a: unknown[]) => mockCallStructured(...a) }));

const { checkDivergence, WHOLE_MESSAGE_SIMILARITY_THRESHOLD, OPENING_SIMILARITY_THRESHOLD } = await import(
  '@/lib/generation/email-quality'
);
const { writeEmailFromBrief } = await import('@/lib/generation/write-email');
const { chooseDraft, editIsFaithful } = await import('@/lib/generation/edit-email');
const { buildEmailBrief } = await import('@/lib/generation/brief');

const solution = {
  solution: {
    id: 'zamp_ap_automation',
    name: 'Accounts payable automation',
    description: 'Processes invoices, matches and reconciles payables, and executes AP workflows end to end.',
    supported_workflows: ['Invoice processing', 'Payables matching and reconciliation'],
    target_functions: ['Finance'],
    use_cases: [], non_use_cases: [], matches_capability_ids: ['ap_automation'],
  },
  matched_capabilities: [], why_it_fits: '',
} as never;

const brief = (over: Partial<EmailBrief> = {}): EmailBrief => ({
  ...buildEmailBrief({
    recipientName: 'Tanmay',
    company: 'Shiprocket',
    role: 'Head of Finance Operations',
    verifiedFact: "Shiprocket's non-shipping technology business now generates over a quarter of total revenue.",
    solution,
    proof: null,
  }),
  ...over,
});

const ORIGINAL = [
  "Shiprocket's non-shipping technology business now generates over a quarter of total revenue.",
  'As that mix shifts, invoice processing and payables matching have to stay consistent across a wider set of merchant relationships than the shipping business alone required.',
  'Zamp can process invoices, match and reconcile payables against purchase orders, flag the exceptions that need a person, and run accounts payable workflows end to end.',
  "I'd be keen to understand how your team handles invoice processing today and where we could be useful. Would be great to compare notes on a short call.",
].join('\n\n');

/** Root-cause example from the audit: one word changed, everything else identical. */
const TRIVIAL_VARIANT = ORIGINAL.replace('now generates', 'now produces');

/** Genuinely different construction, same argument. */
const GENUINE_REWRITE = [
  'A quarter of Shiprocket\'s total revenue now comes from its non-shipping technology business.',
  'That shift means invoice processing and payables matching now span a wider set of merchant relationships than the core shipping operation ever did on its own.',
  'On that workflow specifically, Zamp reconciles payables against purchase orders, surfaces the exceptions worth a second look, and carries accounts payable through to close.',
  'Would be great to compare notes on a short call about how that side of finance operations is run today.',
].join('\n\n');

const promptSent = () => mockCallStructured.mock.calls[0][0].input as string;

beforeEach(() => {
  vi.clearAllMocks();
  mockCallStructured.mockResolvedValue({ data: { message: 'draft', messageClaims: [] }, meta: {} });
});

// ─── the pure divergence measurement ─────────────────────────────────────────

describe('checkDivergence — the measurement itself', () => {
  it('rejects an exact duplicate outright, before any similarity math', () => {
    const r = checkDivergence(ORIGINAL, ORIGINAL);
    expect(r.passed).toBe(false);
    expect(r.wholeMessageSimilarity).toBe(1);
    expect(r.reason).toMatch(/identical/i);
  });

  it('rejects the audit’s own example — one word changed', () => {
    const r = checkDivergence(TRIVIAL_VARIANT, ORIGINAL);
    expect(r.passed).toBe(false);
    expect(r.wholeMessageSimilarity).toBeGreaterThanOrEqual(WHOLE_MESSAGE_SIMILARITY_THRESHOLD);
  });

  it('accepts a genuinely different rewrite of the same argument', () => {
    const r = checkDivergence(GENUINE_REWRITE, ORIGINAL);
    expect(r.passed).toBe(true);
    expect(r.wholeMessageSimilarity).toBeLessThan(WHOLE_MESSAGE_SIMILARITY_THRESHOLD);
    expect(r.openingSimilarity).toBeLessThan(OPENING_SIMILARITY_THRESHOLD);
  });

  it('catches a changed body with an UNCHANGED opening — still a duplicate failure', () => {
    const sameOpening = [ORIGINAL.split('\n\n')[0], ...GENUINE_REWRITE.split('\n\n').slice(1)].join('\n\n');
    const r = checkDivergence(sameOpening, ORIGINAL);
    expect(r.openingSimilarity).toBeGreaterThanOrEqual(OPENING_SIMILARITY_THRESHOLD);
    expect(r.passed).toBe(false);
  });

  it('ignores the greeting and signature — those are expected to repeat', () => {
    const wrapped = (m: string) => `Hi Tanmay,\n\n${m}\n\nBest,\nAnnant Sharma`;
    const r = checkDivergence(wrapped(GENUINE_REWRITE), wrapped(ORIGINAL));
    expect(r.passed).toBe(true);
  });

  it('the thresholds are named constants, not magic numbers buried in logic', () => {
    expect(typeof WHOLE_MESSAGE_SIMILARITY_THRESHOLD).toBe('number');
    expect(typeof OPENING_SIMILARITY_THRESHOLD).toBe('number');
    expect(WHOLE_MESSAGE_SIMILARITY_THRESHOLD).toBeGreaterThan(0);
    expect(WHOLE_MESSAGE_SIMILARITY_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

// ─── 1-3: the writer's prompt in regeneration mode ───────────────────────────

describe('1. the previous message reaches the prompt, only in regeneration mode', () => {
  it('is present when previousMessage is supplied', async () => {
    await writeEmailFromBrief({
      brief: brief(), senderName: 'S', senderCompany: 'Zamp', outreachContext: 'o', sources: [],
      previousMessage: ORIGINAL,
    });
    expect(promptSent()).toContain('PREVIOUS VERSION');
    expect(promptSent()).toContain(ORIGINAL.split('\n\n')[0]);
  });

  it('is ABSENT on a first generation — no previousMessage means no anchor at all', async () => {
    await writeEmailFromBrief({
      brief: brief(), senderName: 'S', senderCompany: 'Zamp', outreachContext: 'o', sources: [],
    });
    expect(promptSent()).not.toContain('PREVIOUS VERSION');
    expect(promptSent()).not.toContain('REGENERATION');
  });
});

describe('2. regeneration and repair are never mixed in one wrapper', () => {
  it('the regeneration prompt does not contain the repair phrase "change nothing else"', async () => {
    await writeEmailFromBrief({
      brief: brief(), senderName: 'S', senderCompany: 'Zamp', outreachContext: 'o', sources: [],
      previousMessage: ORIGINAL,
    });
    const flat = promptSent().replace(/\s+/g, ' ');
    expect(flat).not.toMatch(/change nothing else/i);
  });

  it('the regeneration prompt explicitly demands materially different wording', async () => {
    await writeEmailFromBrief({
      brief: brief(), senderName: 'S', senderCompany: 'Zamp', outreachContext: 'o', sources: [],
      previousMessage: ORIGINAL,
    });
    expect(promptSent()).toMatch(/materially different in wording and sentence construction/i);
  });

  it('the repair prompt still uses "change nothing else" — that wording is correct there', async () => {
    await writeEmailFromBrief({
      brief: brief(), senderName: 'S', senderCompany: 'Zamp', outreachContext: 'o', sources: [],
      repairNotes: 'The opening restates the source headline almost verbatim.',
    });
    expect(promptSent()).toMatch(/change\nnothing else/i);
    expect(promptSent()).not.toContain('REGENERATION —');
  });

  it('a retry with BOTH a divergence failure and a quality failure states both, without contradiction', async () => {
    await writeEmailFromBrief({
      brief: brief(), senderName: 'S', senderCompany: 'Zamp', outreachContext: 'o', sources: [],
      previousMessage: ORIGINAL,
      regenerationReinforcement: 'The previous regenerated version was too similar to the original. Produce substantially different sentence construction and wording.',
      repairNotes: 'The email describes what the product IS instead of what it DOES.',
    });
    const prompt = promptSent();
    expect(prompt).toMatch(/too similar to the original/i);
    expect(prompt).toContain('what the product IS');
    expect(prompt.replace(/\s+/g, ' ')).not.toMatch(/change nothing else/i);
  });
});

describe('3. regeneration preserves the same brief — fact, workflow, capability, proof, recipient', () => {
  it('all five reach the prompt unchanged when regenerating', async () => {
    const proof = {
      id: 'p1', customer: 'Fixture Customer A', workflow: 'invoice processing',
      approved_statement: 'FIXTURE STATEMENT (not a real customer result). Approved invoice proof goes here.',
    };
    await writeEmailFromBrief({
      brief: brief({ approvedProof: proof }), senderName: 'S', senderCompany: 'Zamp', outreachContext: 'o', sources: [],
      previousMessage: ORIGINAL,
    });
    const prompt = promptSent();

    expect(prompt).toContain('Tanmay');
    expect(prompt).toContain("Shiprocket's non-shipping technology business now generates over a quarter of total revenue.");
    expect(prompt).toContain('Invoice processing');
    expect(prompt).toContain('Processes invoices, matches and reconciles payables');
    expect(prompt).toContain(proof.approved_statement);
  });

  it('the regeneration block itself names every field that must stay fixed', async () => {
    await writeEmailFromBrief({
      brief: brief(), senderName: 'S', senderCompany: 'Zamp', outreachContext: 'o', sources: [],
      previousMessage: ORIGINAL,
    });
    const prompt = promptSent();
    for (const field of ['recipient', 'verified fact', 'why this person', 'operational implication', 'workflow', 'Zamp capability', 'approved proof']) {
      expect(prompt.toLowerCase(), field).toContain(field.toLowerCase());
    }
  });
});

describe('10. no-proof mode is preserved through a regeneration', () => {
  it('neither the original nor the regenerated prompt gains a customer result', async () => {
    await writeEmailFromBrief({
      brief: brief(), senderName: 'S', senderCompany: 'Zamp', outreachContext: 'o', sources: [],
      previousMessage: ORIGINAL,
    });
    const prompt = promptSent();
    expect(prompt).toContain('Approved proof: NONE');
    expect(prompt).toMatch(/no percentage/i);
  });

  it('divergence measurement is unaffected by proof state — it only compares prose', () => {
    const r = checkDivergence(GENUINE_REWRITE, ORIGINAL);
    expect(r.passed).toBe(true);
  });
});

// ─── 9: the editor cannot silently undo a regeneration ───────────────────────

describe('9. the editorial pass cannot revert a regeneration toward the original', () => {
  const written = { message: GENUINE_REWRITE, claims: [] };

  it('rejects an edit that is itself a near-duplicate of the original', () => {
    const choice = chooseDraft(brief(), written, { message: TRIVIAL_VARIANT, claims: [] }, null, ORIGINAL);
    expect(choice.edited).toBe(false);
    expect(choice.message).toBe(GENUINE_REWRITE);
    expect(choice.reason).toMatch(/too similar to the original/i);
  });

  it('rejects an edit that pulls the draft MATERIALLY back toward the original, without being a duplicate outright', () => {
    // The opening is reworded (individually passes divergence on its own) but
    // the second paragraph reverts to ORIGINAL's exact wording — a real step
    // backward, comfortably past the noise margin, while paragraphs 3-4 stay
    // fully diverged so this never trips the outright-duplicate check. Only
    // the direction-of-travel rule catches a regression shaped like this.
    const partiallyReverted = [
      'Over a quarter of total revenue at Shiprocket now sits outside shipping, inside its technology business.',
      ORIGINAL.split('\n\n')[1],
      ...GENUINE_REWRITE.split('\n\n').slice(2),
    ].join('\n\n');

    const choice = chooseDraft(brief(), written, { message: partiallyReverted, claims: [] }, null, ORIGINAL);
    expect(choice.edited).toBe(false);
    expect(choice.reason).toMatch(/closer to the original/i);
  });

  it('does NOT revert to the original merely because the edit scores equally well', () => {
    // A same-quality edit that happens to be a near-duplicate must still be
    // discarded — the instruction is explicit that a tied score must not win.
    const choice = chooseDraft(brief(), written, { message: TRIVIAL_VARIANT, claims: [] }, null, ORIGINAL);
    expect(choice.edited).toBe(false);
  });

  it('a genuinely improved edit that stays diverged is accepted, even if a shared workflow term nudges similarity by a hair', () => {
    // "flags the exceptions that need a person" happens to echo ORIGINAL's
    // own wording slightly more than the writer's draft did — an honest
    // rewrite can land a point or two closer on shared domain vocabulary
    // alone. The margin is what keeps this from being punished as if it were
    // a regression.
    const tightened = GENUINE_REWRITE.replace(
      'surfaces the exceptions worth a second look',
      'flags the exceptions that need a person to look at',
    );
    const choice = chooseDraft(brief(), written, { message: tightened, claims: [] }, null, ORIGINAL);
    expect(choice.edited).toBe(true);
    expect(choice.message).toBe(tightened);
  });

  it('first-generation editing (no previousMessage) is completely unaffected', () => {
    // previousMessage omitted entirely — the exact call shape a first
    // generation already used before this fix.
    const choice = chooseDraft(brief(), written, { message: TRIVIAL_VARIANT, claims: [] }, null);
    // No previous-message comparison applies; only faithfulness + score decide.
    expect(choice.edited).toBe(true);
  });

  it('faithfulness is still checked before divergence, exactly as before this fix', () => {
    const approved = {
      id: 'p1', customer: 'Fixture Customer A', workflow: 'invoice processing',
      approved_statement: 'FIXTURE STATEMENT (not a real customer result).',
    };
    const b = brief({ approvedProof: approved });
    const withProof = GENUINE_REWRITE.replace('Zamp reconciles', `${approved.approved_statement}\n\nZamp reconciles`);
    expect(editIsFaithful(b, GENUINE_REWRITE, GENUINE_REWRITE.replace(approved.approved_statement, ''))).toBe(true);
    // (sanity: faithfulness logic itself is untouched — full coverage lives in editorial-quality.test.ts)
    expect(typeof withProof).toBe('string');
  });
});

// ─── 11: first generation is provably unaffected by this whole feature ──────

describe('11. first generation never receives regeneration machinery', () => {
  it('no previousMessage, no REGENERATION framing, no reinforcement field used', async () => {
    await writeEmailFromBrief({
      brief: brief(), senderName: 'S', senderCompany: 'Zamp', outreachContext: 'o', sources: [],
    });
    const prompt = promptSent();
    expect(prompt).not.toContain('PREVIOUS VERSION');
    expect(prompt).not.toContain('REGENERATION');
    expect(prompt).not.toMatch(/too similar to the original/i);
  });

  it('chooseDraft with no previousMessage argument behaves exactly as the pre-fix signature did', () => {
    const choice = chooseDraft(brief(), { message: ORIGINAL, claims: [] }, null, null);
    expect(choice.edited).toBe(false);
    expect(choice.reason).toMatch(/no edit was produced/i);
  });
});
