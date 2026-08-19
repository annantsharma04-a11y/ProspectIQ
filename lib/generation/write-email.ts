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
fact to open on, the workflow, what the product does in that workflow, and the
customer proof if any exists. You are not choosing between them, improving on
them, or looking for a better angle. Your job is prose.

Three things you must never do, because they undo decisions made upstream:
  - open on a different fact from the one in the brief
  - name a workflow, capability or product behaviour the brief does not state
  - state a customer result the brief does not carry, in any wording

${EMAIL_WRITING_RULES}

OPENING: state the fact. Do not narrate noticing it.
  Good: "Shiprocket's non-shipping tech solutions now generate over a quarter
         of total revenue."
  Bad:  "I noticed Shiprocket..." / "I saw that..." / "I came across..."
        "Watching Shiprocket scale..." / "...highlights the sheer volume..."
        "...underscores the need..." / "...demonstrates how important..."
  The first paragraph is a clean fact. Interpretation belongs in the second.

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
   * Named validator failures from the previous attempt.
   *
   * When present this is a REWRITE: same brief, same fact, same workflow, same
   * proof, new prose. It never reopens the business decisions.
   */
  directive?: string | null;
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
${
  input.directive
    ? `
REWRITE — the previous draft failed these checks. Fix exactly these, and change
nothing else. Keep the same fact, the same workflow, the same proof and the
same recipient; do not look for a new angle.
${input.directive}
`
    : ''
}
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
