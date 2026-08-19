import { describe, it, expect } from 'vitest';
import { checkOpener, openerFailureSummary } from '@/lib/pipeline/stages';
import { buildEmailBrief, renderBrief } from '@/lib/generation/brief';
import type { SolutionMatch } from '@/lib/solutions/types';

// The real Shiprocket case this fix targets: select_hook (Stage 12) produces
// a strong verified hook plus its own reasoning (why_it_matters,
// role_relevance, outreach_rationale) — but generate_message (Stage 13) only
// ever saw the raw fact, and its own prompt literally instructed "state the
// fact" as the opener. The opener-quality checker (unchanged by this fix)
// correctly rejected the result at ~87% containment.
//
// The fix has three parts: (1) the brief now carries the hook's own reasoning
// so there is something to build an implication FROM, (2) the prompt tells
// the writer never to use the fact, a narrated fact, or a close paraphrase of
// it as the opener, and (3) a retry after a restatement failure gets the
// exact corrective instruction rather than a generic nudge.

const SHIPROCKET_HOOK =
  "Shiprocket recently expanded its non-shipping merchant software and checkout solutions, which now generate over a quarter of total revenue.";
const SHIPROCKET_WHY_MATTERS =
  'As non-shipping software and emerging product lines expand faster than core logistics, transaction volumes and supplier interactions grow correspondingly.';
const SHIPROCKET_OUTREACH_HYPOTHESIS =
  'Expanding non-shipping revenue streams scale vendor and carrier supplier networks, increasing accounts payable volume and reconciliation overhead.';

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

const shiprocketBrief = () =>
  buildEmailBrief({
    recipientName: 'Tanmay',
    company: 'Shiprocket',
    role: 'Group CFO',
    verifiedFact: SHIPROCKET_HOOK,
    whyThisMatters: SHIPROCKET_WHY_MATTERS,
    outreachHypothesis: SHIPROCKET_OUTREACH_HYPOTHESIS,
    solution,
    proof: null,
  });

const HOOK_FOR_OPENER_CHECK = {
  signal: SHIPROCKET_HOOK,
  supporting_quote: 'Shiprocket non-shipping revenue crosses a quarter of total revenue.',
  source_title: "Shiprocket's non-shipping business growth",
};

describe('1-3. genuine restatement is still caught by the unchanged deterministic gate', () => {
  it('1. the exact hook copied as the opener fails', () => {
    const msg = `Hi Tanmay,\n\n${SHIPROCKET_HOOK}\n\nWorth a chat?`;
    const result = checkOpener(msg, HOOK_FOR_OPENER_CHECK);
    expect(result.isHeadline).toBe(true);
    expect(result.similarity).toBeGreaterThanOrEqual(0.72);
  });

  it('2. the hook wrapped in "I saw that..." still fails — narrating does not fix restating', () => {
    const msg = `Hi Tanmay,\n\nI saw that ${SHIPROCKET_HOOK.charAt(0).toLowerCase()}${SHIPROCKET_HOOK.slice(1)}\n\nWorth a chat?`;
    const result = checkOpener(msg, HOOK_FOR_OPENER_CHECK);
    expect(result.isHeadline).toBe(true);
  });

  it('3. a close paraphrase that preserves the same proposition still fails when containment stays above threshold', () => {
    // The actual bad opener the real run produced.
    const msg =
      "Hi Tanmay,\n\nShiprocket's non-shipping merchant software and checkout solutions now generate over a quarter of total revenue.\n\nWorth a chat?";
    const result = checkOpener(msg, HOOK_FOR_OPENER_CHECK);
    expect(result.isHeadline).toBe(true);
    expect(result.similarity).toBeGreaterThan(0.72);
  });
});

describe('4-5. a fresh, implication-based opener passes the same unchanged gate', () => {
  it('4. an implication derived from the fact, hedged, passes', () => {
    const msg =
      'Hi Tanmay,\n\nAs Shiprocket expands beyond its core logistics business, I imagine keeping the finance operations behind those additional product lines coordinated gets more complex.\n\nWorth a chat?';
    const result = checkOpener(msg, HOOK_FOR_OPENER_CHECK);
    expect(result.isHeadline).toBe(false);
  });

  it('5. a role-based cautious question passes', () => {
    const msg =
      "Hi Tanmay,\n\nWith Shiprocket expanding into additional product lines, I'm curious how your finance team is handling the operational side of that growth.\n\nWorth a chat?";
    const result = checkOpener(msg, HOOK_FOR_OPENER_CHECK);
    expect(result.isHeadline).toBe(false);
  });
});

describe('6. the outreach hypothesis is framed as inference, never as settled fact', () => {
  it('renderBrief marks it a HYPOTHESIS and requires hedged language', () => {
    const rendered = renderBrief(shiprocketBrief());
    expect(rendered).toContain(SHIPROCKET_OUTREACH_HYPOTHESIS);
    expect(rendered).toMatch(/HYPOTHESIS, not a verified company fact/i);
    expect(rendered).toMatch(/"I imagine".*"it can mean".*"curious how".*"I was wondering whether"/);
  });

  it('the verified fact itself is marked as private context, not text to reproduce', () => {
    const rendered = renderBrief(shiprocketBrief());
    expect(rendered).toMatch(/private context.*must NOT use this sentence/i);
  });

  it('whyThisMatters is present and distinct from the raw fact', () => {
    const brief = shiprocketBrief();
    expect(brief.whyThisMatters).toBe(SHIPROCKET_WHY_MATTERS);
    expect(brief.whyThisMatters).not.toBe(brief.verifiedFact);
  });

  it('with no hook reasoning supplied, both fields are simply absent — never invented', () => {
    const bare = buildEmailBrief({
      recipientName: 'Tanmay', company: 'Shiprocket', role: null,
      verifiedFact: SHIPROCKET_HOOK, solution: null, proof: null,
    });
    expect(bare.whyThisMatters).toBeNull();
    expect(bare.outreachHypothesis).toBeNull();
    expect(renderBrief(bare)).not.toMatch(/HYPOTHESIS/i);
  });
});

describe('9. the SUPERLATIVE regression from the previous fix still holds', () => {
  it('adjective "leading" is still detected; verb "leading" still is not', () => {
    const hook = { signal: 'x', supporting_quote: 'y', source_title: 'z' };
    expect(checkOpener('Hi X,\n\nAs the leading logistics platform, this stood out.', hook).isHeadline).toBe(true);
    expect(
      checkOpener('Hi X,\n\nSaw you spent time leading operations before this role.', hook).isHeadline,
    ).toBe(false);
  });
});

describe('10. openerFailureSummary still reports the accurate reason for a restatement failure', () => {
  it('a Shiprocket-shaped restatement failure reports restatement, not a generic label', () => {
    const opener = checkOpener(
      "Hi Tanmay,\n\nShiprocket's non-shipping merchant software and checkout solutions now generate over a quarter of total revenue.",
      HOOK_FOR_OPENER_CHECK,
    );
    const summary = openerFailureSummary(opener, 84);
    expect(summary).toBe('Draft still opens by restating the source after one regeneration (84 words) — sent to manual review.');
  });
});
