import { describe, it, expect } from 'vitest';
import { checkEmailQuality, repairDirective, emailBody, countFacts } from '@/lib/generation/email-quality';
import { buildEmailBrief, renderBrief, type EmailBrief } from '@/lib/generation/brief';
import type { SolutionMatch } from '@/lib/solutions/types';

// The Shiprocket draft is why this module exists. It passed every check the
// app already had, and was still visibly worse than the reference emails:
//
//   "Watching Shiprocket scale past ₹2,000 crore ... highlights the sheer
//    volume of vendor relationships your finance team manages."
//   "...creates unnecessary friction in everyday accounting operations."
//   "We provide AI digital-employee agents that process invoices..."
//
// Four distinct defects: an opening that interprets instead of stating, a
// stacked opening, an asserted difficulty nobody evidenced, and the product
// described as a category rather than as work. Each gets its own rule, and
// these tests assert PROPERTIES rather than wording.

const brief = (over: Partial<EmailBrief> = {}): EmailBrief => ({
  recipientName: 'Tanmay',
  verifiedFact: 'Shiprocket crossed 2,000 crore in annual operating revenue this year.',
  operationalImplication: 'As the business grows, keeping invoice processing consistent across finance and operations becomes more involved.',
  workflow: 'Invoice processing',
  zampCapability: 'Processes invoices, matches and reconciles payables, and executes AP workflows end to end.',
  approvedProof: null,
  subjectContext: 'Invoice processing',
  whyThisPerson: 'Their role is Head of Finance Operations at Shiprocket, which sits close to invoice processing.',
  desiredConversation: 'How Shiprocket handles invoice processing today, and where we could be useful.',
  ...over,
});

/** The actual generated Shiprocket email, verbatim. */
const SHIPROCKET_BAD = [
  'Watching Shiprocket scale past 2,000 crore in annual operating revenue while expanding merchant software offerings highlights the sheer volume of vendor relationships your finance team manages.',
  'As transaction volumes climb across multiple subsidiaries, matching and reconciling payables manually creates unnecessary friction in everyday accounting operations.',
  'We provide AI digital-employee agents that process invoices, match and reconcile payables, and execute AP workflows end to end.',
  'Curious how your team handles invoice processing volume today, and whether it makes sense to compare notes on where automation fits?',
].join('\n\n');

/**
 * The same situation, written the way the reference emails are written.
 *
 * Note the opening leads on ONE fact. An earlier draft of this fixture kept
 * "while expanding its merchant software offerings" and the stacked-fact rule
 * correctly rejected it — which is the rule doing its job, so the fixture
 * changed rather than the rule.
 */
const SHIPROCKET_GOOD = [
  'Shiprocket has crossed 2,000 crore in annual operating revenue this year.',
  'As the business grows, keeping invoice processing and payables matching consistent across finance operations becomes more involved, particularly where several subsidiaries feed into the same ledger each month.',
  'Zamp can process invoices, match and reconcile payables against purchase orders, flag the exceptions that need a person to look at them, and run accounts payable workflows end to end.',
  "I'd be keen to understand how your team handles invoice processing today and where we could be useful. Would be great to compare notes on a short call.",
].join('\n\n');

describe('the Shiprocket draft fails, and for the right reasons', () => {
  const result = checkEmailQuality(SHIPROCKET_BAD, { brief: brief() });

  it('is rejected', () => {
    expect(result.passed).toBe(false);
  });

  it('flags the opening as interpretation rather than a stated fact', () => {
    expect(result.detail.opening_not_interpreted).toBe(false);
    expect(result.failures.join(' ')).toMatch(/interprets the fact/i);
  });

  it('flags the opening as stacking more than one fact', () => {
    expect(result.detail.opening_single_fact).toBe(false);
  });

  it('flags the unsupported difficulty', () => {
    expect(result.detail.no_assumed_pain).toBe(false);
    expect(result.failures.join(' ')).toMatch(/difficulty the evidence does not establish/i);
  });

  it('flags the product-category language', () => {
    expect(result.detail.no_product_category).toBe(false);
    expect(result.failures.join(' ')).toMatch(/what the product IS/i);
  });

  it('produces a directive naming each failure and what to preserve', () => {
    const directive = repairDirective(result, brief());

    expect(directive).toContain('EMAIL QUALITY FAILURES');
    expect(directive).toMatch(/1\./);
    expect(directive).toContain('Tanmay');
    expect(directive).toContain('Invoice processing');
    expect(directive).toMatch(/Do not invent difficulty/i);
    expect(directive).toMatch(/Do not invent a customer result/i);
  });
});

describe('the cleaned-up version passes', () => {
  const result = checkEmailQuality(SHIPROCKET_GOOD, { brief: brief() });

  it('passes every check', () => {
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('has the shape the reference emails have', () => {
    expect(result.wordCount).toBeGreaterThanOrEqual(90);
    expect(result.wordCount).toBeLessThanOrEqual(130);
    expect(result.paragraphs).toBeGreaterThanOrEqual(3);
    expect(result.paragraphs).toBeLessThanOrEqual(4);
  });

  it('states the fact plainly and carries the briefed workflow', () => {
    expect(result.detail.opening_uses_fact).toBe(true);
    expect(result.detail.opening_single_fact).toBe(true);
    expect(result.detail.workflow_present).toBe(true);
  });
});

describe('opening rules', () => {
  const withOpening = (opening: string) =>
    checkEmailQuality([opening, ...SHIPROCKET_GOOD.split('\n\n').slice(1)].join('\n\n'), { brief: brief() });

  it('rejects an opening that leads with the sender or the product', () => {
    expect(withOpening('Zamp helps finance teams process invoices at scale.').detail.opening_not_weak).toBe(false);
    expect(withOpening('We provide invoice processing support for finance teams.').detail.opening_not_weak).toBe(false);
    expect(withOpening('I wanted to reach out about your invoice processing.').detail.opening_not_weak).toBe(false);
  });

  it('rejects praise', () => {
    const r = checkEmailQuality(
      SHIPROCKET_GOOD.replace('has crossed', 'has impressive growth and crossed'),
      { brief: brief() },
    );
    expect(r.detail.no_praise).toBe(false);
  });

  it('counts stacked facts without parsing grammar', () => {
    expect(countFacts('Shiprocket crossed 2,000 crore in revenue.')).toBe(1);
    expect(countFacts('Shiprocket crossed 2,000 crore while expanding its software offerings.')).toBe(2);
    expect(countFacts('Shiprocket raised a round, with 400 new merchants added.')).toBe(2);
  });

  it('accepts a single-fact opening that merely mentions the company twice', () => {
    expect(countFacts('Shiprocket has crossed 2,000 crore in annual operating revenue.')).toBe(1);
  });
});

describe('the pain rule targets assertions, not vocabulary', () => {
  const withParagraph = (p: string) =>
    checkEmailQuality([SHIPROCKET_GOOD.split('\n\n')[0], p, ...SHIPROCKET_GOOD.split('\n\n').slice(2)].join('\n\n'), {
      brief: brief(),
    });

  it('rejects a difficulty asserted about their work', () => {
    for (const bad of [
      'Your finance team is struggling with invoice processing across the subsidiaries today.',
      'Reconciling payables manually creates unnecessary friction in everyday accounting operations.',
      'That process must be a bottleneck for the team as volumes climb across the group.',
    ]) {
      expect(withParagraph(bad).detail.no_assumed_pain, bad).toBe(false);
    }
  });

  it('does NOT reject ordinary language that merely contains a similar word', () => {
    for (const fine of [
      'As volumes grow, invoice matching and reconciliation work spreads across more entities each quarter.',
      'Consolidation usually means someone standardizes invoice matching before it settles into a routine.',
      'Reconciliation work tends to expand as the number of subsidiaries feeding the ledger increases.',
    ]) {
      expect(withParagraph(fine).detail.no_assumed_pain, fine).toBe(true);
    }
  });
});

describe('the product must be described as work', () => {
  const withZampParagraph = (p: string) => {
    const parts = SHIPROCKET_GOOD.split('\n\n');
    return checkEmailQuality([parts[0], parts[1], p, parts[3]].join('\n\n'), { brief: brief() });
  };

  it('rejects product-category phrasing', () => {
    for (const bad of [
      'We provide AI digital-employee agents that process invoices and reconcile payables end to end.',
      'Zamp is an AI-powered platform that handles invoice processing for finance teams everywhere.',
      'Our digital workforce processes invoices and matches payables across your entities each month.',
    ]) {
      expect(withZampParagraph(bad).detail.no_product_category, bad).toBe(false);
    }
  });

  it('accepts a description of the actual work', () => {
    const r = withZampParagraph(
      'Zamp can process invoices, match and reconcile payables against purchase orders, and run accounts payable workflows end to end.',
    );
    expect(r.detail.no_product_category).toBe(true);
  });
});

describe('workflow presence', () => {
  it('rejects a message unrelated to the briefed workflow', () => {
    const offTopic = [
      'Shiprocket has crossed 2,000 crore in annual operating revenue this year.',
      'As the network grows, keeping recruiting pipelines and interview scheduling consistent takes coordination between teams.',
      'Zamp can prepare candidate shortlists, schedule panels, and keep hiring records current across systems.',
      "I'd be keen to understand how your team handles that today and where we could be useful. Would be great to compare notes on a short call.",
    ].join('\n\n');

    expect(checkEmailQuality(offTopic, { brief: brief({ workflow: 'Invoice processing' }) }).detail.workflow_present).toBe(false);
  });

  it('accepts the workflow expressed naturally rather than as an exact string', () => {
    expect(checkEmailQuality(SHIPROCKET_GOOD, { brief: brief({ workflow: 'Payables matching and reconciliation' }) }).detail.workflow_present).toBe(true);
  });
});

describe('proof rules', () => {
  const parts = SHIPROCKET_GOOD.split('\n\n');
  const withProofParagraph = (p: string, b: EmailBrief) =>
    checkEmailQuality([parts[0], parts[1], parts[2], p, parts[3]].join('\n\n'), { brief: b });

  it('rejects a customer result when no approved proof exists', () => {
    for (const bad of [
      'Zamp recently helped a large retailer cut invoice processing time by 40% across their finance team.',
      'Our clients typically save more than 100 hours of manual work each month on payables.',
      'Teams see roughly 30% faster reconciliation once the workflow is running end to end.',
    ]) {
      expect(withProofParagraph(bad, brief()).detail.no_invented_proof, bad).toBe(false);
    }
  });

  it('accepts an email with no customer result at all', () => {
    expect(checkEmailQuality(SHIPROCKET_GOOD, { brief: brief() }).detail.no_invented_proof).toBe(true);
  });

  it('requires the approved statement verbatim when one exists', () => {
    const approved = {
      id: 'p1',
      customer: 'Fixture Customer A',
      workflow: 'invoice processing',
      approved_statement: 'FIXTURE STATEMENT (not a real customer result). Approved invoice proof goes here.',
    };
    const b = brief({ approvedProof: approved });

    // Paraphrased: rejected.
    expect(withProofParagraph('Zamp helped a customer cut invoice work by 40% last year.', b).detail.proof_verbatim).toBe(false);
    // Verbatim: accepted.
    expect(withProofParagraph(approved.approved_statement, b).detail.proof_verbatim).toBe(true);
  });
});

describe('the close', () => {
  const parts = SHIPROCKET_GOOD.split('\n\n');
  const withClose = (p: string) => checkEmailQuality([parts[0], parts[1], parts[2], p].join('\n\n'), { brief: brief() });

  it('rejects a pushy close', () => {
    for (const bad of [
      'Can I steal 15 minutes this week to walk through what we have seen at similar companies elsewhere?',
      "I'd love to show you a demo of how this works across your entities and subsidiaries today.",
      'Happy to book a demo whenever suits you best, so we can get moving on this quickly.',
    ]) {
      expect(withClose(bad).detail.cta_not_pushy, bad).toBe(false);
    }
  });

  it('rejects several competing questions', () => {
    expect(withClose('How does your team handle this today? Would a short call work? Who else should join?').detail.single_cta).toBe(false);
  });

  it('accepts a collaborative invitation', () => {
    expect(checkEmailQuality(SHIPROCKET_GOOD, { brief: brief() }).detail.cta_present).toBe(true);
  });
});

describe('emailBody ignores the greeting and signature', () => {
  it('counts only the body', () => {
    const withWrapper = `Hi Tanmay,\n\n${SHIPROCKET_GOOD}\n\nBest,\nAnnant Sharma`;
    const bare = checkEmailQuality(SHIPROCKET_GOOD, { brief: brief() });
    const wrapped = checkEmailQuality(withWrapper, { brief: brief() });

    expect(wrapped.wordCount).toBe(bare.wordCount);
    expect(wrapped.passed).toBe(true);
    expect(emailBody(withWrapper)).not.toContain('Annant Sharma');
  });
});

describe('the brief carries settled decisions, and omits what is unsettled', () => {
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

  it('takes the workflow decision away from the model', () => {
    const b = buildEmailBrief({
      recipientName: 'Tanmay', company: 'Shiprocket',
      verifiedFact: 'Shiprocket crossed 2,000 crore in revenue.', solution, proof: null,
    });

    expect(b.workflow).toBe('Invoice processing');
    expect(b.zampCapability).toContain('matches and reconciles payables');
    expect(b.operationalImplication).toContain('Shiprocket');
  });

  it('leaves the implication empty when no solution was matched, rather than inventing one', () => {
    const b = buildEmailBrief({
      recipientName: 'Tanmay', company: 'Shiprocket',
      verifiedFact: 'Shiprocket crossed 2,000 crore in revenue.', solution: null, proof: null,
    });

    expect(b.workflow).toBeNull();
    expect(b.operationalImplication).toBeNull();
    expect(b.zampCapability).toBeNull();
  });

  it('the implication never asserts difficulty', () => {
    const b = buildEmailBrief({
      recipientName: 'Tanmay', company: 'Shiprocket',
      verifiedFact: 'x', solution, proof: null,
    });

    expect(b.operationalImplication!.toLowerCase()).not.toMatch(/struggl|bottleneck|friction|overwhelm|difficult/);
  });

  it('renders the no-proof instruction explicitly rather than staying silent', () => {
    const rendered = renderBrief(buildEmailBrief({
      recipientName: 'Tanmay', company: 'Shiprocket', verifiedFact: 'x', solution, proof: null,
    }));

    expect(rendered).toContain('Approved proof: NONE');
    expect(rendered).toMatch(/no percentage/i);
    expect(rendered).toMatch(/do not re-decide/i);
  });
});
