// Outreach Rationale — shown above the drafted message: why this account, why
// this contact, what verified signal the message rests on, and which approved
// solution (if any) was recommended and why.
//
// Every field is read from data already persisted by the pipeline — the same
// qualification result the Target Qualification panel shows, the same hook
// signal row the "Selected hook" panel shows, and the `approved_solution` /
// `solution_match_note` the generate_message stage recorded (computed once,
// deterministically, in lib/solutions/match.ts). Nothing here is invented for
// display; a run with no draft has no rationale to show at all.

import type { RunSnapshot } from '@/lib/types';
import type { FitClassification } from '@/lib/qualification/types';
import { NO_SOLUTION_MATCH_MESSAGE } from '@/lib/solutions/types';

interface ApprovedSolutionOutput {
  name: string;
  why_it_fits: string;
}

/** Shape actually written by generateMessageStage() — see lib/pipeline/stages.ts. */
interface GenerateMessageOutput {
  approved_solution?: ApprovedSolutionOutput | null;
  solution_match_note?: string | null;
}

export interface FitSummary {
  classification: FitClassification;
  score: number;
  reason: string | null;
}

export interface PrimarySignal {
  signal: string;
  sourceUrl: string;
  quote: string | null;
}

export interface OutreachRationaleData {
  accountFit: FitSummary;
  contactFit: FitSummary;
  /** The verified signal the message was built on — null only if a draft exists with no linked hook row. */
  primarySignal: PrimarySignal | null;
  /** Null when no approved solution matched this company's verified capabilities. */
  solutionName: string | null;
  /** Always populated — either the evidence-grounded fit explanation, or NO_SOLUTION_MATCH_MESSAGE. */
  whyItFits: string;
}

/** Re-exported so callers rendering the "no match" case don't need a second import. */
export { NO_SOLUTION_MATCH_MESSAGE };

/**
 * Null whenever there is no drafted message to explain — before qualification
 * has run, when the target did not qualify, or while a run is still in
 * progress.
 */
export function buildOutreachRationale(snapshot: RunSnapshot): OutreachRationaleData | null {
  const q = snapshot.run.qualification;
  if (!q || !snapshot.draft) return null;

  const genStage = snapshot.stages.find((s) => s.stage_name === 'generate_message');
  const output = (genStage?.output ?? null) as GenerateMessageOutput | null;

  const hookSignal = snapshot.signals.find((s) => s.selected_as_hook) ?? null;

  return {
    accountFit: {
      classification: q.company_fit.classification,
      score: q.company_fit.score,
      reason: q.company_fit.fit_reasons[0]?.reason ?? null,
    },
    contactFit: {
      classification: q.prospect_fit.classification,
      score: q.prospect_fit.score,
      reason: q.prospect_fit.relevance_reason,
    },
    primarySignal: hookSignal
      ? { signal: hookSignal.signal, sourceUrl: hookSignal.source_url, quote: hookSignal.supporting_quote }
      : null,
    solutionName: output?.approved_solution?.name ?? null,
    whyItFits: output?.approved_solution?.why_it_fits ?? NO_SOLUTION_MATCH_MESSAGE,
  };
}
