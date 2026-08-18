// The Zamp Solution Catalog — the fixed, controlled set of products outreach
// may ever reference by name.
//
// This exists for the same reason SENDER_CAPABILITIES exists (see
// lib/generation/sender.ts): what the model may claim about the product must
// be configuration, never invention. A capability describes an OBSERVABLE
// COMPANY CHARACTERISTIC; a solution is the PRODUCT that addresses it. Keeping
// them separate means qualification can establish "this company has workflow
// X" without ever deciding, on its own, which product to pitch for it — that
// mapping lives here, in code, and is applied deterministically.

import type { EvidenceItem } from '@/lib/qualification/types';

export interface ZampSolution {
  /** Short id, e.g. "ap_automation_suite". Stable — referenced by matching config. */
  id: string;
  name: string;
  description: string;
  /** Workflows this solution is built to support. */
  supported_workflows: string[];
  /** Roles/functions this solution is aimed at. */
  target_functions: string[];
  /** When this solution genuinely applies. */
  use_cases: string[];
  /** When it does NOT apply — kept explicit so the model is never invited to stretch it. */
  non_use_cases: string[];
  /**
   * Sender capability ids (see SenderCapability.id in lib/generation/sender.ts)
   * this solution addresses. A solution matches a company only when qualification
   * found OBSERVED, evidenced fit for one of these ids — never on inference,
   * and never chosen by a model.
   */
  matches_capability_ids: string[];
}

/** One capability that contributed to a solution match, carrying its verified evidence. */
export interface MatchedCapability {
  capability_id: string;
  capability_name: string;
  company_signal: string;
  fit_strength: number;
  evidence: EvidenceItem[];
}

export interface SolutionMatch {
  solution: ZampSolution;
  /** The verified capability match(es) that produced this pick, strongest first. */
  matched_capabilities: MatchedCapability[];
  /** Deterministic, evidence-grounded explanation — never model-authored. */
  why_it_fits: string;
}

/** Shown wherever a run has no verified capability that maps to an approved solution. */
export const NO_SOLUTION_MATCH_MESSAGE = 'No specific solution match established.';
