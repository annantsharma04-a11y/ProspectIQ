// Deterministic voice checks for generated outreach.
//
// The model is asked to write in a particular voice; this module VERIFIES that
// it did, in code, the same way the rest of the pipeline verifies rather than
// trusts. Model proposes, code decides.
//
// Scope: this checks GENERATED MESSAGE TEXT only. Verified evidence — the
// supporting quote from a source, or anything the message quotes verbatim — is
// removed before scanning, because a prospect who genuinely said "this is a
// transformative moment" must remain quotable. Banning a word inside evidence
// would corrupt the record to satisfy a style rule.
//
// This is a STYLE layer. It has no opinion on whether a claim is true; factual
// verification stays in lib/validation/factcheck.ts and is untouched by it.

/**
 * Hard length bounds for a generated message.
 *
 * The floor is deliberately low. A genuinely good draft built on one verified
 * detail can land at 40–55 words, and forcing it to 60 means padding — which
 * reads as more artificial, not less. Brevity is not a defect to correct.
 *
 * Shortness alone earns nothing: a 40-word draft still has to clear every other
 * voice, personalisation and evidence check before it ships.
 */
export const MIN_WORDS = 40;
export const MAX_WORDS = 130;

export type VoiceRule =
  | 'ai_construction'
  | 'corporate_filler'
  | 'banned_vocabulary'
  | 'generic_praise'
  | 'fake_familiarity'
  | 'banned_opener'
  | 'pushy_cta'
  | 'em_dash'
  | 'exclamation'
  | 'word_count'
  | 'rhetorical_question';

export interface VoiceIssue {
  rule: VoiceRule;
  /** The exact text that triggered it, for the regeneration directive. */
  match: string;
  /** block = the draft fails the gate. warn = recorded, does not fail. */
  severity: 'block' | 'warn';
}

export interface VoiceCheck {
  passed: boolean;
  issues: VoiceIssue[];
  /** One line per distinct problem, phrased for the model. */
  failures: string[];
  wordCount: number;
  exclamations: number;
}

interface Rule {
  rule: VoiceRule;
  pattern: RegExp;
  severity: 'block' | 'warn';
  advice: string;
}

// ─── the patterns ────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  // "It's not X, it's Y" and its relatives — manufactured contrast that exists
  // to sound insightful.
  {
    rule: 'ai_construction',
    pattern:
      /\b(it'?s not (just )?[^.!?]{2,60}?,\s*it'?s|less about [^.!?]{2,40}?,\s*(and )?more about|the real question (isn'?t|is not)|this isn'?t just|that'?s not [^.!?]{2,40}?,\s*that'?s|isn'?t the answer)\b/gi,
    severity: 'block',
    advice: 'Remove the manufactured contrast ("it\'s not X, it\'s Y"). State the point once, plainly.',
  },
  {
    rule: 'ai_construction',
    pattern: /\b(what struck me|here'?s the thing|the truth is|the reality is|let me explain)\b/gi,
    severity: 'block',
    advice: 'Drop the essayistic lead-in and start with the observation itself.',
  },
  {
    rule: 'corporate_filler',
    pattern:
      /\b(it'?s worth noting|i wanted to flag|that said,|ultimately,|which is why|at the end of the day|in today'?s world|in an era of|at a time when|at the intersection of)\b/gi,
    severity: 'block',
    advice: 'Cut the corporate connective tissue; join the sentences directly or start a new one.',
  },
  {
    rule: 'banned_vocabulary',
    pattern:
      /\b(meaningful|impactful|compelling|powerful|profound|transformative|revolutionary|game-?changing|unlock(s|ing|ed)?|reimagin(e|ing|ed)|leverag(e|ing|ed)|synerg(y|ies)|north star|core truth|at scale|increasingly|seamless(ly)?|robust|innovative|cutting-?edge|exciting|dynamic|unique)\b/gi,
    severity: 'block',
    advice: 'Replace the marketing vocabulary with the plain word you would actually say.',
  },
  {
    rule: 'generic_praise',
    pattern:
      /\b(impressive|remarkable|visionary|forward-?thinking|incredible|outstanding|stellar|exceptional|admirable)\b/gi,
    severity: 'block',
    advice: 'Remove the compliment. The verified fact is the reason for writing; praise adds nothing.',
  },
  {
    rule: 'fake_familiarity',
    pattern:
      /\b(i'?ve been following|i'?ve long admired|i'?ve been keeping an eye on|i know how (challenging|hard|difficult)|i can imagine how|i understand how (challenging|hard|difficult)|as someone who also)\b/gi,
    severity: 'block',
    advice: 'Do not imply a relationship or knowledge of how they feel. Say what the evidence shows.',
  },
  {
    rule: 'banned_opener',
    pattern:
      /\b(hope (you'?re doing well|this (email|message) finds you well|all is well)|i recently came across your profile|i came across your profile|i was impressed by your (background|profile)|your impressive journey|trust you'?re well)\b/gi,
    severity: 'block',
    advice: 'Open with the specific verified reason for writing, not a pleasantry.',
  },
  {
    rule: 'pushy_cta',
    pattern:
      /\b(hop on a (quick )?call|steal (15|fifteen|10|ten|5|five) minutes|quick (15|fifteen|10|ten)[- ]minute|book (a )?time (here|below)|let'?s connect asap|circle back|touch base|jump on a call)\b/gi,
    severity: 'block',
    advice: 'Soften the close to a question or an offer, not a meeting request.',
  },
  {
    // Em dashes are the single most recognisable tell in generated prose.
    rule: 'em_dash',
    pattern: /—/g,
    severity: 'block',
    advice: 'Replace the em dash with a period or a comma.',
  },
];

/** A trailing "Best, Name" style sign-off — excluded from the word count. */
const SIGNOFF_BLOCK =
  /\n\s*(best( regards)?|regards|thanks|thank you|cheers|sincerely|warmly)\s*,?\s*\n[\s\S]*$/i;

// ─── checking ────────────────────────────────────────────────────────────────

export interface VoiceOptions {
  /**
   * Verified text the message may legitimately reproduce — typically the hook's
   * supporting quote. Removed before scanning so evidence is never penalised.
   */
  quotes?: (string | null | undefined)[];
  minWords?: number;
  maxWords?: number;
}

/**
 * Strip everything that is evidence rather than the writer's own prose:
 * supplied verified quotes, and any span the message puts in quotation marks.
 */
export function scannableText(message: string, quotes: (string | null | undefined)[] = []): string {
  let text = message;

  for (const q of quotes) {
    const quote = (q ?? '').trim();
    if (quote.length < 8) continue;
    // Remove the quote wherever it appears, however it is punctuated around.
    const escaped = quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    text = text.replace(new RegExp(escaped, 'gi'), ' ');
  }

  // Anything the draft explicitly quotes is the source speaking, not the sender.
  text = text.replace(/[""][^""]{8,400}[""]/g, ' ').replace(/"[^"]{8,400}"/g, ' ');

  return text;
}

export function checkVoice(message: string, options: VoiceOptions = {}): VoiceCheck {
  const { quotes = [], minWords = MIN_WORDS, maxWords = MAX_WORDS } = options;

  const scannable = scannableText(message, quotes);
  const issues: VoiceIssue[] = [];
  const failures: string[] = [];

  for (const r of RULES) {
    const found = scannable.match(r.pattern);
    if (!found || found.length === 0) continue;
    const unique = [...new Set(found.map((m) => m.trim()))];
    for (const m of unique) issues.push({ rule: r.rule, match: m, severity: r.severity });
    failures.push(`${r.advice} Found: ${unique.slice(0, 4).map((m) => `"${m}"`).join(', ')}.`);
  }

  // Exclamation marks: the default is zero.
  const exclamations = (scannable.match(/!/g) ?? []).length;
  if (exclamations > 0) {
    issues.push({ rule: 'exclamation', match: '!', severity: 'block' });
    failures.push(`Remove the exclamation mark${exclamations > 1 ? 's' : ''} (${exclamations} found).`);
  }

  // Length, excluding any sign-off block so a signature cannot push it over.
  const body = message.replace(SIGNOFF_BLOCK, '');
  const wordCount = countWords(body);
  if (wordCount > 0 && (wordCount < minWords || wordCount > maxWords)) {
    issues.push({ rule: 'word_count', match: String(wordCount), severity: 'block' });
    failures.push(
      wordCount < minWords
        ? `The message is ${wordCount} words; it needs at least ${minWords}. Add substance, not padding.`
        : `The message is ${wordCount} words; keep it under ${maxWords}. Cut the least specific sentence.`,
    );
  }

  // A question that is not the closing ask reads as a rhetorical transition.
  // Warn only: some drafts legitimately ask two things.
  const sentences = body.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const earlyQuestions = sentences.slice(0, Math.max(0, sentences.length - 2)).filter((s) => s.trim().endsWith('?'));
  if (earlyQuestions.length > 0) {
    for (const q of earlyQuestions) {
      issues.push({ rule: 'rhetorical_question', match: q.trim().slice(0, 60), severity: 'warn' });
    }
    failures.push('A question appears before the close; make sure it is a real ask, not a rhetorical transition.');
  }

  return {
    passed: !issues.some((i) => i.severity === 'block'),
    issues,
    failures,
    wordCount,
    exclamations,
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
