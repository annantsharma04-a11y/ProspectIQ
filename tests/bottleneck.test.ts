import { describe, it, expect } from 'vitest';
import {
  identifyBottleneck,
  MATERIAL_SHARE,
  WEAK_EVIDENCE_RATE,
  SLOW_MEDIAN_MS,
} from '@/lib/evaluation/bottleneck';
import { windowFor, type EvaluationInput } from '@/lib/evaluation/types';
import type { RunRow } from '@/lib/types';

// The bottleneck line is the most quotable thing on the dashboard, so the rule
// behind it has to be pinned. The failure mode to guard against is confident
// attribution: naming a bottleneck from a one-run difference, or blaming a
// later stage for a loss that actually happened earlier.

const NOW = new Date('2026-08-17T12:00:00Z');
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const W = windowFor('30d', NOW);

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'r',
    user_id: 'u',
    prospect_id: 'p',
    status: 'ready_for_review',
    identity_status: 'VERIFIED',
    qualification_status: 'QUALIFIED',
    insufficient_evidence: false,
    ai_error_type: null,
    error: null,
    started_at: ago(1),
    completed_at: ago(1),
    created_at: ago(1),
    ...over,
  }) as RunRow;

const base = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  prospects: [],
  runs: [],
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

const stage = (run_id: string, stage_name: string, duration_ms: number | null = 1000) =>
  ({ run_id, stage_name, status: 'complete', duration_ms }) as EvaluationInput['stages'][number];

/**
 * Build n runs where the first `through` of them progressed to each named
 * stage, so a funnel with a specific shape can be constructed directly.
 */
function pipeline(counts: {
  submitted: number;
  validated: number;
  identity: number;
  research: number;
  qualification: number;
  signals: number;
  drafts?: number;
}): EvaluationInput {
  const runs: RunRow[] = [];
  const stages: EvaluationInput['stages'] = [];
  const signals: EvaluationInput['signals'] = [];
  const drafts: EvaluationInput['drafts'] = [];

  for (let i = 0; i < counts.submitted; i++) {
    const id = `r${i}`;
    runs.push(run({ id, identity_status: i < counts.identity ? 'VERIFIED' : 'PARTIAL' }));
    if (i < counts.validated) stages.push(stage(id, 'validate_input'));
    if (i < counts.identity) stages.push(stage(id, 'research_prospect'));
    if (i < counts.research) stages.push(stage(id, 'research_company'));
    if (i < counts.qualification) stages.push(stage(id, 'collect_signals'));
    if (i < counts.signals) {
      signals.push({
        run_id: id, selected_as_hook: true, supporting_quote: 'q', composite_score: 80, category: 'funding',
      } as EvaluationInput['signals'][number]);
    }
    if (i < (counts.drafts ?? counts.signals)) {
      drafts.push({
        run_id: id, reviewer_action: null, validation_status: 'pass', claims: null, mode: 'personalized',
      } as EvaluationInput['drafts'][number]);
    }
  }
  return base({ runs, stages, signals, drafts });
}

describe('the largest funnel loss is named', () => {
  it('identity, when that is where most runs are lost', () => {
    // 100 → 100 → 60 → 58 → 56 → 54: identity loses 40, nothing else loses much.
    const input = pipeline({
      submitted: 100, validated: 100, identity: 60, research: 58, qualification: 56, signals: 54,
    });
    const b = identifyBottleneck(input, W);
    expect(b.kind).toBe('identity');
    expect(b.headline).toMatch(/identity resolution/i);
    expect(b.lost).toBe(40);
    expect(b.share).toBe(40);
    expect(b.why).toMatch(/40 of 100|did not reach VERIFIED/i);
  });

  it('qualification, when the drop is concentrated there', () => {
    const input = pipeline({
      submitted: 100, validated: 100, identity: 96, research: 94, qualification: 50, signals: 48,
    });
    const b = identifyBottleneck(input, W);
    expect(b.kind).toBe('qualification');
    expect(b.headline).toMatch(/qualification/i);
    expect(b.lost).toBe(44);
  });

  it('evidence, when qualified runs produce no verified signal', () => {
    const input = pipeline({
      submitted: 100, validated: 100, identity: 96, research: 94, qualification: 92, signals: 40,
    });
    const b = identifyBottleneck(input, W);
    expect(b.kind).toBe('evidence');
    expect(b.lost).toBe(52);
  });

  it('message generation, when signals exist but drafts do not', () => {
    const input = pipeline({
      submitted: 100, validated: 100, identity: 96, research: 94, qualification: 92, signals: 90, drafts: 40,
    });
    const b = identifyBottleneck(input, W);
    expect(b.kind).toBe('message');
    expect(b.lost).toBe(50);
  });

  it('breaks ties in favour of the EARLIER stage', () => {
    // Identity and qualification each lose exactly 20.
    const input = pipeline({
      submitted: 100, validated: 100, identity: 80, research: 80, qualification: 60, signals: 60,
    });
    const b = identifyBottleneck(input, W);
    expect(b.kind).toBe('identity');
    expect(b.lost).toBe(20);
  });
});

describe('materiality threshold', () => {
  it('reports no dominant bottleneck when every loss is small', () => {
    // Largest single loss is 4 of 100, below the 10% floor.
    const input = pipeline({
      submitted: 100, validated: 100, identity: 98, research: 96, qualification: 94, signals: 90,
    });
    const b = identifyBottleneck(input, W);
    expect(b.kind).toBe('none');
    expect(b.headline).toBe('No dominant bottleneck.');
    expect(b.why).toMatch(new RegExp(`${MATERIAL_SHARE}%`));
  });

  it('a loss exactly at the threshold is reported', () => {
    const input = pipeline({
      submitted: 100, validated: 100, identity: 90, research: 90, qualification: 90, signals: 90,
    });
    const b = identifyBottleneck(input, W);
    expect(b.share).toBe(MATERIAL_SHARE);
    expect(b.kind).toBe('identity');
  });

  it('a loss just below the threshold is not', () => {
    const input = pipeline({
      submitted: 100, validated: 100, identity: 91, research: 91, qualification: 91, signals: 91,
    });
    expect(identifyBottleneck(input, W).kind).toBe('none');
  });

  it('does not name a bottleneck from a single run in a tiny dataset', () => {
    // 1 of 20 runs is 5%: real, but not a systemic finding.
    const input = pipeline({
      submitted: 20, validated: 20, identity: 19, research: 19, qualification: 19, signals: 19,
    });
    expect(identifyBottleneck(input, W).kind).toBe('none');
  });
});

describe('weak evidence overrides the funnel comparison', () => {
  it('names evidence when most proposed signals are rejected', () => {
    const input = pipeline({
      submitted: 100, validated: 100, identity: 50, research: 50, qualification: 50, signals: 50,
    });
    // Identity loses 50 runs, but only 20% of proposed signals survive.
    input.proposals = [{ run_id: 'r0', ranked: 6, rejected: 24 }];
    const b = identifyBottleneck(input, W);
    expect(b.kind).toBe('evidence');
    expect(b.why).toMatch(/24 of 30 proposed signals/);
  });

  it('ignores a weak rate computed from too few proposals', () => {
    const input = pipeline({
      submitted: 100, validated: 100, identity: 50, research: 50, qualification: 50, signals: 50,
    });
    // 1 of 4 accepted is 25%, but four proposals prove nothing.
    input.proposals = [{ run_id: 'r0', ranked: 1, rejected: 3 }];
    expect(identifyBottleneck(input, W).kind).toBe('identity');
  });

  it('a healthy acceptance rate does not trigger the override', () => {
    const input = pipeline({
      submitted: 100, validated: 100, identity: 50, research: 50, qualification: 50, signals: 50,
    });
    input.proposals = [{ run_id: 'r0', ranked: 49, rejected: 2 }];
    const b = identifyBottleneck(input, W);
    expect(b.kind).toBe('identity');
    expect(WEAK_EVIDENCE_RATE).toBe(50);
  });
});

describe('latency is only the story when nothing is bleeding runs', () => {
  const slow = (input: EvaluationInput): EvaluationInput => {
    // Every run takes four minutes.
    for (const r of input.runs) {
      r.started_at = '2026-08-16T10:00:00Z';
      r.completed_at = '2026-08-16T10:04:00Z';
    }
    return input;
  };

  it('reports latency when the funnel is healthy but runs are slow', () => {
    const input = slow(
      pipeline({ submitted: 100, validated: 100, identity: 98, research: 97, qualification: 96, signals: 95 }),
    );
    const b = identifyBottleneck(input, W);
    expect(b.kind).toBe('latency');
    expect(b.headline).toMatch(/research latency/i);
    expect(b.why).toMatch(/4m 0s|median/i);
  });

  it('names the slowest stage when stage timings exist', () => {
    const input = slow(
      pipeline({ submitted: 100, validated: 100, identity: 98, research: 97, qualification: 96, signals: 95 }),
    );
    input.stages.push(stage('r0', 'research_company', 90_000));
    expect(identifyBottleneck(input, W).why).toMatch(/research company/);
  });

  it('a material run loss outranks slowness', () => {
    const input = slow(
      pipeline({ submitted: 100, validated: 100, identity: 50, research: 50, qualification: 50, signals: 50 }),
    );
    expect(identifyBottleneck(input, W).kind).toBe('identity');
  });

  it('a fast, healthy pipeline reports no bottleneck at all', () => {
    const input = pipeline({
      submitted: 100, validated: 100, identity: 98, research: 97, qualification: 96, signals: 95,
    });
    const b = identifyBottleneck(input, W);
    expect(b.kind).toBe('none');
    expect(SLOW_MEDIAN_MS).toBe(120_000);
  });
});

describe('degenerate inputs', () => {
  it('an empty window says so rather than inventing a bottleneck', () => {
    const b = identifyBottleneck(base(), W);
    expect(b.kind).toBe('none');
    expect(b.headline).toMatch(/no runs/i);
    expect(b.lost).toBeNull();
  });

  it('never blames the unreviewed approval queue', () => {
    // Every run reaches a draft; none is reviewed. That is a pending human
    // step, and must never be reported as a pipeline bottleneck.
    const input = pipeline({
      submitted: 50, validated: 50, identity: 50, research: 50, qualification: 50, signals: 50,
    });
    const b = identifyBottleneck(input, W);
    expect(b.kind).not.toBe('message');
    expect(b.headline).toBe('No dominant bottleneck.');
  });

  it('always returns a headline and a reason', () => {
    for (const input of [
      base(),
      pipeline({ submitted: 10, validated: 10, identity: 5, research: 5, qualification: 5, signals: 5 }),
      pipeline({ submitted: 3, validated: 3, identity: 3, research: 3, qualification: 3, signals: 3 }),
    ]) {
      const b = identifyBottleneck(input, W);
      expect(b.headline.length).toBeGreaterThan(0);
      expect(b.why.length).toBeGreaterThan(0);
    }
  });
});
