import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedSource } from '@/lib/research/normalize';

// End-to-end fixture for qualifyTarget() itself: callStructured is mocked so
// this exercises the REAL construction/verification wiring in qualify.ts —
// confirming the model's self-reported evidence_basis: OBSERVED is not
// trusted unless verifyEvidence() actually confirms the cited quote appears
// in a genuinely retrieved source. No live model or network calls.

const mockCallStructured = vi.fn();
vi.mock('@/lib/llm/gemini', () => ({ callStructured: (...args: unknown[]) => mockCallStructured(...args) }));

const { qualifyTarget } = await import('@/lib/qualification/qualify');
const { PROSPECT_INFERRED_ONLY_CEILING } = await import('@/lib/qualification/types');

const source = (over: Partial<NormalizedSource> = {}): NormalizedSource => ({
  url: 'https://www.weforum.org/people/ritesh-agarwal',
  canonical_url: 'https://www.weforum.org/people/ritesh-agarwal',
  title: 'Ritesh Agarwal | World Economic Forum',
  snippet: 'Founder and Group CEO, PRISM',
  source_type: 'web',
  credibility: 0.8,
  published_date: null,
  providers: ['tavily'],
  queries: [],
  categories: ['prospect_identity'],
  duplicate_count: 0,
  retrieved_at: '2026-08-17T00:00:00Z',
  content: 'Ritesh Agarwal is the Founder and Group CEO of PRISM, funded by Microsoft, Airbnb and SoftBank.',
  fetch_status: 'scraped',
  ...over,
});

const senderConfig = {
  name: 'Sender Name',
  company: 'Acme',
  value_prop: 'Automates AP and vendor payment reconciliation.',
  capabilities: [
    { id: 'ap_automation', name: 'AP automation', description: 'd', applies_when: 'w' },
  ],
};

beforeEach(() => {
  mockCallStructured.mockReset();
});

describe('qualifyTarget — evidence is mechanically verified, not self-reported', () => {
  it('a real-but-irrelevant citation cannot sustain OBSERVED or a HIGH score', async () => {
    // Mirrors the live Ritesh regression exactly: the model attaches a real,
    // genuinely-retrieved URL, but the quote it reports does not actually
    // appear in that source's content — the source is a generic bio page.
    mockCallStructured.mockResolvedValueOnce({
      data: {
        prospect_fit: {
          score: 85,
          classification: 'HIGH',
          role: 'Founder and Group CEO',
          seniority: 'C-suite',
          relevance_reason: 'Oversees global operations including finance functions.',
          decision_authority: 'HIGH',
          product_relevance: 'HIGH',
          why_this_person: ['Ultimate decision authority over enterprise operations.'],
          why_not_this_person: [],
          missing_information: [],
          evidence_basis: 'OBSERVED',
          evidence: [
            {
              url: 'https://www.weforum.org/people/ritesh-agarwal',
              quote: 'personally manages accounts payable and vendor dispute resolution',
            },
          ],
        },
        company_fit: {
          score: 82,
          classification: 'HIGH',
          industry: 'Hospitality & Travel Technology',
          company_size: '10,000+',
          relevant_workflows: ['accounts payable'],
          capability_matches: [],
          fit_reasons: [{ reason: 'x', basis: 'INFERRED', evidence: [] }],
          missing_information: [],
        },
      },
      meta: { model: 'test', used_fallback_model: false, purpose: 'qualify_target', duration_ms: 1, attempts: 1, total_tokens: null },
    });

    const result = await qualifyTarget({
      profile: null,
      profileAccessNote: 'not fetched',
      sources: [source()],
      prospectName: 'Ritesh Agarwal',
      role: 'Founder and Group CEO',
      company: 'PRISM',
      sender: senderConfig,
    });

    expect(result.prospect_fit.evidence).toHaveLength(0);
    expect(result.prospect_fit.evidence_basis).toBe('INFERRED');
    expect(result.prospect_fit.score).toBeLessThanOrEqual(PROSPECT_INFERRED_ONLY_CEILING);
    expect(result.prospect_fit.classification).not.toBe('HIGH');
  });

  it('a citation whose quote genuinely appears in the source is trusted and can sustain HIGH', async () => {
    mockCallStructured.mockResolvedValueOnce({
      data: {
        prospect_fit: {
          score: 85,
          classification: 'HIGH',
          role: 'VP Finance',
          seniority: 'VP',
          relevance_reason: 'Publicly described as owning accounts payable operations.',
          decision_authority: 'HIGH',
          product_relevance: 'HIGH',
          why_this_person: ['Quoted discussing invoice volume.'],
          why_not_this_person: [],
          missing_information: [],
          evidence_basis: 'OBSERVED',
          evidence: [
            {
              url: 'https://www.weforum.org/people/ritesh-agarwal',
              quote: 'Founder and Group CEO of PRISM',
            },
          ],
        },
        company_fit: {
          score: 82,
          classification: 'HIGH',
          industry: 'Hospitality & Travel Technology',
          company_size: '10,000+',
          relevant_workflows: ['accounts payable'],
          capability_matches: [],
          fit_reasons: [{ reason: 'x', basis: 'INFERRED', evidence: [] }],
          missing_information: [],
        },
      },
      meta: { model: 'test', used_fallback_model: false, purpose: 'qualify_target', duration_ms: 1, attempts: 1, total_tokens: null },
    });

    const result = await qualifyTarget({
      profile: null,
      profileAccessNote: 'not fetched',
      sources: [source()],
      prospectName: 'Ritesh Agarwal',
      role: 'Founder and Group CEO',
      company: 'PRISM',
      sender: senderConfig,
    });

    expect(result.prospect_fit.evidence).toHaveLength(1);
    expect(result.prospect_fit.evidence_basis).toBe('OBSERVED');
    expect(result.prospect_fit.score).toBe(85);
    expect(result.prospect_fit.classification).toBe('HIGH');
  });
});
