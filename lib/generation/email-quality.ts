// Deterministic email quality checks — the specific failures we have actually
// seen, not another list of banned adjectives.
//
// Every rule here exists because a real generated email failed on it. The
// Shiprocket draft is the reference case: it passed every existing check while
// opening on "Watching Shiprocket scale past ₹2,000 crore ... highlights the
// sheer volume of vendor relationships your finance team manages", asserting
// "unnecessary friction", and describing the product as "AI digital-employee
// agents". Those are four distinct defects, and each has its own rule below.
//
// Deliberately NOT duplicated here: word-level voice policing (checkVoice),
// hook dependence (checkPersonalization), headline openers (checkOpener).
// Those already run. This adds only what they do not cover.
//
// The rules are written to be narrow. A pain word inside a quote, or an
// ordinary use of "difficult", must not fail an otherwise good email — so the
// pain rule matches ASSERTIONS about the recipient's work, not vocabulary.

import type { EmailBrief } from './brief';

export interface EmailQualityCheck {
  passed: boolean;
  failures: string[];
  detail: Record<string, boolean>;
  wordCount: number;
  paragraphs: number;
}

export const MIN_EMAIL_WORDS = 90;
export const MAX_EMAIL_WORDS = 130;

/** Strip the greeting and the sign-off; the rules apply to the body. */
export function emailBody(message: string): string {
  const lines = message.trim().split(/\n+/);
  const kept = lines.filter((line) => {
    const l = line.trim();
    if (!l) return false;
    if (/^(hi|hello|hey|dear)\b[^.!?]*,?\s*$/i.test(l)) return false;
    if (/^(best|thanks|regards|cheers|best regards|kind regards)\s*,?\s*$/i.test(l)) return false;
    return true;
  });

  // Drop a trailing signature name line (the line after "Best,").
  const signoffIndex = lines.findIndex((l) => /^(best|thanks|regards|cheers)\b/i.test(l.trim()));
  if (signoffIndex >= 0) {
    const after = lines.slice(signoffIndex + 1).map((l) => l.trim()).filter(Boolean);
    for (const name of after) {
      const idx = kept.indexOf(name);
      if (idx >= 0) kept.splice(idx, 1);
    }
  }
  return kept.join('\n\n');
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
}

/** The first real sentence of the body. */
export function openingSentence(body: string): string {
  const first = body.split(/(?<=[.!?])\s+/)[0] ?? body;
  return first.trim();
}

/**
 * Product-category language: describing WHAT the product is instead of what it
 * DOES. Narrow and literal — these exact phrasings, not every use of "AI".
 */
const PRODUCT_CATEGORY =
  /\b(ai[- ]powered\s+\w+|ai\s+platform|ai\s+agents?|digital[- ]employees?|digital[- ]employee\s+agents?|digital\s+workforce|ai\s+workforce|automation\s+platform|intelligent\s+platform|technology\s+platform|saas\s+platform)\b/i;

/**
 * Unsupported pain: a difficulty ASSERTED about the recipient's world.
 *
 * Requires both a pain term AND a construction attaching it to them, so
 * "reconciliation work" passes while "reconciliation is a bottleneck for your
 * team" does not. This is the rule most likely to misfire, so it is the
 * narrowest.
 */
const PAIN_TERM =
  '(struggl\\w*|frustrat\\w*|overwhelm\\w*|bottleneck\\w*|pain[- ]point\\w*|friction|headache\\w*|burden\\w*|inefficien\\w*|time[- ]consuming|costly)';
const PAIN_ASSERTION = new RegExp(
  [
    // "your team is struggling", "their process becomes a bottleneck"
    `\\b(your|their|the)\\s+(\\w+\\s+){0,3}(team|process|workflow|operations?|work|staff|function)\\b[^.]{0,60}\\b${PAIN_TERM}`,
    // "creates unnecessary friction", "causes a bottleneck"
    `\\b(creat\\w*|caus\\w*|introduc\\w*|lead\\w*\\s+to|result\\w*\\s+in)\\b[^.]{0,40}\\b${PAIN_TERM}`,
    // "must be painful", "is probably overwhelming"
    `\\b(must\\s+be|is\\s+probably|are\\s+probably|no\\s+doubt|i'?m\\s+sure)\\b[^.]{0,40}\\b${PAIN_TERM}`,
  ].join('|'),
  'i',
);

/** Interpretation dressed as observation — the "highlights the sheer volume" family. */
const OPENING_INTERPRETATION =
  /\b(highlight\w*|underscore\w*|speaks?\s+to|points?\s+to|signals?\s+(?:just\s+)?how|shows?\s+(?:just\s+)?how|reflects?\s+the|the\s+sheer\s+\w+|watching\s+\w+\s+(?:scale|grow|expand))\b/i;

/** Openers that are about the sender, the product, or nothing. */
const WEAK_OPENING =
  /^(zamp\b|we\s+(are|provide|build|help)\b|ai\b|as\s+a\s+leader\b|given\s+your\s+role\b|i\s+(wanted|hope|recently|came)\b|hope\s+you)/i;

/** Praise. */
const PRAISE =
  /\b(impressive|remarkable|incredible|outstanding|exceptional|admirable|amazing|visionary|forward[- ]thinking)\b/i;

/** A customer-result-shaped sentence, whether or not a customer is named. */
const CUSTOMER_RESULT =
  /(\b\d+(\.\d+)?\s*%|\b\d+\s*(hours?|hrs?|days?|weeks?)\b[^.]{0,30}\b(saved|saving|faster|quicker|reduc\w*)|\bhelped\s+(a|an|one|another|several)\b|\bour\s+(clients?|customers?)\b|\bcustomers?\s+(save|see|report)\b|\bteams?\s+(typically\s+)?see\b|\broi\b)/i;

/** Low-pressure, collaborative closes. */
const GOOD_CTA =
  /\b(keen\s+to\s+understand|compare\s+notes|worth\s+(a\s+)?(short\s+)?(call|chat)|talk\s+through|happy\s+to\s+(compare|share|talk)|would\s+be\s+great\s+to)\b/i;

/** Pushy closes. */
const PUSHY_CTA =
  /\b(book\s+a\s+demo|schedule\s+a\s+demo|hop\s+on\s+a\s+quick\s+call|steal\s+\d+\s+minutes|connect\s+asap|i'?d\s+love\s+to\s+show\s+you|don'?t\s+miss|limited\s+time|act\s+now)\b/i;

export interface EmailQualityOptions {
  /** The settled inputs this email was written from. */
  brief: EmailBrief | null;
}

/**
 * Check a generated email against the quality bar the reference emails set.
 *
 * Returns every failure rather than the first, because the failures become the
 * targeted regeneration instruction — a rewrite told exactly what was wrong is
 * far more likely to fix it than one told "try again".
 */
export function checkEmailQuality(message: string, options: EmailQualityOptions): EmailQualityCheck {
  const brief = options.brief;
  const body = emailBody(message);
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const count = words(body).length;
  const opening = openingSentence(body);
  const failures: string[] = [];
  const detail: Record<string, boolean> = {};

  // ── length and shape ───────────────────────────────────────────────────
  detail.word_count = count >= MIN_EMAIL_WORDS && count <= MAX_EMAIL_WORDS;
  if (!detail.word_count) {
    failures.push(
      count < MIN_EMAIL_WORDS
        ? `The email body is ${count} words. The structure needs ${MIN_EMAIL_WORDS}-${MAX_EMAIL_WORDS}; aim for 100-115.`
        : `The email body is ${count} words, over the ${MAX_EMAIL_WORDS}-word limit. Cut, do not compress.`,
    );
  }

  detail.paragraph_count = paragraphs.length >= 3 && paragraphs.length <= 4;
  if (!detail.paragraph_count) {
    failures.push(`The body has ${paragraphs.length} paragraph(s). Use 3-4 short ones.`);
  }

  // ── the opening ────────────────────────────────────────────────────────
  detail.opening_not_weak = !WEAK_OPENING.test(opening);
  if (!detail.opening_not_weak) {
    failures.push('The opening starts with the sender, the product or a generic outreach phrase. Open on the verified fact.');
  }

  detail.opening_not_interpreted = !OPENING_INTERPRETATION.test(opening);
  if (!detail.opening_not_interpreted) {
    failures.push(
      'The opening interprets the fact instead of stating it (e.g. "highlights the sheer volume", "watching X scale"). State the fact plainly; the next paragraph is where the implication belongs.',
    );
  }

  detail.opening_single_fact = countFacts(opening) <= 1;
  if (!detail.opening_single_fact) {
    failures.push('The opening combines more than one company fact. Lead on one fact only.');
  }

  detail.no_praise = !PRAISE.test(body);
  if (!detail.no_praise) failures.push('The email compliments the recipient or their company. Let the verified fact do that work.');

  if (brief?.verifiedFact) {
    const factTokens = tokens(brief.verifiedFact);
    const openingTokens = tokens(opening);
    const shared = [...factTokens].filter((t) => openingTokens.has(t)).length;
    detail.opening_uses_fact = factTokens.size === 0 || shared / factTokens.size >= 0.2;
    if (!detail.opening_uses_fact) {
      failures.push('The opening does not state the verified fact the email was briefed on.');
    }
  }

  // ── unsupported pain ───────────────────────────────────────────────────
  detail.no_assumed_pain = !PAIN_ASSERTION.test(body);
  if (!detail.no_assumed_pain) {
    failures.push(
      'The email asserts a difficulty the evidence does not establish. Describe the work that the fact creates, not how hard it is.',
    );
  }

  // ── product described as work, not as a category ───────────────────────
  detail.no_product_category = !PRODUCT_CATEGORY.test(body);
  if (!detail.no_product_category) {
    failures.push(
      'The email describes what the product IS ("AI agents", "digital employees") instead of what it DOES. Name the actual work in this workflow.',
    );
  }

  // ── the briefed workflow is actually present ───────────────────────────
  if (brief?.workflow) {
    const wanted = tokens(brief.workflow);
    const bodyTokens = tokens(body);
    const covered = [...wanted].filter((t) => bodyTokens.has(t)).length;
    detail.workflow_present = wanted.size === 0 || covered > 0;
    if (!detail.workflow_present) {
      failures.push(`The email never mentions the briefed workflow (${brief.workflow}).`);
    }
  }

  // ── customer proof ─────────────────────────────────────────────────────
  const hasResultShape = CUSTOMER_RESULT.test(body);
  if (brief?.approvedProof) {
    // A result may appear, but only the approved sentence.
    detail.proof_verbatim = !hasResultShape || body.includes(brief.approvedProof.approved_statement);
    if (!detail.proof_verbatim) {
      failures.push('The email states a customer result that is not the approved statement, word for word.');
    }
  } else {
    detail.no_invented_proof = !hasResultShape;
    if (!detail.no_invented_proof) {
      failures.push(
        'The email states a customer result, a percentage or a time saving, but no approved proof exists for this prospect. Remove it.',
      );
    }
  }

  // ── the close ──────────────────────────────────────────────────────────
  detail.cta_present = GOOD_CTA.test(body);
  if (!detail.cta_present) failures.push('The email has no collaborative, low-pressure invitation to talk.');

  detail.cta_not_pushy = !PUSHY_CTA.test(body);
  if (!detail.cta_not_pushy) failures.push('The closing pushes a demo or a meeting. Invite, do not press.');

  const questions = (body.match(/\?/g) ?? []).length;
  detail.single_cta = questions <= 1;
  if (!detail.single_cta) failures.push(`The email asks ${questions} questions. One invitation, not several.`);

  return { passed: failures.length === 0, failures, detail, wordCount: count, paragraphs: paragraphs.length };
}

/**
 * How many distinct factual assertions a sentence makes.
 *
 * Used only for the opening. Counts the joins that stack a second fact onto a
 * first ("X while also Y", "X, with Y") rather than parsing grammar — enough
 * to catch a stacked opening without pretending to understand the sentence.
 */
export function countFacts(sentence: string): number {
  const joins = sentence.match(/\b(while|whilst|as well as|alongside|in addition to|and also)\b|,\s*with\b/gi) ?? [];
  return 1 + joins.length;
}

/** Turn failures into a rewrite instruction that names what to fix and what to keep. */
export function repairDirective(check: EmailQualityCheck, brief: EmailBrief | null): string {
  const numbered = check.failures.map((f, i) => `${i + 1}. ${f}`).join('\n');
  const keep = [
    brief?.recipientName ? `the recipient (${brief.recipientName})` : null,
    brief?.verifiedFact ? 'the verified fact you were briefed on' : null,
    brief?.workflow ? `the workflow (${brief.workflow})` : null,
    brief?.approvedProof ? 'the approved proof, word for word' : null,
  ].filter(Boolean);

  return [
    'EMAIL QUALITY FAILURES:',
    numbered,
    '',
    `Rewrite the email, preserving ${keep.length > 0 ? keep.join(', ') : 'every verified fact'}.`,
    'Do not introduce a new company or person fact. Do not invent difficulty. Do not invent a customer result.',
  ].join('\n');
}
