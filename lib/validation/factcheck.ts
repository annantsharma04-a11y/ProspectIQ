// Claim validation — deterministic, provenance-aware.
//
// The analysis call declares the claims its message makes, what KIND each claim
// is, and its own verdict. Self-judgment is not a safeguard on its own, so this
// module independently re-checks the result.
//
// The central rule is that evidence requirements depend on claim TYPE:
//
//   PROSPECT_FACT / COMPANY_FACT / EXTERNAL_EVENT
//       assertions about the world → external evidence required
//   SENDER_OFFERING / GENERIC_OUTREACH_LANGUAGE
//       statements about what the sender sells, or ordinary outreach phrasing
//       → no third-party evidence required, and never downgraded for lacking it
//
// Without that distinction, "we automate accounts payable" gets treated as an
// unverifiable claim about the prospect and flags an otherwise clean draft.

import { evidenceLevel, type NormalizedSource } from '@/lib/research/normalize';
import type { AnalysisClaim, ClaimType } from '@/lib/llm/analyze';
import type { ScoredSignal } from '@/lib/signals/types';
import { isSameSource } from '@/lib/url-identity';

/** ALLOWED = valid without external evidence, by virtue of the claim's type. */
export type ClaimVerdict = 'SUPPORTED' | 'UNSUPPORTED' | 'UNCERTAIN' | 'ALLOWED';
export type ValidationStatus = 'pass' | 'revised' | 'flagged';

export interface CheckedClaim {
  claim: string;
  type: ClaimType;
  requires_external_evidence: boolean;
  verdict: ClaimVerdict;
  evidence_url: string | null;
  explanation: string;
}

export interface ValidationResult {
  status: ValidationStatus;
  claims: CheckedClaim[];
  final_message_text: string;
  was_revised: boolean;
  notes: string;
  confidence: number;
  sensitivity_note: string | null;
}

const CLAIM_TYPES: ClaimType[] = [
  'PROSPECT_FACT',
  'COMPANY_FACT',
  'EXTERNAL_EVENT',
  'SENDER_OFFERING',
  'SENDER_CAPABILITY',
  'SENDER_OUTCOME_CLAIM',
  'GENERIC_LANGUAGE',
];

/**
 * Claims about the prospect's world need a retrieved source.
 * Claims about the sender's own product do not — with one exception below.
 */
export function requiresExternalEvidence(type: ClaimType): boolean {
  return type === 'PROSPECT_FACT' || type === 'COMPANY_FACT' || type === 'EXTERNAL_EVENT';
}

/**
 * A performance claim about the sender's product ("cuts costs 40%") is not a
 * prospect fact, so prospect research cannot corroborate it — but it is still a
 * factual assertion that could embarrass the sender. It needs product evidence
 * or it must be softened, so it is never simply ALLOWED.
 */
export function isSenderOutcomeClaim(type: ClaimType): boolean {
  return type === 'SENDER_OUTCOME_CLAIM';
}

/** Quantified performance language, used to catch mislabelled outcome claims. */
const OUTCOME_LANGUAGE =
  /(\d+\s*%|\d+x\b|\bROI\b|saves?\s+\d|cut(s|ting)?\s+\w+\s+by|reduc(e|es|ed|ing)\s+\w+\s+by|\b\d{2,}\+?\s+(\w+\s+){0,2}(customers|companies|teams|clients|users)\b|fastest|best-in-class|industry[- ]leading|guarantee)/i;

function normalizeType(value: unknown): ClaimType {
  const v = String(value ?? '').toUpperCase().replace(/[\s-]/g, '_');
  return (CLAIM_TYPES as string[]).includes(v)
    ? (v as ClaimType)
    // An unlabelled claim is treated as an assertion about the world, which is
    // the stricter reading.
    : 'PROSPECT_FACT';
}

function normalizeVerdict(value: unknown): 'SUPPORTED' | 'UNSUPPORTED' | 'UNCERTAIN' {
  const v = String(value ?? '').toUpperCase();
  return v === 'SUPPORTED' || v === 'UNSUPPORTED' ? v : v === 'UNCERTAIN' ? v : 'UNCERTAIN';
}

/**
 * Does the claim's distinctive content survive in the message?
 * Deliberately errs toward "yes" — it is only ever used to escalate.
 * Figures carry the most weight: a message that drops the company name but
 * keeps "$40M Series B" is still making the claim.
 */
export function claimStillPresent(claim: string, text: string): boolean {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'to', 'of', 'in', 'for', 'on', 'with', 'is', 'are',
    'their', 'they', 'you', 'your', 'that', 'this', 'has', 'have', 'was', 'were',
  ]);
  const words = claim
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stop.has(w));
  if (words.length === 0) return false;

  const body = text.toLowerCase();
  const figures = words.filter((w) => /\d/.test(w));
  if (figures.some((w) => body.includes(w))) return true;

  return words.filter((w) => body.includes(w)).length / words.length >= 0.5;
}

/** Sensitive events that must not be used as an outreach angle. */
// Prefixes match on a word boundary at the START only, so inflected forms
// ("layoffs", "resigned", "bankruptcy") are caught too.
const SENSITIVE =
  /\b(layoff|laid off|redundanc|lawsuit|sued|litigation|bankrupt|insolven|scandal|investigation|indict|resign|stepping down|stepped down|ousted|fired|death|died|passed away)/i;

export interface ValidateInput {
  message: string;
  claims: AnalysisClaim[];
  sources: NormalizedSource[];
  evidence: ScoredSignal[];
  /** Set when the run had no usable hook — the message must claim no findings. */
  conservative: boolean;
  modelConfidence: number;
}

export function validateClaims(input: ValidateInput): ValidationResult {
  const checked: CheckedClaim[] = input.claims.map((raw) => {
    const type = normalizeType(raw.type);
    const needsEvidence = requiresExternalEvidence(type);
    const evidenceUrl = raw.evidence_url ?? null;

    // A performance claim about the sender's product needs product evidence.
    // We have none in a prospect-research run, so it is flagged for softening
    // rather than waved through as a harmless sender statement.
    if (isSenderOutcomeClaim(type)) {
      return {
        claim: raw.claim,
        type,
        requires_external_evidence: true,
        verdict: 'UNCERTAIN' as const,
        evidence_url: raw.evidence_url ?? null,
        explanation:
          `${raw.explanation ?? ''} [automatic] Performance claim about the sender's product; needs verified product evidence or should be softened to a capability statement.`.trim(),
      };
    }

    // Statements about the sender's own product, and ordinary outreach phrasing,
    // are valid on their face. They are never downgraded for lacking a source.
    if (!needsEvidence) {
      // Catch an outcome claim the model mislabelled as a plain capability.
      if (OUTCOME_LANGUAGE.test(raw.claim)) {
        return {
          claim: raw.claim,
          type,
          requires_external_evidence: true,
          verdict: 'UNCERTAIN' as const,
          evidence_url: null,
          explanation:
            `${raw.explanation ?? ''} [automatic] Reads as a performance claim about the sender's product; needs product evidence or softening.`.trim(),
        };
      }

      return {
        claim: raw.claim,
        type,
        requires_external_evidence: false,
        verdict: 'ALLOWED' as const,
        evidence_url: null,
        explanation:
          raw.explanation ||
          (type === 'SENDER_OFFERING' || type === 'SENDER_CAPABILITY'
            ? 'Describes the sender’s own product; no third-party evidence required.'
            : 'Ordinary outreach language; makes no factual assertion about the prospect.'),
      };
    }

    const verdict = normalizeVerdict(raw.verdict);

    // An assertion about the world with no citation is not supported.
    if (verdict === 'SUPPORTED' && !evidenceUrl) {
      return {
        claim: raw.claim,
        type,
        requires_external_evidence: true,
        verdict: 'UNSUPPORTED' as const,
        evidence_url: null,
        explanation:
          `${raw.explanation ?? ''} [automatic] This asserts a fact about the prospect or company but cites no source.`.trim(),
      };
    }

    // A citation we never retrieved cannot support anything. URL identity, not
    // string equality — a country-subdomain LinkedIn citation is the same source.
    if (verdict === 'SUPPORTED' && evidenceUrl) {
      const cited = input.sources.find(
        (s) => isSameSource(s.url, evidenceUrl) || isSameSource(s.canonical_url, evidenceUrl),
      );
      if (!cited) {
        return {
          claim: raw.claim,
          type,
          requires_external_evidence: true,
          verdict: 'UNSUPPORTED' as const,
          evidence_url: evidenceUrl,
          explanation:
            `${raw.explanation ?? ''} [automatic] Cited source was not among the retrieved sources.`.trim(),
        };
      }

      // One shared definition of evidence strength (lib/research/normalize).
      const level = evidenceLevel(cited);

      if (level === 'UNAVAILABLE') {
        return {
          claim: raw.claim,
          type,
          requires_external_evidence: true,
          verdict: 'UNSUPPORTED' as const,
          evidence_url: evidenceUrl,
          explanation:
            `${raw.explanation ?? ''} [automatic] The cited source yielded no usable evidence.`.trim(),
        };
      }

      // Snippet-only evidence is real but weaker than a retrieved page.
      if (level === 'SNIPPET' && cited.duplicate_count === 0) {
        return {
          claim: raw.claim,
          type,
          requires_external_evidence: true,
          verdict: 'UNCERTAIN' as const,
          evidence_url: evidenceUrl,
          explanation:
            `${raw.explanation ?? ''} [automatic] Public search evidence was found, but the underlying page could not be fully retrieved, so this claim was not treated as fully corroborated.`.trim(),
        };
      }
    }

    return {
      claim: raw.claim,
      type,
      requires_external_evidence: true,
      verdict,
      evidence_url: evidenceUrl,
      explanation: raw.explanation ?? '',
    };
  });

  const unsupported = checked.filter((c) => c.verdict === 'UNSUPPORTED');
  const uncertain = checked.filter((c) => c.verdict === 'UNCERTAIN');

  const notes: string[] = [];
  let status: ValidationStatus = 'pass';

  const surviving = unsupported.filter((c) => claimStillPresent(c.claim, input.message));
  if (surviving.length > 0) {
    status = 'flagged';
    notes.push(
      `[automatic] ${surviving.length} unsupported claim(s) remain in the message text; escalated for human review.`,
    );
  } else if (unsupported.length > 0) {
    notes.push(`[automatic] ${unsupported.length} unsupported claim(s) were kept out of the final message.`);
  }

  if (uncertain.length > 0 && status === 'pass') {
    status = 'revised';
    notes.push(`[automatic] ${uncertain.length} claim(s) rest on weak or uncorroborated evidence.`);
  }

  // A conservative message may still state verified basics — the prospect's name,
  // role and employer taken from the retrieved profile. What it must not do is
  // assert a research finding it cannot support. So only unsupported or shaky
  // world-claims are a problem here.
  if (input.conservative) {
    const unverifiedResearchClaims = checked.filter(
      (c) => c.requires_external_evidence && c.verdict !== 'SUPPORTED',
    );
    if (unverifiedResearchClaims.length > 0) {
      status = 'flagged';
      notes.push(
        `[automatic] This run had insufficient evidence, so the message may only state verified basics, but ${unverifiedResearchClaims.length} unverified claim(s) about the prospect or company were detected.`,
      );
    }
  }

  let sensitivity: string | null = null;
  const sensitiveHit = input.message.match(SENSITIVE);
  if (sensitiveHit) {
    status = 'flagged';
    sensitivity = `The message references a potentially sensitive topic ("${sensitiveHit[0]}"). A human should confirm this is appropriate before use.`;
    notes.push('[automatic] Sensitive-topic language detected in the message.');
  }

  // Confidence can be reduced by our checks, never raised by the model's optimism.
  const penalty = surviving.length * 40 + unsupported.length * 15 + uncertain.length * 10;
  const confidence = Math.max(0, Math.min(100, Math.round(input.modelConfidence) - penalty));

  return {
    status,
    claims: checked,
    final_message_text: input.message,
    was_revised: false,
    notes: notes.join(' '),
    confidence,
    sensitivity_note: sensitivity,
  };
}
