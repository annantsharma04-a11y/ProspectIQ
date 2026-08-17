import { describe, it, expect } from 'vitest';
import {
  DIAGNOSTIC_SECTIONS,
  NEVER_PRIMARY,
  PRIMARY_KPIS,
  STRONG_EVIDENCE_RATE,
  STRONG_SUCCESS_RATE,
  milestones,
  strengthHighlights,
} from '@/lib/evaluation/presentation';
import { OVERVIEW_DEFINITIONS, PANEL_DEFINITIONS, STATIC_DEFINITIONS } from '@/lib/evaluation/definitions';
import {
  claimMetrics,
  evidenceMetrics,
  hookMetrics,
  identityMetrics,
  reliabilityMetrics,
} from '@/lib/evaluation/metrics';
import { windowFor, type EvaluationInput } from '@/lib/evaluation/types';
import type { RunRow } from '@/lib/types';

// The risk this file guards is specific: a presentation layer that flatters the
// product by quietly changing what it counts. Every assertion below exists to
// prove the split is editorial — same numbers, different position on the page.

const NOW = new Date('2026-08-17T12:00:00Z');
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const W = windowFor('30d', NOW);

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'r', user_id: 'u', prospect_id: 'p',
    status: 'ready_for_review', identity_status: 'VERIFIED', qualification_status: 'QUALIFIED',
    insufficient_evidence: false, ai_error_type: null, error: null,
    started_at: ago(1), completed_at: ago(1), created_at: ago(1),
    ...over,
  }) as RunRow;

const base = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  prospects: [{ id: 'p', created_at: ago(5) }],
  runs: [run()],
  stages: [],
  signals: [],
  drafts: [],
  proposals: [],
  hooks: [],
  sourceProviders: {},
  sourceFetchStatus: {},
  sourcesSampled: false,
  sourcesCounted: 0,
  contactCandidates: [],
  ...over,
});

describe('primary versus diagnostic selection', () => {
  it('leads with the stable, defensible metrics', () => {
    expect(PRIMARY_KPIS).toContain('run_success_rate');
    expect(PRIMARY_KPIS).toContain('evidence_backed_rate');
    expect(PRIMARY_KPIS).toContain('citation_verification');
    expect(PRIMARY_KPIS).toContain('median_runtime');
    expect(PRIMARY_KPIS).toContain('active_prospects');
    expect(PRIMARY_KPIS).toContain('research_runs');
  });

  it('never promotes the context-heavy rates to a headline card', () => {
    for (const key of NEVER_PRIMARY) {
      expect(PRIMARY_KPIS as readonly string[]).not.toContain(key);
    }
  });

  it('keeps every detailed section available under Diagnostics', () => {
    // Nothing may be dropped from the page: moved, yes; removed, no.
    for (const section of [
      'Identity', 'Qualification', 'Evidence performance', 'Hook performance',
      'Message and review', 'Claim validation', 'Failure analysis',
      'Provider performance', 'Reliability', 'Trends', 'Not measured',
      'Pipeline funnel', 'Current bottleneck', 'Volume',
    ]) {
      expect(DIAGNOSTIC_SECTIONS as readonly string[]).toContain(section);
    }
  });

  it('the demoted metrics are still computed at their original values', () => {
    const input = base({
      runs: [
        run({ id: 'a', identity_status: 'VERIFIED' }),
        run({ id: 'b', identity_status: 'PARTIAL' }),
      ],
      stages: [
        { run_id: 'a', stage_name: 'verify_identity', status: 'complete', duration_ms: 1 },
        { run_id: 'b', stage_name: 'verify_identity', status: 'complete', duration_ms: 1 },
      ] as EvaluationInput['stages'],
      hooks: [
        { run_id: 'a', selected: true, insufficient_evidence: false, rejected_candidates: 0 },
        { run_id: 'b', selected: false, insufficient_evidence: true, rejected_candidates: 0 },
      ],
    });

    // Demotion changes position, never arithmetic: 1 of 2 both ways.
    expect(identityMetrics(input, W).verificationRate).toMatchObject({ numerator: 1, denominator: 2, rate: 50 });
    expect(hookMetrics(input, W).acceptanceRate).toMatchObject({ numerator: 1, denominator: 2, rate: 50 });
  });

  it('failed runs stay in the denominators that lead the page', () => {
    const input = base({
      runs: [run({ id: 'ok' }), run({ id: 'bad', status: 'failed' })],
    });
    const r = reliabilityMetrics(input, W);
    // The failure is NOT excluded to lift the headline number.
    expect(r.successRate.denominator).toBe(2);
    expect(r.successRate.rate).toBe(50);
  });
});

describe('highlights are gated on real data', () => {
  const strong = base({
    runs: [run()],
    proposals: [{ run_id: 'r', ranked: 49, rejected: 2 }],
    signals: [{ run_id: 'r', selected_as_hook: true, supporting_quote: 'q', composite_score: 80, category: 'funding' }] as EvaluationInput['signals'],
  });

  it('claims evidence strength only when the rate supports it', () => {
    const h = strengthHighlights(strong, W);
    expect(h.some((x) => /survived deterministic evidence checking/.test(x.claim))).toBe(true);

    const weak = base({ runs: [run()], proposals: [{ run_id: 'r', ranked: 2, rejected: 20 }] });
    expect(strengthHighlights(weak, W).some((x) => /survived deterministic/.test(x.claim))).toBe(false);
  });

  it('drops the reliability claim when success falls below the bar', () => {
    const bad = base({
      runs: [run({ id: 'a', status: 'failed' }), run({ id: 'b', status: 'failed' }), run({ id: 'c' })],
    });
    expect(strengthHighlights(bad, W).some((x) => /terminal state/.test(x.claim))).toBe(false);
    expect(STRONG_SUCCESS_RATE).toBe(90);
    expect(STRONG_EVIDENCE_RATE).toBe(90);
  });

  it('labels the citation figure as enforced rather than observed', () => {
    // This is the claim most likely to be over-read in a demo: it cannot vary,
    // so it must never be presented as a measured pass rate.
    const h = strengthHighlights(strong, W).find((x) => /supporting citation/.test(x.claim));
    expect(h).toBeDefined();
    expect(h!.byConstruction).toBe(true);
    expect(h!.basis).toMatch(/enforced in code rather than observed/i);
  });

  it('always states that outreach is never sent', () => {
    const h = strengthHighlights(base(), W).find((x) => /human review/i.test(x.claim));
    expect(h).toBeDefined();
    expect(h!.claim).toMatch(/No outreach is ever sent/i);
    expect(h!.byConstruction).toBe(true);
  });

  it('uses no marketing adjectives', () => {
    const banned = /powerful|transformative|groundbreaking|revolutionary|industry-leading|cutting-edge|seamless|best-in-class/i;
    for (const h of strengthHighlights(strong, W)) {
      expect(h.claim).not.toMatch(banned);
      expect(h.basis).not.toMatch(banned);
    }
  });

  it('produces no data-derived claims from an empty window', () => {
    const h = strengthHighlights(base({ runs: [], prospects: [] }), W);
    // Only the product-behaviour claim survives; nothing is asserted about data.
    expect(h.every((x) => x.byConstruction || !/\d+%/.test(x.claim))).toBe(true);
  });
});

describe('pipeline at a glance', () => {
  it('reports real counts and never exceeds the run total', () => {
    const input = base({
      runs: [run({ id: 'a' }), run({ id: 'b' }), run({ id: 'c', status: 'failed' })],
      signals: [{ run_id: 'a', selected_as_hook: true, supporting_quote: 'q', composite_score: 80, category: 'funding' }] as EvaluationInput['signals'],
      drafts: [{ run_id: 'a', reviewer_action: null, validation_status: 'pass', claims: null, mode: 'personalized' }] as EvaluationInput['drafts'],
    });
    const m = milestones(input, W);
    expect(m[0]).toMatchObject({ label: 'Research runs', count: 3 });
    expect(m[1].count).toBe(2);
    expect(m[2].count).toBe(1);
    for (const step of m) expect(step.count).toBeLessThanOrEqual(m[0].count);
  });

  it('every milestone carries a definition', () => {
    for (const m of milestones(base(), W)) {
      expect(m.definition.length).toBeGreaterThan(20);
    }
  });

  it('says a run may legitimately end without a signal', () => {
    const m = milestones(base(), W).find((x) => /evidence-backed/i.test(x.label));
    expect(m!.definition).toMatch(/legitimately end without one/i);
  });
});

describe('info definitions', () => {
  it('every static definition is non-empty and explains a denominator or scope', () => {
    for (const [key, text] of Object.entries(STATIC_DEFINITIONS)) {
      expect(text.trim().length, `${key} is empty`).toBeGreaterThan(40);
    }
  });

  it('covers every panel that renders an icon', () => {
    for (const key of [
      'Pipeline funnel', 'Current bottleneck', 'Failure analysis', 'Volume',
      'Trends', 'Provider performance', 'Not measured', 'Pipeline at a glance',
      'What ProspectIQ does well',
    ]) {
      expect(PANEL_DEFINITIONS[key], `missing definition for ${key}`).toBeTruthy();
    }
    for (const key of ['Active prospects', 'Research runs', 'Median runtime', 'Human review']) {
      expect(OVERVIEW_DEFINITIONS[key], `missing definition for ${key}`).toBeTruthy();
    }
  });

  it('rate definitions come from the metric layer, not from this module', () => {
    // The dashboard reads Rate.definition directly, so a formula and its
    // explanation cannot drift. These must NOT be duplicated as static text.
    const input = base({
      runs: [run()],
      proposals: [{ run_id: 'r', ranked: 1, rejected: 0 }],
    });
    for (const def of [
      reliabilityMetrics(input, W).successRate.definition,
      evidenceMetrics(input, W).evidenceBackedRate.definition,
      evidenceMetrics(input, W).citationRate.definition,
      claimMetrics(input, W).passRate.definition,
    ]) {
      expect(def.length).toBeGreaterThan(40);
      expect(Object.values(STATIC_DEFINITIONS)).not.toContain(def);
    }
  });

  it('the citation definition states that it is an invariant', () => {
    const input = base({ runs: [run()] });
    expect(evidenceMetrics(input, W).citationRate.definition).toMatch(/invariant|below 100%.*bug/i);
  });
});
