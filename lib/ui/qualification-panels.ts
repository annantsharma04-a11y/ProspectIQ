// Qualification panels — the three-way display split for Stage 8 (qualify_company).
//
// This exists because company fit and overall fit, shown as two adjacent
// numbers with no explicit label separating them, are easy to misread as the
// same statement: a QUALIFIED company (e.g. 60/100) sitting right above a
// BORDERLINE overall decision (e.g. 45/100, driven by the weaker CONTACT
// side) reads as "the company is borderline" — which is wrong, and led
// directly to "why wasn't I shown an Account Decision?" for a run where none
// was ever required.
//
// Exactly like lib/ui/decision-summary.ts, this adds no new judgment — it
// only reads companyFitState/prospectFitState (unchanged) and relabels the
// three axes (company, contact, overall) so they can never disagree with the
// Decision Summary or Account Decision panels shown elsewhere on the run
// page.

import {
  companyFitState,
  prospectFitState,
  type CompanyFit,
  type ProspectFit,
  type FitState,
  type QualificationAction,
} from '@/lib/qualification/types';

export interface FitAxis {
  state: FitState;
  score: number;
  evidenceBasis: CompanyFit['evidence_basis'];
}

export interface OverallAxis {
  /** The run's overall qualification.classification — a decision-level status, distinct from either FitState above. */
  classification: string;
  score: number;
  action: QualificationAction;
  suggestion: string | null;
  reason: string;
}

export interface QualificationPanels {
  company: FitAxis;
  contact: FitAxis;
  overall: OverallAxis;
  /**
   * True only when the company qualified on its own evidence but the overall
   * decision is still BORDERLINE because of the contact — the exact case
   * that must never surface an Account Decision prompt, since that prompt is
   * for a borderline COMPANY, not a borderline contact at a qualified one.
   */
  noAccountDecisionNeeded: boolean;
}

export function buildQualificationPanels(input: {
  company_fit: CompanyFit;
  prospect_fit: ProspectFit;
  classification: string;
  overall_fit: number;
  action: QualificationAction;
  suggestion: string | null;
  reason: string;
}): QualificationPanels {
  const companyState = companyFitState(input.company_fit);
  const contactState = prospectFitState(input.prospect_fit);

  return {
    company: {
      state: companyState,
      score: input.company_fit.score,
      evidenceBasis: input.company_fit.evidence_basis,
    },
    contact: {
      state: contactState,
      score: input.prospect_fit.score,
      evidenceBasis: input.prospect_fit.evidence_basis,
    },
    overall: {
      classification: input.classification,
      score: input.overall_fit,
      action: input.action,
      suggestion: input.suggestion,
      reason: input.reason,
    },
    noAccountDecisionNeeded: companyState === 'QUALIFIED' && input.classification === 'BORDERLINE',
  };
}
