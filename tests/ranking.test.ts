import { describe, it, expect } from 'vitest';
import { recencyScore, scoreSignals, gateHook, HOOK_THRESHOLD, WEIGHTS } from '@/lib/ranking/rank';
import { signal, source } from './helpers';

const NOW = new Date('2026-08-15T00:00:00Z');

const proposal = (over: Partial<Parameters<typeof gateHook>[1]> = {}) => ({
  index: 0,
  reason: 'Most relevant to the finance-ops remit.',
  confidence: 88,
  alternatives: [] as { index: number; why_not: string }[],
  insufficient: false,
  insufficientReason: null as string | null,
  ...over,
});

describe('recencyScore', () => {
  it('scores fresh signals 100 and stale ones 0', () => {
    expect(recencyScore('2026-08-01', NOW)).toBe(100);
    expect(recencyScore('2024-01-01', NOW)).toBe(0);
  });

  it('decays monotonically between the bounds', () => {
    expect(recencyScore('2026-05-15', NOW)).toBeGreaterThan(recencyScore('2025-11-15', NOW));
    expect(recencyScore('2025-11-15', NOW)).toBeGreaterThan(0);
  });

  it('gives undated sources a low but non-zero score', () => {
    expect(recencyScore(null, NOW)).toBe(30);
    expect(recencyScore(null, NOW)).toBeLessThan(recencyScore('2026-08-01', NOW));
  });
});

describe('scoreSignals — requirement C (multiple signals ranked)', () => {
  it('sorts by composite and exposes every component', () => {
    const sources = [
      source({
        url: 'https://reuters.com/a', canonical_url: 'https://reuters.com/a',
        credibility: 0.9, duplicate_count: 2,
        fetch_status: 'scraped', content: 'Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. ',
      }),
      source({ url: 'https://blog.dev/b', canonical_url: 'https://blog.dev/b', credibility: 0.45 }),
    ];
    const signals = [
      signal({ source_url: 'https://blog.dev/b', published_date: '2025-01-01', relevance_score: 30, specificity_score: 20, confidence_score: 40 }),
      signal({ source_url: 'https://reuters.com/a', published_date: '2026-08-01', relevance_score: 90, specificity_score: 90, confidence_score: 90 }),
    ];

    const ranked = scoreSignals(signals, sources, NOW);
    expect(ranked[0].source_url).toBe('https://reuters.com/a');
    expect(ranked[0].composite_score).toBeGreaterThan(ranked[1].composite_score);
    expect(ranked[0].credibility_score).toBe(90);
    expect(ranked[0].corroboration_count).toBe(2);
  });

  it('weights sum to 1 so composites stay on a 0–100 scale', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    const ranked = scoreSignals(
      [signal({ published_date: '2026-08-01', relevance_score: 100, specificity_score: 100, confidence_score: 100 })],
      [source({ credibility: 1, duplicate_count: 4, fetch_status: 'scraped', content: 'Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. ' })],
      NOW,
    );
    expect(ranked[0].composite_score).toBe(100);
  });

  it('requirement E — an old signal scores below a fresh equivalent', () => {
    const [fresh] = scoreSignals([signal({ published_date: '2026-08-10' })], [source()], NOW);
    const [old] = scoreSignals([signal({ published_date: '2024-06-01' })], [source()], NOW);
    expect(fresh.composite_score).toBeGreaterThan(old.composite_score);
  });
});

describe('evidence level affects scoring', () => {
  const strongSignal = signal({ published_date: '2026-08-01', relevance_score: 90, specificity_score: 90, confidence_score: 90 });

  it('scores a fully retrieved page above the same claim from a snippet', () => {
    const [full] = scoreSignals([strongSignal], [source({ fetch_status: 'scraped', content: 'Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. ' })], NOW);
    const [snippet] = scoreSignals([strongSignal], [source({ fetch_status: 'snippet_only', content: null })], NOW);

    expect(full.evidence_level).toBe('FULL');
    expect(snippet.evidence_level).toBe('SNIPPET');
    expect(full.composite_score).toBeGreaterThan(snippet.composite_score);
  });

  it('still allows snippet-only evidence to clear the threshold when otherwise strong', () => {
    const [snippet] = scoreSignals([strongSignal], [source({ fetch_status: 'scrape_failed', content: null })], NOW);
    // Extraction failure lowers confidence; it does not disqualify the evidence.
    expect(snippet.composite_score).toBeGreaterThanOrEqual(HOOK_THRESHOLD);
  });

  it('treats a source with no usable text as UNAVAILABLE', () => {
    const [none] = scoreSignals([strongSignal], [source({ fetch_status: 'scrape_failed', content: null, snippet: '', title: '' })], NOW);
    expect(none.evidence_level).toBe('UNAVAILABLE');
    expect(none.credibility_score).toBe(0);
  });
});

describe('gateHook — deterministic gating of the model’s choice', () => {
  const strong = () => scoreSignals([signal()], [source()], NOW);

  it('accepts a valid proposal and keeps the reasoning', () => {
    const selection = gateHook(strong(), proposal());
    expect(selection.selected_index).toBe(0);
    expect(selection.insufficient_evidence).toBe(false);
    expect(selection.overridden).toBe(false);
    expect(selection.confidence).toBe(88);
  });

  it('requirement A — reports insufficient evidence when there are no signals', () => {
    const selection = gateHook([], proposal());
    expect(selection.selected_index).toBeNull();
    expect(selection.insufficient_evidence).toBe(true);
    expect(selection.overridden).toBe(false);
  });

  it('honours an explicit "insufficient" from the analysis', () => {
    const selection = gateHook(strong(), proposal({ insufficient: true, insufficientReason: 'All candidates are sensitive.' }));
    expect(selection.selected_index).toBeNull();
    expect(selection.insufficient_reason).toMatch(/sensitive/i);
  });

  it('treats a negative index as "none of these"', () => {
    const selection = gateHook(strong(), proposal({ index: -1, reason: 'nothing suitable' }));
    expect(selection.selected_index).toBeNull();
    expect(selection.insufficient_evidence).toBe(true);
  });

  it('requirement D — overrides a disputed pick', () => {
    const ranked = scoreSignals(
      [signal({ conflicts_with: 'Another source says the round never closed.' })],
      [source()],
      NOW,
    );
    const selection = gateHook(ranked, proposal());
    expect(selection.selected_index).toBeNull();
    expect(selection.overridden).toBe(true);
    expect(selection.insufficient_reason).toMatch(/disputed/i);
  });

  it('overrides a pick below the quality threshold', () => {
    const weak = scoreSignals(
      [signal({ published_date: null, relevance_score: 10, specificity_score: 10, confidence_score: 20 })],
      [source({ credibility: 0.3 })],
      NOW,
    );
    expect(weak[0].composite_score).toBeLessThan(HOOK_THRESHOLD);

    const selection = gateHook(weak, proposal());
    expect(selection.selected_index).toBeNull();
    expect(selection.overridden).toBe(true);
    expect(selection.insufficient_reason).toMatch(/threshold/i);
  });

  it('overrides an out-of-range index', () => {
    const selection = gateHook(strong(), proposal({ index: 99 }));
    expect(selection.selected_index).toBeNull();
    expect(selection.overridden).toBe(true);
    expect(selection.insufficient_reason).toMatch(/outside the candidate list/i);
  });

  it('falls through to the next QUALIFYING signal when the pick is rejected', () => {
    const ranked = scoreSignals(
      [signal({ conflicts_with: 'disputed' }), signal({ signal: 'Clean', source_url: 'https://reuters.com/c' })],
      [source(), source({ url: 'https://reuters.com/c', canonical_url: 'https://reuters.com/c' })],
      NOW,
    );
    const disputedIndex = ranked.findIndex((s) => s.conflicts_with);
    const selection = gateHook(ranked, proposal({ index: disputedIndex }));

    // It does not invent a hook, but it does keep looking down the ranked list.
    expect(selection.selected_index).not.toBeNull();
    expect(selection.selected_index).not.toBe(disputedIndex);
    expect(selection.overridden).toBe(true);
    expect(selection.rejected_candidates[0].reason).toMatch(/disputed/i);
  });

  it('reports insufficient evidence when NO candidate qualifies', () => {
    const ranked = scoreSignals(
      [signal({ conflicts_with: 'disputed' }), signal({ signal: 'Also disputed', conflicts_with: 'also disputed' })],
      [source()],
      NOW,
    );
    const selection = gateHook(ranked, proposal());
    expect(selection.selected_index).toBeNull();
    expect(selection.insufficient_evidence).toBe(true);
    expect(selection.rejected_candidates.length).toBeGreaterThan(0);
  });
});
