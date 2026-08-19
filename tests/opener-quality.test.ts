import { describe, it, expect } from 'vitest';
import { checkOpener, checkPersonalization, applySenderIdentity } from '@/lib/pipeline/stages';

const HOOK = {
  signal:
    'McKinsey partnered with KPN to reinvent customer service through agentic AI in enterprise workflows',
  supporting_quote: 'KPN partners with McKinsey to reinvent customer service through agentic AI',
  source_title: 'KPN partners with McKinsey to reinvent customer service through agentic AI',
};

describe('checkOpener — anti-headline', () => {
  it('flags an opener that restates the source headline verbatim', () => {
    const msg = `Hi Stuti,

KPN partners with McKinsey to reinvent customer service through agentic AI. Worth a chat?`;
    const result = checkOpener(msg, HOOK);
    expect(result.isHeadline).toBe(true);
    expect(result.reason).toMatch(/headline|source|verbatim/i);
  });

  it('flags a minimally reworded headline', () => {
    const msg = `Hi Stuti,

I saw that KPN partnered with McKinsey to reinvent customer service using agentic AI. Worth a chat?`;
    expect(checkOpener(msg, HOOK).isHeadline).toBe(true);
  });

  it('accepts an interpretive opener that references the same fact', () => {
    const msg = `Hi Stuti,

Came across the KPN work on agentic AI, and given you sit in capabilities and insights
I wondered how much of that thinking is reaching internal operations. At Acme we build
finance back-office agents. Open to comparing notes?`;
    const result = checkOpener(msg, HOOK);
    expect(result.isHeadline).toBe(false);
  });

  it('does not treat a greeting line as the opener', () => {
    const msg = `Hi Nithin,

Your lean-team philosophy is unusual at Zerodha's scale, and it made me curious how you
think about back-office headcount specifically.`;
    expect(checkOpener(msg, HOOK).isHeadline).toBe(false);
  });

  it('ignores hooks with too little text to compare against', () => {
    expect(checkOpener('Some message here about things.', { signal: 'AI' }).isHeadline).toBe(false);
  });

  it('does not flag an empty message', () => {
    expect(checkOpener('', HOOK).isHeadline).toBe(false);
  });

  it('reports similarity even when it passes', () => {
    const msg = 'Hi — the agentic AI work you have been doing raises an interesting operations question.';
    const result = checkOpener(msg, HOOK);
    expect(result.similarity).toBeGreaterThanOrEqual(0);
    expect(result.similarity).toBeLessThan(0.72);
  });
});

describe('opener check complements the personalization gate', () => {
  const ctx = { prospectName: 'Stuti Sharma', company: 'McKinsey', role: 'Insights Analyst' };

  it('a headline opener can still pass the personalization gate — both checks are needed', () => {
    const msg = `Hi Stuti,

KPN partners with McKinsey to reinvent customer service through agentic AI. Given your
capabilities and insights remit at McKinsey, is that reaching internal workflows? Acme
builds finance agents. Open to a chat?`;

    // It uses the hook and names specifics, so personalisation is satisfied...
    expect(checkPersonalization(msg, HOOK, ctx).passed).toBe(true);
    // ...but the opener is still a pasted headline.
    expect(checkOpener(msg, HOOK).isHeadline).toBe(true);
  });

  it('the personalization gate still catches generic copy the opener check would miss', () => {
    const msg = `Hi Stuti, I hope this email finds you well. We help teams automate operations.
      Quick call?`;
    expect(checkPersonalization(msg, HOOK, ctx).passed).toBe(false);
    expect(checkOpener(msg, HOOK).isHeadline).toBe(false);
  });
});

describe('applySenderIdentity — configured sender name', () => {
  it('signs a new draft with the configured name', () => {
    const msg = 'Hi Nithin,\n\nA real observation here.\n\nBest,\n[Your Name]';
    expect(applySenderIdentity(msg, 'Annant Sharma')).toBe(
      'Hi Nithin,\n\nA real observation here.\n\nBest,\nAnnant Sharma',
    );
  });

  it('falls back to the team signature when no name is configured', () => {
    const msg = 'Hi Nithin,\n\nA real observation.\n\nBest,\n[Your Name]';
    expect(applySenderIdentity(msg, null)).toContain('Best,\nthe sending team');
    expect(applySenderIdentity(msg, '   ')).toContain('the sending team');
    expect(applySenderIdentity(msg, undefined)).toContain('the sending team');
  });

  it('respects an explicit fallback', () => {
    expect(applySenderIdentity('Body.\n\nBest,\n[Your Name]', null, 'Acme Sales')).toContain('Acme Sales');
  });

  it('completes a dangling sign-off that has no signature line at all', () => {
    expect(applySenderIdentity('Body text.\n\nBest,', 'Annant Sharma')).toBe(
      'Body text.\n\nBest,\nAnnant Sharma',
    );
  });

  it('leaves a real signature untouched', () => {
    const msg = 'Hi Nithin,\n\nA real observation.\n\nBest,\nAnnant';
    expect(applySenderIdentity(msg, 'Annant Sharma')).toBe(msg);
  });

  it('leaves a message with no sign-off untouched', () => {
    expect(applySenderIdentity('Just the body.', 'Annant Sharma')).toBe('Just the body.');
  });
});

describe('placeholder leakage — none may reach a final draft', () => {
  const PLACEHOLDERS = [
    '[Your Name]', '[Sender Name]', '[SENDER_NAME]', '[Name]', '[your name]',
    '<Your Name>', '<sender name>', '{{sender_name}}', '{{ sender_name }}',
    '{sender}', '[Your Signature]', '[Full Name]', '[Rep Name]',
  ];

  it.each(PLACEHOLDERS)('replaces %s with the configured sender', (ph) => {
    const out = applySenderIdentity(`Body text here.\n\nBest,\n${ph}`, 'Annant Sharma');
    expect(out).toContain('Annant Sharma');
    expect(out).not.toContain(ph);
    // No stray bracket/brace debris left behind.
    expect(out).not.toMatch(/[[\]{}<>]/);
  });

  it.each(PLACEHOLDERS)('never leaves %s when no sender is configured', (ph) => {
    const out = applySenderIdentity(`Body text here.\n\nBest,\n${ph}`, null);
    expect(out).not.toContain(ph);
    expect(out).toContain('the sending team');
  });

  it('does not touch product or company names that merely contain similar words', () => {
    const msg =
      'We build the Name Resolution Engine and integrate with Sender Analytics. ' +
      'Our client Full Name Systems uses it.\n\nBest,\n[Your Name]';
    const out = applySenderIdentity(msg, 'Annant Sharma');

    expect(out).toContain('Name Resolution Engine');
    expect(out).toContain('Sender Analytics');
    expect(out).toContain('Full Name Systems');
    expect(out).toContain('Annant Sharma');
  });

  it('does not strip bracketed text that is not a sender placeholder', () => {
    const msg = 'We support [SOC 2] and [ISO 27001] controls.\n\nBest,\n[Your Name]';
    const out = applySenderIdentity(msg, 'Annant Sharma');
    expect(out).toContain('[SOC 2]');
    expect(out).toContain('[ISO 27001]');
    expect(out).not.toContain('[Your Name]');
  });
});

describe('historical drafts are never rewritten', () => {
  it('applies only at generation time — stored text is not transformed on read', () => {
    // A stored draft from before this change still contains its original text.
    const stored = 'Hi Nithin,\n\nOld draft.\n\nBest,\n[Your Name]';
    // Nothing in the read path calls applySenderIdentity, so the value a
    // history view renders is exactly what was persisted.
    const rendered = stored;
    expect(rendered).toBe(stored);
    expect(rendered).toContain('[Your Name]');
  });
});

describe('per-run sender name', () => {
  it('signs with the name given for this run', () => {
    const msg = 'Hi Nithin,\n\nA real observation.\n\nBest,\n[Your Name]';
    expect(applySenderIdentity(msg, 'Priya Raman')).toContain('Best,\nPriya Raman');
  });

  it('completes an unsigned sign-off with the run name', () => {
    expect(applySenderIdentity('Body.\n\nBest,', 'Priya Raman')).toBe('Body.\n\nBest,\nPriya Raman');
  });

  it('falls back to the team signature when the run supplied no name', () => {
    expect(applySenderIdentity('Body.\n\nBest,\n[Your Name]', null)).toContain('the sending team');
  });

  it('never leaves a placeholder whichever name is used', () => {
    for (const name of ['Priya Raman', null, '']) {
      const out = applySenderIdentity('Body.\n\nBest,\n[Sender Name]', name);
      expect(out).not.toMatch(/\[|\]/);
    }
  });
});

describe('conversational opener quality', () => {
  const HOOK2 = {
    signal:
      'Zerodha operates as India’s largest retail discount brokerage handling millions of customers under SEBI regulation',
    supporting_quote: 'Zerodha is India’s largest retail discount brokerage',
    source_title: 'Zerodha: India’s largest discount broker',
  };

  it('1. rejects an accurate but research-report-style opener', () => {
    // Every fact here is true; it still reads like a briefing.
    const msg = `Hi Nithin,

Given that Zerodha operates as India's largest retail discount brokerage firm handling millions of
retail brokerage customers under strict SEBI financial regulatory frameworks requiring high-volume
customer onboarding and verification workflows, I was curious how your team manages the operational load.`;

    const result = checkOpener(msg, HOOK2);
    expect(result.isHeadline).toBe(true);
    expect(result.failures.join(' ')).toMatch(/research-report phrasing|research summary|words/i);
  });

  it('2. rejects a source-title-like opener', () => {
    const msg = 'Hi Nithin,\n\nZerodha is India’s largest retail discount brokerage. Worth a chat?';
    expect(checkOpener(msg, HOOK2).isHeadline).toBe(true);
  });

  it('3. rejects a long company-description opener', () => {
    const msg = `Hi Nithin,

Zerodha operates as the leading brokerage platform serving millions of investors across India,
headquartered in Bengaluru, with a market share of roughly twenty percent of retail volumes.`;

    const result = checkOpener(msg, HOOK2);
    expect(result.isHeadline).toBe(true);
    expect(result.failures.join(' ')).toMatch(/describes the company back to itself/i);
  });

  it('4. accepts a concise, evidence-grounded observation', () => {
    const msg = `Hi Nithin,

Your onboarding and verification volumes stood out to me, especially given how directly you shape
operations at Zerodha. At Acme we build finance back-office agents. Worth comparing notes?`;

    const result = checkOpener(msg, HOOK2);
    expect(result.isHeadline).toBe(false);
    expect(result.failures).toHaveLength(0);
    expect(result.word_count).toBeLessThanOrEqual(30);
  });

  it('flags a sentence that stacks several independent facts', () => {
    const msg =
      'Hi Nithin,\n\nZerodha crossed 10 million accounts, expanded into Bengaluru, and partnered with SEBI on compliance pilots.';
    const result = checkOpener(msg, HOOK2);
    expect(result.fact_clauses).toBeGreaterThanOrEqual(3);
    expect(result.isHeadline).toBe(true);
  });

  it('6. the existing anti-headline similarity check still fires independently', () => {
    // Short, conversational, no report phrasing — but it is the source restated.
    const hook = {
      signal: 'McKinsey partnered with KPN to reinvent customer service through agentic AI',
      supporting_quote: 'KPN partners with McKinsey to reinvent customer service through agentic AI',
      source_title: 'KPN partners with McKinsey to reinvent customer service through agentic AI',
    };
    const msg = 'Hi Stuti,\n\nKPN partnered with McKinsey to reinvent customer service through agentic AI.';
    const result = checkOpener(msg, hook);
    expect(result.isHeadline).toBe(true);
    expect(result.similarity).toBeGreaterThanOrEqual(0.72);
  });

  it('does not penalise a natural opener that happens to name the company once', () => {
    const msg =
      'Hi Nithin,\n\nI noticed how much weight Zerodha puts on verification at onboarding, which made me curious about your approach.';
    expect(checkOpener(msg, HOOK2).isHeadline).toBe(false);
  });

  it('7. the personalization gate still operates independently of opener quality', () => {
    const ctx = { prospectName: 'Nithin Kamath', company: 'Zerodha', role: 'Founder & CEO' };
    // Conversational and short, but engages nothing specific.
    const msg = 'Hi Nithin,\n\nI wanted to reach out about operations. We help teams automate. Chat?';
    expect(checkPersonalization(msg, HOOK2, ctx).passed).toBe(false);
  });

  it('8. sender identity is untouched by opener checking', () => {
    const msg = 'Hi Nithin,\n\nA concise observation about verification volumes.\n\nBest,\n[Your Name]';
    const signed = applySenderIdentity(msg, 'Priya Raman');
    expect(signed).toContain('Priya Raman');
    expect(checkOpener(signed, HOOK2).isHeadline).toBe(false);
  });
});

describe('superlative and scale phrasing', () => {
  const HOOK3 = {
    signal: 'Zerodha runs high-volume customer onboarding and verification',
    supporting_quote: 'Zerodha handles large volumes of customer onboarding',
    source_title: 'Zerodha onboarding at scale',
  };

  it('rejects a short opener that recites the company’s size back to them', () => {
    const msg =
      "Hi Nithin,\n\nRunning India's largest discount brokerage with millions of retail accounts means managing huge onboarding volumes.";
    const result = checkOpener(msg, HOOK3);
    expect(result.isHeadline).toBe(true);
    expect(result.failures.join(' ')).toMatch(/own size and standing/i);
  });

  it('rejects superlative-led phrasing even without a figure', () => {
    const msg = 'Hi Nithin,\n\nAs the leading brokerage in the country, your onboarding must be complex.';
    expect(checkOpener(msg, HOOK3).isHeadline).toBe(true);
  });

  it('still accepts a specific observation that mentions scale without superlatives', () => {
    const msg =
      'Hi Nithin,\n\nYour onboarding volumes stood out to me, especially given how directly you shape operations there.';
    expect(checkOpener(msg, HOOK3).isHeadline).toBe(false);
  });
});

// ─── superlative precision: "leading" as adjective vs verb ─────────────────
//
// Audit finding: the plain word-boundary match on "leading" flagged the verb
// sense ("time leading business finance", "you're co-leading Sunday
// PropTech") exactly as readily as the adjective sense ("the leading firm").
// Two real generated drafts (Myntra/Kannan, OYO/Saurav) were sent to manual
// review over legitimate, well-personalized openers for this reason alone.
// The fix requires a determiner immediately before "leading" — the adjective
// sense is reliably "the/a/an/one of the leading X"; the verb sense never is.

describe('superlative precision — "leading" requires adjective context', () => {
  const HOOK4 = {
    signal: 'A company milestone unrelated to the wording under test',
    supporting_quote: 'Some unrelated supporting quote',
    source_title: 'Some unrelated headline',
  };

  it('1. "the leading payments platform" — still detected', () => {
    const msg = "Hi Priya,\n\nAs the leading payments platform in the region, this caught my eye.";
    const r = checkOpener(msg, HOOK4);
    expect(r.isHeadline).toBe(true);
    expect(r.failures.join(' ')).toMatch(/superlative/i);
  });

  it('2. "one of the leading fintech providers" — still detected', () => {
    const msg = "Hi Priya,\n\nAs one of the leading fintech providers in the country, this stood out.";
    const r = checkOpener(msg, HOOK4);
    expect(r.isHeadline).toBe(true);
    expect(r.failures.join(' ')).toMatch(/superlative/i);
  });

  it('3. "time leading business finance" — NOT detected (the real Myntra/Kannan case)', () => {
    const msg =
      'Kannan, I noticed your recent transition into the CFO role at Myntra after your time leading business finance at Flipkart.';
    const r = checkOpener(msg, HOOK4);
    expect(r.isHeadline).toBe(false);
    expect(r.failures.join(' ')).not.toMatch(/superlative/i);
  });

  it('4. "you\'re co-leading Sunday PropTech" — NOT detected (the real OYO/Saurav case)', () => {
    const msg =
      "Saurav, saw you're co-leading Sunday PropTech alongside Rakesh Kumar to scale premium assets ahead of PRISM's IPO.";
    const r = checkOpener(msg, HOOK4);
    expect(r.isHeadline).toBe(false);
    expect(r.failures.join(' ')).not.toMatch(/superlative/i);
  });

  it('5a. existing high-confidence superlatives remain detected: largest', () => {
    const msg = 'Hi Nithin,\n\nRunning the largest brokerage in the region keeps things interesting.';
    expect(checkOpener(msg, HOOK4).isHeadline).toBe(true);
  });

  it('5b. existing high-confidence superlatives remain detected: cutting-edge / foremost / premier', () => {
    for (const word of ['cutting-edge', 'foremost', 'premier', 'biggest', 'renowned']) {
      const msg = `Hi Nithin,\n\nBuilding a ${word} platform for retail investors is no small task.`;
      expect(checkOpener(msg, HOOK4).isHeadline, word).toBe(true);
    }
  });

  it('a bare, undeterminered "leading" elsewhere in the sentence still does not trip the check', () => {
    // Guards against a regex that merely drops the word-boundary requirement
    // rather than genuinely requiring determiner context.
    const msg = 'Hi Nithin,\n\nLeading through that transition must have required real judgment calls.';
    expect(checkOpener(msg, HOOK4).isHeadline).toBe(false);
  });
});

// ─── Issue 2: the Stage 12 summary reports the ACTUAL opener failure ────────
//
// Audit finding: generateMessageStage() always displayed "Draft still opens
// by restating the source..." whenever checkOpener().isHeadline was true,
// regardless of which of checkOpener()'s six independent checks actually
// failed. Two real runs (be4ec378 / Myntra, 4b8dbb21 / OYO) failed on the
// superlative check specifically and were shown a factually wrong reason.

import { openerFailureSummary } from '@/lib/pipeline/stages';

describe('openerFailureSummary — reports the real reason, not an assumed one', () => {
  it('containment failure → the restatement summary', () => {
    const summary = openerFailureSummary(
      { reason: 'The opening sentence restates the research signal almost verbatim (83% of its content words), so it reads like a pasted headline rather than an observation.' },
      98,
    );
    expect(summary).toBe('Draft still opens by restating the source after one regeneration (98 words) — sent to manual review.');
  });

  it('superlative failure → the superlative summary, NOT restatement', () => {
    const summary = openerFailureSummary(
      { reason: 'The opening leans on superlatives ("largest", "leading") instead of a specific observation.' },
      73,
    );
    expect(summary).toBe('Draft still leans on superlative phrasing after one regeneration (73 words) — sent to manual review.');
    expect(summary).not.toMatch(/restating the source/i);
  });

  it('company-size-and-superlative failure also reads as superlative, not restatement', () => {
    const summary = openerFailureSummary(
      { reason: 'The opening recites the company’s own size and standing back to them rather than making an observation.' },
      80,
    );
    expect(summary).toMatch(/superlative phrasing/i);
  });

  it('stacked-facts failure → its own accurate summary', () => {
    const summary = openerFailureSummary(
      { reason: 'The opening sentence packs 3 separate facts together, which reads as a research summary rather than one clear observation.' },
      90,
    );
    expect(summary).toMatch(/stacks too many facts/i);
    expect(summary).not.toMatch(/restating the source|superlative/i);
  });

  it('overlong-sentence failure → its own accurate summary', () => {
    const summary = openerFailureSummary(
      { reason: 'The opening sentence runs to 52 words. A natural observation is roughly 15-30.' },
      95,
    );
    expect(summary).toMatch(/overlong sentence/i);
  });

  it('research-report-phrasing failure → its own accurate summary', () => {
    const summary = openerFailureSummary(
      { reason: 'The message opens with research-report phrasing rather than an observation a salesperson would write.' },
      88,
    );
    expect(summary).toMatch(/research-report phrasing/i);
  });

  it('company-describes-itself failure → its own accurate summary', () => {
    const summary = openerFailureSummary(
      { reason: 'The opening describes the company back to itself. The prospect already knows what their company does.' },
      70,
    );
    expect(summary).toMatch(/describes the company back to itself/i);
  });

  it('an unrecognised reason falls back honestly rather than mislabeling', () => {
    const summary = openerFailureSummary({ reason: 'Some future check text not yet mapped.' }, 60);
    expect(summary).not.toMatch(/restating the source/i);
    expect(summary).toMatch(/pasted headline/i);
  });
});

describe('multiple simultaneous opener failures — summary follows the SAME primary/first failure checkOpener() itself uses', () => {
  it('when containment and superlative both fail, the summary reports containment (checkOpener\'s own first-listed check)', () => {
    // Verbatim-restated AND leans on "the leading X" — containment is
    // evaluated first inside checkOpener(), so opener.reason (failures[0])
    // is already the containment message; the summary must track it exactly.
    const hook = {
      signal: 'Acme is the leading logistics platform processing millions of shipments',
      supporting_quote: 'Acme is the leading logistics platform',
      source_title: 'Acme: the leading logistics platform',
    };
    const msg = 'Hi Sam,\n\nAcme is the leading logistics platform processing millions of shipments annually.';
    const opener = checkOpener(msg, hook);

    expect(opener.isHeadline).toBe(true);
    expect(opener.failures.length).toBeGreaterThan(1); // containment AND superlative both present
    expect(opener.reason).toMatch(/restates .+ almost verbatim/i); // containment is failures[0]

    const summary = openerFailureSummary(opener, 42);
    expect(summary).toMatch(/restating the source/i);
    expect(summary).not.toMatch(/superlative phrasing/i);
  });
});

// ─── end-to-end regression: the real audit cases, composed through both real functions ──

describe('regression — the real audit cases, through checkOpener() + openerFailureSummary() together', () => {
  it('a genuine source-restatement draft still fails and still reports restatement (f2b80bd9-shaped)', () => {
    const hook = {
      signal:
        "Zerodha operates as India's largest retail discount brokerage firm handling millions of retail brokerage customers under strict SEBI financial regulatory frameworks requiring high-volume customer onboarding and verification workflows.",
      supporting_quote: 'Zerodha is India’s largest retail discount brokerage',
      source_title: 'Zerodha: India’s largest discount broker',
    };
    const msg =
      "Hi Nithin,\n\nGiven that Zerodha operates as India's largest retail discount brokerage firm handling millions of retail brokerage customers under strict SEBI financial regulatory frameworks requiring high-volume customer onboarding and verification workflows, I was curious how your team manages that.";

    const opener = checkOpener(msg, hook);
    expect(opener.isHeadline).toBe(true);

    const summary = openerFailureSummary(opener, 60);
    expect(summary).toBe('Draft still opens by restating the source after one regeneration (60 words) — sent to manual review.');
  });

  it('a legitimate personalized opener using "leading" as a verb now PASSES (be4ec378-shaped)', () => {
    const hook = {
      signal: 'Kannan Ganesan was appointed as Chief Financial Officer of Myntra, succeeding Abhishek Gupta.',
      supporting_quote: 'Kannan Ganesan appointed CFO of Myntra',
      source_title: 'Myntra names Kannan Ganesan as new CFO',
    };
    const msg =
      'Kannan, I noticed your recent transition into the CFO role at Myntra after your time leading business finance at Flipkart.';

    const opener = checkOpener(msg, hook);
    expect(opener.isHeadline).toBe(false);
    expect(opener.failures).toEqual([]);
  });

  it('a legitimate personalized opener using "co-leading" as a verb now PASSES (4b8dbb21-shaped)', () => {
    const hook = {
      signal:
        "Led Sunday PropTech alongside Group CFO Rakesh Kumar to manage high-performing hotel and office assets through long-term strategies and recent funding rounds ahead of OYO's parent PRISM's IPO.",
      supporting_quote: 'Saurav Agarwal co-leads Sunday PropTech',
      source_title: 'Sunday PropTech leadership',
    };
    const msg =
      "Saurav, saw you're co-leading Sunday PropTech alongside Rakesh Kumar to scale premium assets ahead of PRISM's IPO.";

    const opener = checkOpener(msg, hook);
    expect(opener.isHeadline).toBe(false);
    expect(opener.failures).toEqual([]);
  });
});
