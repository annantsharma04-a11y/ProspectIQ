// The email brief — the already-decided inputs an outreach email is written FROM.
//
// The problem this exists to fix: the model was being handed raw research and
// left to decide the entire business narrative — which fact to lead on, what
// it implies, which workflow it points at, and how to describe the product.
// It made those calls in prose, and the failures showed up as prose problems
// ("highlights the sheer volume", "we provide AI digital-employee agents")
// that no amount of extra style rules reliably prevented.
//
// Every field here is already settled deterministically somewhere upstream:
// the fact is the gated hook, the workflow and capability come from the
// matched solution, the proof comes from lib/proof/match.ts. Assembling them
// into one object narrows the model's job to the thing it is genuinely good
// at — turning settled inputs into natural sentences.
//
// It is deliberately a projection, not a store: nothing is computed here that
// the pipeline has not already established, and a field with no confident
// source is left null rather than filled in.

import type { PipelineContext } from '@/lib/pipeline/context';
import type { SolutionMatch } from '@/lib/solutions/types';
import type { ProofMatch } from '@/lib/proof/types';

export interface EmailBriefProof {
  id: string;
  customer: string;
  workflow: string;
  /** Verbatim or omitted. Never reworded. */
  approved_statement: string;
}

export interface EmailBrief {
  recipientName: string | null;
  /** The gated hook: the one verified fact the email opens on. */
  verifiedFact: string;
  /**
   * What work follows from that fact, as a statement about the WORK.
   *
   * Null when no solution matched, because without a workflow there is no
   * defensible implication to draw — and inventing one is exactly how
   * "your team is struggling" gets written. Absent is a correct value.
   */
  operationalImplication: string | null;
  /** The single workflow this email is about. Null when no solution matched. */
  workflow: string | null;
  /** What the product DOES in that workflow, in the catalog's own words. */
  zampCapability: string | null;
  approvedProof: EmailBriefProof | null;
  /** Short context for the subject line — the workflow, or the company. */
  subjectContext: string | null;
  /**
   * Why THIS person, from their verified role — internal context, not a line
   * to reproduce. Null when no role was established, because the alternative
   * is inventing a responsibility, which is the failure this whole layer
   * exists to prevent.
   */
  whyThisPerson: string | null;
  /** What we actually want to learn about how they run this work today. */
  desiredConversation: string | null;
}

/**
 * The operational implication, stated as work rather than as difficulty.
 *
 * Deliberately templated rather than model-written. The one sentence in this
 * email most likely to become an unsupported pain claim is this one, and a
 * fixed shape that talks about consistency and volume cannot accidentally
 * assert that anyone is struggling. The model is told it may rephrase for
 * grammar but may not add difficulty — see the prompt block.
 */
const IMPLICATION_PATTERNS: ((workflow: string, subject: string) => string)[] = [
  (w, s) => `At that scale, keeping ${w} consistent across ${s} becomes more involved.`,
  (w, s) => `As ${s} expands, ${w} has to stay consistent across every part of it.`,
  (w, s) => `With ${s} operating at that size, keeping ${w} aligned becomes more involved.`,
  (w, s) => `Work like ${w} tends to spread as ${s} grows, and it has to stay consistent.`,
];

/**
 * Stable index so the same run always produces the same sentence.
 *
 * Variety across prospects, reproducibility within one — a random pick would
 * make a run's own output change between replays, which is not something an
 * evidence-driven pipeline should do.
 */
function patternIndex(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 100_000;
  return hash % IMPLICATION_PATTERNS.length;
}

function implicationFor(workflow: string, company: string | null): string {
  const subject = company ?? 'the business';
  const w = workflow.toLowerCase();
  return IMPLICATION_PATTERNS[patternIndex(`${w}|${subject}`)](w, subject);
}

/**
 * Why this person, stated from their VERIFIED role and nothing else.
 *
 * Deliberately does not assert what they own or are responsible for — a title
 * is evidence of a title, not of a remit. It says where they sit and lets the
 * writer connect that to the workflow.
 */
function whyThisPersonFor(role: string | null, company: string | null, workflow: string | null): string | null {
  if (!role) return null;
  const where = company ? ` at ${company}` : '';
  return workflow
    ? `Their role is ${role}${where}, which sits close to ${workflow.toLowerCase()}.`
    : `Their role is ${role}${where}.`;
}

/**
 * The first supported workflow of the matched solution.
 *
 * One workflow, chosen deterministically, because "pick the most relevant
 * workflow" is precisely the business decision this brief exists to take away
 * from the model.
 */
function workflowFor(match: SolutionMatch | null): string | null {
  return match?.solution.supported_workflows[0] ?? null;
}

export interface BuildBriefInput {
  recipientName: string | null;
  company: string | null;
  /** The prospect's verified role, when identity established one. */
  role?: string | null;
  verifiedFact: string;
  solution: SolutionMatch | null;
  proof: ProofMatch | null;
}

/** Assemble the brief from inputs the pipeline has already settled. */
export function buildEmailBrief(input: BuildBriefInput): EmailBrief {
  const workflow = workflowFor(input.solution);

  return {
    recipientName: input.recipientName,
    verifiedFact: input.verifiedFact,
    operationalImplication: workflow ? implicationFor(workflow, input.company) : null,
    workflow,
    // The catalog description states what the product does. It is used as-is:
    // the model may not restate it as a product category.
    zampCapability: input.solution?.solution.description ?? null,
    approvedProof: input.proof
      ? {
          id: input.proof.proof.id,
          customer: input.proof.proof.customer,
          workflow: input.proof.proof.workflow,
          approved_statement: input.proof.proof.approved_statement,
        }
      : null,
    subjectContext: workflow ?? input.company,
    whyThisPerson: whyThisPersonFor(input.role ?? null, input.company, workflow),
    desiredConversation: workflow
      ? `How ${input.company ?? 'they'} handles ${workflow.toLowerCase()} today, and where we could be useful.`
      : null,
  };
}

/** Build the brief for a run, from the context the pipeline already carries. */
export function briefForContext(
  ctx: PipelineContext,
  solution: SolutionMatch | null,
  proof: ProofMatch | null,
): EmailBrief | null {
  // No gated hook means no verified fact, which means no email at all.
  if (!ctx.hook) return null;

  return buildEmailBrief({
    recipientName: ctx.identity?.full_name ?? ctx.run.input_name,
    company: ctx.identity?.company ?? ctx.run.input_company,
    role: ctx.identity?.role ?? ctx.run.input_title,
    verifiedFact: ctx.hook.signal,
    solution,
    proof,
  });
}

/** The brief rendered for the prompt. Sections with no settled value are omitted. */
export function renderBrief(brief: EmailBrief): string {
  const lines = [
    'EMAIL BRIEF — these decisions are already made. Write them as prose; do not re-decide them.',
    `Recipient: ${brief.recipientName ?? '(unknown)'}`,
    `Verified fact (the email opens on THIS, and only this): ${brief.verifiedFact}`,
  ];

  if (brief.operationalImplication) {
    lines.push(
      `Operational implication (express this idea; rephrase for grammar if needed, but do NOT add difficulty, friction, struggle or urgency to it): ${brief.operationalImplication}`,
    );
  }
  if (brief.whyThisPerson) {
    lines.push(
      `Why this person (context for you, not a line to reproduce; do NOT assert what they own): ${brief.whyThisPerson}`,
    );
  }
  if (brief.workflow) lines.push(`Workflow (the ONE workflow this email is about): ${brief.workflow}`);
  if (brief.zampCapability) {
    lines.push(
      `What the product does in that workflow (describe this WORK; never restate it as a product category such as "AI agents" or "digital employees"): ${brief.zampCapability}`,
    );
  }
  if (brief.approvedProof) {
    lines.push(`Approved proof (verbatim or omit): ${brief.approvedProof.approved_statement}`);
  } else {
    lines.push('Approved proof: NONE. Write no customer result, no percentage, no named or anonymous customer.');
  }
  if (brief.desiredConversation) lines.push(`What the close should invite: ${brief.desiredConversation}`);
  if (brief.subjectContext) lines.push(`Subject should reference: ${brief.subjectContext}`);

  return lines.join('\n');
}
