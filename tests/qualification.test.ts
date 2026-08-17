import { describe, it, expect } from 'vitest';
import {
  combineQualification,
  applyEvidenceDiscipline,
  PROSPECT_FIT_FLOOR,
  COMPANY_FIT_FLOOR,
  INFERRED_ONLY_CEILING,
  UNEVIDENCED_MATCH_CEILING,
  type CapabilityMatch,
  type CompanyFit,
  type ProspectFit,
} from '@/lib/qualification/types';
import { deriveOutreachStatus } from '@/lib/qualification/outreach-status';
import type { RunRow } from '@/lib/types';
import { getSenderCapabilities, renderCapabilities } from '@/lib/generation/sender';
import { qualifyHook, gateHook, scoreSignals } from '@/lib/ranking/rank';
import { signal, source } from './helpers';

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
      evidence: ['https://example.com/report'],
      basis: 'OBSERVED',
      reason: 'Multi-entity operations imply meaningful invoice volume.',
    },
  ],
  fit_reasons: [
    {
      reason: 'Public information indicates a plausible AP automation use case.',
      basis: 'OBSERVED',
      evidence: ['https://example.com/report'],
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

  it('4. CFO + unknown company fit → BORDERLINE, held for review', () => {
    const r = combineQualification(
      prospect({ role: 'Chief Financial Officer', seniority: 'CFO' }),
      company({
        score: 50,
        classification: 'UNKNOWN',
        industry: null,
        relevant_workflows: [],
        capability_matches: [],
        fit_reasons: [],
        missing_information: ['No public information about finance operations or scale.'],
      }),
    );

    expect(r.classification).toBe('BORDERLINE');
    expect(r.proceed).toBe(false);
    expect(r.reason).toMatch(/insufficient to establish company relevance/i);
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

  it('reports both sides failing without a misleading single-cause reason', () => {
    const r = combineQualification(
      prospect({ score: 10, classification: 'LOW' }),
      company({ score: 10, classification: 'LOW' }),
    );
    expect(r.reason).toMatch(/neither the prospect nor the company/i);
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
    evidence: ['https://example.com/compliance-page'],
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
            evidence: ['https://example.com/shared-services'],
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
    expect(adjusted.evidence_adjustment).toMatch(/cited no source/i);
  });

  it('every match that keeps a high strength carries supporting evidence', () => {
    const adjusted = applyEvidenceDiscipline(
      company({
        capability_matches: [
          match({ fit_strength: 90, evidence: ['https://example.com/a'] }),
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
            evidence: ['https://example.com/zerodha-compliance'],
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
