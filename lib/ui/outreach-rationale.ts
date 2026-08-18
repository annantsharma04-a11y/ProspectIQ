// Outreach Rationale — a compact synthesis shown above the drafted message:
// why we're sending this message, why now, and what we're offering.
//
// This is deliberately NOT a second copy of Target Qualification. That panel
// already owns the full "why is this account/contact qualified" story —
// scores, reasoning paragraphs, evidence, capability matches, sources. This
// module only ever derives a short synthesis from data qualification and
// solution matching already computed; it never repeats a score, and never
// repeats a full reason/evidence paragraph or capability description
// verbatim. Same underlying data, intentionally different — smaller, and for
// the solution, more decision-oriented — composition.
//
// Recommended Solution is the primary element here: it is the one thing a
// reviewer needs to understand in one glance — WHICH approved Zamp solution,
// WHY it fits (one sentence, not the catalog description), the EVIDENCE that
// justified it (capability + score + source, not the full qualification
// writeup), and what to actually lead with when writing outreach.
//
// Every field is read from data already persisted by the pipeline — the same
// qualification result the Target Qualification panel shows, the same hook
// signal row the "Selected hook" panel shows, and the `approved_solution` /
// `solution_match_note` the generate_message stage recorded (computed once,
// deterministically, in lib/solutions/match.ts). Nothing here is invented for
// display; a run with no draft has no rationale to show at all.

import type { RunSnapshot } from '@/lib/types';
import type { CompanyFit, ProspectFit } from '@/lib/qualification/types';
import { NO_SOLUTION_MATCH_MESSAGE } from '@/lib/solutions/types';

interface ApprovedSolutionOutput {
  name: string;
  description: string;
  /** Added alongside this UI change — see generateMessageStage() in lib/pipeline/stages.ts. Optional so older persisted runs degrade gracefully. */
  supported_workflows?: string[];
  matched_capabilities: {
    capability_name: string;
    fit_strength: number;
    evidence: { url: string; quote: string }[];
  }[];
}

/** Shape actually written by generateMessageStage() — see lib/pipeline/stages.ts. */
interface GenerateMessageOutput {
  approved_solution?: ApprovedSolutionOutput | null;
  solution_match_note?: string | null;
}

export interface PrimarySignal {
  signal: string;
  sourceUrl: string;
  quote: string | null;
}

/** The single verified fact that justified the solution match — not the full qualification writeup. */
export interface SolutionEvidence {
  capabilityName: string;
  fitStrength: number;
  sourceUrl: string | null;
}

export interface OutreachRationaleData {
  /** One sentence — never the full company-fit reasoning paragraph, never a score. */
  accountFit: string;
  /** One sentence — never the full prospect-fit reasoning paragraph, never a score. */
  contactFit: string;
  /** Why now — the verified signal the message was built on. Null only if a draft exists with no linked hook row. */
  primarySignal: PrimarySignal | null;
  /** Null when no approved solution matched this company's verified capabilities. */
  solutionName: string | null;
  /** One concise, evidence-based sentence — never the raw capability description or qualification reasoning. */
  whyItFits: string;
  /** The observed capability + score + source that justified the match — null only when there is no match. */
  solutionEvidence: SolutionEvidence | null;
  /** What the message should actually lead with — the solution's own approved workflow list, comma-joined. Null when there is no match. */
  useInOutreach: string | null;
}

/** Re-exported so callers rendering the "no match" case don't need a second import. */
export { NO_SOLUTION_MATCH_MESSAGE };

/** Natural adjective for a fit classification — presentation only, no new judgment. */
const FIT_ADJECTIVE: Record<string, string> = {
  HIGH: 'Strong',
  MEDIUM: 'Moderate',
  LOW: 'Weak',
  UNKNOWN: 'Unclear',
};

/**
 * One-sentence account-fit synthesis: the classification plus the single
 * strongest VERIFIED reason, never the full `fit_reasons` paragraph or the
 * capability evidence list — those stay in Target Qualification.
 */
function accountFitSentence(company: CompanyFit): string {
  const adjective = FIT_ADJECTIVE[company.classification] ?? 'Uncertain';
  const topObserved = company.capability_matches.find(
    (m) => m.basis === 'OBSERVED' && m.evidence.length > 0,
  );
  if (topObserved) {
    return `${adjective} account fit — a verified ${topObserved.capability_name.toLowerCase()} need.`;
  }
  if (company.relevant_workflows.length > 0) {
    return `${adjective} account fit, based on ${company.relevant_workflows[0]}.`;
  }
  return `${adjective} account fit.`;
}

/**
 * One-sentence contact-fit synthesis: the classification plus role and
 * decision authority, never the full `relevance_reason` paragraph — that
 * stays in Target Qualification.
 */
function contactFitSentence(prospect: ProspectFit): string {
  const adjective = FIT_ADJECTIVE[prospect.classification] ?? 'Uncertain';
  const role = prospect.role ?? 'this contact';
  const authority = prospect.decision_authority === 'HIGH' ? ' with decision authority over the qualified workflow' : '';
  return `${adjective} contact fit — ${role}${authority}.`;
}

/**
 * One concise, evidence-based sentence connecting the APPROVED SOLUTION to
 * the VERIFIED workflow — built from the solution's own catalog description
 * (approved, never invented) plus the company it was matched to. Deliberately
 * does NOT include the capability's full `company_signal` text or the
 * qualification's fit reasoning: those already appear, in full, in the
 * Evidence line below and in Target Qualification respectively.
 */
function solutionFitSentence(solution: ApprovedSolutionOutput, company: string | null): string {
  const description = solution.description.trim().replace(/\.\s*$/, '');
  return `${description}, a verified need at ${company ?? 'this company'}.`;
}

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
  const solution = output?.approved_solution ?? null;

  const hookSignal = snapshot.signals.find((s) => s.selected_as_hook) ?? null;

  // Strongest match first — matchApprovedSolution() (lib/solutions/match.ts)
  // already sorts `matched_capabilities` by fit_strength descending.
  const topMatch = solution?.matched_capabilities?.[0] ?? null;

  return {
    accountFit: accountFitSentence(q.company_fit),
    contactFit: contactFitSentence(q.prospect_fit),
    primarySignal: hookSignal
      ? { signal: hookSignal.signal, sourceUrl: hookSignal.source_url, quote: hookSignal.supporting_quote }
      : null,
    solutionName: solution?.name ?? null,
    whyItFits: solution ? solutionFitSentence(solution, snapshot.run.company_name) : NO_SOLUTION_MATCH_MESSAGE,
    solutionEvidence: topMatch
      ? {
          capabilityName: topMatch.capability_name,
          fitStrength: topMatch.fit_strength,
          sourceUrl: topMatch.evidence[0]?.url ?? null,
        }
      : null,
    useInOutreach:
      solution?.supported_workflows && solution.supported_workflows.length > 0
        ? solution.supported_workflows.join(', ')
        : null,
  };
}
