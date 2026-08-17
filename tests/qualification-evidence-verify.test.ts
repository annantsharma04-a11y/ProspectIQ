import { describe, it, expect } from 'vitest';
import { verifyEvidence } from '@/lib/qualification/verify';
import {
  applyProspectEvidenceDiscipline,
  applyEvidenceDiscipline,
  combineQualification,
  PROSPECT_INFERRED_ONLY_CEILING,
  type CompanyFit,
  type ProspectFit,
} from '@/lib/qualification/types';
import { source } from './helpers';

// Regression: the Ritesh Agarwal / PRISM run. A retry produced prospect_fit
// 85/HIGH/OBSERVED by citing two genuinely-retrieved URLs — a WEF exec bio
// and a paywalled Skift video page — neither of which says anything about
// him personally owning accounts payable, invoicing, vendor payments, or
// dispute handling. The old discipline check (`evidence.length > 0`) let
// this through because both URLs were real. verifyEvidence() is the fix:
// it requires a quote that genuinely appears in that source's own content.

const weforumBio = () =>
  source({
    url: 'https://www.weforum.org/people/ritesh-agarwal',
    canonical_url: 'https://www.weforum.org/people/ritesh-agarwal',
    title: 'Ritesh Agarwal | World Economic Forum',
    snippet: 'Founder and Group CEO, PRISM',
    fetch_status: 'scraped',
    content:
      'Ritesh Agarwal is the Founder and Group CEO of PRISM. Funded by Microsoft, Airbnb and SoftBank, PRISM operates across multiple countries.',
  });

const skiftPaywall = () =>
  source({
    url: 'https://skift.com/2025/09/22/prism-ceo-ritesh-agarwal-at-skift-global-forum-full-video',
    canonical_url: 'https://skift.com/2025/09/22/prism-ceo-ritesh-agarwal-at-skift-global-forum-full-video',
    title: 'PRISM CEO Ritesh Agarwal at Skift Global Forum (Full Video)',
    snippet: 'Watch the full video.',
    fetch_status: 'scraped',
    content: 'Subscribe to Skift Pro to access this recording and transcript. Already a member? Sign in.',
  });

const prospectRaw = (over: Partial<ProspectFit> = {}): ProspectFit => ({
  score: 85,
  classification: 'HIGH',
  role: 'Founder and Group CEO',
  seniority: 'C-suite',
  relevance_reason: 'As Group CEO he holds ultimate authority over finance and back-office operations.',
  decision_authority: 'HIGH',
  product_relevance: 'HIGH',
  why_this_person: ['Oversees global operations including finance functions.'],
  why_not_this_person: [],
  missing_information: [],
  evidence_basis: 'OBSERVED',
  evidence: [],
  ...over,
});

describe('verifyEvidence — mechanical URL + quote verification', () => {
  it('real URL + unrelated quote → rejected, not counted as observed', () => {
    const sources = [weforumBio()];
    const verified = verifyEvidence(
      [
        {
          url: 'https://www.weforum.org/people/ritesh-agarwal',
          quote: 'personally oversees accounts payable and vendor payment operations',
        },
      ],
      sources,
    );
    expect(verified).toHaveLength(0);
  });

  it('real URL + a quote genuinely present in the source → OBSERVED-eligible', () => {
    const sources = [weforumBio()];
    const verified = verifyEvidence(
      [{ url: 'https://www.weforum.org/people/ritesh-agarwal', quote: 'Founder and Group CEO of PRISM' }],
      sources,
    );
    expect(verified).toHaveLength(1);
    expect(verified[0].url).toBe('https://www.weforum.org/people/ritesh-agarwal');
  });

  it('missing URL (never retrieved this run) → not counted as evidence', () => {
    const sources = [weforumBio()];
    const verified = verifyEvidence(
      [{ url: 'https://not-retrieved.example.com/article', quote: 'Founder and Group CEO of PRISM' }],
      sources,
    );
    expect(verified).toHaveLength(0);
  });

  it('fabricated quote (real URL, but text never said this) → rejected', () => {
    // The Skift page's actual scraped content is a paywall notice — no
    // interview substance was ever retrieved, so any quote attributing
    // workflow-specific claims to it is fabricated.
    const sources = [skiftPaywall()];
    const verified = verifyEvidence(
      [
        {
          url: 'https://skift.com/2025/09/22/prism-ceo-ritesh-agarwal-at-skift-global-forum-full-video',
          quote: 'I personally review every vendor invoice and payment dispute',
        },
      ],
      sources,
    );
    expect(verified).toHaveLength(0);
  });

  it('an item missing a quote entirely is dropped, not treated as unverifiable-but-present', () => {
    const sources = [weforumBio()];
    const verified = verifyEvidence([{ url: 'https://www.weforum.org/people/ritesh-agarwal', quote: '' }], sources);
    expect(verified).toHaveLength(0);
  });

  it('an item missing a URL entirely is dropped', () => {
    const sources = [weforumBio()];
    const verified = verifyEvidence([{ url: '', quote: 'Founder and Group CEO of PRISM' }], sources);
    expect(verified).toHaveLength(0);
  });
});

describe('Ritesh Agarwal regression — corrected outcome with verified evidence', () => {
  it('the exact regression citations produce no verified evidence, so evidence_basis cannot stay OBSERVED', () => {
    const sources = [weforumBio(), skiftPaywall()];

    // What the model actually cited, now required to carry a quote. Since
    // neither source's real content ties Ritesh to the qualified workflow,
    // any quote attempting to do so fails verification — exactly the
    // failure mode the audit found.
    const rawEvidence = [
      { url: 'https://www.weforum.org/people/ritesh-agarwal', quote: 'oversees finance and vendor operations at PRISM' },
      {
        url: 'https://skift.com/2025/09/22/prism-ceo-ritesh-agarwal-at-skift-global-forum-full-video',
        quote: 'discusses PRISM\'s accounts payable and dispute resolution process',
      },
    ];

    const verified = verifyEvidence(rawEvidence, sources);
    expect(verified).toHaveLength(0);

    const fit = applyProspectEvidenceDiscipline(prospectRaw({ evidence: verified }));

    expect(fit.evidence_basis).toBe('INFERRED');
    expect(fit.score).toBeLessThanOrEqual(PROSPECT_INFERRED_ONLY_CEILING);
    expect(fit.classification).not.toBe('HIGH');
  });

  it('cannot become QUALIFIED off seniority alone, even against a genuinely strong company', () => {
    const companyFit: CompanyFit = applyEvidenceDiscipline({
      score: 82,
      classification: 'HIGH',
      industry: 'Hospitality & Travel Technology',
      company_size: '10,000+',
      relevant_workflows: ['accounts payable', 'chargebacks'],
      capability_matches: [
        {
          capability_id: 'ap_automation',
          capability_name: 'Accounts Payable Automation',
          company_signal: 'Large global portfolio generating high-volume vendor and payout workflows.',
          fit_strength: 90,
          evidence: [{ url: 'https://example.com/prism-ap-report', quote: 'PRISM processes millions of vendor invoices annually across its global portfolio.' }],
          basis: 'OBSERVED',
          reason: 'High-volume invoice processing and vendor payouts across a large portfolio.',
        },
      ],
      fit_reasons: [
        {
          reason: 'Documented high-volume vendor payment operations.',
          basis: 'OBSERVED',
          evidence: [{ url: 'https://example.com/prism-ap-report', quote: 'PRISM processes millions of vendor invoices annually across its global portfolio.' }],
        },
      ],
      missing_information: [],
      evidence_basis: 'UNKNOWN',
      evidence_adjustment: null,
    });

    const unverifiedProspect = applyProspectEvidenceDiscipline(
      prospectRaw({ evidence: verifyEvidence([], [weforumBio(), skiftPaywall()]) }),
    );

    const decision = combineQualification(unverifiedProspect, companyFit);

    expect(decision.classification).not.toBe('QUALIFIED');
    expect(decision.proceed).toBe(false);
    // Company was genuinely strong, so the right move is pointing at a
    // different, better-evidenced contact — not declining the account.
    expect(decision.suggestion).toMatch(/functional owner|decision-maker/i);
  });
});

describe('company-side evidence needed the identical fix', () => {
  const capability = (over: Partial<CompanyFit['capability_matches'][number]> = {}) => ({
    capability_id: 'kyc_kyb',
    capability_name: 'KYC / KYB onboarding and compliance',
    company_signal: 'Regulated platform verifying customers at onboarding.',
    fit_strength: 90,
    evidence: [] as CompanyFit['capability_matches'][number]['evidence'],
    basis: 'OBSERVED' as const,
    reason: 'Public information indicates substantial identity/compliance workflows.',
    ...over,
  });

  it('real URL + unrelated quote → capability match downgraded to inferred and capped', () => {
    const sources = [
      source({
        url: 'https://example.com/company-about',
        canonical_url: 'https://example.com/company-about',
        fetch_status: 'scraped',
        content: 'Acme Corp is a leading fintech company headquartered in Austin, Texas, founded in 2015.',
      }),
    ];
    const verified = verifyEvidence(
      [{ url: 'https://example.com/company-about', quote: 'runs a documented KYC verification workflow at onboarding' }],
      sources,
    );
    expect(verified).toHaveLength(0);

    const fit = applyEvidenceDiscipline({
      score: 90,
      classification: 'HIGH',
      industry: 'Fintech',
      company_size: null,
      relevant_workflows: [],
      capability_matches: [capability({ evidence: verified })],
      fit_reasons: [{ reason: 'Fintech companies typically run KYC.', basis: 'INFERRED', evidence: [] }],
      missing_information: [],
      evidence_basis: 'UNKNOWN',
      evidence_adjustment: null,
    });

    expect(fit.capability_matches[0].basis).toBe('INFERRED');
    expect(fit.evidence_basis).toBe('INFERRED');
  });

  it('real URL + a quote genuinely describing the workflow → stays OBSERVED', () => {
    const sources = [
      source({
        url: 'https://example.com/compliance-page',
        canonical_url: 'https://example.com/compliance-page',
        fetch_status: 'scraped',
        content: 'Every new customer undergoes a documented KYC verification workflow before account activation.',
      }),
    ];
    const verified = verifyEvidence(
      [{ url: 'https://example.com/compliance-page', quote: 'documented KYC verification workflow before account activation' }],
      sources,
    );
    expect(verified).toHaveLength(1);

    const fit = applyEvidenceDiscipline({
      score: 90,
      classification: 'HIGH',
      industry: 'Fintech',
      company_size: null,
      relevant_workflows: [],
      capability_matches: [capability({ evidence: verified })],
      fit_reasons: [
        {
          reason: 'Documented KYC workflow at onboarding.',
          basis: 'OBSERVED',
          evidence: verified,
        },
      ],
      missing_information: [],
      evidence_basis: 'UNKNOWN',
      evidence_adjustment: null,
    });

    expect(fit.capability_matches[0].basis).toBe('OBSERVED');
    expect(fit.evidence_basis).toBe('OBSERVED');
    expect(fit.score).toBe(90);
  });
});
