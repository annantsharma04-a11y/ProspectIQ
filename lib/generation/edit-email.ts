// One editorial pass over a written email.
//
// The deterministic validators can tell us an email is not BROKEN. They cannot
// tell us it is good. A draft can state one clean fact, name the right
// workflow, avoid every banned construction and still read like a template
// somebody filled in — and that is what separates the current output from the
// reference emails.
//
// So this is a second model call with a deliberately tiny remit: improve the
// prose, change nothing else. It is given the same brief the writer had, and
// its output is accepted only if code judges it at least as good as what it
// replaced. It cannot introduce a fact, a workflow, a proof or a pain claim,
// because anything it produces goes back through the same checks — and if it
// comes out worse, it is discarded silently and the writer's draft stands.
//
// One pass. No loop. A failure here costs nothing but the call.

import { callStructured } from '@/lib/llm/gemini';
import type { JsonSchema } from '@/lib/llm/types';
import type { AnalysisClaim } from '@/lib/llm/analyze';
import { renderBrief, type EmailBrief } from './brief';
import { checkEmailQuality, checkDivergence, type EmailQualityCheck } from './email-quality';
import { checkVoice } from './voice';

const SYSTEM = `You are an editor. You improve the prose of one outreach email.

You are NOT rewriting the argument. The fact, the workflow, the product
description and the customer proof were all decided before you saw this, and
they stay exactly as they are. Your remit is how it READS.

Ask yourself, and fix only what fails:
  - Does the opening state the fact cleanly, or does it narrate noticing it?
  - Does the second paragraph reason about the WORK, in a way a person who does
    that work would recognise?
  - Is the product described through what it does here, or as a category?
  - Does anything read like a template with the details swapped in?
  - Does the close genuinely ask how they handle this today?
  - Does it sound like one senior person writing to another?

You may reorder, tighten, join or split sentences, and change wording.

You may NOT:
  - add a fact about the person, the company or the world
  - remove or alter the verified fact the email opens on
  - change which workflow the email is about
  - add, remove, reword or invent any customer result
  - assert that anything is hard, slow, painful or broken for them
  - add a second call to action

If the draft is already good, return it unchanged. That is a valid answer and
better than editing for the sake of it.

List every factual claim the FINAL text makes in messageClaims, using the same
types and verdicts as the draft you were given.`;

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    changed: { type: 'boolean' },
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

export interface EditEmailInput {
  brief: EmailBrief;
  message: string;
  claims: AnalysisClaim[];
}

export interface EditedEmail {
  message: string;
  claims: AnalysisClaim[];
}

/** Returns null on any model failure — the writer's draft simply stands. */
export async function editEmail(input: EditEmailInput): Promise<EditedEmail | null> {
  const prompt = `${renderBrief(input.brief)}

DRAFT TO EDIT
${input.message}

Improve the prose. Change nothing else.`;

  try {
    const { data } = await callStructured<{ message: string; messageClaims?: AnalysisClaim[] }>({
      purpose: 'edit_outreach_email',
      system: SYSTEM,
      input: prompt,
      schema: SCHEMA,
      timeoutMs: 90_000,
    });

    const message = (data.message ?? '').trim();
    if (!message) return null;
    return { message, claims: data.messageClaims ?? input.claims };
  } catch {
    return null;
  }
}

/**
 * Did the edit actually preserve what it was told to preserve?
 *
 * Checked in code rather than trusted, because "I only changed the prose" is
 * exactly the kind of claim a model is bad at self-assessing.
 */
export function editIsFaithful(brief: EmailBrief, original: string, edited: string): boolean {
  // The approved proof, if there is one, must survive character for character.
  if (brief.approvedProof && original.includes(brief.approvedProof.approved_statement)) {
    if (!edited.includes(brief.approvedProof.approved_statement)) return false;
  }
  // An edit must never introduce a customer result where none existed.
  if (!brief.approvedProof) {
    const before = checkEmailQuality(original, { brief });
    const after = checkEmailQuality(edited, { brief });
    if (before.detail.no_invented_proof && !after.detail.no_invented_proof) return false;
  }
  return true;
}

/** How much MORE similar-to-the-original an edit must become to count as a regression, not noise. */
const DIRECTION_OF_TRAVEL_MARGIN = 0.1;

export interface DraftChoice {
  message: string;
  claims: AnalysisClaim[];
  /** True when the editor's version was taken. */
  edited: boolean;
  reason: string;
}

/**
 * Choose between the writer's draft and the editor's, in code.
 *
 * The editor's version wins only when it is faithful AND scores no worse on
 * the deterministic checks. A tie goes to the editor, since its whole purpose
 * is the readability the checks cannot measure; anything worse is discarded
 * and never seen again.
 *
 * `previousMessage` is supplied ONLY on a user regeneration (null on every
 * first generation, which is a structural no-op for this whole branch). The
 * editor is never told a regeneration happened — it edits the writer's draft
 * on its own merits, brief and quality checks, exactly as it would on a first
 * generation — so nothing stops it from independently converging back toward
 * the same "good email" shape the OLD draft also satisfied. That convergence
 * would silently undo the regeneration the user asked for, and a tied or
 * better quality score would not catch it, because the quality checks do not
 * know an old draft exists. So when a previous message is in play, divergence
 * from it is checked FIRST and cannot be outvoted by the score comparison
 * below: an edit that regresses toward the old email is discarded regardless
 * of how well it reads.
 */
export function chooseDraft(
  brief: EmailBrief,
  written: { message: string; claims: AnalysisClaim[] },
  edited: EditedEmail | null,
  supportingQuote: string | null,
  previousMessage: string | null = null,
): DraftChoice {
  const base = { message: written.message, claims: written.claims, edited: false };

  if (!edited) return { ...base, reason: 'No edit was produced; the written draft stands.' };
  if (edited.message === written.message) {
    return { ...base, reason: 'The editor returned the draft unchanged.' };
  }
  if (!editIsFaithful(brief, written.message, edited.message)) {
    return { ...base, reason: 'The edit altered protected content, so it was discarded.' };
  }

  if (previousMessage) {
    const editedDivergence = checkDivergence(edited.message, previousMessage);
    if (!editedDivergence.passed) {
      return {
        ...base,
        reason: 'The edit was too similar to the original message being regenerated, so it was discarded.',
      };
    }
    // Even a faithful, non-duplicate edit is rejected if it pulled the draft
    // MATERIALLY back toward the old email relative to what the writer had
    // already achieved. A margin, not a strict inequality: two honest
    // rewrites of the same argument can land a percentage point or two apart
    // on shared vocabulary alone (workflow and capability terms the brief
    // requires both to use), and treating any tiny increase as a regression
    // would reject good edits for noise. DIRECTION_OF_TRAVEL_MARGIN is the
    // size of increase that counts as a genuine step backward rather than
    // incidental overlap — documented and adjustable, same as the pass/fail
    // thresholds in email-quality.ts.
    const writtenDivergence = checkDivergence(written.message, previousMessage);
    if (
      editedDivergence.wholeMessageSimilarity - writtenDivergence.wholeMessageSimilarity >=
      DIRECTION_OF_TRAVEL_MARGIN
    ) {
      return {
        ...base,
        reason: 'The edit was closer to the original message than the written draft, so it was discarded.',
      };
    }
  }

  const before = score(written.message, brief, supportingQuote);
  const after = score(edited.message, brief, supportingQuote);

  if (after < before) {
    return { ...base, reason: `The edit scored worse (${after} vs ${before}), so it was discarded.` };
  }

  return {
    message: edited.message,
    claims: edited.claims,
    edited: true,
    reason: `The edit was kept (${after} vs ${before} on the deterministic checks).`,
  };
}

/** Count of checks passed — a blunt but honest comparison between two drafts. */
function score(message: string, brief: EmailBrief, supportingQuote: string | null): number {
  const quality: EmailQualityCheck = checkEmailQuality(message, { brief });
  const passed = Object.values(quality.detail).filter(Boolean).length;
  const voice = checkVoice(message, { quotes: supportingQuote ? [supportingQuote] : [] });
  return passed + (voice.passed ? 1 : 0);
}
