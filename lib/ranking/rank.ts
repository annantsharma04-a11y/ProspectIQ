// Signal ranking and hook gating — entirely deterministic.
//
//   1. scoreSignals() — inspectable arithmetic. Same inputs always produce the
//      same ordering, and every component is stored on the signal row.
//   2. gateHook() — enforces the rules the model is not trusted to follow:
//      a hook must clear the quality threshold and must not be disputed.
//
// The model proposes which hook to open with (inside the single analysis call);
// this module decides whether that proposal is allowed to stand.

import { monthsOld } from '@/lib/research/engine';
import { isSameSource } from '@/lib/url-identity';
import { evidenceLevel, EVIDENCE_WEIGHT, type NormalizedSource } from '@/lib/research/normalize';
import type { ExtractedSignal, ScoredSignal } from '@/lib/signals/types';

/** Composite weights. Documented here because reviewers ask why a hook won. */
export const WEIGHTS = {
  recency: 0.3,
  relevance: 0.25,
  specificity: 0.15,
  confidence: 0.15,
  credibility: 0.1,
  corroboration: 0.05,
} as const;

/** Below this composite, we do not consider a signal usable as a hook. */
export const HOOK_THRESHOLD = 45;
/** Signals older than this are stale and cannot anchor a "recent news" opener. */
export const STALE_MONTHS = 18;

/**
 * 100 for the last 30 days, decaying to 0 at STALE_MONTHS.
 * Undated sources get a low-but-not-zero score: unknown is weaker than fresh,
 * but not proof of staleness.
 */
export function recencyScore(publishedDate: string | null, now: Date = new Date()): number {
  if (!publishedDate) return 30;
  const months = monthsOld(publishedDate, now);
  if (!Number.isFinite(months)) return 30;
  if (months < 0) return 100; // future-dated: treat as brand new
  if (months <= 1) return 100;
  if (months >= STALE_MONTHS) return 0;
  return Math.round(100 * (1 - (months - 1) / (STALE_MONTHS - 1)));
}

export function scoreSignals(
  signals: ExtractedSignal[],
  sources: NormalizedSource[],
  now: Date = new Date(),
): ScoredSignal[] {
  const scored = signals.map((s) => {
    const source = sources.find(
      (x) => isSameSource(x.url, s.source_url) || isSameSource(x.canonical_url, s.source_url),
    );
    // Evidence quality scales credibility: a claim resting on a snippet is
    // weaker than the same claim resting on a page we actually retrieved.
    const level = source ? evidenceLevel(source) : 'SNIPPET';
    const credibility = Math.round((source?.credibility ?? 0.45) * EVIDENCE_WEIGHT[level] * 100);
    const recency = recencyScore(s.published_date, now);
    // Each independent corroborating result adds 25, capped at 100.
    const corroboration = Math.min(100, (source?.duplicate_count ?? 0) * 25);

    const composite =
      WEIGHTS.recency * recency +
      WEIGHTS.relevance * s.relevance_score +
      WEIGHTS.specificity * s.specificity_score +
      WEIGHTS.confidence * s.confidence_score +
      WEIGHTS.credibility * credibility +
      WEIGHTS.corroboration * corroboration;

    return {
      ...s,
      source_type: source?.source_type ?? 'web',
      evidence_level: level,
      credibility_score: credibility,
      recency_score: recency,
      corroboration_count: source?.duplicate_count ?? 0,
      composite_score: Math.round(composite),
      retrieved_at: source?.retrieved_at ?? new Date().toISOString(),
    } satisfies ScoredSignal;
  });

  return scored.sort((a, b) => b.composite_score - a.composite_score);
}


/**
 * Whether a candidate may serve as the outreach hook.
 *
 * A person-level signal qualifies on verification and relevance alone.
 * A company-level signal is also legitimate — most B2B outreach opens on company
 * context — but only when we know the prospect's role AND the signal connects to
 * it. Without that connection the message would be "your employer did a thing",
 * which is not personalisation.
 */
export function qualifyHook(
  signal: ScoredSignal,
  prospectRole: string | null,
  /**
   * Capability ids the company was actually shown to have. A hook whose angle
   * rests on an unevidenced use case is rejected: qualifying a company on
   * observed KYC evidence and then pitching an inferred AP workflow would put a
   * claim in front of a prospect that no source supports.
   */
  observedCapabilityIds: Set<string> = new Set(),
): { qualified: boolean; reason: string | null } {
  if (signal.conflicts_with) {
    return { qualified: false, reason: `Disputed by another source: ${signal.conflicts_with}` };
  }
  if (signal.composite_score < HOOK_THRESHOLD) {
    return {
      qualified: false,
      reason: `Scored ${signal.composite_score}, below the ${HOOK_THRESHOLD} quality threshold.`,
    };
  }

  if (signal.related_capability_id && !observedCapabilityIds.has(signal.related_capability_id)) {
    return {
      qualified: false,
      reason: `The hook's angle rests on the "${signal.related_capability_id}" use case, which was only inferred for this company, not evidenced. Using it would assert a workflow no source shows.`,
    };
  }

  if (signal.signal_level === 'COMPANY') {
    if (!prospectRole || !prospectRole.trim()) {
      return {
        qualified: false,
        reason:
          'Company-level signal, but the prospect’s role is unknown, so there is no established reason it is relevant to them.',
      };
    }
    if (!signal.role_relevance || signal.role_relevance.trim().length < 15) {
      return {
        qualified: false,
        reason:
          'Company-level signal with no stated connection to this person’s role or function.',
      };
    }
  }

  return { qualified: true, reason: null };
}

export interface HookSelection {
  /** Index into the ranked array, or null when nothing is usable. */
  selected_index: number | null;
  selection_reason: string;
  confidence: number;
  alternatives_considered: { index: number; why_not: string }[];
  insufficient_evidence: boolean;
  insufficient_reason: string | null;
  /** True when code overrode the model's choice. */
  overridden: boolean;
  /** Candidates considered and turned down, with the reason for each. */
  rejected_candidates: { signal: string; reason: string }[];
}

/**
 * Decide whether the analysis's proposed hook may stand.
 *
 * Rejects, in order: an explicit "none", an out-of-range index, a disputed
 * signal, and anything below the quality threshold. A rejection is never
 * replaced with a different hook — if the best candidate is not good enough,
 * the run reports insufficient evidence and drafts conservatively.
 */
export function gateHook(
  ranked: ScoredSignal[],
  proposed: {
    index: number | null;
    reason: string;
    confidence: number;
    alternatives: { index: number; why_not: string }[];
    insufficient: boolean;
    insufficientReason: string | null;
  },
  /** Needed to judge whether a company-level signal is relevant to this person. */
  prospectRole: string | null = null,
  /** Capability ids backed by observed evidence at this company. */
  observedCapabilityIds: Set<string> = new Set(),
): HookSelection {
  const base = {
    selection_reason: proposed.reason ?? '',
    confidence: Math.max(0, Math.min(100, Math.round(proposed.confidence ?? 0))),
    alternatives_considered: proposed.alternatives ?? [],
  };

  const none = (reason: string, overridden: boolean): HookSelection => ({
    ...base,
    selected_index: null,
    insufficient_evidence: true,
    insufficient_reason: reason,
    overridden,
    rejected_candidates: [],
  });

  if (ranked.length === 0) {
    return none('No verifiable signals were extracted from the available sources.', false);
  }

  // Models signal "none of these" with either null or -1.
  if (proposed.insufficient || proposed.index === null || (typeof proposed.index === 'number' && proposed.index < 0)) {
    return none(
      proposed.insufficientReason ?? proposed.reason ?? 'No candidate signal was suitable as an opener.',
      false,
    );
  }

  const picked = ranked[proposed.index];
  if (!picked) {
    return none('Hook selection returned an index outside the candidate list.', true);
  }

  const verdict = qualifyHook(picked, prospectRole, observedCapabilityIds);
  if (verdict.qualified) {
    return {
      ...base,
      selected_index: proposed.index,
      insufficient_evidence: false,
      insufficient_reason: null,
      overridden: false,
      rejected_candidates: [],
    };
  }

  // The model's pick does not qualify. Rather than giving up immediately, keep
  // looking down the ranked list — but never invent a hook, and record why each
  // candidate was turned down.
  const rejected: { signal: string; reason: string }[] = [
    { signal: picked.signal, reason: verdict.reason ?? 'Did not qualify.' },
  ];

  for (let i = 0; i < ranked.length; i++) {
    if (i === proposed.index) continue;
    const candidate = ranked[i];
    const check = qualifyHook(candidate, prospectRole, observedCapabilityIds);
    if (check.qualified) {
      return {
        ...base,
        selected_index: i,
        selection_reason:
          `The highest-ranked candidate did not qualify (${verdict.reason}) so the next qualifying signal was used. ` +
          base.selection_reason,
        insufficient_evidence: false,
        insufficient_reason: null,
        overridden: true,
        rejected_candidates: rejected,
      };
    }
    rejected.push({ signal: candidate.signal, reason: check.reason ?? 'Did not qualify.' });
  }

  return {
    ...none(verdict.reason ?? 'No candidate signal qualified as an outreach hook.', true),
    rejected_candidates: rejected,
  };
}
