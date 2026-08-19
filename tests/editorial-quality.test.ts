import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmailBrief } from '@/lib/generation/brief';

// The remaining gap after Phase 4 was editorial, not structural: the Shiprocket
// draft satisfied every deterministic rule and still read like a template with
// the details swapped in. These cover the three things added for that — richer
// brief context, few-shot style references, and one bounded editorial pass —
// plus the failure modes the reference emails avoid.

const mockCallStructured = vi.fn();
vi.mock('@/lib/llm/gemini', () => ({ callStructured: (...a: unknown[]) => mockCallStructured(...a) }));

const { buildEmailBrief, renderBrief } = await import('@/lib/generation/brief');
const { writeEmailFromBrief } = await import('@/lib/generation/write-email');
const { editEmail, chooseDraft, editIsFaithful } = await import('@/lib/generation/edit-email');
const { checkEmailQuality } = await import('@/lib/generation/email-quality');

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
    verifiedFact: "Shiprocket's non-shipping tech solutions now generate over a quarter of total revenue.",
    solution,
    proof: null,
  }),
  ...over,
});

/** The reference standard, written the way David/Emily/Katie are written. */
const GOOD = [
  "Shiprocket's non-shipping tech solutions now generate over a quarter of total revenue.",
  'As that mix shifts, invoice processing and payables matching have to stay consistent across a wider set of merchant relationships than the shipping business alone required.',
  'Zamp can process invoices, match and reconcile payables against purchase orders, flag the exceptions that need a person, and run accounts payable workflows end to end.',
  "I'd be keen to understand how your team handles invoice processing today and where we could be useful. Would be great to compare notes on a short call.",
].join('\n\n');

/** The original failure: structurally valid, editorially wrong. */
const BAD = [
  'Watching Shiprocket scale past 2,000 crore in annual operating revenue while expanding merchant software offerings highlights the sheer volume of vendor relationships your finance team manages.',
  'As transaction volumes climb across multiple subsidiaries, matching and reconciling payables manually creates unnecessary friction in everyday accounting operations.',
  'We provide AI digital-employee agents that process invoices, match and reconcile payables, and execute AP workflows end to end.',
  'Curious how your team handles invoice processing volume today, and whether it makes sense to compare notes on where automation fits?',
].join('\n\n');

const promptSent = () => mockCallStructured.mock.calls[0][0].input as string;
const systemSent = () => mockCallStructured.mock.calls[0][0].system as string;

beforeEach(() => {
  vi.clearAllMocks();
  mockCallStructured.mockResolvedValue({ data: { message: 'draft', messageClaims: [] }, meta: {} });
});

describe('whyThisPerson comes from the verified role, never an invented remit', () => {
  it('is present when a role was established', () => {
    const b = brief();
    expect(b.whyThisPerson).toContain('Head of Finance Operations');
    expect(b.whyThisPerson).toContain('Shiprocket');
  });

  it('does not assert what they own or are responsible for', () => {
    const b = brief();
    expect(b.whyThisPerson!.toLowerCase()).not.toMatch(/owns|responsible for|manages the|in charge of/);
  });

  it('is null when no role was established, rather than guessed', () => {
    const b = buildEmailBrief({
      recipientName: 'Tanmay', company: 'Shiprocket', role: null,
      verifiedFact: 'x', solution, proof: null,
    });
    expect(b.whyThisPerson).toBeNull();
  });

  it('reaches the prompt flagged as context, not as a line to reproduce', async () => {
    await writeEmailFromBrief({
      brief: brief(), senderName: 'S', senderCompany: 'Zamp',
      outreachContext: 'o', sources: [], directive: null,
    });
    expect(promptSent()).toMatch(/not a line to reproduce/i);
    expect(promptSent()).toMatch(/do NOT assert what they own/i);
  });
});

describe('desiredConversation shapes the close', () => {
  it('asks how they handle the workflow today', () => {
    expect(brief().desiredConversation).toMatch(/handles invoice processing today/i);
  });

  it('is null with no workflow', () => {
    const b = buildEmailBrief({ recipientName: 'T', company: 'C', verifiedFact: 'x', solution: null, proof: null });
    expect(b.desiredConversation).toBeNull();
  });
});

describe('the operational implication varies but stays safe and reproducible', () => {
  const implicationFor = (company: string) =>
    buildEmailBrief({ recipientName: 'T', company, role: null, verifiedFact: 'x', solution, proof: null })
      .operationalImplication!;

  it('produces the same sentence for the same inputs, every time', () => {
    const runs = new Set(Array.from({ length: 10 }, () => implicationFor('Shiprocket')));
    expect(runs.size).toBe(1);
  });

  it('is not one single template across different companies', () => {
    const variants = new Set(
      ['Shiprocket', 'Revolut', 'Myntra', 'Zerodha', 'Instamart', 'GoKwik', 'Acme', 'Northwind'].map(implicationFor),
    );
    expect(variants.size).toBeGreaterThan(1);
  });

  it('never asserts difficulty, whichever pattern is chosen', () => {
    for (const company of ['Shiprocket', 'Revolut', 'Myntra', 'Zerodha', 'Instamart', 'GoKwik', 'Acme', 'Northwind']) {
      expect(implicationFor(company).toLowerCase()).not.toMatch(
        /struggl|bottleneck|friction|overwhelm|difficult|painful|burden|inefficien/,
      );
    }
  });
});

describe('the writer is shown the standard, and the openings to avoid', () => {
  beforeEach(async () => {
    await writeEmailFromBrief({
      brief: brief(), senderName: 'S', senderCompany: 'Zamp', outreachContext: 'o', sources: [], directive: null,
    });
  });

  it('carries all three style references', () => {
    const sys = systemSent();
    expect(sys).toContain('STYLE REFERENCES');
    for (const name of ['David', 'Emily', 'Katie']) expect(sys, name).toContain(`Hi ${name},`);
  });

  it('marks their customer results as illustrative, not approved evidence', () => {
    expect(systemSent()).toMatch(/illustrative, not approved evidence/i);
  });

  it('bans narrating the noticing', () => {
    const sys = systemSent();
    expect(sys).toMatch(/state the fact\. Do not narrate noticing it/i);
    for (const bad of ['I noticed', 'I saw that', 'I came across', 'Watching', 'highlights the sheer', 'underscores']) {
      expect(sys, bad).toContain(bad);
    }
  });

  it('names what the references have in common, so they are a lesson not decoration', () => {
    // Normalised: the prompt hard-wraps, so the phrase straddles a newline.
    expect(systemSent().replace(/\s+/g, ' ')).toMatch(/none of them says "I noticed"/i);
  });
});

describe('the editor may only improve prose', () => {
  it('is told the argument is already settled', async () => {
    await editEmail({ brief: brief(), message: GOOD, claims: [] });
    const sys = systemSent();

    expect(sys).toMatch(/You are NOT rewriting the argument/i);
    expect(sys).toMatch(/add a fact about the person, the company or the world/i);
    expect(sys).toMatch(/change which workflow/i);
    expect(sys).toMatch(/invent any customer result/i);
  });

  it('receives the same brief the writer had', async () => {
    await editEmail({ brief: brief(), message: GOOD, claims: [] });
    expect(promptSent()).toContain(renderBrief(brief()));
  });

  it('is allowed to return the draft unchanged', async () => {
    await editEmail({ brief: brief(), message: GOOD, claims: [] });
    expect(systemSent()).toMatch(/return it unchanged\. That is a valid answer/i);
  });

  it('returns null on failure so the written draft simply stands', async () => {
    mockCallStructured.mockRejectedValue(new Error('unavailable'));
    expect(await editEmail({ brief: brief(), message: GOOD, claims: [] })).toBeNull();
  });
});

describe('an edit is accepted only when code judges it no worse', () => {
  const written = { message: GOOD, claims: [] };

  it('keeps the written draft when no edit was produced', () => {
    const choice = chooseDraft(brief(), written, null, null);
    expect(choice.edited).toBe(false);
    expect(choice.message).toBe(GOOD);
  });

  it('keeps the written draft when the editor returns it unchanged', () => {
    const choice = chooseDraft(brief(), written, { message: GOOD, claims: [] }, null);
    expect(choice.edited).toBe(false);
  });

  it('DISCARDS an edit that scores worse on the deterministic checks', () => {
    const choice = chooseDraft(brief(), written, { message: BAD, claims: [] }, null);

    expect(choice.edited).toBe(false);
    expect(choice.message).toBe(GOOD);
    expect(choice.reason).toMatch(/scored worse/i);
  });

  it('DISCARDS an edit that invents a customer result', () => {
    const withProof = GOOD.replace(
      'Zamp can process invoices',
      'Zamp helped a large retailer cut invoice work by 40%. Zamp can process invoices',
    );
    expect(editIsFaithful(brief(), GOOD, withProof)).toBe(false);
    expect(chooseDraft(brief(), written, { message: withProof, claims: [] }, null).edited).toBe(false);
  });

  it('DISCARDS an edit that drops the approved statement', () => {
    const approved = {
      id: 'p1', customer: 'Fixture Customer A', workflow: 'invoice processing',
      approved_statement: 'FIXTURE STATEMENT (not a real customer result). Approved invoice proof goes here.',
    };
    const b = brief({ approvedProof: approved });
    const original = GOOD.replace('Zamp can process', `${approved.approved_statement}\n\nZamp can process`);

    expect(editIsFaithful(b, original, GOOD)).toBe(false);
  });

  it('KEEPS an edit that preserves everything and reads at least as well', () => {
    const tightened = GOOD.replace(
      'flag the exceptions that need a person, and run accounts payable workflows end to end',
      'flag the exceptions worth a second look, and run accounts payable workflows end to end',
    );
    const choice = chooseDraft(brief(), written, { message: tightened, claims: [] }, null);

    expect(choice.edited).toBe(true);
    expect(choice.message).toBe(tightened);
  });
});

describe('the Shiprocket regression still holds', () => {
  it('the original email fails', () => {
    const r = checkEmailQuality(BAD, { brief: brief() });

    expect(r.passed).toBe(false);
    expect(r.detail.opening_not_interpreted).toBe(false);
    expect(r.detail.opening_single_fact).toBe(false);
    expect(r.detail.no_assumed_pain).toBe(false);
    expect(r.detail.no_product_category).toBe(false);
  });

  it('the reference-standard version passes', () => {
    const r = checkEmailQuality(GOOD, { brief: brief() });
    expect(r.failures).toEqual([]);
  });

  it('the good version opens on a clean fact and carries no invented proof', () => {
    const r = checkEmailQuality(GOOD, { brief: brief() });
    expect(r.detail.opening_not_weak).toBe(true);
    expect(r.detail.opening_single_fact).toBe(true);
    expect(r.detail.no_invented_proof).toBe(true);
    expect(r.detail.workflow_present).toBe(true);
    expect(r.detail.cta_present).toBe(true);
  });
});
