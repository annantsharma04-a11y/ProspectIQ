// Approved customer proof — the fixed, controlled set of customer evidence
// outreach may ever repeat.
//
// This is the third layer of the same "configuration, not invention" pattern
// the app already applies twice:
//
//   SENDER_CAPABILITIES (lib/generation/sender.ts)  what we can DO
//   ZAMP_SOLUTION_CATALOG (lib/solutions/catalog.ts) what we SELL for it
//   ZAMP_PROOF_CATALOG (this module)                 who we have DONE it for
//
// Proof is the most dangerous of the three, and gets the strictest contract.
// A wrong capability is an irrelevant email; a wrong customer claim is a
// factual assertion about a named third party, made to a stranger, in writing.
// So `approved_statement` is stored as one pre-approved, ready-to-use string:
// the model is never given the raw customer, workflow, metric or outcome to
// assemble a sentence from, because assembling is where paraphrase — and
// therefore drift — happens.
//
// Phase 1 (this one) builds the data layer and the deterministic matching
// only. Nothing here reaches the LLM yet.

import type { EvidenceItem } from '@/lib/qualification/types';

export interface ApprovedProof {
  /** Short stable id, referenced from ZampSolution.proof_point_ids. */
  id: string;
  /** The customer this proof is about, exactly as approved for external use. */
  customer: string;
  /** The workflow the proof demonstrates — what makes it RELEVANT, not impressive. */
  workflow: string;
  /**
   * The sender capability (SenderCapability.id) this proof evidences.
   *
   * The join key for matching. A proof is only ever offered for a capability
   * the company was VERIFIED to have, so a proof cannot travel to an unrelated
   * function however strong its numbers are.
   */
  capability_id: string;
  /**
   * The ONLY customer-proof text that may ever appear in an email.
   *
   * Stored whole and used verbatim. Not a template, not a set of fields to be
   * composed, not a number to be re-expressed — a finished, approved sentence.
   * Later phases will enforce this verbatim; Phase 1 only carries it.
   */
  approved_statement: string;
  /**
   * True when the customer has agreed to be named publicly.
   *
   * A private reference is real evidence internally and still unusable in
   * outbound email, so it is excluded from matching rather than quietly
   * anonymised — anonymising is itself a rewrite.
   */
  is_public: boolean;
  /** Optional public source backing the statement, when one exists. */
  evidence?: EvidenceItem[];
}

/** The capability that justified a proof, carried through for display and audit. */
export interface ProofMatchBasis {
  capability_id: string;
  capability_name: string;
  /** The observed company signal that verified this capability. */
  company_signal: string;
  fit_strength: number;
}

export interface ProofMatch {
  proof: ApprovedProof;
  /** The verified capability that connected this proof to this company. */
  matched_on: ProofMatchBasis;
  /** The solution whose catalog entry listed this proof. */
  solution_id: string;
  /**
   * Why this proof and not another — assembled deterministically from the
   * match, never model-authored.
   */
  why_this_proof: string;
  /** Which rule selected it, so a surprising pick is explainable after the fact. */
  selection_basis: ProofSelectionBasis;
}

/**
 * How a proof won, in the order the matcher tries them.
 *
 * Relevance beats magnitude at every step — none of these rules consults a
 * number in the statement, and none can.
 */
export type ProofSelectionBasis =
  /** The proof's workflow text matches the verified company signal or capability name. */
  | 'WORKFLOW_MATCH'
  /** Same capability, no workflow overlap — still relevant, less specific. */
  | 'CAPABILITY_MATCH';

/** Shown wherever a run has a solution but no approved proof for it. */
export const NO_PROOF_MATCH_MESSAGE = 'No approved customer proof established for this workflow.';
