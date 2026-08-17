import { describe, it, expect } from 'vitest';
import { verifyHooks, quoteAppearsIn } from '@/lib/signals/verify';
import { validateClaims, claimStillPresent } from '@/lib/validation/factcheck';
import { scoreSignals } from '@/lib/ranking/rank';
import { signal, source } from './helpers';
import type { AnalysisClaim } from '@/lib/llm/analyze';
import type { AnalysisHook } from '@/lib/llm/analyze';

const hook = (over: Partial<AnalysisHook> = {}): AnalysisHook => ({
  signal: 'Acme raised a $40M Series B',
  why_it_matters: 'Fresh capital usually precedes finance-ops hiring.',
  category: 'funding',
  source_url: 'https://techcrunch.com/2026/05/01/acme-series-b',
  published_date: '2026-05-01',
  supporting_quote: 'Acme announced a $40M Series B led by Sequoia',
  relevance_score: 80,
  specificity_score: 90,
  confidence_score: 85,
  conflicts_with: null,
  ...over,
});

describe('quoteAppearsIn', () => {
  const body = 'Acme announced a $40M Series B led by Sequoia to scale finance operations.';

  it('matches despite punctuation and whitespace drift', () => {
    expect(quoteAppearsIn('Acme announced a $40M Series B led by Sequoia', body)).toBe(true);
    expect(quoteAppearsIn('Acme  announced   a $40M   Series B', body)).toBe(true);
  });

  it('rejects a quote that is not in the source', () => {
    expect(quoteAppearsIn('Acme is migrating its ERP to SAP next quarter', body)).toBe(false);
  });

  it('rejects quotes too short to verify', () => {
    expect(quoteAppearsIn('Acme', body)).toBe(false);
  });
});

describe('verifyHooks — the mechanical hallucination gate', () => {
  it('keeps a hook whose quote is genuinely in its cited source', () => {
    const { kept, rejected } = verifyHooks([hook()], [source()]);
    expect(kept).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it('drops a hook citing a URL that was never retrieved', () => {
    const { kept, rejected } = verifyHooks([hook({ source_url: 'https://invented.example/story' })], [source()]);
    expect(kept).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/not retrieved/i);
  });

  it('drops a hook whose supporting quote is fabricated', () => {
    const { kept, rejected } = verifyHooks(
      [hook({ supporting_quote: 'Acme confirmed it will acquire Globex for $2B in cash.' })],
      [source()],
    );
    expect(kept).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/does not appear/i);
  });

  it('overrides a model-invented date with the date the source carries', () => {
    const { kept } = verifyHooks([hook({ published_date: '2020-01-01' })], [source({ published_date: '2026-05-01' })]);
    expect(kept[0].published_date).toBe('2026-05-01');
  });

  it('clamps out-of-range scores', () => {
    const { kept } = verifyHooks([hook({ relevance_score: 999, confidence_score: -5 })], [source()]);
    expect(kept[0].relevance_score).toBe(100);
    expect(kept[0].confidence_score).toBe(0);
  });

  it('keeps the conflict marker so ranking can exclude disputed hooks', () => {
    const { kept } = verifyHooks([hook({ conflicts_with: 'Another source disagrees.' })], [source()]);
    expect(kept[0].conflicts_with).toMatch(/disagrees/);
  });
});

describe('claimStillPresent', () => {
  it('detects a surviving claim and ignores a removed one', () => {
    const text = 'Congratulations on the $40M Series B — scaling finance ops is the next challenge.';
    expect(claimStillPresent('Acme raised a $40M Series B', text)).toBe(true);
    expect(claimStillPresent('Acme acquired Globex for two billion dollars', text)).toBe(false);
  });
});

describe('validateClaims — provenance-aware', () => {
  const evidence = scoreSignals([signal()], [source()], new Date('2026-08-15'));
  const sources = [source({ fetch_status: 'scraped', content: 'Acme announced a $40M Series B led by Sequoia. ' + 'Additional retrieved page body text. '.repeat(8) })];

  const base = {
    message: 'Congrats on the $40M Series B.',
    sources,
    evidence,
    conservative: false,
    modelConfidence: 95,
  };

  const claim = (over: Partial<AnalysisClaim>): AnalysisClaim => ({
    claim: 'Acme raised a $40M Series B',
    type: 'EXTERNAL_EVENT',
    verdict: 'SUPPORTED',
    evidence_url: 'https://techcrunch.com/2026/05/01/acme-series-b',
    explanation: 'Stated in the source.',
    ...over,
  });

  it('passes a fully supported message', () => {
    const result = validateClaims({ ...base, claims: [claim({})] });
    expect(result.status).toBe('pass');
    expect(result.claims[0].verdict).toBe('SUPPORTED');
    expect(result.confidence).toBe(95);
  });

  it('marks SENDER_OFFERING as ALLOWED without third-party evidence', () => {
    const result = validateClaims({
      ...base,
      claims: [
        claim({
          claim: 'Acme automates accounts payable, chargebacks and KYC workflows',
          type: 'SENDER_OFFERING',
          evidence_url: null,
        }),
      ],
    });
    expect(result.claims[0].verdict).toBe('ALLOWED');
    expect(result.claims[0].requires_external_evidence).toBe(false);
    expect(result.status).toBe('pass');
    expect(result.confidence).toBe(95);
  });

  it('marks GENERIC_LANGUAGE as ALLOWED', () => {
    const result = validateClaims({
      ...base,
      claims: [claim({ claim: 'Open to a quick chat?', type: 'GENERIC_LANGUAGE', evidence_url: null })],
    });
    expect(result.claims[0].verdict).toBe('ALLOWED');
    expect(result.status).toBe('pass');
  });

  it.each(['PROSPECT_FACT', 'COMPANY_FACT', 'EXTERNAL_EVENT'] as const)(
    'requires evidence for %s',
    (type) => {
      const result = validateClaims({ ...base, claims: [claim({ type, evidence_url: null })] });
      expect(result.claims[0].requires_external_evidence).toBe(true);
      expect(result.claims[0].verdict).toBe('UNSUPPORTED');
    },
  );

  it('downgrades a claim citing a URL we never retrieved', () => {
    const result = validateClaims({
      ...base,
      claims: [claim({ evidence_url: 'https://not-retrieved.example/post' })],
    });
    expect(result.claims[0].verdict).toBe('UNSUPPORTED');
    expect(result.claims[0].explanation).toMatch(/not among the retrieved sources/i);
  });

  it('accepts a citation that differs only by LinkedIn country subdomain', () => {
    const profile = source({
      url: 'https://www.linkedin.com/in/example-person',
      canonical_url: 'https://www.linkedin.com/in/example-person',
      fetch_status: 'scraped',
      content: 'Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. ',
    });
    const result = validateClaims({
      ...base,
      sources: [profile],
      claims: [claim({ type: 'PROSPECT_FACT', evidence_url: 'https://in.linkedin.com/in/example-person' })],
    });
    expect(result.claims[0].verdict).toBe('SUPPORTED');
  });

  it('downgrades snippet-only evidence with no corroboration to UNCERTAIN', () => {
    const snippetOnly = source({ fetch_status: 'scrape_failed', content: null, duplicate_count: 0 });
    const result = validateClaims({ ...base, sources: [snippetOnly], claims: [claim({})] });
    expect(result.claims[0].verdict).toBe('UNCERTAIN');
    expect(result.status).toBe('revised');
  });

  it('accepts snippet evidence that is independently corroborated', () => {
    const corroborated = source({ fetch_status: 'snippet_only', content: null, duplicate_count: 2 });
    const result = validateClaims({ ...base, sources: [corroborated], claims: [claim({})] });
    expect(result.claims[0].verdict).toBe('SUPPORTED');
  });

  it('escalates to flagged when an unsupported claim survives in the message', () => {
    const result = validateClaims({
      ...base,
      message: 'Congrats on the $40M Series B. Saw you are migrating to a new ERP platform.',
      claims: [
        claim({
          claim: 'Acme is migrating to a new ERP platform',
          type: 'COMPANY_FACT',
          verdict: 'UNSUPPORTED',
          evidence_url: null,
        }),
      ],
    });
    expect(result.status).toBe('flagged');
    expect(result.confidence).toBeLessThan(95);
  });

  it('treats an unlabelled claim as an assertion needing evidence', () => {
    const result = validateClaims({
      ...base,
      claims: [claim({ type: 'NOT_A_REAL_TYPE' as never, evidence_url: null })],
    });
    expect(result.claims[0].requires_external_evidence).toBe(true);
  });

  it('flags a conservative run that asserts UNVERIFIED prospect facts', () => {
    const bad = validateClaims({
      ...base,
      conservative: true,
      claims: [claim({ type: 'COMPANY_FACT', verdict: 'UNSUPPORTED', evidence_url: null })],
    });
    expect(bad.status).toBe('flagged');

    const good = validateClaims({
      ...base,
      message: 'Hi — Acme automates AP and KYC workflows. Open to a chat?',
      conservative: true,
      claims: [
        claim({ claim: 'Acme automates AP and KYC workflows', type: 'SENDER_OFFERING', evidence_url: null }),
        claim({ claim: 'Open to a chat?', type: 'GENERIC_LANGUAGE', evidence_url: null }),
      ],
    });
    expect(good.status).toBe('pass');
  });

  it('allows a conservative message to state a verified basic from the profile', () => {
    // "You work at McKinsey" is supported by the retrieved profile; a
    // conservative draft may say it even when no research hook was found.
    const result = validateClaims({
      ...base,
      message: 'Hi Stuti — you work at McKinsey. Acme automates AP workflows. Open to a chat?',
      conservative: true,
      claims: [
        claim({ claim: 'You work at McKinsey & Company', type: 'PROSPECT_FACT', verdict: 'SUPPORTED' }),
        claim({ claim: 'Acme automates AP workflows', type: 'SENDER_OFFERING', evidence_url: null }),
      ],
    });
    expect(result.status).toBe('pass');
  });

  it('flags sensitive-topic language regardless of claim verdicts', () => {
    const result = validateClaims({
      ...base,
      message: 'Saw the news about the layoffs — wanted to reach out.',
      claims: [],
    });
    expect(result.status).toBe('flagged');
    expect(result.sensitivity_note).toMatch(/sensitive/i);
  });
});
