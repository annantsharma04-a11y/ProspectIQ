// Human account decision — the one judgment the evidence cannot make.
//
// Qualification answers "does the evidence establish a fit?". For a BORDERLINE
// company the honest answer is "it does not, but it does not rule one out
// either" — and that is a commercial judgment, not an evidence problem. No
// amount of further research resolves it, so the run pauses and asks a person:
// is this account worth pursuing?
//
// What the human is deciding:
//     "This borderline account is worth pursuing."
// What the human is NOT deciding:
//     "The evidence rules no longer apply."
//
// That distinction is enforced structurally, not by convention. This module
// only ever produces a DecisionState; it never touches a score, a basis, a
// classification or an action. CONTINUED does not turn BORDERLINE into
// QUALIFIED, and every downstream gate — identity verification, candidate
// pre-verification, hook evidence, solution matching, claim validation — runs
// afterwards exactly as it does for any other run. Continuing decides that the
// pipeline may KEEP GOING; it decides nothing about what the pipeline finds.

import type { QualificationAction, TargetQualification } from './types';

/**
 * Where a run stands on the human decision.
 *
 *   NONE       this run never needed one (the company is QUALIFIED or
 *              NOT_QUALIFIED — the evidence already decided)
 *   REQUIRED   waiting on a person; no downstream work has run
 *   CONTINUED  a person judged the account worth pursuing
 *   HELD       a person stopped it here; terminal
 */
export type AccountDecisionState = 'NONE' | 'REQUIRED' | 'CONTINUED' | 'HELD';

/** The two answers a person can give. */
export type AccountDecisionChoice = 'CONTINUED' | 'HELD';

/** What CONTINUED means for this run — determined by the matrix cell, not by the user. */
export type ContinuationPath = 'OUTREACH' | 'FIND_CONTACT';

/** The persisted record. Stored inside runs.qualification (jsonb) — no migration. */
export interface AccountDecisionRecord {
  decision: AccountDecisionChoice;
  /** ISO timestamp. */
  decided_at: string;
  /** Supabase auth user id. Null only if a decision predates ownership. */
  decided_by: string | null;
}

/**
 * The matrix cells that pause for a person, and what continuing does in each.
 *
 * Only BORDERLINE-company cells with a live path forward appear here:
 *
 *   EXPLORATORY_OUTREACH            borderline company, QUALIFIED contact.
 *                                   The contact is well evidenced in their own
 *                                   right, so continuing pursues THIS person.
 *   EXPLORATORY_OUTREACH_IF_SIGNAL  borderline company, BORDERLINE contact.
 *                                   Neither side is confidently evidenced, so
 *                                   continuing looks for a better-evidenced
 *                                   contact rather than pitching this one.
 *
 * Deliberately absent:
 *   DO_NOT_CONTACT           company NOT_QUALIFIED. Never offered — a human
 *                            decision must not reach below the evidence floor.
 *   TARGET_DIRECTLY,         company QUALIFIED. The evidence already decided;
 *   VERIFY_BETTER_CONTACT,   these keep their existing behaviour untouched.
 *   FIND_BETTER_CONTACT
 *   FIND_BETTER_CONTACT_OR_HOLD  borderline company AND an unrelated contact.
 *                            Already held for a human with no candidate path,
 *                            and unchanged by this feature.
 */
const DECISION_ACTIONS: Partial<Record<QualificationAction, ContinuationPath>> = {
  EXPLORATORY_OUTREACH: 'OUTREACH',
  EXPLORATORY_OUTREACH_IF_SIGNAL: 'FIND_CONTACT',
};

/** The record a run carries, if any. */
export function accountDecisionRecord(
  q: TargetQualification | null | undefined,
): AccountDecisionRecord | null {
  return q?.human_account_decision ?? null;
}

/** True when this matrix cell asks a person before going further. */
export function needsAccountDecision(q: TargetQualification | null | undefined): boolean {
  return Boolean(q && q.action in DECISION_ACTIONS);
}

/** What continuing would do here, or null when no decision applies. */
export function continuationPath(
  q: TargetQualification | null | undefined,
): ContinuationPath | null {
  if (!q) return null;
  return DECISION_ACTIONS[q.action] ?? null;
}

/** Where this run stands. The single source of truth for UI and pipeline alike. */
export function accountDecisionState(
  q: TargetQualification | null | undefined,
): AccountDecisionState {
  if (!needsAccountDecision(q)) return 'NONE';
  return accountDecisionRecord(q)?.decision ?? 'REQUIRED';
}

/** True while a run is waiting on a person — nothing downstream may run. */
export function accountDecisionPending(q: TargetQualification | null | undefined): boolean {
  return accountDecisionState(q) === 'REQUIRED';
}

/** True when a person stopped this account. Terminal. */
export function accountHeld(q: TargetQualification | null | undefined): boolean {
  return accountDecisionState(q) === 'HELD';
}

/**
 * May this run generate outreach — signals, hook, message?
 *
 * Deliberately separate from `proceed`. `proceed` is the EVIDENCE's verdict and
 * is untouched by any human; this is the additional human gate layered on top.
 * Both must pass, and this one can only ever subtract:
 *
 *   NONE                      unchanged behaviour — the evidence decided alone
 *   CONTINUED + OUTREACH      the person pursued this contact
 *   CONTINUED + FIND_CONTACT  no — they asked for a BETTER contact, so this
 *                             run stops at discovery and the outreach happens
 *                             on the run created from the selected candidate
 *   REQUIRED / HELD           no
 */
export function outreachAllowedByDecision(q: TargetQualification | null | undefined): boolean {
  const state = accountDecisionState(q);
  if (state === 'NONE') return true;
  return state === 'CONTINUED' && continuationPath(q) === 'OUTREACH';
}

/**
 * May contact discovery run for this run, on the strength of a human decision?
 *
 * Only ever ADDS the one cell a person explicitly opened up. Discovery's own
 * whitelist (CONTACT_DISCOVERY_ACTIONS in the pipeline) is unchanged, and this
 * returns false for every run without an explicit CONTINUED on the
 * find-a-better-contact path — including every run that predates this feature.
 */
export function contactDiscoveryUnlockedByDecision(
  q: TargetQualification | null | undefined,
): boolean {
  return accountDecisionState(q) === 'CONTINUED' && continuationPath(q) === 'FIND_CONTACT';
}

/**
 * Attach a decision to a qualification result.
 *
 * Returns a NEW object and copies every existing field through untouched —
 * classification, action, scores, evidence and `proceed` all survive exactly
 * as the matrix produced them. A BORDERLINE account is still BORDERLINE after
 * a person continues it.
 */
export function withAccountDecision(
  q: TargetQualification,
  decision: AccountDecisionChoice,
  userId: string | null,
  now: Date = new Date(),
): TargetQualification {
  return {
    ...q,
    human_account_decision: {
      decision,
      decided_at: now.toISOString(),
      decided_by: userId,
    },
  };
}

/** UI copy, keyed to the path so the two cases never describe each other's action. */
export const ACCOUNT_DECISION_COPY: Record<
  ContinuationPath,
  {
    heading: string;
    body: string;
    continueLabel: string;
    continueBody: string;
    holdLabel: string;
    holdBody: string;
    heldBody: string;
    continuedBody: string;
  }
> = {
  OUTREACH: {
    heading: 'Account needs your decision',
    body: 'The company shows potential, but the available evidence does not establish a strong enough fit automatically.',
    continueLabel: 'Continue to outreach',
    continueBody:
      'Continue with this verified contact and proceed through signals, solution fit, hook selection, and message generation.',
    holdLabel: 'Hold account',
    holdBody: 'Stop here. No outreach will be generated.',
    heldBody: 'No outreach generated.',
    continuedBody:
      'Continuing with this contact. Every evidence, hook, solution and claim check still applies.',
  },
  FIND_CONTACT: {
    heading: 'Account needs your decision',
    body: 'The company is potentially relevant, but the evidence is not strong enough to proceed automatically.',
    continueLabel: 'Continue with this account',
    continueBody:
      'Find a better verified contact at this company and continue the outreach workflow.',
    holdLabel: 'Hold account',
    holdBody: 'Stop here. No contact search or outreach will be generated.',
    heldBody: 'No contact search or outreach generated.',
    continuedBody:
      'Looking for a better-evidenced contact at this company. Candidates are still pre-verified, and identity verification still runs in full after you select one.',
  },
};
