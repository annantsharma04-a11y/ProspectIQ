// Deterministic customer-proof matching — code only, never the model.
//
// The last link in a chain the app already builds deterministically:
//
//   verified capability  →  Zamp solution  →  approved customer proof
//   (qualification)         (solutions/match.ts)  (here)
//
// Every input is something code already established. matchApprovedSolution()
// has already discarded inferred-only capabilities, so anything reaching this
// module rests on OBSERVED evidence that survived verification. This module
// adds no judgment of its own — it is a filter and a fixed sort.
//
// THE ORDERING RULE, which is the whole point of this module: relevance beats
// magnitude. A proof is chosen because it demonstrates the workflow this
// company was verified to run, never because its number is larger. Nothing
// here parses, compares or even reads a figure inside approved_statement —
// there is no code path by which a bigger percentage can win. A marketing
// lead gets the campaign proof, not the chargeback proof, however impressive
// the chargeback statistic is.

import { getProofCatalog } from './catalog';
import type { ApprovedProof, ProofMatch, ProofSelectionBasis } from './types';
import type { SolutionMatch } from '@/lib/solutions/types';

export { NO_PROOF_MATCH_MESSAGE } from './types';

/** Shared normalisation, so workflow overlap is judged on words rather than punctuation. */
function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
}

/**
 * HOW MUCH does this proof's workflow overlap the workflow this company was
 * actually verified to run? Returns the number of shared terms.
 *
 * Compared against the capability NAME and the observed COMPANY SIGNAL — the
 * two pieces of text qualification produced for this specific company — so a
 * match means "this proof is about the thing we saw them doing", not "these
 * strings happen to look alike".
 *
 * A COUNT rather than a boolean, because one shared word is often incidental:
 * a proof about "supplier onboarding" and a signal about "processes supplier
 * invoices" share "supplier" without being about the same work. Ranking on
 * the size of the overlap lets the more specifically relevant proof win, and
 * is still purely a relevance measure — it reads only workflow vocabulary,
 * never a figure in the statement.
 */
function workflowOverlap(proof: ApprovedProof, capabilityName: string, companySignal: string): number {
  const proofWords = words(proof.workflow);
  if (proofWords.size === 0) return 0;

  let best = 0;
  for (const target of [capabilityName, companySignal]) {
    const targetWords = words(target);
    if (targetWords.size === 0) continue;
    let shared = 0;
    for (const w of proofWords) if (targetWords.has(w)) shared++;
    if (shared > best) best = shared;
  }
  return best;
}

/**
 * Pick the one approved proof to offer for an already-matched solution.
 *
 * Returns null — never a substitute, never a generic statement — when nothing
 * qualifies. "No approved proof for this workflow" is a correct and common
 * answer, and is the only safe one: the alternative is a customer claim
 * nobody approved for this context.
 *
 * Selection, in strict order:
 *   1. eligible proofs only — listed by the solution, present in the catalog,
 *      public, and evidencing a capability this company was VERIFIED to have
 *   2. prefer a proof whose workflow overlaps the verified workflow
 *      (WORKFLOW_MATCH) over one that only shares the capability
 *      (CAPABILITY_MATCH)
 *   3. within a tier, prefer the stronger verified capability — a property of
 *      OUR EVIDENCE about the company, not of the proof's numbers
 *   4. ties break on the solution's own proof_point_ids order, then on id, so
 *      the same inputs always produce the same proof
 */
export function matchApprovedProof(
  solutionMatch: SolutionMatch | null | undefined,
  catalog: ApprovedProof[] = getProofCatalog(),
): ProofMatch | null {
  // No solution means no proof. There is no path from "we found a customer
  // story" to sending one when no product was matched to this company.
  if (!solutionMatch) return null;

  const allowedIds = solutionMatch.solution.proof_point_ids ?? [];
  if (allowedIds.length === 0) return null;

  // Capability ids this company was VERIFIED to have. matchApprovedSolution()
  // already restricted these to OBSERVED matches carrying surviving evidence,
  // so an inferred-only capability can never reach this map.
  const verified = new Map(solutionMatch.matched_capabilities.map((c) => [c.capability_id, c]));

  const candidates = allowedIds
    .map((id, order) => ({ proof: catalog.find((p) => p.id === id), order }))
    .filter((c): c is { proof: ApprovedProof; order: number } => Boolean(c.proof))
    // A private reference is unusable in outbound email. Excluded outright
    // rather than anonymised, because anonymising is itself a rewrite.
    .filter((c) => c.proof.is_public)
    // The proof must evidence a capability THIS company was verified to have.
    .filter((c) => verified.has(c.proof.capability_id));

  if (candidates.length === 0) return null;

  const scored = candidates.map((c) => {
    const capability = verified.get(c.proof.capability_id)!;
    const overlap = workflowOverlap(c.proof, capability.capability_name, capability.company_signal);
    const basis: ProofSelectionBasis = overlap > 0 ? 'WORKFLOW_MATCH' : 'CAPABILITY_MATCH';
    return { ...c, capability, overlap, basis };
  });

  scored.sort((a, b) => {
    // 1. Workflow relevance always outranks a merely-shared capability.
    if (a.basis !== b.basis) return a.basis === 'WORKFLOW_MATCH' ? -1 : 1;
    // 2. The more specifically relevant workflow, when both are relevant.
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    // 3. Strength of OUR evidence about the company — never the proof's numbers.
    if (b.capability.fit_strength !== a.capability.fit_strength) {
      return b.capability.fit_strength - a.capability.fit_strength;
    }
    // 4. Catalog order, then id: stable and reproducible.
    if (a.order !== b.order) return a.order - b.order;
    return a.proof.id.localeCompare(b.proof.id);
  });

  const winner = scored[0];

  return {
    proof: winner.proof,
    matched_on: {
      capability_id: winner.capability.capability_id,
      capability_name: winner.capability.capability_name,
      company_signal: winner.capability.company_signal,
      fit_strength: winner.capability.fit_strength,
    },
    solution_id: solutionMatch.solution.id,
    why_this_proof: describeProofFit(winner.proof, winner.capability.capability_name, winner.basis),
    selection_basis: winner.basis,
  };
}

/** Plain sentence assembled from matched data — never generated by a model. */
function describeProofFit(
  proof: ApprovedProof,
  capabilityName: string,
  basis: ProofSelectionBasis,
): string {
  return basis === 'WORKFLOW_MATCH'
    ? `${proof.customer} is approved proof for ${proof.workflow}, the same workflow this company was verified to run (${capabilityName}).`
    : `${proof.customer} is approved proof for ${capabilityName}, the capability this company was verified to have.`;
}

/**
 * What a later phase will be allowed to show the model: the approved sentence
 * and its identifiers, and nothing it could recompose.
 *
 * Deliberately omits every raw ingredient — no metric fields, no outcome
 * fields, no separated customer/result pair. The statement is offered whole
 * so that the only correct use of it is to repeat it verbatim. Unused in
 * Phase 1; defined here so the boundary is fixed alongside the data model
 * rather than improvised later.
 */
export interface ApprovedProofContext {
  id: string;
  customer: string;
  workflow: string;
  /** Use verbatim or omit. Never paraphrase, extend or re-express. */
  approved_statement: string;
}

export function proofForPrompt(match: ProofMatch): ApprovedProofContext {
  return {
    id: match.proof.id,
    customer: match.proof.customer,
    workflow: match.proof.workflow,
    approved_statement: match.proof.approved_statement,
  };
}
