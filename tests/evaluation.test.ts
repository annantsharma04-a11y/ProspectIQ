import { describe, it, expect } from 'vitest';
import {
  claimMetrics,
  evidenceMetrics,
  failureAnalysis,
  funnel,
  hookMetrics,
  identityMetrics,
  messageMetrics,
  providerMetrics,
  qualificationMetrics,
  reliabilityMetrics,
  trends,
  unavailableMetrics,
  volumeMetrics,
} from '@/lib/evaluation/metrics';
import {
  inWindow,
  previousWindow,
  windowFor,
  type EvaluationInput,
} from '@/lib/evaluation/types';
import type { RunRow } from '@/lib/types';

// The metric layer is pure, so every denominator claim in the dashboard can be
// asserted here without a database. The cases that matter most are the ones
// where a careless implementation would flatter the pipeline: retries counted
// as extra prospects, UNKNOWN folded into "disqualified", generic phrasing
// counted as a failed factual claim, an empty review queue read as 0% approval.

const NOW = new Date('2026-08-17T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'r1',
    user_id: 'user-a',
    prospect_id: 'p1',
    linkedin_url: 'https://www.linkedin.com/in/a',
    linkedin_slug: 'a',
    status: 'ready_for_review',
    identity_status: 'VERIFIED',
    identity_resolution: 'AUTOMATIC',
    qualification_status: 'QUALIFIED',
    qualification: null,
    insufficient_evidence: false,
    ai_error_type: null,
    error: null,
    selected_hook: 'hook',
    linkedin_access_status: 'accessible',
    started_at: ago(1),
    completed_at: ago(1),
    created_at: ago(1),
    updated_at: ago(1),
    ...over,
  }) as RunRow;

const base = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  prospects: [{ id: 'p1', created_at: ago(10) }],
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

const stage = (run_id: string, stage_name: string, status = 'complete', duration_ms: number | null = 1000) =>
  ({ run_id, stage_name, status, duration_ms }) as EvaluationInput['stages'][number];

const W = windowFor('30d', NOW);

describe('date windows', () => {
  it('includes and excludes by the window boundary', () => {
    expect(inWindow(ago(1), W)).toBe(true);
    expect(inWindow(ago(29), W)).toBe(true);
    expect(inWindow(ago(31), W)).toBe(false);
    expect(inWindow(null, W)).toBe(false);
    expect(inWindow('not-a-date', W)).toBe(false);
  });

  it('all-time has no lower bound', () => {
    expect(inWindow(ago(9999), windowFor('all', NOW))).toBe(true);
  });

  it('the previous window is the same length, immediately before', () => {
    const prev = previousWindow('7d', NOW)!;
    expect(prev.to.getTime()).toBe(NOW.getTime() - 7 * 86_400_000);
    expect(prev.from!.getTime()).toBe(NOW.getTime() - 14 * 86_400_000);
    expect(previousWindow('all', NOW)).toBeNull();
  });

  it('metrics respect the window consistently', () => {
    const input = base({ runs: [run({ id: 'in', created_at: ago(2) }), run({ id: 'out', created_at: ago(60) })] });
    expect(volumeMetrics(input, W).totalRuns).toBe(1);
    expect(funnel(input, W)[0].count).toBe(1);
  });
});

describe('prospect-level vs run-level counting', () => {
  it('does not treat multiple runs of one prospect as multiple prospects', () => {
    const input = base({
      prospects: [{ id: 'p1', created_at: ago(10) }],
      runs: [
        run({ id: 'r1', prospect_id: 'p1' }),
        run({ id: 'r2', prospect_id: 'p1' }),
        run({ id: 'r3', prospect_id: 'p1' }),
      ],
    });
    const v = volumeMetrics(input, W);
    expect(v.totalRuns).toBe(3);
    expect(v.activeProspects).toBe(1);
    expect(v.runsPerProspect).toBe(3);
  });

  it('mirrors the real shape: many runs, far fewer prospects', () => {
    const runs = Array.from({ length: 65 }, (_, i) =>
      run({ id: `r${i}`, prospect_id: `p${i % 16}` }),
    );
    const prospects = Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, created_at: ago(20) }));
    const v = volumeMetrics(base({ runs, prospects }), W);
    expect(v.totalRuns).toBe(65);
    expect(v.activeProspects).toBe(16);
    expect(v.activeProspects).not.toBe(v.totalRuns);
  });

  it('a retry does not become a second run or a second prospect', () => {
    // Retries re-execute the SAME run row, so a retried run is still one run.
    const input = base({ runs: [run({ id: 'r1', prospect_id: 'p1', status: 'ready_for_review' })] });
    const v = volumeMetrics(input, W);
    expect(v.totalRuns).toBe(1);
    expect(v.activeProspects).toBe(1);
    expect(v.completedRuns).toBe(1);
  });

  it('counts prospects added separately from prospects active', () => {
    const input = base({
      prospects: [{ id: 'p1', created_at: ago(100) }],
      runs: [run({ prospect_id: 'p1', created_at: ago(1) })],
    });
    const v = volumeMetrics(input, W);
    expect(v.activeProspects).toBe(1);
    expect(v.prospectsAdded).toBe(0);
    expect(v.totalProspects).toBe(1);
  });
});

describe('identity denominators', () => {
  it('excludes runs that never reached verification', () => {
    const input = base({
      runs: [
        run({ id: 'r1', identity_status: 'VERIFIED' }),
        run({ id: 'r2', identity_status: null }),
      ],
      stages: [stage('r1', 'verify_identity', 'complete')],
    });
    const m = identityMetrics(input, W);
    expect(m.reached).toBe(1);
    expect(m.verificationRate.denominator).toBe(1);
    expect(m.verificationRate.rate).toBe(100);
  });

  it('a skipped verify stage is not a failure', () => {
    const input = base({
      runs: [run({ id: 'r1', identity_status: null })],
      stages: [stage('r1', 'verify_identity', 'skipped')],
    });
    const m = identityMetrics(input, W);
    expect(m.reached).toBe(0);
    expect(m.verificationRate.rate).toBeNull();
  });

  it('splits the four identity outcomes', () => {
    const input = base({
      runs: [
        run({ id: 'a', identity_status: 'VERIFIED' }),
        run({ id: 'b', identity_status: 'PARTIAL' }),
        run({ id: 'c', identity_status: 'AMBIGUOUS' }),
        run({ id: 'd', identity_status: 'FAILED' }),
      ],
      stages: ['a', 'b', 'c', 'd'].map((id) => stage(id, 'verify_identity')),
    });
    const m = identityMetrics(input, W);
    expect([m.verified, m.partial, m.ambiguous, m.failed]).toEqual([1, 1, 1, 1]);
    expect(m.verificationRate.rate).toBe(25);
  });
});

describe('qualification never treats UNKNOWN as a rejection', () => {
  it('keeps UNKNOWN in its own bucket', () => {
    const input = base({
      runs: [
        run({ id: 'a', qualification_status: 'QUALIFIED' }),
        run({ id: 'b', qualification_status: 'NOT_QUALIFIED' }),
        run({ id: 'c', qualification_status: null }),
      ],
      stages: ['a', 'b', 'c'].map((id) => stage(id, 'qualify_company')),
    });
    const m = qualificationMetrics(input, W);
    expect(m.qualified).toBe(1);
    expect(m.notQualified).toBe(1);
    expect(m.unknown).toBe(1);
    // The unknown run is NOT added to notQualified.
    expect(m.notQualified).not.toBe(2);
  });

  it('counts BORDERLINE apart from NOT_QUALIFIED', () => {
    const input = base({
      runs: [run({ id: 'a', qualification_status: 'BORDERLINE' })],
      stages: [stage('a', 'qualify_prospect')],
    });
    const m = qualificationMetrics(input, W);
    expect(m.borderline).toBe(1);
    expect(m.notQualified).toBe(0);
  });

  it('reads fit classifications and evidence basis from stored qualification', () => {
    const q = {
      prospect_fit: { classification: 'HIGH' },
      company_fit: { classification: 'LOW', evidence_basis: 'INFERRED' },
    } as unknown as RunRow['qualification'];
    const input = base({
      runs: [run({ id: 'a', qualification: q })],
      stages: [stage('a', 'qualify_company')],
    });
    const m = qualificationMetrics(input, W);
    expect(m.prospectFit.HIGH).toBe(1);
    expect(m.companyFit.LOW).toBe(1);
    expect(m.companyEvidenceBasis.INFERRED).toBe(1);
  });
});

describe('evidence metrics use verified signals, not proposed ones', () => {
  it('divides accepted by proposed', () => {
    const input = base({
      runs: [run({ id: 'r1' })],
      proposals: [{ run_id: 'r1', ranked: 3, rejected: 7 }],
    });
    const m = evidenceMetrics(input, W);
    expect(m.proposed).toBe(10);
    expect(m.accepted).toBe(3);
    expect(m.rejected).toBe(7);
    expect(m.evidenceBackedRate.rate).toBe(30);
  });

  it('does not credit a proposed signal merely for existing', () => {
    const input = base({ runs: [run({ id: 'r1' })], proposals: [{ run_id: 'r1', ranked: 0, rejected: 5 }] });
    expect(evidenceMetrics(input, W).evidenceBackedRate.rate).toBe(0);
  });

  it('citation rate flags a signal stored without a quote', () => {
    const input = base({
      runs: [run({ id: 'r1' })],
      signals: [
        { run_id: 'r1', selected_as_hook: true, supporting_quote: 'a real quote', composite_score: 80, category: 'funding' },
        { run_id: 'r1', selected_as_hook: false, supporting_quote: '  ', composite_score: 60, category: null },
      ] as EvaluationInput['signals'],
    });
    const m = evidenceMetrics(input, W);
    expect(m.persisted).toBe(2);
    expect(m.withQuote).toBe(1);
    expect(m.citationRate.rate).toBe(50);
  });

  it('no signals means no rate rather than zero', () => {
    expect(evidenceMetrics(base(), W).evidenceBackedRate.rate).toBeNull();
  });
});

describe('hook metrics', () => {
  it('counts a run with no verified hook against acceptance', () => {
    const input = base({
      runs: [run({ id: 'a' }), run({ id: 'b' })],
      hooks: [
        { run_id: 'a', selected: true, insufficient_evidence: false, rejected_candidates: 2 },
        { run_id: 'b', selected: false, insufficient_evidence: true, rejected_candidates: 1 },
      ],
    });
    const m = hookMetrics(input, W);
    expect(m.selected).toBe(1);
    expect(m.insufficientEvidence).toBe(1);
    expect(m.rejectedCandidates).toBe(3);
    expect(m.acceptanceRate.rate).toBe(50);
  });

  it('groups selected hooks by their stored category only', () => {
    const input = base({
      runs: [run({ id: 'a' })],
      hooks: [{ run_id: 'a', selected: true, insufficient_evidence: false, rejected_candidates: 0 }],
      signals: [
        { run_id: 'a', selected_as_hook: true, supporting_quote: 'q', composite_score: 80, category: 'funding' },
        { run_id: 'a', selected_as_hook: false, supporting_quote: 'q', composite_score: 50, category: 'partnership' },
      ] as EvaluationInput['signals'],
    });
    const m = hookMetrics(input, W);
    expect(m.byCategory).toEqual({ funding: 1 });
  });
});

describe('review metrics distinguish an empty queue from a bad result', () => {
  it('unreviewed drafts give no approval rate, not 0%', () => {
    const input = base({
      runs: [run({ id: 'r1' })],
      drafts: [{ run_id: 'r1', reviewer_action: null, validation_status: 'pass', claims: null, mode: 'personalized' }] as EvaluationInput['drafts'],
    });
    const m = messageMetrics(input, W);
    expect(m.generated).toBe(1);
    expect(m.awaitingReview).toBe(1);
    expect(m.reviewed).toBe(0);
    expect(m.approvalRate.rate).toBeNull();
    expect(m.editRate.rate).toBeNull();
  });

  it('computes approval and edit rates over reviewed drafts only', () => {
    const d = (id: string, action: string | null) =>
      ({ run_id: id, reviewer_action: action, validation_status: 'pass', claims: null, mode: 'personalized' }) as EvaluationInput['drafts'][number];
    const input = base({
      runs: ['a', 'b', 'c', 'd'].map((id) => run({ id })),
      drafts: [d('a', 'approved'), d('b', 'edited'), d('c', 'rejected'), d('d', null)],
    });
    const m = messageMetrics(input, W);
    expect(m.reviewed).toBe(3);
    expect(m.approvalRate).toMatchObject({ numerator: 1, denominator: 3 });
    expect(m.editRate).toMatchObject({ numerator: 1, denominator: 3 });
    expect(m.awaitingReview).toBe(1);
  });
});

describe('claim validation excludes non-factual claims from the pass rate', () => {
  const claim = (type: string, verdict: string, requires: boolean | null) =>
    ({ claim: 'c', type, verdict, requires_external_evidence: requires, evidence_url: null, explanation: '' }) as never;

  it('generic language is not a failed factual claim', () => {
    const input = base({
      runs: [run({ id: 'r1' })],
      drafts: [
        {
          run_id: 'r1',
          reviewer_action: null,
          validation_status: 'pass',
          mode: 'personalized',
          claims: [
            claim('GENERIC_LANGUAGE', 'ALLOWED', false),
            claim('SENDER_OFFERING', 'ALLOWED', false),
            claim('COMPANY_FACT', 'SUPPORTED', true),
            claim('EXTERNAL_EVENT', 'UNCERTAIN', true),
          ],
        },
      ] as unknown as EvaluationInput['drafts'],
    });
    const m = claimMetrics(input, W);
    expect(m.total).toBe(4);
    expect(m.allowedByType).toBe(2);
    expect(m.factual).toBe(2);
    // 1 supported of 2 factual — the two ALLOWED claims are in neither side.
    expect(m.passRate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(m.passRate.rate).toBe(50);
  });

  it('claims stored before typing existed are excluded, not assumed factual', () => {
    const input = base({
      runs: [run({ id: 'r1' })],
      drafts: [
        { run_id: 'r1', reviewer_action: null, validation_status: 'pass', mode: 'personalized', claims: [claim('', 'SUPPORTED', null)] },
      ] as unknown as EvaluationInput['drafts'],
    });
    const m = claimMetrics(input, W);
    expect(m.uncategorised).toBe(1);
    expect(m.factual).toBe(0);
    expect(m.passRate.rate).toBeNull();
  });
});

describe('funnel', () => {
  it('reports each step against the previous and the start', () => {
    const input = base({
      runs: [run({ id: 'a' }), run({ id: 'b', identity_status: 'PARTIAL' })],
      stages: [
        stage('a', 'validate_input'),
        stage('b', 'validate_input'),
        stage('a', 'research_prospect'),
        stage('a', 'research_company'),
      ],
      signals: [{ run_id: 'a', selected_as_hook: true, supporting_quote: 'q', composite_score: 80, category: 'funding' }] as EvaluationInput['signals'],
      drafts: [{ run_id: 'a', reviewer_action: null, validation_status: 'pass', claims: null, mode: 'personalized' }] as EvaluationInput['drafts'],
    });
    const f = funnel(input, W);
    expect(f[0]).toMatchObject({ label: 'Submitted', count: 2, ofPrevious: null });
    expect(f[1]).toMatchObject({ label: 'Validated', count: 2, ofPrevious: 100 });
    // b halted at identity, so only a cleared the gate.
    expect(f[2]).toMatchObject({ label: 'Cleared identity gate', count: 1, ofPrevious: 50, ofStart: 50 });
    expect(f.at(-1)).toMatchObject({ label: 'Approved after human review', count: 0 });
  });

  it('is monotonic — no step can exceed the one before it', () => {
    // The regression this guards: measuring a gate by its verdict column made
    // legacy runs (recorded before that column existed) vanish from one step and
    // reappear in the next, producing a "511% of previous" funnel.
    const legacy = (id: string) =>
      run({ id, identity_status: null, qualification_status: null });
    const input = base({
      runs: [legacy('l1'), legacy('l2'), run({ id: 'modern' })],
      stages: ['l1', 'l2', 'modern'].flatMap((id) => [
        stage(id, 'validate_input'),
        stage(id, 'research_prospect'),
        stage(id, 'research_company'),
        stage(id, 'collect_signals'),
      ]),
      signals: ['l1', 'l2', 'modern'].map((id) => ({
        run_id: id, selected_as_hook: true, supporting_quote: 'q', composite_score: 80, category: 'funding',
      })) as EvaluationInput['signals'],
    });

    const f = funnel(input, W);
    for (let i = 1; i < f.length; i++) {
      expect(f[i].count, `${f[i].label} exceeds ${f[i - 1].label}`).toBeLessThanOrEqual(f[i - 1].count);
      if (f[i].ofPrevious != null) expect(f[i].ofPrevious).toBeLessThanOrEqual(100);
    }
    // Legacy runs are credited with clearing gates they genuinely progressed past.
    expect(f.find((s) => s.label === 'Cleared identity gate')!.count).toBe(3);
    expect(f.find((s) => s.label === 'Cleared qualification gate')!.count).toBe(3);
  });

  it('an empty dataset produces zeroes, not NaN', () => {
    const f = funnel(base({ runs: [], prospects: [] }), W);
    expect(f[0].count).toBe(0);
    for (const s of f) expect(s.ofPrevious === null || Number.isFinite(s.ofPrevious)).toBe(true);
  });
});

describe('failure analysis', () => {
  it('buckets each run once, by the earliest reason', () => {
    // This run is both unverified AND has no evidence; identity is earlier.
    const input = base({
      runs: [run({ id: 'a', identity_status: 'AMBIGUOUS', qualification_status: null, insufficient_evidence: true })],
    });
    const f = failureAnalysis(input, W);
    expect(f).toHaveLength(1);
    expect(f[0].label).toBe('Identity ambiguous');
    expect(f.reduce((n, b) => n + b.count, 0)).toBe(1);
  });

  it('shares sum to 100% across buckets', () => {
    const input = base({
      runs: [
        run({ id: 'a', identity_status: 'PARTIAL' }),
        run({ id: 'b', qualification_status: 'NOT_QUALIFIED' }),
        run({ id: 'c', insufficient_evidence: true, qualification_status: 'QUALIFIED' }),
      ],
    });
    const f = failureAnalysis(input, W);
    expect(Math.round(f.reduce((n, b) => n + b.share, 0))).toBe(100);
  });

  it('excludes runs that reached a draft and runs still processing', () => {
    const input = base({
      runs: [run({ id: 'a' }), run({ id: 'b', status: 'running' })],
      drafts: [{ run_id: 'a', reviewer_action: null, validation_status: 'pass', claims: null, mode: 'personalized' }] as EvaluationInput['drafts'],
    });
    expect(failureAnalysis(input, W)).toEqual([]);
  });

  it('surfaces a classified model error as its own bucket', () => {
    const input = base({ runs: [run({ id: 'a', status: 'failed', ai_error_type: 'quota_exhausted' })] });
    expect(failureAnalysis(input, W)[0].label).toContain('quota exhausted');
  });
});

describe('reliability', () => {
  it('excludes in-flight runs from success and failure rates', () => {
    const input = base({
      runs: [
        run({ id: 'a', status: 'ready_for_review' }),
        run({ id: 'b', status: 'failed' }),
        run({ id: 'c', status: 'running' }),
      ],
    });
    const m = reliabilityMetrics(input, W);
    expect(m.successRate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(m.failureRate).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it('computes median and p95 from timed runs only', () => {
    const at = (start: string, ms: number) =>
      run({ id: start, created_at: ago(1), started_at: start, completed_at: new Date(new Date(start).getTime() + ms).toISOString() });
    const input = base({
      runs: [
        at('2026-08-16T10:00:00Z', 1000),
        at('2026-08-16T11:00:00Z', 3000),
        at('2026-08-16T12:00:00Z', 5000),
        run({ id: 'untimed', started_at: null, completed_at: null }),
      ],
    });
    const m = reliabilityMetrics(input, W);
    expect(m.timed).toBe(3);
    expect(m.medianMs).toBe(3000);
    expect(m.p95Ms).toBe(5000);
    expect(m.avgMs).toBe(3000);
  });

  it('missing timestamps yield null durations rather than zero', () => {
    const input = base({ runs: [run({ started_at: null, completed_at: null })] });
    const m = reliabilityMetrics(input, W);
    expect(m.timed).toBe(0);
    expect(m.avgMs).toBeNull();
    expect(m.medianMs).toBeNull();
  });

  it('ranks stages by mean duration', () => {
    const input = base({
      runs: [run({ id: 'a' })],
      stages: [stage('a', 'research_company', 'complete', 9000), stage('a', 'validate_input', 'complete', 100)],
    });
    const m = reliabilityMetrics(input, W);
    expect(m.slowestStages[0].stage).toBe('research_company');
    expect(m.slowestStages[0].avgMs).toBe(9000);
  });
});

describe('providers', () => {
  it('reports profile retrieval over attempted runs only', () => {
    const input = base({
      runs: [
        run({ id: 'a', linkedin_access_status: 'accessible' }),
        run({ id: 'b', linkedin_access_status: 'unavailable' }),
        run({ id: 'c', linkedin_access_status: 'not_attempted' }),
      ],
    });
    const m = providerMetrics(input, W);
    expect(m.profileAttempted).toBe(2);
    expect(m.profileSuccessRate).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it('reports full-text retrieval from source fetch status', () => {
    const input = base({ sourceFetchStatus: { scraped: 1, snippet_only: 3 } });
    expect(providerMetrics(input, W).fullTextRate.rate).toBe(25);
  });

  it('records no model errors when none occurred', () => {
    const m = providerMetrics(base(), W);
    expect(m.modelErrors).toEqual({});
    expect(m.modelErrorRate.numerator).toBe(0);
  });
});

describe('trends', () => {
  it('returns null when the previous window has no runs', () => {
    const input = base({ runs: [run({ created_at: ago(1) })] });
    expect(trends(input, windowFor('7d', NOW), previousWindow('7d', NOW))).toBeNull();
  });

  it('compares equal-length windows when both hold data', () => {
    const input = base({
      runs: [
        run({ id: 'now', created_at: ago(1), identity_status: 'VERIFIED' }),
        run({ id: 'then', created_at: ago(10), identity_status: 'PARTIAL' }),
      ],
      stages: [stage('now', 'verify_identity'), stage('then', 'verify_identity')],
    });
    const t = trends(input, windowFor('7d', NOW), previousWindow('7d', NOW));
    expect(t).not.toBeNull();
    const idt = t!.find((x) => x.label === 'Identity verification')!;
    expect(idt.current).toBe(100);
    expect(idt.previous).toBe(0);
    expect(idt.delta).toBe(100);
  });

  it('all-time has no previous window', () => {
    expect(trends(base(), windowFor('all', NOW), previousWindow('all', NOW))).toBeNull();
  });
});

describe('empty and degenerate datasets', () => {
  const emptyInput = base({ prospects: [], runs: [] });

  it('zero runs produces null rates everywhere, never NaN or 0%', () => {
    expect(volumeMetrics(emptyInput, W).totalRuns).toBe(0);
    expect(volumeMetrics(emptyInput, W).runsPerProspect).toBeNull();
    expect(identityMetrics(emptyInput, W).verificationRate.rate).toBeNull();
    expect(qualificationMetrics(emptyInput, W).qualificationRate.rate).toBeNull();
    expect(evidenceMetrics(emptyInput, W).evidenceBackedRate.rate).toBeNull();
    expect(messageMetrics(emptyInput, W).approvalRate.rate).toBeNull();
    expect(claimMetrics(emptyInput, W).passRate.rate).toBeNull();
    expect(reliabilityMetrics(emptyInput, W).successRate.rate).toBeNull();
    expect(failureAnalysis(emptyInput, W)).toEqual([]);
  });

  it('a single successful run reports 100%, not 0', () => {
    const input = base({
      runs: [run({ id: 'a' })],
      stages: [stage('a', 'verify_identity'), stage('a', 'qualify_company')],
    });
    expect(identityMetrics(input, W).verificationRate.rate).toBe(100);
    expect(qualificationMetrics(input, W).qualificationRate.rate).toBe(100);
    expect(reliabilityMetrics(input, W).successRate.rate).toBe(100);
  });

  it('all failures report 0% success and 100% failure', () => {
    const input = base({
      runs: [run({ id: 'a', status: 'failed' }), run({ id: 'b', status: 'failed' })],
    });
    const m = reliabilityMetrics(input, W);
    expect(m.successRate.rate).toBe(0);
    expect(m.failureRate.rate).toBe(100);
  });
});

describe('unavailable metrics are declared, not faked', () => {
  it('names retry rate and cost with a reason and a requirement', () => {
    const gaps = unavailableMetrics();
    const names = gaps.map((g) => g.name);
    expect(names).toContain('Retry rate');
    expect(names.some((n) => /cost/i.test(n))).toBe(true);
    for (const g of gaps) {
      expect(g.reason.length).toBeGreaterThan(20);
      expect(g.requires.length).toBeGreaterThan(10);
    }
  });
});
