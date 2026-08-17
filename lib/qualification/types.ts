// Target qualification contracts.
//
// Qualification answers "should we be talking to this person about this product
// at this company?" — a separate question from "is there something interesting
// to say?". A strong news signal is not evidence of fit, and this module never
// treats it as such.

export type FitClassification = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type AuthorityLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type QualificationStatus = 'QUALIFIED' | 'BORDERLINE' | 'NOT_QUALIFIED';

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
}

/** Numeric floors. Deliberately explicit so a reviewer can see the bar. */
export const PROSPECT_FIT_FLOOR = 45;
export const COMPANY_FIT_FLOOR = 45;

const RANK: Record<FitClassification, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

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
 * Combine the two fits into a decision, in code rather than in the model.
 *
 * The rules that matter:
 *   - A weak prospect is never rescued by a strong company, and vice versa.
 *     Outreach requires both sides to stand on their own.
 *   - UNKNOWN is not failure. It means we could not establish fit, which is a
 *     reason to ask a human rather than to guess — so it lands BORDERLINE.
 *   - Only QUALIFIED proceeds to hook selection and message generation.
 */
export function combineQualification(
  prospect: ProspectFit,
  company: CompanyFit,
): Pick<TargetQualification, 'overall_fit' | 'classification' | 'reason' | 'proceed' | 'suggestion'> {
  // The weaker side dominates: this is a minimum, not an average.
  const overall = Math.min(prospect.score, company.score);

  const prospectWeak = prospect.classification === 'LOW' || prospect.score < PROSPECT_FIT_FLOOR;
  const companyWeak = company.classification === 'LOW' || company.score < COMPANY_FIT_FLOOR;
  const prospectUnknown = prospect.classification === 'UNKNOWN';
  const companyUnknown = company.classification === 'UNKNOWN';

  const suggestion =
    !prospectWeak || companyWeak
      ? null
      : 'The company looks like a plausible fit, but this person does not appear to own or influence the relevant workflows. Consider identifying a functional owner or decision-maker there instead.';

  if (prospectWeak && companyWeak) {
    return {
      overall_fit: overall,
      classification: 'NOT_QUALIFIED',
      reason:
        'Neither the prospect nor the company shows sufficient relevance to the product, so no outreach was generated.',
      proceed: false,
      suggestion: null,
    };
  }

  if (prospectWeak) {
    return {
      overall_fit: overall,
      classification: 'NOT_QUALIFIED',
      reason: `This prospect does not appear sufficiently relevant to the product's target audience. ${prospect.relevance_reason}`.trim(),
      proceed: false,
      suggestion,
    };
  }

  if (companyWeak) {
    return {
      overall_fit: overall,
      classification: 'NOT_QUALIFIED',
      reason: `Available public information does not indicate a meaningful use case for the current offering at this company. ${company.fit_reasons[0]?.reason ?? ''}`.trim(),
      proceed: false,
      suggestion: null,
    };
  }

  // Company fit resting only on inference is not a qualification. Industry
  // context can make a use case plausible, but "plausible" is a reason to check
  // with a human, not a reason to pitch.
  if (company.evidence_basis === 'INFERRED') {
    return {
      overall_fit: overall,
      classification: 'BORDERLINE',
      reason:
        'Company fit rests on inference from context rather than an observed workflow. No retrieved source shows the operations this product would serve, so the target is held for a human rather than pitched.',
      proceed: false,
      suggestion: null,
    };
  }

  // Symmetric with the company check above: decision authority and seniority
  // can make a person a PLAUSIBLE target without any source tying them to the
  // workflow itself. Above the floor is not the same as evidenced — a
  // capped-but-still-passable score must not silently combine into QUALIFIED
  // just because it cleared the numeric bar.
  if (prospect.evidence_basis === 'INFERRED') {
    return {
      overall_fit: overall,
      classification: 'BORDERLINE',
      reason:
        'Prospect fit rests on seniority and decision authority rather than an observed link between this person and the qualified workflow. No retrieved source ties them to it, so the target is held for a human rather than pitched.',
      proceed: false,
      // The company side is fine here — genuinely OBSERVED, not weak. The
      // open question is entirely "is this the right person", which is
      // exactly what points at finding a different, better-evidenced contact
      // rather than simply declining the account.
      suggestion:
        'The company looks like a plausible fit, but this person does not appear to own or influence the relevant workflows. Consider identifying a functional owner or decision-maker there instead.',
    };
  }

  // Neither side is weak, but something could not be established.
  if (prospectUnknown || companyUnknown) {
    const which = prospectUnknown && companyUnknown ? 'prospect and company' : prospectUnknown ? 'prospect' : 'company';
    return {
      overall_fit: overall,
      classification: 'BORDERLINE',
      reason: `There is some evidence of fit, but public information was insufficient to establish ${which} relevance with confidence. Held for a human to judge rather than pitching an unsupported use case.`,
      proceed: false,
      suggestion: null,
    };
  }

  // Both sides are at least MEDIUM and above the floors.
  if (RANK[prospect.classification] >= 2 && RANK[company.classification] >= 2) {
    return {
      overall_fit: overall,
      classification: 'QUALIFIED',
      reason: `${prospect.relevance_reason} ${company.fit_reasons[0]?.reason ?? ''}`.trim(),
      proceed: true,
      suggestion: null,
    };
  }

  return {
    overall_fit: overall,
    classification: 'BORDERLINE',
    reason:
      'Fit is plausible on both sides but not strong enough to pitch confidently without a human check.',
    proceed: false,
    suggestion: null,
  };
}
