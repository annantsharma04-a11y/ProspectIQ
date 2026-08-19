import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApprovedProofContext } from '@/lib/proof/match';

// Phase 2 wires the deterministically-selected approved proof into the
// generation prompt. What has to hold, and what these pin down:
//
//   - the ONE selected proof reaches the prompt, whole and unaltered
//   - the model never sees a catalog, so it has nothing to choose between
//   - when there is no proof, the prompt says so explicitly and forbids a
//     stand-in, rather than staying silent and inviting one
//
// Deliberately asserted against the PROMPT STRING the model actually receives,
// not against a wrapper's arguments: the prompt is the contract, and a field
// that is passed but never interpolated would pass an argument-shape test
// while changing nothing.

const mockCallStructured = vi.fn();
vi.mock('@/lib/llm/gemini', () => ({
  callStructured: (...a: unknown[]) => mockCallStructured(...a),
}));

const { analyzeProspect } = await import('@/lib/llm/analyze');

// A deliberately SYNTHETIC fixture. The illustrative statements supplied
// with the reference emails are placeholders, not approved evidence, so
// nothing resembling a real customer result lives here — the statement says
// outright that it is a fixture, and the customer is unmistakably fictional.
const PROOF: ApprovedProofContext = {
  id: 'proof_fixture_reporting',
  customer: 'Fixture Customer A',
  workflow: 'reporting pack preparation',
  approved_statement:
    'FIXTURE STATEMENT (not a real customer result). Approved reporting proof goes here.',
};

const baseInput = {
  profile: null,
  profileAccessNote: 'Profile unavailable.',
  sources: [],
  slug: 'jane-kapoor',
  nameHint: 'Jane Kapoor',
  userHints: { name: null, company: null, title: null },
  outreachContext: 'We build AI agents for finance operations.',
  senderName: 'Sam Rivera',
  senderCompany: 'Zamp',
};

/** The user-role prompt string the model actually received. */
function promptSent(): string {
  return mockCallStructured.mock.calls[0][0].input as string;
}

/** The system instruction the model actually received. */
function systemSent(): string {
  return mockCallStructured.mock.calls[0][0].system as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCallStructured.mockResolvedValue({ data: {}, meta: {} });
});

describe('an approved proof reaches the generation prompt', () => {
  it('includes the approved proof block', async () => {
    await analyzeProspect({ ...baseInput, approvedProof: PROOF });
    expect(promptSent()).toContain('APPROVED ZAMP PROOF');
  });

  it('carries the exact id, customer and workflow', async () => {
    await analyzeProspect({ ...baseInput, approvedProof: PROOF });
    const prompt = promptSent();

    expect(prompt).toContain('proof_fixture_reporting');
    expect(prompt).toContain('Fixture Customer A');
    expect(prompt).toContain('reporting pack preparation');
  });

  it('carries the approved statement byte-for-byte', async () => {
    await analyzeProspect({ ...baseInput, approvedProof: PROOF });

    // The whole point: the sentence the model is shown is the sentence that
    // was approved, character for character.
    expect(promptSent()).toContain(PROOF.approved_statement);
  });

  it('states the verbatim-or-omit rule beside the statement', async () => {
    await analyzeProspect({ ...baseInput, approvedProof: PROOF });
    const prompt = promptSent().toLowerCase();

    expect(prompt).toContain('word for word');
    expect(prompt).toContain('paraphrase');
  });

  it('shows exactly ONE proof and no catalog to choose from', async () => {
    await analyzeProspect({ ...baseInput, approvedProof: PROOF });
    const prompt = promptSent();

    // One block, one statement. Nothing to select between.
    expect(prompt.match(/APPROVED ZAMP PROOF/g)).toHaveLength(1);
    expect(prompt).not.toContain('proof_chargeback');
    expect(prompt.toLowerCase()).not.toContain('choose the most');
  });
});

describe('no proof is never an invitation to invent one', () => {
  it('says explicitly that no proof is available', async () => {
    await analyzeProspect({ ...baseInput });
    expect(promptSent()).toContain('NO APPROVED PROOF');
  });

  it('forbids the anonymous stand-in, which is the likely failure mode', async () => {
    await analyzeProspect({ ...baseInput });
    const flat = promptSent().replace(/\s+/g, ' ').toLowerCase();

    // "a large retailer saw..." is still a fabricated result, so each escape
    // route is closed by name rather than left to a general prohibition.
    expect(flat).toContain('name a customer');
    expect(flat).toContain('"a client"');
    expect(flat).toContain('percentage');
    expect(flat).toContain('anonymous or composite customer result');
    expect(flat).toContain('case study');
    expect(flat).toContain('invent evidence');
  });

  it('states that a message with no customer result is correct', async () => {
    await analyzeProspect({ ...baseInput });
    // Normalised: the prompt hard-wraps, so the phrase straddles a newline.
    const flat = promptSent().replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('an email with no proof is correct and expected here');
  });

  it('never emits a placeholder, example or fallback proof', async () => {
    await analyzeProspect({ ...baseInput });
    const prompt = promptSent();

    expect(prompt).not.toContain('APPROVED ZAMP PROOF');
    expect(prompt).not.toContain('Fixture Customer A');
    expect(prompt).not.toContain('Approved statement:');
    expect(prompt).not.toContain('example_proof');
  });

  it('the system rules also forbid an unattributed result', async () => {
    await analyzeProspect({ ...baseInput });
    const system = systemSent().toLowerCase();

    expect(system).toContain('anonymous result is still a fabricated result');
  });
});

describe('the proof rule is stated as immutable in the system instruction', () => {
  it('permits only verbatim reproduction or omission', async () => {
    await analyzeProspect({ ...baseInput, approvedProof: PROOF });
    const system = systemSent();

    expect(system).toContain('APPROVED PROOF');
    expect(system.toLowerCase()).toContain('word for word');
  });

  it('forbids every mutation route individually', async () => {
    await analyzeProspect({ ...baseInput, approvedProof: PROOF });
    const system = systemSent().toLowerCase();

    for (const forbidden of ['paraphrase', 'number', 'customer name', 'second proof', 'second result']) {
      expect(system, forbidden).toContain(forbidden);
    }
  });

  it('states the model does not select the proof', async () => {
    await analyzeProspect({ ...baseInput, approvedProof: PROOF });
    expect(systemSent().toLowerCase()).toContain('not yours to choose');
  });
});

describe('the new message structure is instructed', () => {
  it('requests 90-130 words, aiming for 100-115', async () => {
    await analyzeProspect({ ...baseInput });
    const system = systemSent();

    expect(system).toContain('90-130 words');
    expect(system).toContain('100-115');
    // The old target must be gone, not merely supplemented.
    expect(system).not.toContain('40-130 words');
  });

  it('names every beat of the required sequence', async () => {
    await analyzeProspect({ ...baseInput });
    const system = systemSent();

    for (const beat of [
      'ONE VERIFIED FACT',
      'OPERATIONAL IMPLICATION',
      'ONE RELEVANT WORKFLOW',
      'SPECIFIC CAPABILITY',
      'ONE APPROVED RESULT',
      'COLLABORATIVE QUESTION',
      'LOW-PRESSURE INVITATION',
    ]) {
      expect(system, beat).toContain(beat);
    }
  });

  it('draws the infer-the-work / invent-the-pain line explicitly', async () => {
    await analyzeProspect({ ...baseInput });
    const system = systemSent();

    expect(system).toContain('INFER THE WORK, NEVER INVENT THE PAIN');
    // Both sides of the line are shown, so it is a distinction rather than a ban.
    expect(system).toContain('gets harder');
    expect(system.toLowerCase()).toContain("i'm sure your team is struggling");
  });

  it('asks for one fact, not a research dump', async () => {
    await analyzeProspect({ ...baseInput });
    expect(systemSent()).toContain('ONE FACT ONLY');
  });

  it('requires the message field to contain the email and nothing else', async () => {
    await analyzeProspect({ ...baseInput });
    const system = systemSent();

    expect(system).toContain('OUTPUT SHAPE:');
    // Normalised: the prompt hard-wraps, so phrases straddle newlines.
    const flat = system.replace(/\s+/g, ' ');
    for (const banned of ['No headings', 'bullet points', 'Here is your email', 'markdown']) {
      expect(flat, banned).toContain(banned);
    }
    // The structure is reasoning, not layout the reader sees.
    expect(flat).toContain('The structure above is how you THINK');
  });

  it('bans the remaining marketing, praise and opener phrases', async () => {
    await analyzeProspect({ ...baseInput });
    const system = systemSent();

    for (const banned of ['world-class', 'best-in-class', 'exceptional', 'admirable', 'amazing']) {
      expect(system, banned).toContain(banned);
    }
    for (const opener of ['I wanted to reach out', 'I wanted to introduce myself', 'Given your role', 'As a leader in']) {
      expect(system, opener).toContain(opener);
    }
  });

  it('constrains the subject line', async () => {
    await analyzeProspect({ ...baseInput });
    const system = systemSent();

    expect(system).toContain('SUBJECT:');
    expect(system).toContain('Quick question');
  });
});

describe('existing evidence policy is untouched by the rewrite', () => {
  it('the evidence rules still lead the system instruction', async () => {
    await analyzeProspect({ ...baseInput });
    const system = systemSent();

    expect(system).toContain('EVIDENCE RULES — these override everything else');
    expect(system).toContain('supporting_quote MUST be text copied verbatim');
    expect(system).toContain('Never guess a');
    expect(system).toContain('Use ONLY the supplied LinkedIn profile data and web sources.');
  });

  it('hook selection, identity and claim-typing rules all survive', async () => {
    await analyzeProspect({ ...baseInput });
    const system = systemSent();

    expect(system).toContain('HOOK SELECTION:');
    expect(system).toContain('IDENTITY:');
    expect(system).toContain('SENDER_OUTCOME_CLAIM');
    expect(system).toContain('APPROVED SOLUTION:');
  });

  it('the banned-language and no-em-dash rules survive', async () => {
    await analyzeProspect({ ...baseInput });
    const system = systemSent();

    expect(system).toContain('NEVER WRITE:');
    expect(system).toContain('Em dashes.');
  });
});

// A non-brittle structural fixture: properties an intended message has, with
// no assertion about wording. This is what a Phase 3 checkStructure() would
// formalise — kept as an observation for now, per the phase boundary.
describe('reference structure — properties, not prose', () => {
  const INTENDED = `Hi David,

You wrote recently that Revolut now has 11 product lines generating more than £100 million in annual revenue, with New Bets run as a portfolio of internal startups.

As that portfolio grows, keeping financial and operating reporting consistent across each product becomes harder. Zamp can pull agreed metrics from existing systems, flag missing or inconsistent inputs, and prepare the first portfolio update for review.

${PROOF.approved_statement}

I'd be keen to understand how reporting across New Bets is handled today and where we could be useful. Would be great to schedule a quick call to talk through the same.`;

  const body = INTENDED.split('\n').slice(1).join('\n');
  const wordCount = body.trim().split(/\s+/).filter(Boolean).length;

  it('lands inside the requested word range', () => {
    expect(wordCount).toBeGreaterThanOrEqual(90);
    expect(wordCount).toBeLessThanOrEqual(130);
  });

  it('uses three or four short paragraphs', () => {
    const paragraphs = body.trim().split(/\n\s*\n/).filter(Boolean);
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
    expect(paragraphs.length).toBeLessThanOrEqual(4);
  });

  it('reproduces the approved statement verbatim, exactly once', () => {
    expect(body).toContain(PROOF.approved_statement);
    expect(body.split(PROOF.approved_statement).length - 1).toBe(1);
  });

  it('carries no em dash and no exclamation mark', () => {
    expect(INTENDED).not.toContain('—');
    expect(INTENDED).not.toContain('!');
  });

  it('asserts no pain and pays no compliment', () => {
    const lower = INTENDED.toLowerCase();
    for (const banned of ['struggling', 'must be frustrating', 'impressed', 'i imagine', "i've been following"]) {
      expect(lower, banned).not.toContain(banned);
    }
  });

  it('opens on the verified fact rather than the sender or the product', () => {
    const firstLine = body.trim().split('\n')[0];
    expect(firstLine.startsWith('Zamp')).toBe(false);
    expect(firstLine.toLowerCase()).not.toContain('i wanted to reach out');
    expect(firstLine.toLowerCase()).not.toContain('hope you');
  });
});
