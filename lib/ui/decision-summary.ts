// Decision Summary — the TL;DR shown at the top of a run: is the account
// qualified, is the contact qualified, what should happen next, and why.
//
// Every field here is read from data qualification already computed
// (lib/qualification/types.ts) — companyFitState/prospectFitState for the two
// independent statuses, and the matrix's own `action`/`reason` for the
// recommendation. This module adds no new judgment; it only selects and
// relabels what already exists, so the summary can never disagree with the
// full Target Qualification panel below it.

import type { RunRow } from '@/lib/types';
import {
  companyFitState,
  personRelevance,
  prospectFitState,
  type FitState,
  type PersonRelevance,
  type QualificationAction,
} from '@/lib/qualification/types';
import type { StatusTone } from '@/components/StatusBadge';

/** The five canonical actions of the product's decision matrix. */
export type DecisionAction =
  | 'TARGET DIRECTLY'
  | 'VERIFY BETTER CONTACT'
  | 'FIND BETTER CONTACT'
  | 'EXPLORATORY OUTREACH'
  | 'DO NOT CONTACT';

/**
 * The qualification matrix (lib/qualification/types.ts combineQualification)
 * actually tracks seven cells — two are finer-grained refinements of a
 * canonical action (a BORDERLINE-company "hold" is still "find a better
 * contact, or wait"; an "only if a signal survives" exploratory case is
 * still "exploratory outreach"). This maps every cell onto the five actions
 * the decision summary is specified to show, without altering the
 * underlying `action` value or its reason anywhere else in the app.
 */
const DECISION_ACTION: Record<QualificationAction, DecisionAction> = {
  TARGET_DIRECTLY: 'TARGET DIRECTLY',
  VERIFY_BETTER_CONTACT: 'VERIFY BETTER CONTACT',
  FIND_BETTER_CONTACT: 'FIND BETTER CONTACT',
  FIND_BETTER_CONTACT_OR_HOLD: 'FIND BETTER CONTACT',
  EXPLORATORY_OUTREACH: 'EXPLORATORY OUTREACH',
  EXPLORATORY_OUTREACH_IF_SIGNAL: 'EXPLORATORY OUTREACH',
  DO_NOT_CONTACT: 'DO NOT CONTACT',
};

/** Shared tone mapping for the five actions — one place, every consumer (DecisionSummary, the homepage command center) renders the same colors for the same action. */
export const ACTION_TONE: Record<DecisionAction, StatusTone> = {
  'TARGET DIRECTLY': 'emerald',
  'VERIFY BETTER CONTACT': 'amber',
  'FIND BETTER CONTACT': 'amber',
  'EXPLORATORY OUTREACH': 'accent',
  'DO NOT CONTACT': 'neutral',
};

export interface DecisionSummaryData {
  accountStatus: FitState;
  contactStatus: FitState;
  /**
   * How closely the submitted person is tied to the qualified workflow —
   * finer-grained than `contactStatus`, which collapses "wrong title at a good
   * account" and "wrong company entirely" into one NOT_QUALIFIED.
   *
   * The account is the hard anchor; this is the softer signal. It never
   * changes `accountStatus` or `action`, and it cannot qualify a company.
   */
  personRelevance: PersonRelevance;
  action: DecisionAction;
  /** The same evidence-based reason shown in the full qualification panel. */
  reason: string;
}

/** Null before qualification has run (research still in progress, or the run failed earlier). */
export function buildDecisionSummary(run: Pick<RunRow, 'qualification'>): DecisionSummaryData | null {
  const q = run.qualification;
  if (!q) return null;

  return {
    accountStatus: companyFitState(q.company_fit),
    contactStatus: prospectFitState(q.prospect_fit),
    personRelevance: personRelevance(q.prospect_fit),
    action: DECISION_ACTION[q.action],
    reason: q.reason,
  };
}
