// Regression test for the exact failure observed on a real run.
//
// Input:    https://www.linkedin.com/in/stuti09
// Signal:   "Stuti Sharma is a Senior Capabilities & Insights Analyst at
//            McKinsey & Company in Chandigarh."
// Citation: https://sg.linkedin.com/in/stuti09   (country subdomain)
//
// Previously: the citation did not string-match the stored profile URL, the
// legitimate profile-derived signal was rejected as "not retrieved", the run
// fell through to a conservative draft, and the sender-offering line was then
// flagged as an unverifiable claim.
//
// This test asserts the identity and claim logic are correct — it does not
// weaken verification. A genuinely uncited or misquoted signal must still fail,
// which the final cases here confirm.

import { describe, it, expect } from 'vitest';
import { verifyHooks } from '@/lib/signals/verify';
import { scoreSignals, gateHook, HOOK_THRESHOLD } from '@/lib/ranking/rank';
import { validateClaims } from '@/lib/validation/factcheck';
import type { NormalizedSource } from '@/lib/research/normalize';
import type { AnalysisHook, AnalysisClaim } from '@/lib/llm/analyze';

const PROFILE_TEXT = `LinkedIn profile (retrieved directly): https://www.linkedin.com/in/stuti09
name: Stuti Sharma
location: Chandigarh
current company: McKinsey & Company (title: Senior Capabilities & Insights Analyst)
followers: 1688
about: Capabilities and insights work spanning analytics, research and internal knowledge products.
education: Panjab University
connections: 500`;

/** The profile as the pipeline stores it: canonical www form. */
const profileSource: NormalizedSource = {
  url: 'https://www.linkedin.com/in/stuti09',
  canonical_url: 'https://www.linkedin.com/in/stuti09',
  title: 'Stuti Sharma — LinkedIn profile',
  snippet: 'Senior Capabilities & Insights Analyst at McKinsey & Company',
  source_type: 'linkedin',
  credibility: 0.85,
  published_date: null,
  providers: ['brightdata'],
  queries: [],
  categories: ['prospect_identity'],
  duplicate_count: 0,
  retrieved_at: '2026-08-16T00:00:00.000Z',
  content: PROFILE_TEXT,
  fetch_status: 'scraped',
};

/** The hook as the model returned it — citing the Singapore subdomain. */
const profileHook: AnalysisHook = {
  signal:
    'Stuti Sharma is a Senior Capabilities & Insights Analyst at McKinsey & Company in Chandigarh.',
  why_it_matters:
    'Her remit sits in capabilities and insights, where operational analytics workloads are decided.',
  category: 'other',
  source_url: 'https://sg.linkedin.com/in/stuti09',
  published_date: null,
  supporting_quote: 'current company: McKinsey & Company (title: Senior Capabilities & Insights Analyst)',
  relevance_score: 70,
  specificity_score: 75,
  confidence_score: 90,
  conflicts_with: null,
};

describe('stuti09 regression — profile-derived signal is not falsely rejected', () => {
  it('accepts a hook citing a country-subdomain LinkedIn URL', () => {
    const { kept, rejected } = verifyHooks([profileHook], [profileSource]);

    expect(rejected).toHaveLength(0);
    expect(kept).toHaveLength(1);
    expect(kept[0].signal).toContain('Senior Capabilities & Insights Analyst');
  });

  it('scores the accepted signal and makes it hook-eligible', () => {
    const { kept } = verifyHooks([profileHook], [profileSource]);
    const ranked = scoreSignals(kept, [profileSource], new Date('2026-08-16'));

    expect(ranked).toHaveLength(1);
    expect(ranked[0].composite_score).toBeGreaterThanOrEqual(HOOK_THRESHOLD);
    // Profile data was fully retrieved, so it counts as FULL evidence.
    expect(ranked[0].evidence_level).toBe('FULL');
  });

  it('lets the gate select it as the outreach hook', () => {
    const { kept } = verifyHooks([profileHook], [profileSource]);
    const ranked = scoreSignals(kept, [profileSource], new Date('2026-08-16'));
    const selection = gateHook(ranked, {
      index: 0,
      reason: 'Directly describes her current remit at McKinsey.',
      confidence: 80,
      alternatives: [],
      insufficient: false,
      insufficientReason: null,
    });

    expect(selection.selected_index).toBe(0);
    expect(selection.insufficient_evidence).toBe(false);
    expect(selection.overridden).toBe(false);
  });

  it('does not flag the sender-offering line in the resulting message', () => {
    const claims: AnalysisClaim[] = [
      {
        claim: 'Stuti Sharma is a Senior Capabilities & Insights Analyst at McKinsey & Company',
        type: 'PROSPECT_FACT',
        verdict: 'SUPPORTED',
        evidence_url: 'https://sg.linkedin.com/in/stuti09',
        explanation: 'Stated on the retrieved profile.',
      },
      {
        claim: 'Acme automates accounts payable, chargebacks and KYC workflows using AI agents',
        type: 'SENDER_OFFERING',
        verdict: 'SUPPORTED',
        evidence_url: null,
        explanation: "Describes the sender's own product.",
      },
      {
        claim: 'Would you be open to a brief chat this week?',
        type: 'GENERIC_LANGUAGE',
        verdict: 'SUPPORTED',
        evidence_url: null,
        explanation: 'Call to action.',
      },
    ];

    const result = validateClaims({
      message:
        'Hi Stuti, saw you lead capabilities and insights work at McKinsey. Acme automates accounts payable, chargebacks and KYC workflows using AI agents. Would you be open to a brief chat this week?',
      claims,
      sources: [profileSource],
      evidence: scoreSignals(verifyHooks([profileHook], [profileSource]).kept, [profileSource]),
      conservative: false,
      modelConfidence: 90,
    });

    expect(result.status).toBe('pass');
    expect(result.claims.find((c) => c.type === 'SENDER_OFFERING')?.verdict).toBe('ALLOWED');
    expect(result.claims.find((c) => c.type === 'GENERIC_LANGUAGE')?.verdict).toBe('ALLOWED');
    // The prospect fact cited a real retrieved source, via identity matching.
    expect(result.claims.find((c) => c.type === 'PROSPECT_FACT')?.verdict).toBe('SUPPORTED');
    expect(result.confidence).toBe(90);
  });
});

describe('stuti09 regression — verification is not weakened', () => {
  it('still rejects a hook citing a source that was never retrieved', () => {
    const { kept, rejected } = verifyHooks(
      [{ ...profileHook, source_url: 'https://www.linkedin.com/in/someone-entirely-different' }],
      [profileSource],
    );
    expect(kept).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/not retrieved/i);
  });

  it('still rejects a hook whose quote is not in the cited source', () => {
    const { kept, rejected } = verifyHooks(
      [{ ...profileHook, supporting_quote: 'Stuti Sharma was promoted to Partner in June 2026.' }],
      [profileSource],
    );
    expect(kept).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/does not appear/i);
  });

  it('still marks an uncited company claim UNSUPPORTED', () => {
    const result = validateClaims({
      message: 'McKinsey recently expanded its AI capabilities.',
      claims: [
        {
          claim: 'McKinsey recently expanded its AI capabilities',
          type: 'COMPANY_FACT',
          verdict: 'SUPPORTED',
          evidence_url: null,
          explanation: 'model asserted it',
        },
      ],
      sources: [profileSource],
      evidence: [],
      conservative: false,
      modelConfidence: 90,
    });

    expect(result.claims[0].verdict).toBe('UNSUPPORTED');
    expect(result.status).toBe('flagged');
  });
});
