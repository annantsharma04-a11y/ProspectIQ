import { describe, it, expect } from 'vitest';
import {
  combineQualification,
  companyFitState,
  prospectFitState,
  applyEvidenceDiscipline,
  applyProspectEvidenceDiscipline,
  PROSPECT_FIT_FLOOR,
  COMPANY_FIT_FLOOR,
  INFERRED_ONLY_CEILING,
  UNEVIDENCED_MATCH_CEILING,
  PROSPECT_INFERRED_ONLY_CEILING,
  type CapabilityMatch,
  type CompanyFit,
  type EvidenceItem,
  type ProspectFit,
} from '@/lib/qualification/types';
import { deriveOutreachStatus } from '@/lib/qualification/outreach-status';
import type { RunRow } from '@/lib/types';
import { getSenderCapabilities, renderCapabilities } from '@/lib/generation/sender';
import { qualifyHook, gateHook, scoreSignals } from '@/lib/ranking/rank';
import { signal, source } from './helpers';

/** A verified evidence item — the discipline functions only look at `.length`, so the quote content is arbitrary here. */
const ev = (url: string, quote = 'A verified verbatim excerpt supporting the claim.'): EvidenceItem => ({ url, quote });

const prospect = (over: Partial<ProspectFit> = {}): ProspectFit => ({
  score: 80,
  classification: 'HIGH',
  role: 'VP Finance Operations',
  seniority: 'VP',
  relevance_reason: 'Owns the finance operations function, including AP.',
  decision_authority: 'HIGH',
  product_relevance: 'HIGH',
  why_this_person: ['Owns AP and reconciliation.'],
  why_not_this_person: [],
  missing_information: [],
  evidence_basis: 'OBSERVED',
  evidence: [ev('https://example.com/prospect-evidence')],
  ...over,
});

const company = (over: Partial<CompanyFit> = {}): CompanyFit => ({
  score: 78,
  classification: 'HIGH',
  industry: 'Logistics',
  company_size: '1,000+',
  relevant_workflows: ['accounts payable', 'vendor payments'],
  capability_matches: [
    {
      capability_id: 'ap_automation',
      capability_name: 'Accounts payable automation',
      company_signal: 'High vendor-payment volume across multiple entities.',
      fit_strength: 80,
      evidence: [ev('https://example.com/report')],
      basis: 'OBSERVED',
      reason: 'Multi-entity operations imply meaningful invoice volume.',
    },
  ],
  fit_reasons: [
    {
      reason: 'Public information indicates a plausible AP automation use case.',
      basis: 'OBSERVED',
      evidence: [ev('https://example.com/report')],
    },
  ],
  missing_information: [],
  evidence_basis: 'OBSERVED',
  evidence_adjustment: null,
  ...over,
});

describe('combineQualification — the outreach gate', () => {
  it('7. strong prospect + strong company → QUALIFIED and proceeds', () => {
    const r = combineQualification(prospect(), company());
    expect(r.classification).toBe('QUALIFIED');
    expect(r.proceed).toBe(true);
  });

  it('1. junior analyst at a strong-fit company → prospect fails, no outreach', () => {
    const r = combineQualification(
      prospect({
        score: 20,
        classification: 'LOW',
        role: 'Junior Analyst',
        seniority: 'Entry level',
        decision_authority: 'LOW',
        product_relevance: 'LOW',
        relevance_reason:
          'Available evidence does not indicate ownership or influence over the relevant workflows.',
      }),
      company(),
    );

    expect(r.classification).toBe('NOT_QUALIFIED');
    expect(r.proceed).toBe(false);
    expect(r.reason).toMatch(/not appear sufficiently relevant/i);
    // The company is fine, so suggest finding the right person there.
    expect(r.suggestion).toMatch(/functional owner|decision-maker/i);
  });

  it('2. senior executive at a poor-fit company → company fails, no outreach', () => {
    const r = combineQualification(
      prospect({ role: 'Chief Executive Officer', seniority: 'CEO' }),
      company({
        score: 15,
        classification: 'LOW',
        industry: 'Boutique design studio',
        relevant_workflows: [],
        capability_matches: [],
        fit_reasons: [
          { reason: 'No observable finance, payments or compliance operations at scale.', basis: 'OBSERVED', evidence: [] },
        ],
      }),
    );

    expect(r.classification).toBe('NOT_QUALIFIED');
    expect(r.proceed).toBe(false);
    expect(r.reason).toMatch(/does not indicate a meaningful use case/i);
    // Do not tell them to find another person at a company that does not fit.
    expect(r.suggestion).toBeNull();
  });

  it('3. strong company + wrong department → prospect fails', () => {
    const r = combineQualification(
      prospect({
        score: 25,
        classification: 'LOW',
        role: 'Recruiting Manager',
        seniority: 'Manager',
        decision_authority: 'LOW',
        product_relevance: 'LOW',
        relevance_reason: 'Recruiting function with no evident influence over finance workflows.',
        why_not_this_person: ['No evidence of involvement in finance or compliance operations.'],
      }),
      company(),
    );
    expect(r.classification).toBe('NOT_QUALIFIED');
    expect(r.proceed).toBe(false);
  });

  it('4. CFO + unknown company fit → BORDERLINE, but exploratory outreach is allowed (a QUALIFIED prospect is not blocked by an unconfirmed company)', () => {
    // Matrix cell: company BORDERLINE (here from UNKNOWN, not inference) ×
    // prospect QUALIFIED → EXPLORATORY_OUTREACH. Classification stays
    // BORDERLINE — never QUALIFIED — but `proceed` is true so the pipeline
    // can attempt cautious, discovery-oriented outreach rather than holding
    // a well-evidenced prospect hostage to an unconfirmed company.
    const r = combineQualification(
      prospect({ role: 'Chief Financial Officer', seniority: 'CFO' }),
      company({
        score: 50,
        classification: 'UNKNOWN',
        evidence_basis: 'UNKNOWN',
        industry: null,
        relevant_workflows: [],
        capability_matches: [],
        fit_reasons: [],
        missing_information: ['No public information about finance operations or scale.'],
      }),
    );

    expect(r.classification).toBe('BORDERLINE');
    expect(r.action).toBe('EXPLORATORY_OUTREACH');
    expect(r.proceed).toBe(true);
    expect(r.reason).toMatch(/insufficient to establish company relevance/i);
    expect(r.reason).toMatch(/exploratory/i);
    expect(r.suggestion).toBeNull();
  });

  it('6. a strong hook cannot rescue a poor fit — the gate never sees hooks', () => {
    // combineQualification takes no signal input at all: fit is decided
    // independently of whether interesting news exists.
    const r = combineQualification(
      prospect({ score: 30, classification: 'LOW' }),
      company({ score: 20, classification: 'LOW' }),
    );
    expect(r.proceed).toBe(false);
    expect(r.classification).toBe('NOT_QUALIFIED');
  });

  it('does not let a high company score compensate for a weak prospect', () => {
    const r = combineQualification(
      prospect({ score: 30, classification: 'LOW' }),
      company({ score: 100, classification: 'HIGH' }),
    );
    expect(r.proceed).toBe(false);
    // Overall is the weaker side, not an average.
    expect(r.overall_fit).toBe(30);
  });

  it('does not let a high prospect score compensate for a weak company', () => {
    const r = combineQualification(
      prospect({ score: 100, classification: 'HIGH' }),
      company({ score: 25, classification: 'LOW' }),
    );
    expect(r.proceed).toBe(false);
    expect(r.overall_fit).toBe(25);
  });

  it('9. treats UNKNOWN as "ask a human", never as confident fit or confident rejection', () => {
    const r = combineQualification(
      prospect({ score: 55, classification: 'UNKNOWN' }),
      company({ score: 60, classification: 'MEDIUM' }),
    );
    expect(r.classification).toBe('BORDERLINE');
    expect(r.proceed).toBe(false);
    expect(r.reason).toMatch(/insufficient/i);
  });

  it('qualifies a MEDIUM/MEDIUM pair that clears both floors', () => {
    const r = combineQualification(
      prospect({ score: 60, classification: 'MEDIUM' }),
      company({ score: 55, classification: 'MEDIUM' }),
    );
    expect(r.classification).toBe('QUALIFIED');
    expect(r.proceed).toBe(true);
  });

  it('fails a score below the floor even when the label says otherwise', () => {
    // A model that labels HIGH but scores 20 must not slip through.
    const r = combineQualification(
      prospect({ score: PROSPECT_FIT_FLOOR - 1, classification: 'HIGH' }),
      company(),
    );
    expect(r.proceed).toBe(false);

    const r2 = combineQualification(prospect(), company({ score: COMPANY_FIT_FLOOR - 1, classification: 'HIGH' }));
    expect(r2.proceed).toBe(false);
  });

  it('when both sides fail, the company gate dominates — matches the matrix exactly (NOT_QUALIFIED company + any prospect state → do not contact)', () => {
    // The decision matrix collapses every prospect state under a
    // NOT_QUALIFIED company into one "do not contact" row — there is no
    // separate "both failed" message, by design: a company with no use case
    // is reason enough on its own, regardless of the prospect.
    const r = combineQualification(
      prospect({ score: 10, classification: 'LOW' }),
      company({ score: 10, classification: 'LOW' }),
    );
    expect(r.action).toBe('DO_NOT_CONTACT');
    expect(r.classification).toBe('NOT_QUALIFIED');
    expect(r.reason).toMatch(/does not indicate a meaningful use case/i);
  });
});

// ─── the full company-state × prospect-state decision matrix ────────────────
//
// One test per cell, asserting `action` directly rather than pattern-matching
// prose — `action` is the exhaustive, typed record of which cell fired.
// Company/prospect fixtures are built to land in each FitState deliberately
// (never just "some score that happens to work"), and companyFitState()/
// prospectFitState() are asserted alongside combineQualification() so a
// fixture drifting out of its intended state fails loudly at the state-
// derivation step, not only at the end of the whole matrix.
//
//   Company \ Prospect   QUALIFIED                BORDERLINE                      NOT_QUALIFIED
//   QUALIFIED            TARGET_DIRECTLY          VERIFY_BETTER_CONTACT           FIND_BETTER_CONTACT
//   BORDERLINE           EXPLORATORY_OUTREACH     EXPLORATORY_OUTREACH_IF_SIGNAL  FIND_BETTER_CONTACT_OR_HOLD
//   NOT_QUALIFIED        DO_NOT_CONTACT           DO_NOT_CONTACT                  DO_NOT_CONTACT

describe('the qualification decision matrix — every cell', () => {
  // Company fixtures, one per FitState, independent of any particular prospect.
  const qualifiedCo = () => company(); // HIGH / score 78 / OBSERVED (factory default)
  const borderlineCoInferred = () =>
    applyEvidenceDiscipline(
      company({
        score: 90,
        classification: 'HIGH',
        capability_matches: [
          { capability_id: 'ap_automation', capability_name: 'AP', company_signal: 'x', fit_strength: 70, evidence: [], basis: 'INFERRED', reason: 'x' },
        ],
        fit_reasons: [{ reason: 'Plausible from context.', basis: 'INFERRED', evidence: [] }],
      }),
    );
  const borderlineCoUnknown = () =>
    company({ score: 50, classification: 'UNKNOWN', evidence_basis: 'UNKNOWN', capability_matches: [], fit_reasons: [] });
  const notQualifiedCo = () => company({ score: 20, classification: 'LOW' });

  // Prospect fixtures, one per FitState.
  const qualifiedProspect = () => prospect(); // HIGH / score 80 / OBSERVED (factory default)
  const borderlineProspectInferred = () =>
    applyProspectEvidenceDiscipline(prospect({ score: 85, classification: 'HIGH', evidence_basis: 'INFERRED', evidence: [] }));
  const notQualifiedProspect = () => prospect({ score: 20, classification: 'LOW' });

  it('company fixtures land in the intended FitState', () => {
    expect(companyFitState(qualifiedCo())).toBe('QUALIFIED');
    expect(companyFitState(borderlineCoInferred())).toBe('BORDERLINE');
    expect(companyFitState(borderlineCoUnknown())).toBe('BORDERLINE');
    expect(companyFitState(notQualifiedCo())).toBe('NOT_QUALIFIED');
  });

  it('prospect fixtures land in the intended FitState', () => {
    expect(prospectFitState(qualifiedProspect())).toBe('QUALIFIED');
    expect(prospectFitState(borderlineProspectInferred())).toBe('BORDERLINE');
    expect(prospectFitState(notQualifiedProspect())).toBe('NOT_QUALIFIED');
  });

  it('QUALIFIED company + QUALIFIED prospect → target directly', () => {
    const r = combineQualification(qualifiedProspect(), qualifiedCo());
    expect(r.action).toBe('TARGET_DIRECTLY');
    expect(r.classification).toBe('QUALIFIED');
    expect(r.proceed).toBe(true);
    expect(r.suggestion).toBeNull();
  });

  it('QUALIFIED company + BORDERLINE prospect → verify or find a better contact', () => {
    const r = combineQualification(borderlineProspectInferred(), qualifiedCo());
    expect(r.action).toBe('VERIFY_BETTER_CONTACT');
    expect(r.classification).toBe('BORDERLINE');
    expect(r.proceed).toBe(false);
    expect(r.suggestion).toMatch(/verify|functional owner|decision-maker/i);
  });

  it('QUALIFIED company + NOT_QUALIFIED prospect → find a better contact', () => {
    const r = combineQualification(notQualifiedProspect(), qualifiedCo());
    expect(r.action).toBe('FIND_BETTER_CONTACT');
    expect(r.classification).toBe('NOT_QUALIFIED');
    expect(r.proceed).toBe(false);
    expect(r.suggestion).toMatch(/functional owner|decision-maker/i);
  });

  it('BORDERLINE company + QUALIFIED prospect → cautious exploratory outreach is allowed', () => {
    const r = combineQualification(qualifiedProspect(), borderlineCoInferred());
    expect(r.action).toBe('EXPLORATORY_OUTREACH');
    // Never QUALIFIED — borderline must never mean qualified.
    expect(r.classification).toBe('BORDERLINE');
    expect(r.proceed).toBe(true);
    expect(r.suggestion).toBeNull();
    expect(r.reason).toMatch(/exploratory/i);
  });

  it('BORDERLINE company (unknown) + QUALIFIED prospect → the same exploratory action, regardless of why the company is borderline', () => {
    const r = combineQualification(qualifiedProspect(), borderlineCoUnknown());
    expect(r.action).toBe('EXPLORATORY_OUTREACH');
    expect(r.classification).toBe('BORDERLINE');
    expect(r.proceed).toBe(true);
  });

  it('BORDERLINE company + BORDERLINE prospect → exploratory outreach only if a verified signal survives review', () => {
    const r = combineQualification(borderlineProspectInferred(), borderlineCoInferred());
    expect(r.action).toBe('EXPLORATORY_OUTREACH_IF_SIGNAL');
    expect(r.classification).toBe('BORDERLINE');
    // proceed:true means the pipeline is ALLOWED to attempt it — whether a
    // message actually gets drafted still depends entirely on the existing,
    // unmodified hook-verification gate finding a genuinely verified signal.
    // That downstream gate is what enforces "only when a strong signal
    // exists" — qualification itself cannot see signals it hasn't gathered.
    expect(r.proceed).toBe(true);
    expect(r.suggestion).toBeNull();
    expect(r.reason).toMatch(/verified signal/i);
  });

  it('BORDERLINE company + NOT_QUALIFIED prospect → find a better contact, or hold (no paid discovery search triggered)', () => {
    const r = combineQualification(notQualifiedProspect(), borderlineCoInferred());
    expect(r.action).toBe('FIND_BETTER_CONTACT_OR_HOLD');
    expect(r.classification).toBe('BORDERLINE');
    expect(r.proceed).toBe(false);
    // Deliberately null: searching for a different contact at an unconfirmed
    // company is premature — this holds rather than spending on discovery.
    expect(r.suggestion).toBeNull();
  });

  it('NOT_QUALIFIED company + QUALIFIED prospect → do not contact (company gate dominates)', () => {
    const r = combineQualification(qualifiedProspect(), notQualifiedCo());
    expect(r.action).toBe('DO_NOT_CONTACT');
    expect(r.classification).toBe('NOT_QUALIFIED');
    expect(r.proceed).toBe(false);
    expect(r.suggestion).toBeNull();
  });

  it('NOT_QUALIFIED company + BORDERLINE prospect → do not contact (company gate dominates)', () => {
    const r = combineQualification(borderlineProspectInferred(), notQualifiedCo());
    expect(r.action).toBe('DO_NOT_CONTACT');
    expect(r.classification).toBe('NOT_QUALIFIED');
    expect(r.proceed).toBe(false);
  });

  it('NOT_QUALIFIED company + NOT_QUALIFIED prospect → do not contact (company gate dominates)', () => {
    const r = combineQualification(notQualifiedProspect(), notQualifiedCo());
    expect(r.action).toBe('DO_NOT_CONTACT');
    expect(r.classification).toBe('NOT_QUALIFIED');
    expect(r.proceed).toBe(false);
  });

  it('overall_fit is always the weaker score, never an average, across every cell', () => {
    const cells = [
      [qualifiedProspect(), qualifiedCo()],
      [borderlineProspectInferred(), qualifiedCo()],
      [notQualifiedProspect(), qualifiedCo()],
      [qualifiedProspect(), borderlineCoInferred()],
      [borderlineProspectInferred(), borderlineCoInferred()],
      [notQualifiedProspect(), borderlineCoInferred()],
      [qualifiedProspect(), notQualifiedCo()],
    ] as const;
    for (const [p, c] of cells) {
      const r = combineQualification(p, c);
      expect(r.overall_fit).toBe(Math.min(p.score, c.score));
    }
  });

  it('evidence verification is never weakened for exploratory outreach: an unverified prospect claim is still capped exactly as it would be for a QUALIFIED company', () => {
    // Same uncited, seniority-only claim applyProspectEvidenceDiscipline is
    // built to catch — proves the borderline-company path does not bypass it.
    const raw = prospect({
      score: 92,
      classification: 'HIGH',
      evidence_basis: 'OBSERVED', // self-reported, but...
      evidence: [], // ...nothing verified backs it
    });
    const disciplined = applyProspectEvidenceDiscipline(raw);
    expect(disciplined.evidence_basis).toBe('INFERRED');
    expect(disciplined.score).toBeLessThanOrEqual(PROSPECT_INFERRED_ONLY_CEILING);

    const r = combineQualification(disciplined, borderlineCoInferred());
    // Both sides borderline — still the conditional-signal cell, not upgraded
    // to a confident action just because the company is also uncertain.
    expect(r.action).toBe('EXPLORATORY_OUTREACH_IF_SIGNAL');
    expect(r.classification).not.toBe('QUALIFIED');
  });
});

describe('8. configured capabilities drive company matching', () => {
  it('exposes a well-formed capability set whatever is configured', () => {
    // Asserts the contract, not one deployment's product surface — the real
    // capabilities live in SENDER_CAPABILITIES, not in the repository.
    const caps = getSenderCapabilities();
    expect(caps.length).toBeGreaterThan(0);
    for (const c of caps) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.description).toBeTruthy();
      expect(c.applies_when).toBeTruthy();
    }
    // Ids must be unique, since matches are keyed by id.
    expect(new Set(caps.map((c) => c.id)).size).toBe(caps.length);
  });

  it('renders capabilities with the conditions that make them plausible', () => {
    const rendered = renderCapabilities(getSenderCapabilities());
    expect(rendered).toMatch(/Plausible when:/);
    // Every configured capability appears in the rendering.
    for (const c of getSenderCapabilities()) expect(rendered).toContain(c.id);
  });

  it('a configured capability set replaces the placeholder entirely', () => {
    process.env.SENDER_CAPABILITIES = JSON.stringify([
      { id: 'ap', name: 'AP', description: 'd', applies_when: 'w' },
      { id: 'kyc', name: 'KYC', description: 'd', applies_when: 'w' },
    ]);
    const caps = getSenderCapabilities();
    expect(caps.map((c) => c.id)).toEqual(['ap', 'kyc']);
    expect(caps.some((c) => c.id === 'example_capability')).toBe(false);
    delete process.env.SENDER_CAPABILITIES;
  });

  it('honours a configured override', () => {
    process.env.SENDER_CAPABILITIES = JSON.stringify([
      { id: 'custom', name: 'Custom thing', description: 'Does a thing.', applies_when: 'Always.' },
    ]);
    expect(getSenderCapabilities().map((c) => c.id)).toEqual(['custom']);
    delete process.env.SENDER_CAPABILITIES;
  });

  it('falls back to the configured defaults when the override is malformed', () => {
    process.env.SENDER_CAPABILITIES = 'not json';
    expect(getSenderCapabilities().length).toBeGreaterThan(0);
    delete process.env.SENDER_CAPABILITIES;
  });
});

describe('5. qualification is independent of hook availability', () => {
  it('a fully qualified target with no hook still produces no fabricated outreach', () => {
    // Qualification says proceed; the hook gate is a separate, later decision.
    const r = combineQualification(prospect(), company());
    expect(r.proceed).toBe(true);
    // gateHook with an empty ranked list is what stops outreach here — proven
    // in ranking.test.ts ("reports insufficient evidence when NO candidate
    // qualifies"). Qualification never manufactures a hook to fill the gap.
  });
});

// ─── evidence over industry ──────────────────────────────────────────────────

describe('company fit is evidence-driven, not industry-driven', () => {
  const match = (over: Partial<CapabilityMatch> = {}): CapabilityMatch => ({
    capability_id: 'kyc_kyb',
    capability_name: 'KYC / KYB onboarding and compliance',
    company_signal: 'Regulated platform verifying customers at onboarding.',
    fit_strength: 90,
    evidence: [ev('https://example.com/compliance-page')],
    basis: 'OBSERVED',
    reason: 'Public information indicates substantial identity/compliance workflows.',
    ...over,
  });

  it('1. strong industry but no workflow evidence does NOT produce a high fit', () => {
    // The model said "fintech, therefore KYC" — inference, not observation.
    const raw = company({
      score: 92,
      classification: 'HIGH',
      industry: 'Financial services',
      capability_matches: [match({ basis: 'INFERRED', evidence: [], fit_strength: 85 })],
      fit_reasons: [{ reason: 'Financial services companies typically run KYC.', basis: 'INFERRED', evidence: [] }],
    });

    const adjusted = applyEvidenceDiscipline(raw);

    expect(adjusted.score).toBeLessThanOrEqual(INFERRED_ONLY_CEILING);
    expect(adjusted.classification).not.toBe('HIGH');
    expect(adjusted.evidence_basis).toBe('INFERRED');
    expect(adjusted.evidence_adjustment).toMatch(/industry context alone/i);
    // And it therefore cannot carry a qualification on its own.
    expect(combineQualification(prospect(), adjusted).classification).not.toBe('QUALIFIED');
  });

  it('2. strong industry WITH an observed workflow can qualify', () => {
    const adjusted = applyEvidenceDiscipline(
      company({ score: 88, classification: 'HIGH', industry: 'Financial services', capability_matches: [match()] }),
    );

    expect(adjusted.score).toBe(88);
    expect(adjusted.classification).toBe('HIGH');
    expect(adjusted.evidence_basis).toBe('OBSERVED');
    expect(combineQualification(prospect(), adjusted).proceed).toBe(true);
  });

  it('3. a non-obvious industry with an observed workflow can still qualify', () => {
    // Consulting is not a stereotypical fit — the evidence decides, not the sector.
    const adjusted = applyEvidenceDiscipline(
      company({
        score: 76,
        classification: 'HIGH',
        industry: 'Management consulting',
        capability_matches: [
          match({
            capability_id: 'ap_automation',
            capability_name: 'Accounts payable automation',
            company_signal: 'Documented shared-services centre processing supplier invoices across regions.',
            basis: 'OBSERVED',
            evidence: [ev('https://example.com/shared-services')],
            fit_strength: 78,
          }),
        ],
      }),
    );

    expect(adjusted.classification).toBe('HIGH');
    expect(adjusted.evidence_basis).toBe('OBSERVED');
    expect(combineQualification(prospect(), adjusted).proceed).toBe(true);
  });

  it('4. inferred-only evidence cannot independently produce HIGH company fit', () => {
    const adjusted = applyEvidenceDiscipline(
      company({
        score: 95,
        classification: 'HIGH',
        capability_matches: [
          match({ basis: 'INFERRED', evidence: [], fit_strength: 70 }),
          match({ capability_id: 'ap_automation', basis: 'INFERRED', evidence: [], fit_strength: 65 }),
        ],
      }),
    );
    expect(adjusted.classification).toBe('MEDIUM');
    expect(adjusted.score).toBe(INFERRED_ONLY_CEILING);
  });

  it('5. an unknown workflow stays UNKNOWN and lands BORDERLINE', () => {
    const adjusted = applyEvidenceDiscipline(
      company({
        score: 70,
        classification: 'HIGH',
        capability_matches: [match({ basis: 'UNKNOWN', evidence: [], fit_strength: 10 })],
        fit_reasons: [{ reason: 'Could not establish operations.', basis: 'UNKNOWN', evidence: [] }],
      }),
    );

    expect(adjusted.evidence_basis).toBe('UNKNOWN');
    expect(adjusted.classification).toBe('UNKNOWN');
    expect(combineQualification(prospect(), adjusted).classification).toBe('BORDERLINE');
  });

  it('6. an OBSERVED match with no cited source is downgraded, not trusted', () => {
    const adjusted = applyEvidenceDiscipline(
      company({ capability_matches: [match({ basis: 'OBSERVED', evidence: [], fit_strength: 95 })] }),
    );

    expect(adjusted.capability_matches[0].basis).toBe('INFERRED');
    expect(adjusted.capability_matches[0].fit_strength).toBeLessThanOrEqual(UNEVIDENCED_MATCH_CEILING);
    expect(adjusted.evidence_adjustment).toMatch(/no cited source could be verified/i);
  });

  it('every match that keeps a high strength carries supporting evidence', () => {
    const adjusted = applyEvidenceDiscipline(
      company({
        capability_matches: [
          match({ fit_strength: 90, evidence: [ev('https://example.com/a')] }),
          match({ capability_id: 'ap_automation', fit_strength: 90, evidence: [], basis: 'INFERRED' }),
        ],
      }),
    );

    for (const m of adjusted.capability_matches) {
      if (m.fit_strength > UNEVIDENCED_MATCH_CEILING) {
        expect(m.evidence.length).toBeGreaterThan(0);
        expect(m.basis).toBe('OBSERVED');
      }
    }
  });

  it('never raises a score — the caps are one-directional', () => {
    const low = applyEvidenceDiscipline(company({ score: 30, classification: 'LOW' }));
    expect(low.score).toBe(30);
    expect(low.classification).toBe('LOW');
  });
});

// ─── regression: seniority alone must not qualify a prospect ────────────────
//
// A live retry of the same run (same person, same company, same evidence set)
// swung from prospect_fit 35/LOW to 90/HIGH between two model calls. The
// stored reasoning for the 90 case was: "As chief executive... she holds
// ultimate strategic and financial decision authority, making her an elite
// target" plus fabricated, uncited claims ("publicly champions AI-driven
// roadmaps", "background in investment banking provides direct appreciation
// for automated financial workflows"). Nothing caught it because ProspectFit
// had no evidence/citation mechanism at all — company_fit has had one
// (applyEvidenceDiscipline) since qualification was built; prospect_fit did
// not. This block is the missing half of that gate.

describe('prospect fit is evidence-driven, not seniority-driven', () => {
  it('a CEO with decision authority but no workflow evidence cannot score HIGH', () => {
    // The exact shape of the regression: HIGH decision authority, HIGH
    // product_relevance asserted from title/background alone, nothing cited.
    const raw = prospect({
      score: 90,
      classification: 'HIGH',
      role: 'Founder, Chairperson and CEO',
      seniority: 'C-suite',
      decision_authority: 'HIGH',
      product_relevance: 'HIGH',
      relevance_reason:
        'As chief executive of a multi-billion dollar omnichannel retail enterprise, she holds ultimate strategic and financial decision authority, making her an elite target for high-value enterprise finance and operational AI tooling.',
      why_this_person: [
        'Ultimate decision-making authority for enterprise technology and operational investments.',
        'Publicly champions AI-driven organizational roadmaps, efficiency, and digital transformation.',
        'Strong background in finance and investment banking provides direct appreciation for automated financial workflows.',
      ],
      evidence_basis: 'INFERRED',
      evidence: [],
    });

    const adjusted = applyProspectEvidenceDiscipline(raw);

    expect(adjusted.score).toBeLessThanOrEqual(PROSPECT_INFERRED_ONLY_CEILING);
    expect(adjusted.classification).not.toBe('HIGH');
    expect(adjusted.evidence_basis).toBe('INFERRED');
    // And decision authority alone therefore cannot carry a qualification.
    expect(combineQualification(adjusted, company()).classification).not.toBe('QUALIFIED');
  });

  it('the same person, with genuine functional-ownership evidence, CAN score HIGH', () => {
    // Not a CEO blacklist: evidence is what flips the decision either way.
    const raw = prospect({
      score: 88,
      classification: 'HIGH',
      role: 'VP Finance',
      seniority: 'VP',
      decision_authority: 'HIGH',
      product_relevance: 'HIGH',
      relevance_reason: 'Publicly described as owning the accounts payable and vendor payment function.',
      why_this_person: ['Quoted discussing the company’s invoice processing volume and AP team.'],
      evidence_basis: 'OBSERVED',
      evidence: [ev('https://example.com/vp-finance-interview')],
    });

    const adjusted = applyProspectEvidenceDiscipline(raw);

    expect(adjusted.score).toBe(88);
    expect(adjusted.classification).toBe('HIGH');
    expect(adjusted.evidence_basis).toBe('OBSERVED');
    expect(combineQualification(adjusted, company()).proceed).toBe(true);
  });

  it('an OBSERVED claim with no cited source is downgraded, not trusted', () => {
    // Mirrors the identical company-side check: the label alone is not proof.
    const adjusted = applyProspectEvidenceDiscipline(
      prospect({ score: 92, classification: 'HIGH', evidence_basis: 'OBSERVED', evidence: [] }),
    );
    expect(adjusted.evidence_basis).toBe('INFERRED');
    expect(adjusted.score).toBeLessThanOrEqual(PROSPECT_INFERRED_ONLY_CEILING);
    expect(adjusted.relevance_reason).toMatch(/no cited source could be verified/i);
  });

  it('an UNKNOWN basis is also capped, not treated as a pass', () => {
    const adjusted = applyProspectEvidenceDiscipline(
      prospect({ score: 70, classification: 'MEDIUM', evidence_basis: 'UNKNOWN', evidence: [] }),
    );
    expect(adjusted.evidence_basis).toBe('UNKNOWN');
    expect(adjusted.score).toBeLessThanOrEqual(PROSPECT_INFERRED_ONLY_CEILING);
  });

  it('never raises a score — the cap is one-directional', () => {
    const low = applyProspectEvidenceDiscipline(
      prospect({ score: 20, classification: 'LOW', evidence_basis: 'INFERRED', evidence: [] }),
    );
    expect(low.score).toBe(20);
    expect(low.classification).toBe('LOW');
  });

  it('decision authority and evidence basis are independent questions', () => {
    // A HIGH-authority person with no evidence is capped; a LOW-authority
    // person with genuine evidence is not penalised for lacking a title.
    const executive = applyProspectEvidenceDiscipline(
      prospect({ score: 85, classification: 'HIGH', decision_authority: 'HIGH', evidence_basis: 'INFERRED', evidence: [] }),
    );
    const individualContributor = applyProspectEvidenceDiscipline(
      prospect({
        score: 75,
        classification: 'HIGH',
        decision_authority: 'LOW',
        evidence_basis: 'OBSERVED',
        evidence: [ev('https://example.com/quote')],
      }),
    );
    expect(executive.score).toBeLessThanOrEqual(PROSPECT_INFERRED_ONLY_CEILING);
    expect(individualContributor.score).toBe(75);
  });
});

// ─── regression: BORDERLINE-from-inference must still offer another contact ─
//
// The Ritesh/PRISM run: company_fit 82/HIGH/OBSERVED (genuinely evidenced —
// AP automation and chargebacks both cited to real sources), prospect_fit
// capped to 55/MEDIUM/INFERRED by the discipline above (decision authority
// from being CEO, no source tying him to the workflow). combineQualification
// correctly landed BORDERLINE — but set suggestion: null, so
// findContactCandidatesStage's trigger (`!q.proceed && q.suggestion`) never
// fired and the UI never offered another contact at a company that plainly
// qualified. This is the missing wire, not a scoring change: score,
// classification and reason are asserted UNCHANGED below.

describe('a qualified company with an inference-only contact still offers another contact', () => {
  const prismCompany = (): CompanyFit =>
    company({
      score: 82,
      classification: 'HIGH',
      industry: 'Hospitality & Travel Technology',
      evidence_basis: 'OBSERVED',
      capability_matches: [
        {
          capability_id: 'ap_automation',
          capability_name: 'Accounts Payable Automation',
          company_signal: 'Large global portfolio generating high-volume vendor and payout workflows.',
          fit_strength: 90,
          evidence: [ev('https://example.com/prism-leadership')],
          basis: 'OBSERVED',
          reason: 'High-volume invoice processing and vendor payouts across a large portfolio.',
        },
      ],
    });

  const inferredOnlyCeo = (): ProspectFit =>
    prospect({
      score: 55,
      classification: 'MEDIUM',
      role: 'Founder and CEO',
      decision_authority: 'HIGH',
      product_relevance: 'MEDIUM',
      evidence_basis: 'INFERRED',
      evidence: [],
      relevance_reason:
        'Prospect fit rests on seniority and decision authority rather than an observed link between this person and the qualified workflow.',
    });

  it('sets a suggestion, so the exact scoring outcome is unchanged but no longer silent', () => {
    const r = combineQualification(inferredOnlyCeo(), prismCompany());

    // Scoring is untouched — this is the regression's own before/after.
    expect(r.classification).toBe('BORDERLINE');
    expect(r.proceed).toBe(false);
    expect(r.overall_fit).toBe(55);
    expect(r.reason).toMatch(/seniority and decision authority/i);

    // What was missing: a company this solid must point at another contact.
    expect(r.suggestion).not.toBeNull();
    expect(r.suggestion).toMatch(/functional owner|decision-maker/i);
  });

  it('the discovery trigger predicate now fires for this exact state', () => {
    const r = combineQualification(inferredOnlyCeo(), prismCompany());
    // Mirrors findContactCandidatesStage's own condition exactly.
    const applicable = Boolean(r && !r.proceed && r.suggestion);
    expect(applicable).toBe(true);
  });

  it('does NOT fire when the company itself is only inferred — instead becomes cautious exploratory outreach', () => {
    // The open question there is the COMPANY, not which contact to use —
    // finding a different person at an unconfirmed account fixes nothing, so
    // this never suggests one. Under the decision matrix, company BORDERLINE
    // × prospect BORDERLINE is EXPLORATORY_OUTREACH_IF_SIGNAL: `proceed`
    // becomes true (the pipeline may attempt a cautious signal search), but
    // classification stays BORDERLINE and no alternate contact is suggested.
    const uncertainCompany = applyEvidenceDiscipline(
      company({
        score: 92,
        classification: 'HIGH',
        capability_matches: [
          { capability_id: 'ap_automation', capability_name: 'AP', company_signal: 'x', fit_strength: 70, evidence: [], basis: 'INFERRED', reason: 'x' },
        ],
      }),
    );
    const r = combineQualification(inferredOnlyCeo(), uncertainCompany);
    expect(r.classification).toBe('BORDERLINE');
    expect(r.action).toBe('EXPLORATORY_OUTREACH_IF_SIGNAL');
    expect(r.proceed).toBe(true);
    expect(r.suggestion).toBeNull();
    // The discovery trigger predicate (find a DIFFERENT contact) still never
    // fires here — proceed is true now, so `!r.proceed` alone already rules it out.
    expect(Boolean(r && !r.proceed && r.suggestion)).toBe(false);
  });

  it('does NOT fire when the company did not qualify', () => {
    const r = combineQualification(inferredOnlyCeo(), company({ score: 20, classification: 'LOW' }));
    expect(r.classification).toBe('NOT_QUALIFIED');
    expect(r.action).toBe('DO_NOT_CONTACT');
    expect(r.suggestion).toBeNull();
  });

  it('DOES fire when relevance is UNKNOWN rather than inferred — the matrix treats both as the same BORDERLINE prospect state', () => {
    // Deliberate consolidation: the decision matrix has one BORDERLINE
    // prospect state, not a separate "inferred" vs "unknown" distinction. A
    // QUALIFIED company with an unconfirmed-either-way prospect always
    // recommends verifying or finding a better contact — "we don't know
    // enough about this person" is exactly as good a reason to check as
    // "the only evidence is their seniority".
    const r = combineQualification(
      // Above PROSPECT_FIT_FLOOR so this exercises the UNKNOWN branch
      // specifically, not the "score too low" branch above it.
      prospect({ score: 50, classification: 'UNKNOWN', evidence_basis: 'UNKNOWN', evidence: [] }),
      prismCompany(),
    );
    expect(r.classification).toBe('BORDERLINE');
    expect(r.action).toBe('VERIFY_BETTER_CONTACT');
    expect(r.proceed).toBe(false);
    expect(r.suggestion).not.toBeNull();
    expect(r.suggestion).toMatch(/functional owner|decision-maker/i);
    expect(Boolean(r && !r.proceed && r.suggestion)).toBe(true);
  });

  it('still does not fire once the prospect is genuinely qualified', () => {
    const r = combineQualification(prospect(), prismCompany());
    expect(r.classification).toBe('QUALIFIED');
    expect(r.proceed).toBe(true);
    expect(r.suggestion).toBeNull();
  });
});

// ─── qualification vs outreach status ────────────────────────────────────────

describe('7. target qualification and outreach status stay separate', () => {
  const run = (over: Partial<RunRow> = {}): RunRow =>
    ({
      status: 'needs_manual_review',
      qualification_status: 'QUALIFIED',
      ...over,
    }) as RunRow;

  it('NOT_QUALIFIED target → outreach never started', () => {
    expect(deriveOutreachStatus(run({ qualification_status: 'NOT_QUALIFIED' }))).toBe('NOT_STARTED');
  });

  it('BORDERLINE target → outreach never started', () => {
    expect(deriveOutreachStatus(run({ qualification_status: 'BORDERLINE' }))).toBe('NOT_STARTED');
  });

  it('QUALIFIED target with a finished draft → ready for review', () => {
    expect(deriveOutreachStatus(run({ status: 'ready_for_review' }))).toBe('READY_FOR_REVIEW');
  });

  it('QUALIFIED target with no verified hook → outreach needs manual review', () => {
    // The distinction the spec cares about: the target was fine, the message was not.
    expect(deriveOutreachStatus(run({ status: 'needs_manual_review' }))).toBe('NEEDS_MANUAL_REVIEW');
  });

  it('a failed or parked run is reported as skipped, not as a review decision', () => {
    expect(deriveOutreachStatus(run({ status: 'failed' }))).toBe('SKIPPED');
    expect(deriveOutreachStatus(run({ status: 'ai_analysis_pending' }))).toBe('SKIPPED');
  });

  it('reports GENERATING only while the message stages are actually running', () => {
    const stages = [{ stage_name: 'generate_message', status: 'running' }] as never;
    expect(deriveOutreachStatus(run({ status: 'running' }), stages)).toBe('GENERATING');
    expect(deriveOutreachStatus(run({ status: 'running' }), [])).toBe('NOT_STARTED');
  });
});

// ─── capability alignment: what qualified must be what we pitch ──────────────

describe('hook must align with the evidence that qualified the company', () => {
  const NOW = new Date('2026-08-17T00:00:00Z');
  const strongSource = () =>
    source({ fetch_status: 'scraped', content: 'Full retrieved page body. '.repeat(12) });

  /** Zerodha as qualification actually returned it: KYC observed, rest inferred. */
  const zerodhaFit = () =>
    applyEvidenceDiscipline(
      company({
        score: 75,
        classification: 'HIGH',
        industry: 'Financial Services / Stock Broking',
        capability_matches: [
          {
            capability_id: 'kyc_kyb',
            capability_name: 'KYC / KYB onboarding and compliance',
            company_signal: 'Regulated brokerage verifying customers at account opening.',
            fit_strength: 85,
            evidence: [ev('https://example.com/zerodha-compliance')],
            basis: 'OBSERVED',
            reason: 'Public information indicates substantial identity/compliance workflows.',
          },
          {
            capability_id: 'ap_automation',
            capability_name: 'Accounts payable automation',
            company_signal: 'Vendor payments assumed from company scale.',
            fit_strength: 75,
            evidence: [],
            basis: 'INFERRED',
            reason: 'Large companies typically have payables.',
          },
          {
            capability_id: 'chargebacks',
            capability_name: 'Chargeback and dispute handling',
            company_signal: 'Payment disputes assumed from consumer scale.',
            fit_strength: 50,
            evidence: [],
            basis: 'INFERRED',
            reason: 'Consumer platforms typically see disputes.',
          },
        ],
      }),
    );

  const observedIds = (fit: CompanyFit) =>
    new Set(
      fit.capability_matches
        .filter((m) => m.basis === 'OBSERVED' && m.evidence.length > 0)
        .map((m) => m.capability_id),
    );

  it('KYC is primary evidence; AP and chargebacks are capped and not authoritative', () => {
    const fit = zerodhaFit();
    const byId = Object.fromEntries(fit.capability_matches.map((m) => [m.capability_id, m]));

    expect(byId.kyc_kyb.basis).toBe('OBSERVED');
    expect(byId.kyc_kyb.fit_strength).toBe(85);
    expect(byId.kyc_kyb.evidence.length).toBeGreaterThan(0);

    expect(byId.ap_automation.basis).toBe('INFERRED');
    expect(byId.ap_automation.fit_strength).toBeLessThanOrEqual(UNEVIDENCED_MATCH_CEILING);
    expect(byId.chargebacks.basis).toBe('INFERRED');
    expect(byId.chargebacks.fit_strength).toBeLessThanOrEqual(UNEVIDENCED_MATCH_CEILING);

    // The observed match keeps the company qualified — the result does not change.
    expect(fit.evidence_basis).toBe('OBSERVED');
    expect(combineQualification(prospect(), fit).proceed).toBe(true);
  });

  it('rejects a hook that pitches the inferred AP use case', () => {
    const fit = zerodhaFit();
    const ranked = scoreSignals(
      [signal({ signal: 'Company scaled operations', related_capability_id: 'ap_automation' })],
      [strongSource()],
      NOW,
    );

    const verdict = qualifyHook(ranked[0], 'Founder & CEO', observedIds(fit));
    expect(verdict.qualified).toBe(false);
    expect(verdict.reason).toMatch(/only inferred|not evidenced/i);
  });

  it('accepts a hook tied to the observed KYC use case', () => {
    const fit = zerodhaFit();
    const ranked = scoreSignals(
      [signal({ signal: 'Onboarding verification volumes grew', related_capability_id: 'kyc_kyb' })],
      [strongSource()],
      NOW,
    );

    expect(qualifyHook(ranked[0], 'Founder & CEO', observedIds(fit)).qualified).toBe(true);
  });

  it('accepts a hook that assumes no use case at all', () => {
    const fit = zerodhaFit();
    const ranked = scoreSignals(
      [signal({ signal: 'He published a note on lean teams', related_capability_id: null })],
      [strongSource()],
      NOW,
    );
    expect(qualifyHook(ranked[0], 'Founder & CEO', observedIds(fit)).qualified).toBe(true);
  });

  it('falls through from an inferred-capability hook to an evidence-backed one', () => {
    const fit = zerodhaFit();
    const ranked = scoreSignals(
      [
        signal({ signal: 'AP angle', related_capability_id: 'ap_automation' }),
        signal({
          signal: 'KYC angle',
          related_capability_id: 'kyc_kyb',
          source_url: 'https://reuters.com/c',
        }),
      ],
      [
        strongSource(),
        source({ url: 'https://reuters.com/c', canonical_url: 'https://reuters.com/c', fetch_status: 'scraped', content: 'Full retrieved page body. '.repeat(12) }),
      ],
      NOW,
    );

    const selection = gateHook(
      ranked,
      {
        index: ranked.findIndex((r) => r.related_capability_id === 'ap_automation'),
        reason: 'AP looked strong',
        confidence: 80,
        alternatives: [],
        insufficient: false,
        insufficientReason: null,
      },
      'Founder & CEO',
      observedIds(fit),
    );

    expect(selection.selected_index).not.toBeNull();
    expect(ranked[selection.selected_index!].related_capability_id).toBe('kyc_kyb');
    expect(selection.rejected_candidates[0].reason).toMatch(/inferred/i);
  });

  it('holds for manual review when every candidate leans on inferred use cases', () => {
    const fit = zerodhaFit();
    const ranked = scoreSignals(
      [
        signal({ signal: 'AP angle', related_capability_id: 'ap_automation' }),
        signal({ signal: 'Chargeback angle', related_capability_id: 'chargebacks' }),
      ],
      [strongSource()],
      NOW,
    );

    const selection = gateHook(
      ranked,
      { index: 0, reason: 'x', confidence: 70, alternatives: [], insufficient: false, insufficientReason: null },
      'Founder & CEO',
      observedIds(fit),
    );

    // No fabricated fallback — it declines rather than pitching an unevidenced need.
    expect(selection.selected_index).toBeNull();
    expect(selection.insufficient_evidence).toBe(true);
    expect(selection.rejected_candidates).toHaveLength(2);
  });
});
