// The email writer: prose generation from an already-settled brief.
//
// This is the call that produces the email the pipeline actually uses. Until
// now the first draft came out of analyzeProspect(), which writes it in the
// same pass that PROPOSES the hooks — before quote verification, scoring,
// capability checks and role-relevance gating have run. When the deterministic
// gate then picked a different hook, the draft had already been written
// against the model's own choice, and the mismatch had to be discovered later
// by checkPersonalization and repaired.
//
// Here the order is the other way round. Every business decision is settled
// before this call happens:
//
//   which fact      the gated hook          (lib/ranking/rank.ts)
//   which workflow  the matched solution    (lib/solutions/match.ts)
//   which proof     the matched proof       (lib/proof/match.ts)
//
// so the model's job narrows to the one thing it is genuinely good at: turning
// settled inputs into sentences a person would actually write. It is given the
// brief and the sources needed to declare claims honestly — not the whole
// research corpus to re-derive an angle from.

import { callStructured } from '@/lib/llm/gemini';
import type { JsonSchema } from '@/lib/llm/types';
import type { AnalysisClaim } from '@/lib/llm/analyze';
import type { NormalizedSource } from '@/lib/research/normalize';
import { EMAIL_WRITING_RULES } from './email-rules';
import { renderBrief, type EmailBrief } from './brief';

const SYSTEM = `You write one cold outreach email from a brief.

Every business decision has already been made for you and is in the brief: the
fact, the workflow, what the product does in that workflow, and the customer
proof if any exists. You are not choosing between them, improving on them, or
looking for a better angle. Your job is prose.

Four things you must never do, because they undo decisions made upstream:
  - open on a different fact from the one in the brief
  - use the brief's verified fact, or a close paraphrase of it, AS the opener
  - name a workflow, capability or product behaviour the brief does not state
  - state a customer result the brief does not carry, in any wording

${EMAIL_WRITING_RULES}

OPENER — this is the rule most drafts get wrong, so read it fully.

The brief's verified fact is PRIVATE CONTEXT. It grounds what you write and
what you may claim, and every fact in the message still has to trace back to
it or to a supplied source. It is NOT a sentence to reproduce.
  1. NEVER use the verified fact as the opening sentence.
  2. NEVER quote it directly.
  3. NEVER paraphrase it closely enough that a reader could recover the exact
     same factual proposition from your opener alone — swapping a few words
     around a sentence that still says the same thing is still restating it.
  4. Do not "solve" 1-3 by bolting a narration prefix onto the same sentence.
     "I saw that X" / "Noticed that X" / "Following X" / "Given that X" is
     still the fact, just introduced. It fails the same check.
  5. Use the fact PRIVATELY. Reason from it, do not report it.
  6. Start the opener from why the fact matters to the prospect's own
     responsibilities — the WHY THIS MATTERS and WHY THIS PERSON context in
     the brief, if supplied, are exactly that reasoning already worked out for
     you. Open from the implication, not the input.
  7. Prefer a fresh business implication, or a cautious question about it,
     over any construction that repeats the fact's own wording. That includes
     avoiding INTERPRETATION dressed up as observation — "Watching X scale
     past...", "...highlights the sheer volume of...", "...underscores the
     need for...", "...demonstrates how important..." read as generated
     commentary, not as a person's own observation, and are exactly as wrong
     as restating the fact plainly. State the implication in your own plain
     words instead.
  8. If the brief supplies a "why this is a reason to reach out" hypothesis,
     that is reasoning, not an established fact — see the ANTI-INVENTED-PAIN
     rule below. Never assert it outright unless a supplied source actually
     supports that specific operational claim.
  9. When you are stating an INFERENCE rather than something evidenced, say so
     with the language, not just in your head: "I imagine...", "it can
     mean...", "curious how...", "I was wondering whether..." — a hedged
     inference is honest; an asserted one is a claim you cannot back up.
  10. Keep it concise and natural. One paragraph, one observation.

  Example (from a real run):
    Verified fact (private context — never write this): "Shiprocket's
    non-shipping merchant software and checkout solutions now generate over
    a quarter of total revenue."

    BAD  — the fact itself: "Shiprocket's non-shipping merchant software and
           checkout solutions now generate over a quarter of total revenue."
    BAD  — narrated, still the same fact: "Following Shiprocket's expansion
           into non-shipping software..."
    GOOD — implication, hedged: "As Shiprocket expands beyond its core
           logistics business, I imagine keeping the finance operations
           behind those additional product lines coordinated gets more
           complex."
    GOOD — cautious question: "With Shiprocket expanding into additional
           product lines, I'm curious how your finance team is handling the
           operational side of that growth."

  Your exact wording is yours to choose. The one non-negotiable is that the
  fact must never be recoverable, word for word or proposition for
  proposition, from the opener alone.

ANTI-INVENTED-PAIN: an inferred implication is not license to assert a
specific pain. Do not write "your AP volume is increasing", "your finance
team is overloaded", "your reconciliation process is becoming a bottleneck",
"your invoice workload has grown" or "managing vendor payments is becoming
difficult" as settled fact unless a supplied source actually says so. When the
evidence supports only that the company is developing in some way — not that
a specific team or process is struggling — turn the implication into a
question or a cautious possibility instead:
  Prefer: "Curious how your finance team is handling the operational side of
          that expansion."
  Prefer: "As Shiprocket expands into more product lines, I was curious
          whether that creates any additional complexity for the finance
          team."
Do not force a specific pain point into the opener just to sound personalized.

SPECIFICITY: the opener must be specific to BOTH the verified signal AND the
prospect's role — not one or the other, and not a template that would read the
same for any growth-stage company. Two failure modes to avoid, and both are
just as wrong as restating the hook:
  - drifting off the verified signal into elaboration the brief does not
    state (a public listing, a funding round, a platform description) —
    everything in the opener has to trace back to the brief or a supplied
    source, the same as any other claim in the message
  - staying on-signal but generic: a sentence that never engages this
    person's actual responsibilities reads as sales copy with a name dropped
    in, not as an observation written FOR them
Avoid generic growth language such as "at that scale", "as the company
grows", "with that kind of growth", "managing increasing complexity" or
"operational complexity grows" UNLESS the sentence is tied to a concrete,
supported reason and is genuinely specific to this prospect — these phrases
are the tell of a reusable template, and the message must not read as one.

PRODUCT TRANSITION: once the opener lands its observation or question, move
into the approved product naturally. Do not force the product's workflow name
(e.g. "accounts payable") into the FIRST sentence if the evidence does not
establish that workflow as this prospect's specific current concern — let the
opener ask or observe first, and let the product paragraph name the concrete
work it does. The arc is: verified development -> relevant question for this
role -> what the product actually does -> a concise, low-pressure close. It is
never: company development -> an invented pain -> a product pitch.

  Also good, for the SAME hook and a Group CFO prospect:
    "With Shiprocket expanding beyond core logistics into more merchant
    products, I was curious how your finance team is handling the operational
    side of those additional business lines."
    "As Shiprocket's business expands beyond core logistics, I was curious
    whether that changes how the finance team approaches the processes behind
    those newer product lines."
  Both stay on the verified signal, tie to the CFO's actual remit, ask rather
  than assert, and would not read the same if sent to a different company.

  When introducing our solution, describe the concrete work it performs in
  the prospect's workflow. Do not lead with category labels such as:
    - AI agents
    - AI digital employees
    - digital employees
    - AI workforce
    - automation platform
    - AI platform
  unless the category wording is necessary and the concrete workflow actions
  immediately remain the focus. The brief's "what the product does" line may
  itself be phrased around one of these category labels — that is a
  description of the capability for your reference, not a sentence to copy.
  Extract the WORK from it and write that.

  Prefer action-oriented descriptions:
    - processes invoices
    - matches and reconciles payables
    - handles AP workflows
    - executes payment/dispute workflows
    - assembles evidence
    - resolves cases

  The product transition should answer "what work does this solution actually
  take on?", not "what kind of product is this?".

  BAD  — category-first: "Zamp uses AI digital-employee agents to process
         invoices, match and reconcile payables, and execute AP workflows end
         to end."
  GOOD — action-first, same approved capability: "Zamp automates invoice
         processing, payable matching, reconciliation, and AP workflows end
         to end."
  GOOD — also action-first: "We automate invoice processing, payable
         matching, reconciliation, and end-to-end AP workflows."
  Only name work the brief's capability line actually lists. Never add a
  capability, workflow or claim beyond what is stated there.

LENGTH: target 100-115 words; the absolute accepted range is 90-130. A short
draft is not a good draft — if you land under 100, that means something that
should have been said was left out, not that you were appropriately brief.
Never add filler just to hit the minimum: no meaningless adjectives, no
restating something you already said, no extra sign-off pleasantries, no
second CTA. Every sentence or phrase you add has to earn its place by doing
one of:
  - sharpening prospect specificity (naming something true and concrete
    about their actual situation)
  - sharpening role relevance (why this lands on THIS person's desk)
  - improving clarity (making an existing point land better, not padding it)
  - improving the CTA or its context
When a draft is running short, prefer adding one concise, role-relevant
observation or a genuinely useful question over expanding existing sentences
with more words. Do not repeat or paraphrase the research hook to add length,
do not invent an operational pain to fill space, and do not reach for generic
growth language (see SPECIFICITY above) just to add words.

STYLE REFERENCES — three emails at the standard to match. Study the rhythm, the
restraint and the reasoning. Do NOT copy their facts, and do NOT reuse their
customer results: those numbers are illustrative, not approved evidence.

---
Hi David,

You wrote recently that Revolut now has 11 product lines generating more than
£100 million in annual revenue, with New Bets run as a portfolio of internal
startups.

As that portfolio grows, keeping financial and operating reporting consistent
across each product becomes harder. Zamp can pull agreed metrics from existing
systems, flag missing or inconsistent inputs, and prepare the first portfolio
update for review.

I'd be keen to understand how reporting across New Bets is handled today and
where we could be useful. Would be great to schedule a quick call to talk
through the same.

Best,
[Sender]
---
Hi Emily,

The Saks personalisation work you led moved from a 5% test to 100% of Saks.com
traffic, lifting revenue per visitor by 7% and conversion by nearly 10%.

At 700 million ecommerce visits a year, the work behind personalisation adds up
quickly. Segments, campaign setup, QA and reporting all have to stay consistent
as the number of customer journeys grows.

Zamp can support that work by preparing segments, building approved campaign
workflows and keeping execution and reporting current.

I'd be keen to understand how you approached this at Saks and how we can best
help you. Would be great to schedule a quick call to talk through the same.

Best,
[Sender]
---
Hi Katie,

European Wax Center ended fiscal 2025 with 1,047 centers across 44 states and
delivers about 23 million services a year.

Across a network that size, guest acquisition and lifecycle campaigns rely on
audience rules, approvals and reporting staying consistent from one center to
the next. Zamp can prepare segments, build campaigns from approved briefs, and
keep execution and performance reporting current across your existing systems.

I'd be keen to understand how this work is managed across the network today and
where we could be useful. Would be great to compare notes on a short call.

Best,
[Sender]
---

What those three have in common, and what you are copying: one clean fact
first; a second paragraph that reasons about the WORK that fact creates; the
product named through the specific things it does in that workflow; a close
that asks how the work is handled today. Notice that none of them says "I
noticed", none describes a product category, and none tells the reader their
job is hard.

List every factual claim the message makes in messageClaims, using the types
and verdicts described above. The brief's verified fact is supported by the
sources supplied below; cite one of them for it. Sender claims need no external
evidence. If a sentence asserts something the brief does not carry and no
source supports, mark it UNSUPPORTED rather than relabelling it to pass.`;

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    message: { type: 'string' },
    messageClaims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          type: { type: 'string' },
          verdict: { type: 'string', enum: ['SUPPORTED', 'UNSUPPORTED', 'UNCERTAIN'] },
          evidence_url: { type: 'string', nullable: true },
          explanation: { type: 'string' },
        },
        required: ['claim', 'type', 'verdict'],
      },
    },
  },
  required: ['message', 'messageClaims'],
};

export interface WriteEmailInput {
  brief: EmailBrief;
  senderName: string | null;
  senderCompany: string;
  /** One short sentence about what the sender does. */
  outreachContext: string;
  /** Sources the claim declarations may cite. Not an invitation to re-research. */
  sources: NormalizedSource[];
  /**
   * Named validator failures to fix, preserving everything else about the
   * draft. This is REPAIR: a draft that failed a quality gate gets exactly
   * this fixed and nothing else touched — "change nothing else" is correct
   * wording here.
   *
   * Mutually exclusive in spirit with `previousMessage` below, but both may
   * appear together on a regeneration's own retry (see stages.ts), where a
   * fresh rewrite also needs to fix a gate failure the first regenerated
   * attempt introduced.
   */
  repairNotes?: string | null;
  /**
   * Set ONLY for a user-requested regeneration: the previously PERSISTED
   * draft to write a materially different version of. Never set during first
   * generation — see briefForContext() callers.
   *
   * Presence of this field switches the prompt from the repair wrapper to a
   * dedicated regeneration wrapper. The two say opposite things ("change
   * nothing else" vs "write something different") and must never be mixed
   * into one instruction block — that contradiction was the root cause of
   * regeneration returning near-identical text.
   */
  previousMessage?: string | null;
  /**
   * Appended to the regeneration block on a retry, after the first
   * regenerated attempt was itself too similar to `previousMessage`.
   */
  regenerationReinforcement?: string | null;
}

export interface WrittenEmail {
  subject: string;
  message: string;
  claims: AnalysisClaim[];
}

/** Sources rendered compactly — enough to cite, not enough to re-plan from. */
function renderCitableSources(sources: NormalizedSource[], limit = 8): string {
  if (sources.length === 0) return '- (none)';
  return sources
    .slice(0, limit)
    .map((s) => `- ${s.canonical_url || s.url} — ${s.title}`)
    .join('\n');
}

/**
 * REPAIR wrapper: a draft failed a deterministic quality gate, so fix exactly
 * that and preserve everything else. "Change nothing else" is deliberate and
 * correct here — a repair is not a request for new wording, it is a request
 * to stop doing the one specific thing that failed.
 */
function repairBlock(input: WriteEmailInput): string {
  if (!input.repairNotes) return '';
  return `
REWRITE — the previous draft failed these checks. Fix exactly these, and change
nothing else. Keep the same fact, the same workflow, the same proof and the
same recipient; do not look for a new angle.
${input.repairNotes}
`;
}

/**
 * REGENERATION wrapper: the user asked for a different version of an email
 * that was already fine. This says the opposite of the repair wrapper on
 * purpose — the previous wording is shown so there is something concrete to
 * diverge from, and the instruction is to change the prose, not preserve it.
 *
 * `repairNotes` can still appear here (see stages.ts's retry integration): if
 * the regenerated attempt ALSO failed a quality gate, that failure is folded
 * in as an additional fix, appended after the regeneration instruction rather
 * than replacing it — the two are not in tension the way "change nothing
 * else" and "write something different" are.
 */
function regenerationBlock(input: WriteEmailInput): string {
  return `
REGENERATION — this is a user-requested regeneration, not a first draft and not
a repair. Below is the wording produced previously. Write a genuinely different
version of it.

PRESERVE (the business argument does not change):
  - the recipient
  - the verified fact
  - why this person
  - the operational implication
  - the workflow
  - the Zamp capability
  - the approved proof, if any
  - what the close asks about

CHANGE (the prose does change):
  - the opening construction
  - sentence rhythm and length
  - the transitions between paragraphs
  - the wording throughout
  - the CTA phrasing

Do not introduce a new fact, choose a different hook, workflow or proof, invent
a difficulty, or invent customer evidence. This is a prose variation of the
same argument, not a new sales strategy.

The new version must not simply replace one or two words. It must be
materially different in wording and sentence construction — read it back
against the previous version below and confirm a person would not mistake one
for the other.
${input.regenerationReinforcement ? `\n${input.regenerationReinforcement}\n` : ''}${
    input.repairNotes ? `\nThe previous regenerated attempt also failed these checks — fix them too:\n${input.repairNotes}\n` : ''
  }
PREVIOUS VERSION:
${input.previousMessage}
`;
}

/**
 * Write the email. Returns null on any model failure, so the caller can fall
 * back rather than fail the run.
 */
export async function writeEmailFromBrief(input: WriteEmailInput): Promise<WrittenEmail | null> {
  const prompt = `Sender: ${input.senderName ? `${input.senderName}, ` : ''}${input.senderCompany}
Sign the message as: ${input.senderName ?? '(no individual name configured — omit the signature block)'}
What the sender does: ${input.outreachContext}

${renderBrief(input.brief)}

SOURCE URLS YOU MAY CITE IN messageClaims — no others exist
${renderCitableSources(input.sources)}
${input.previousMessage ? regenerationBlock(input) : repairBlock(input)}
Write the email.`;

  try {
    const { data } = await callStructured<{
      subject?: string;
      message: string;
      messageClaims?: AnalysisClaim[];
    }>({
      purpose: 'write_outreach_email',
      system: SYSTEM,
      input: prompt,
      schema: SCHEMA,
      timeoutMs: 120_000,
    });

    const message = (data.message ?? '').trim();
    if (!message) return null;

    return {
      subject: (data.subject ?? '').trim(),
      message,
      claims: data.messageClaims ?? [],
    };
  } catch {
    return null;
  }
}
