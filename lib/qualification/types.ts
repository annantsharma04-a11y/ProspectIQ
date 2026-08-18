// Target qualification contracts.
//
// Qualification answers "should we be talking to this person about this product
// at this company?" — a separate question from "is there something interesting
// to say?". A strong news signal is not evidence of fit, and this module never
// treats it as such.

export type FitClassification = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type AuthorityLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type QualificationStatus = 'QUALIFIED' | 'BORDERLINE' | 'NOT_QUALIFIED';
/** Independent three-state summary of ONE side alone — see companyFitState/prospectFitState. */
export type FitState = 'QUALIFIED' | 'BORDERLINE' | 'NOT_QUALIFIED';

export interface ProspectFit {
  score: number;
  classification: FitClassification;
  role: string | null;
  seniority: string | null;
  relevance_reason: string;
  decision_authority: AuthorityLevel;
  /** How relevant this person is to the sender's product specifically. */
  product_relevance: FitClassification;
  why_this_person: string[];
  why_not_this_person: string[];
  missing_information: string[];
  /**
   * How product_relevance was arrived at. Mirrors CompanyFit.evidence_basis
   * for the same reason: decision authority and seniority describe the ROLE,
   * not whether this person owns the qualified workflow. "CEOs hold ultimate
   * authority" is INFERRED; a source tying this specific person to the
   * workflow (their own statement, a described responsibility, an explicit
   * mention) is OBSERVED. Only OBSERVED may drive a high score.
   */
  evidence_basis: EvidenceBasis;
  /** Verified evidence tying THIS person to the qualified workflow — see EvidenceItem. */
  evidence: EvidenceItem[];
}

/**
 * How a claim about the company was arrived at.
 *
 * The distinction matters because industry is not evidence. "They are a bank,
 * so they must do KYC" is INFERRED; a source describing their verification
 * workflow is OBSERVED. Only OBSERVED may drive a high score.
 */
export type EvidenceBasis = 'OBSERVED' | 'INFERRED' | 'UNKNOWN';

/**
 * A single piece of evidence tying a claim to a specific retrieved source.
 *
 * A URL alone only proves a source was genuinely retrieved — it says nothing
 * about whether that source's content actually supports the claim it is
 * attached to. `quote` is a verbatim excerpt the model claims appears in that
 * source; it exists so code (never the model's self-report) can mechanically
 * confirm the source really says what the citation claims, the same way
 * `AnalysisHook.supporting_quote` is verified for hooks via `quoteAppearsIn()`.
 * An item that fails that check does not count as evidence at all.
 */
export interface EvidenceItem {
  url: string;
  quote: string;
}

/** One capability matched against observed company characteristics. */
export interface CapabilityMatch {
  capability_id: string;
  capability_name: string;
  /** The workflow or operational context actually seen for this company. */
  company_signal: string;
  fit_strength: number;
  /** Verified evidence backing the observed workflow — see EvidenceItem. */
  evidence: EvidenceItem[];
  basis: EvidenceBasis;
  reason: string;
}

/** A company-fit reason, carrying how it was established. */
export interface FitReason {
  reason: string;
  basis: EvidenceBasis;
  evidence: EvidenceItem[];
}

/** Ceiling on company fit when nothing was directly observed. */
export const INFERRED_ONLY_CEILING = 55;
/** A capability match with no supporting source cannot exceed this strength. */
export const UNEVIDENCED_MATCH_CEILING = 40;

export interface CompanyFit {
  score: number;
  classification: FitClassification;
  industry: string | null;
  company_size: string | null;
  relevant_workflows: string[];
  capability_matches: CapabilityMatch[];
  fit_reasons: FitReason[];
  missing_information: string[];
  /** Strongest basis across the capability matches. */
  evidence_basis: EvidenceBasis;
  /** Set when scores were reduced because evidence was inferred or absent. */
  evidence_adjustment: string | null;
}

/**
 * The seven actions the company-state × prospect-state decision matrix can
 * select. Exists so the UI and tests switch on a fixed, exhaustive enum
 * instead of pattern-matching prose — `classification`/`reason`/`suggestion`
 * stay for human-readable display and backward compatibility, but `action`
 * is the one true record of which matrix cell produced this decision.
 */
export type QualificationAction =
  | 'TARGET_DIRECTLY'
  | 'VERIFY_BETTER_CONTACT'
  | 'FIND_BETTER_CONTACT'
  | 'EXPLORATORY_OUTREACH'
  | 'EXPLORATORY_OUTREACH_IF_SIGNAL'
  | 'FIND_BETTER_CONTACT_OR_HOLD'
  | 'DO_NOT_CONTACT';

export interface TargetQualification {
  prospect_fit: ProspectFit;
  company_fit: CompanyFit;
  overall_fit: number;
  classification: QualificationStatus;
  reason: string;
  /** True only when outreach generation may proceed. */
  proceed: boolean;
  /** Surfaced when the company fits but this person does not. */
  suggestion: string | null;
  /** Which cell of the qualification decision matrix produced this outcome. */
  action: QualificationAction;
}

/** Numeric floors. Deliberately explicit so a reviewer can see the bar. */
export const PROSPECT_FIT_FLOOR = 45;
export const COMPANY_FIT_FLOOR = 45;

/**
 * Enforce evidence discipline on company fit, in code.
 *
 * Industry is context, never proof. A model that reasons "financial services,
 * therefore KYC" produces an INFERRED match, and inference alone must not yield
 * a high score — otherwise every bank qualifies without anyone checking whether
 * the workflow is actually there.
 *
 * `m.evidence` at this point has already been through verifyEvidence() in
 * qualify.ts, which drops any item whose URL was not genuinely retrieved or
 * whose quote does not actually appear in that source — so "has evidence"
 * here means "has evidence that was mechanically confirmed to say what it
 * claims", not merely "cited a real URL".
 *
 * Two caps, both one-directional (they can only lower a score):
 *   - a capability match citing no verified source cannot exceed UNEVIDENCED_MATCH_CEILING
 *   - a company with no OBSERVED match cannot exceed INFERRED_ONLY_CEILING
 */
export function applyEvidenceDiscipline(fit: CompanyFit): CompanyFit {
  const notes: string[] = [];

  const matches = fit.capability_matches.map((m) => {
    const hasEvidence = (m.evidence ?? []).length > 0;
    const basis: EvidenceBasis = hasEvidence ? m.basis : m.basis === 'OBSERVED' ? 'INFERRED' : m.basis;

    if (m.basis === 'OBSERVED' && !hasEvidence) {
      notes.push(
        `"${m.capability_name}" was reported as observed but no cited source could be verified, so it was downgraded to inferred.`,
      );
    }

    const capped = hasEvidence
      ? m.fit_strength
      : Math.min(m.fit_strength, UNEVIDENCED_MATCH_CEILING);

    return { ...m, basis, fit_strength: capped };
  });

  const observed = matches.filter((m) => m.basis === 'OBSERVED' && m.fit_strength > 0);
  const inferred = matches.filter((m) => m.basis === 'INFERRED' && m.fit_strength > 0);

  const evidence_basis: EvidenceBasis =
    observed.length > 0 ? 'OBSERVED' : inferred.length > 0 ? 'INFERRED' : 'UNKNOWN';

  let score = fit.score;
  let classification = fit.classification;

  if (observed.length === 0 && score > INFERRED_ONLY_CEILING) {
    notes.push(
      `No directly observed workflow was evidenced, so company fit was capped at ${INFERRED_ONLY_CEILING}. Industry context alone does not establish a use case.`,
    );
    score = INFERRED_ONLY_CEILING;
  }

  // Keep the label consistent with the adjusted score.
  if (classification === 'HIGH' && score <= INFERRED_ONLY_CEILING) {
    classification = evidence_basis === 'UNKNOWN' ? 'UNKNOWN' : 'MEDIUM';
  }

  return {
    ...fit,
    score,
    classification,
    capability_matches: matches,
    evidence_basis,
    evidence_adjustment: notes.length > 0 ? notes.join(' ') : null,
  };
}

/** A prospect scored on inference alone (title, seniority, decision authority) cannot exceed this. */
export const PROSPECT_INFERRED_ONLY_CEILING = 55;

/**
 * Enforce evidence discipline on prospect fit, in code.
 *
 * The company-fit gate above exists because "financial services, therefore
 * KYC" is a guess, not a finding. The identical guess exists on the person
 * side and was, until this function, uncaught: "Chief Executive, therefore
 * ultimate decision authority, therefore an elite target" reasons from TITLE
 * to RELEVANCE with no step in between that touches evidence. A CEO's
 * decision authority is real; it is not proof they personally own accounts
 * payable, KYC, or whatever workflow the product addresses. Seniority answers
 * "could this person approve a purchase" — it does not answer "does this
 * person's remit touch the problem", and only the second question is what
 * product_relevance is supposed to measure.
 *
 * `fit.evidence` at this point has already been through verifyEvidence() in
 * qualify.ts: an item only survives if its URL was genuinely retrieved AND
 * its quote actually appears in that source's content. A citation that is
 * real but irrelevant — e.g. a generic bio page or a paywalled article with
 * no substantive content — cannot produce a verified quote and is dropped
 * here, exactly the failure mode this function exists to catch.
 *
 * One cap, one-directional (it can only lower a score): a prospect whose
 * product_relevance rests on no verified evidence tying THEM SPECIFICALLY to
 * the workflow cannot exceed PROSPECT_INFERRED_ONLY_CEILING, however senior
 * they are, however confidently the model asserts otherwise, or however many
 * real-but-unrelated URLs it attaches.
 */
export function applyProspectEvidenceDiscipline(fit: ProspectFit): ProspectFit {
  const notes: string[] = [];

  const hasEvidence = (fit.evidence ?? []).length > 0;
  // An OBSERVED claim with nothing verified is exactly as trustworthy as an
  // INFERRED one — the label without a confirmed citation is just an assertion.
  const evidence_basis: EvidenceBasis =
    hasEvidence ? fit.evidence_basis : fit.evidence_basis === 'OBSERVED' ? 'INFERRED' : fit.evidence_basis;

  if (fit.evidence_basis === 'OBSERVED' && !hasEvidence) {
    notes.push(
      'Product relevance was reported as observed but no cited source could be verified to actually support the claim, so it was downgraded to inferred.',
    );
  }

  let score = fit.score;
  let classification = fit.classification;

  if (evidence_basis !== 'OBSERVED' && score > PROSPECT_INFERRED_ONLY_CEILING) {
    notes.push(
      `No evidence ties this person specifically to the qualified workflow, so prospect fit was capped at ${PROSPECT_INFERRED_ONLY_CEILING}. Seniority and decision authority describe the role, not functional ownership.`,
    );
    score = PROSPECT_INFERRED_ONLY_CEILING;
  }

  // Keep the label consistent with the adjusted score.
  if (classification === 'HIGH' && score <= PROSPECT_INFERRED_ONLY_CEILING) {
    classification = evidence_basis === 'UNKNOWN' ? 'UNKNOWN' : 'MEDIUM';
  }

  return {
    ...fit,
    score,
    classification,
    evidence_basis,
    relevance_reason:
      notes.length > 0 ? `${fit.relevance_reason} ${notes.join(' ')}`.trim() : fit.relevance_reason,
  };
}

/**
 * Independent three-state summary of ONE side alone — company or prospect.
 *
 * QUALIFIED requires both a real score above the floor AND genuinely
 * OBSERVED evidence. Without OBSERVED evidence a side is at best BORDERLINE,
 * however high its score reads, because applyEvidenceDiscipline /
 * applyProspectEvidenceDiscipline already cap an unevidenced side at its
 * INFERRED_ONLY_CEILING before this ever runs — so "QUALIFIED" here can never
 * mean "plausible but unconfirmed" wearing a passing score. UNKNOWN
 * classification is folded into BORDERLINE for the same reason the old code
 * held it for a human: "could not establish" is not the same as "confirmed
 * fit", so it must never combine into QUALIFIED either.
 */
export function companyFitState(company: CompanyFit): FitState {
  if (company.classification === 'LOW' || company.score < COMPANY_FIT_FLOOR) return 'NOT_QUALIFIED';
  if (company.evidence_basis !== 'OBSERVED' || company.classification === 'UNKNOWN') return 'BORDERLINE';
  return 'QUALIFIED';
}

/** Prospect-side counterpart to companyFitState() — identical reasoning. */
export function prospectFitState(prospect: ProspectFit): FitState {
  if (prospect.classification === 'LOW' || prospect.score < PROSPECT_FIT_FLOOR) return 'NOT_QUALIFIED';
  if (prospect.evidence_basis !== 'OBSERVED' || prospect.classification === 'UNKNOWN') return 'BORDERLINE';
  return 'QUALIFIED';
}

/**
 * How closely this person is tied to the workflow the COMPANY qualified on.
 *
 *   STRONG      a source ties THIS person to the qualified workflow
 *   REASONABLE  senior/functional enough to be plausible, but nothing ties
 *               them to the workflow specifically
 *   WEAK        below the targeting bar, without being categorically unrelated
 *   UNRELATED   a different function entirely
 *
 * This is a strict REFINEMENT of prospectFitState(), not a second system and
 * not a replacement: STRONG ≡ QUALIFIED, REASONABLE ≡ BORDERLINE, and
 * WEAK/UNRELATED split what that function collapses into NOT_QUALIFIED. It
 * reads the same fields, applies the same floor, and changes no decision —
 * `combineQualification()`'s matrix is untouched.
 *
 * It exists because the account is the hard anchor and the person is the
 * softer signal: "wrong title at a genuinely good account" and "wrong company
 * entirely" both used to read as NOT_QUALIFIED, which told a reviewer nothing
 * about whether the ACCOUNT was still worth pursuing through a different
 * contact.
 */
export type PersonRelevance = 'STRONG' | 'REASONABLE' | 'WEAK' | 'UNRELATED';

export function personRelevance(prospect: ProspectFit): PersonRelevance {
  // A different function entirely — the model judged the role itself low-relevance.
  if (prospect.classification === 'LOW') return 'UNRELATED';
  // Below the targeting floor, but not categorically unrelated.
  if (prospect.score < PROSPECT_FIT_FLOOR) return 'WEAK';
  // Clears the floor, but nothing ties THIS person to the qualified workflow —
  // the same inference-only condition prospectFitState() calls BORDERLINE.
  if (prospect.evidence_basis !== 'OBSERVED' || prospect.classification === 'UNKNOWN') return 'REASONABLE';
  return 'STRONG';
}

const FIND_BETTER_CONTACT_SUGGESTION =
  'This person does not appear to own or influence the relevant workflows. Consider identifying a functional owner or decision-maker there instead.';

const VERIFY_BETTER_CONTACT_SUGGESTION =
  "This contact shows some relevant signal, but it isn't confirmed. Verify their connection to the qualified workflow, or consider identifying a different functional owner or decision-maker at the company.";

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Why a company landed in BORDERLINE rather than QUALIFIED — evidence-basis phrasing when a workflow was inferred, confidence phrasing when nothing could be established at all. */
function companyBorderlineReason(company: CompanyFit): string {
  return company.classification === 'UNKNOWN'
    ? 'public information was insufficient to establish company relevance with confidence'
    : 'company fit rests on inference from context rather than a directly observed workflow';
}

/** Prospect-side counterpart to companyBorderlineReason(). */
function prospectBorderlineReason(prospect: ProspectFit): string {
  return prospect.classification === 'UNKNOWN'
    ? "public information was insufficient to establish this person's relevance with confidence"
    : 'prospect fit rests on seniority and decision authority rather than an observed link to the qualified workflow';
}

/**
 * Combine the two fits into a decision, in code rather than in the model.
 *
 * A company-state × prospect-state decision matrix, each side independently
 * QUALIFIED / BORDERLINE / NOT_QUALIFIED (see companyFitState/
 * prospectFitState). BORDERLINE never means qualified — it means plausible
 * fit with insufficient confidence, and the only two cells where it still
 * permits outreach (both under a BORDERLINE company) mark it explicitly as
 * cautious and exploratory, never as a confident target.
 *
 *   Company \ Prospect   QUALIFIED              BORDERLINE                       NOT_QUALIFIED
 *   QUALIFIED            target directly         verify / find better contact    find better contact
 *   BORDERLINE           exploratory outreach     exploratory iff a verified      find better contact,
 *                                                  signal survives review          or hold
 *   NOT_QUALIFIED        do not contact           do not contact                   do not contact
 *
 * "Exploratory outreach" does not weaken evidence verification: it allows the
 * pipeline to PROCEED to signal evaluation and hook selection, but every
 * existing gate downstream — quote verification, capability evidence-backing
 * — still applies unchanged. If nothing genuinely verified survives, no hook
 * is selected and no message is drafted; the run simply lands in manual
 * review instead of being blocked at the qualification gate itself. That is
 * exactly how "only when a strong verified signal exists" is enforced for
 * the doubly-borderline cell, without qualification needing to see signals
 * it hasn't gathered yet.
 */
export function combineQualification(
  prospect: ProspectFit,
  company: CompanyFit,
): Pick<TargetQualification, 'overall_fit' | 'classification' | 'reason' | 'proceed' | 'suggestion' | 'action'> {
  // The weaker side dominates: this is a minimum, not an average.
  const overall = Math.min(prospect.score, company.score);
  const companyState = companyFitState(company);
  const prospectState = prospectFitState(prospect);

  // Company NOT_QUALIFIED dominates regardless of the prospect — there is no
  // account here to find a better contact at.
  if (companyState === 'NOT_QUALIFIED') {
    return {
      overall_fit: overall,
      classification: 'NOT_QUALIFIED',
      action: 'DO_NOT_CONTACT',
      reason: `Available public information does not indicate a meaningful use case for the current offering at this company. ${company.fit_reasons[0]?.reason ?? ''}`.trim(),
      proceed: false,
      suggestion: null,
    };
  }

  if (companyState === 'QUALIFIED') {
    if (prospectState === 'QUALIFIED') {
      return {
        overall_fit: overall,
        classification: 'QUALIFIED',
        action: 'TARGET_DIRECTLY',
        reason: `${prospect.relevance_reason} ${company.fit_reasons[0]?.reason ?? ''}`.trim(),
        proceed: true,
        suggestion: null,
      };
    }
    if (prospectState === 'BORDERLINE') {
      return {
        overall_fit: overall,
        classification: 'BORDERLINE',
        action: 'VERIFY_BETTER_CONTACT',
        reason: `${capitalize(prospectBorderlineReason(prospect))}, so the target is held for a human rather than pitched.`,
        proceed: false,
        // The company side is fine here — genuinely OBSERVED, not weak. The
        // open question is entirely "is this the right person", which is
        // exactly what points at verifying or finding a different contact
        // rather than simply declining the account.
        suggestion: VERIFY_BETTER_CONTACT_SUGGESTION,
      };
    }
    // prospectState === 'NOT_QUALIFIED'
    return {
      overall_fit: overall,
      classification: 'NOT_QUALIFIED',
      action: 'FIND_BETTER_CONTACT',
      reason: `This prospect does not appear sufficiently relevant to the product's target audience. ${prospect.relevance_reason}`.trim(),
      proceed: false,
      suggestion: FIND_BETTER_CONTACT_SUGGESTION,
    };
  }

  // companyState === 'BORDERLINE': plausible fit, insufficient confidence.
  // Never treated as qualified — but not necessarily a dead end either.
  if (prospectState === 'QUALIFIED') {
    return {
      overall_fit: overall,
      classification: 'BORDERLINE',
      action: 'EXPLORATORY_OUTREACH',
      reason: `${capitalize(companyBorderlineReason(company))}, but this person is a well-evidenced target in their own right. Proceeding cautiously: outreach stays exploratory, asks rather than assumes the workflow exists, and still requires a genuinely verified signal before any message is drafted.`,
      proceed: true,
      suggestion: null,
    };
  }
  if (prospectState === 'BORDERLINE') {
    return {
      overall_fit: overall,
      classification: 'BORDERLINE',
      action: 'EXPLORATORY_OUTREACH_IF_SIGNAL',
      reason: `Neither side is confidently evidenced — ${companyBorderlineReason(company)}, and ${prospectBorderlineReason(prospect)}. Cautious exploratory outreach is allowed only if a genuinely verified signal about this person survives review; otherwise the target is held for a human.`,
      proceed: true,
      suggestion: null,
    };
  }
  // prospectState === 'NOT_QUALIFIED', company only BORDERLINE: spending
  // effort finding a DIFFERENT contact at an unconfirmed account is
  // premature, so this holds rather than triggering a paid discovery search.
  return {
    overall_fit: overall,
    classification: 'BORDERLINE',
    action: 'FIND_BETTER_CONTACT_OR_HOLD',
    reason: `Company fit is only plausible, not confirmed — ${companyBorderlineReason(company)} — and this prospect does not appear to be the right contact either. Held for a human, who may look for a better-evidenced contact or wait for stronger company signal rather than spend outreach on an unconfirmed account.`,
    proceed: false,
    suggestion: null,
  };
}
