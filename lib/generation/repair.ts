// Conservative repair of a draft that failed claim validation.
//
// The validator is deliberately strict and stays that way: an UNSUPPORTED
// claim is a claim no retrieved source establishes, and no amount of model
// confidence changes that. What this module adds is a single, bounded attempt
// to REMOVE the unsupported sentence before handing the draft to a human —
// because most such failures are one stray assertion attached to an otherwise
// well-evidenced message, and deleting it is strictly safer than keeping it.
//
// The critical property: repair can only ever SUBTRACT. It is given no search
// tool, no new sources, and no route to establish anything. Every output is
// re-validated by the same `validateClaims()` the original went through, and
// the repaired draft is accepted ONLY if that second pass is clean. A repair
// that introduces a new unsupported claim is discarded and the original
// flagged state is preserved exactly.
//
//   Model proposes. Evidence constrains. Code validates.
//   Human decides when ambiguity remains.

import { callStructured } from '@/lib/llm/gemini';
import type { JsonSchema } from '@/lib/llm/types';
import type { AnalysisClaim } from '@/lib/llm/analyze';
import type { CheckedClaim } from '@/lib/validation/factcheck';
import { claimStillPresent, requiresExternalEvidence } from '@/lib/validation/factcheck';
import type { NormalizedSource } from '@/lib/research/normalize';
import type { ApprovedSolutionContext } from '@/lib/solutions/match';
import { isSameSource } from '@/lib/url-identity';

/** One automatic repair per generated draft. Never a loop. */
export const MAX_REPAIR_ATTEMPTS = 1;

/**
 * Marker prepended to the validation notes when a repair was accepted.
 *
 * Rides the existing notes field rather than a new column, so the draft row
 * remains the single source of truth for every surface that reads it.
 */
export const AUTO_REVISED_MARKER = '[auto-revised]';

const SYSTEM = `You remove unsupported factual claims from an outreach email.

You are NOT rewriting the email, improving it, or making it more persuasive.
You are performing one narrow edit: the claims listed as UNSUPPORTED are not
backed by any retrieved source, so they cannot be sent. Take them out.

WHAT YOU MAY DO, in order of preference:
  1. DELETE the unsupported sentence entirely. This is almost always correct —
     an email that says less is better than one that asserts something no
     source shows.
  2. Only if deleting it would leave the message incoherent, rewrite that
     sentence using ONLY a claim already listed as SUPPORTED below.

WHAT YOU MUST NOT DO:
  - Do not invent a replacement fact, however plausible it sounds.
  - Do not introduce ANY new fact about the person, the company, or the world
    that is not already in the SUPPORTED list.
  - Do not cite a source URL that is not in the list you were given.
  - Do not keep an unsupported claim by hedging it ("reportedly", "it seems",
    "I believe", "from what I understand"). A hedged unsupported claim is
    still an unsupported claim.
  - Do not swap one unsupported claim for a different unsupported claim.
  - Do not restate the removed claim anywhere else in the message.
  - Do not change the supported claims, the approved product description, the
    greeting, or the sign-off.
  - Do not add a new call to action or change the existing one.

PRESERVE: the tone, the structure, the sender's approved product claims, and
every SUPPORTED claim. The result should read as though the removed sentence
was never there — not as though something was cut out of it.

If removing the unsupported claims would leave nothing worth sending, return
the message with them removed anyway. Deciding that is not your job.

List every factual claim the REPAIRED message makes in claims, using the same
types and verdicts you were shown. Be honest: if a sentence still asserts
something no supplied source establishes, mark it UNSUPPORTED rather than
relabelling it to pass.`;

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    removed_claims: { type: 'array', items: { type: 'string' } },
    claims: {
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
  required: ['message', 'claims'],
};

export interface RepairInput {
  message: string;
  /** The validated claims from the first pass — supported and unsupported alike. */
  claims: CheckedClaim[];
  sources: NormalizedSource[];
  approvedSolution?: ApprovedSolutionContext;
}

export interface RepairOutput {
  message: string;
  claims: AnalysisClaim[];
  removed: string[];
}

/**
 * The unsupported claims that actually block: still present in the text.
 *
 * Mirrors the validator's own `surviving` rule exactly. A claim the model
 * declared but never actually wrote into the message is already harmless, and
 * repairing for it would spend a model call to change nothing.
 */
export function blockingClaims(claims: CheckedClaim[], message: string): CheckedClaim[] {
  return claims.filter((c) => c.verdict === 'UNSUPPORTED' && claimStillPresent(c.claim, message));
}

/** True when one bounded repair attempt is worth making. */
export function shouldAttemptRepair(claims: CheckedClaim[], message: string): boolean {
  return blockingClaims(claims, message).length > 0;
}

/**
 * One repair call. Returns null on any model failure — a failed repair is
 * never fatal, it simply leaves the original flagged draft in place.
 *
 * Deliberately takes no search function and no way to obtain a new source:
 * repair cannot go looking for evidence to justify the claim it was asked to
 * remove. That is a structural guarantee, not a prompt instruction.
 */
export async function repairMessage(input: RepairInput): Promise<RepairOutput | null> {
  const blocking = blockingClaims(input.claims, input.message);
  if (blocking.length === 0) return null;

  const supported = input.claims.filter((c) => c.verdict === 'SUPPORTED');

  const prompt = `EMAIL TO REPAIR
${input.message}

UNSUPPORTED CLAIMS — remove these, or rewrite them using only the supported list
${blocking.map((c) => `- "${c.claim}"${c.explanation ? ` (${c.explanation})` : ''}`).join('\n')}

SUPPORTED CLAIMS — these are safe, keep them and draw only on these
${supported.length > 0 ? supported.map((c) => `- "${c.claim}"${c.evidence_url ? ` [${c.evidence_url}]` : ''}`).join('\n') : '- (none)'}

SOURCE URLS YOU MAY CITE — no others exist
${input.sources.length > 0 ? input.sources.slice(0, 25).map((s) => `- ${s.canonical_url || s.url}`).join('\n') : '- (none)'}
${
  input.approvedSolution
    ? `
APPROVED PRODUCT — keep any claim about this exactly as written
${input.approvedSolution.name}: ${input.approvedSolution.description}
`
    : ''
}
Remove the unsupported claims and return the repaired email.`;

  try {
    const { data } = await callStructured<{
      message: string;
      claims: AnalysisClaim[];
      removed_claims?: string[];
    }>({
      purpose: 'repair_unsupported_claims',
      system: SYSTEM,
      input: prompt,
      schema: SCHEMA,
      timeoutMs: 90_000,
    });

    const message = (data.message ?? '').trim();
    if (!message) return null;

    return { message, claims: data.claims ?? [], removed: data.removed_claims ?? [] };
  } catch {
    // A failed repair is not fatal — the original draft goes to human review.
    return null;
  }
}

export interface RepairSafetyVerdict {
  safe: boolean;
  reason: string | null;
}

/**
 * Deterministic checks the repaired draft must pass BEFORE it is revalidated.
 *
 * These catch the failure modes revalidation alone would miss, because
 * validateClaims() judges the claims it is HANDED — a repair that quietly
 * cites a URL nobody retrieved, or that drops the approved product claim and
 * substitutes its own, would produce a clean-looking second pass.
 */
export function verifyRepairSafety(
  original: { claims: CheckedClaim[] },
  repaired: RepairOutput,
  sources: NormalizedSource[],
): RepairSafetyVerdict {
  // 1. Every cited URL must be a source this run actually retrieved.
  for (const c of repaired.claims) {
    if (!c.evidence_url) continue;
    const known = sources.some(
      (s) => isSameSource(s.url, c.evidence_url!) || isSameSource(s.canonical_url, c.evidence_url!),
    );
    if (!known) {
      return { safe: false, reason: `Repair cited a source that was never retrieved: ${c.evidence_url}` };
    }
  }

  // 2. The blocking claims must genuinely be gone from the new text, not
  //    reworded around. Uses the validator's own presence test.
  const stillThere = blockingClaims(original.claims, repaired.message);
  if (stillThere.length > 0) {
    return {
      safe: false,
      reason: `Repair left ${stillThere.length} unsupported claim(s) still present in the message.`,
    };
  }

  // 3. A repair may only ever subtract world-claims. Anything asserted about
  //    the prospect or company that was NOT in the original claim set is a new
  //    fact, which is exactly what repair must never introduce.
  const originalWorldClaims = new Set(
    original.claims.filter((c) => requiresExternalEvidence(c.type)).map((c) => c.claim.trim().toLowerCase()),
  );
  for (const c of repaired.claims) {
    if (!requiresExternalEvidence(c.type)) continue;
    if (!originalWorldClaims.has(c.claim.trim().toLowerCase())) {
      return { safe: false, reason: `Repair introduced a new factual claim: "${c.claim}"` };
    }
  }

  return { safe: true, reason: null };
}
