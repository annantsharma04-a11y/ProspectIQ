import { describe, it, expect } from 'vitest';
import {
  prospectKeyFromUrl,
  sameProspect,
  identityPatchFromRun,
  countsAsResearched,
  daysSince,
} from '@/lib/prospects/types';
import { diffRuns, prospectTimeline } from '@/lib/prospects/changes';
import type { RunRow, SignalRow } from '@/lib/types';

// The prospect layer is deliberately pure: URL → key, run → identity patch,
// two runs → what changed. Everything the UI and the API rely on can therefore
// be tested without a database.

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'run-1',
    user_id: 'user-a',
    prospect_id: 'prospect-1',
    linkedin_url: 'https://www.linkedin.com/in/john-doe',
    linkedin_slug: 'john-doe',
    input_name: null,
    input_company: null,
    input_title: null,
    sender_name: null,
    prospect_name: 'John Doe',
    prospect_title: 'VP Engineering',
    company_name: 'ABC Technologies',
    company_domain: 'abc.com',
    status: 'ready_for_review',
    qualification_status: 'QUALIFIED',
    insufficient_evidence: false,
    error: null,
    ai_error_type: null,
    created_at: '2026-08-10T10:00:00Z',
    completed_at: '2026-08-10T10:05:00Z',
    updated_at: '2026-08-10T10:05:00Z',
    ...over,
  }) as RunRow;

const signal = (text: string, id = text): SignalRow =>
  ({ id, run_id: 'run-1', signal: text, source_url: 'https://example.com' }) as SignalRow;

describe('URL normalization decides prospect identity', () => {
  it('folds the messy real-world variants onto one key', () => {
    const variants = [
      'https://www.linkedin.com/in/john-doe',
      'https://linkedin.com/in/john-doe/',
      'https://www.linkedin.com/in/john-doe/?trk=profile',
      'http://www.linkedin.com/in/John-Doe',
      'www.linkedin.com/in/john-doe',
      'linkedin.com/in/john-doe?originalSubdomain=in',
      'https://in.linkedin.com/in/john-doe',
    ];

    const keys = variants.map((v) => {
      const r = prospectKeyFromUrl(v);
      expect(r.ok, `${v} should parse`).toBe(true);
      return r.ok ? r.key.slug : null;
    });

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('john-doe');
  });

  it('gives every variant the same canonical URL', () => {
    const a = prospectKeyFromUrl('https://linkedin.com/in/john-doe/?trk=x');
    expect(a.ok && a.key.normalized_url).toBe('https://www.linkedin.com/in/john-doe');
  });

  it('keeps genuinely different people apart', () => {
    expect(sameProspect(
      'https://www.linkedin.com/in/john-doe',
      'https://www.linkedin.com/in/jane-doe',
    )).toBe(false);
  });

  it('does not merge two people who share a name but not a slug', () => {
    // LinkedIn disambiguates duplicates with a suffix; those are different
    // profiles and must stay different prospects. Merging them would be
    // fabricating an identity claim the data does not support.
    expect(sameProspect(
      'https://www.linkedin.com/in/john-doe',
      'https://www.linkedin.com/in/john-doe-81136242',
    )).toBe(false);
  });

  it('refuses non-profile URLs rather than inventing a key', () => {
    for (const bad of [
      'https://www.linkedin.com/company/acme',
      'https://example.com/in/john-doe',
      '',
      null,
    ]) {
      expect(prospectKeyFromUrl(bad).ok).toBe(false);
    }
  });
});

describe('a run contributes identity without erasing it', () => {
  it('takes every field a complete run established', () => {
    expect(identityPatchFromRun(run())).toEqual({
      name: 'John Doe',
      current_job_role: 'VP Engineering',
      current_company: 'ABC Technologies',
      company_domain: 'abc.com',
    });
  });

  it('omits fields a partial run never learned', () => {
    const patch = identityPatchFromRun(
      run({ company_name: null, company_domain: null, prospect_title: null }),
    );
    // Only the name survives — and crucially, the missing keys are ABSENT
    // rather than null, so an update cannot blank what an earlier run knew.
    expect(patch).toEqual({ name: 'John Doe' });
    expect('current_company' in patch).toBe(false);
  });

  it('contributes nothing at all from a run that failed before identification', () => {
    const patch = identityPatchFromRun(
      run({ prospect_name: null, prospect_title: null, company_name: null, company_domain: null, status: 'failed' }),
    );
    expect(patch).toEqual({});
  });

  it('counts only terminal runs as research completed', () => {
    expect(countsAsResearched(run({ status: 'ready_for_review' }))).toBe(true);
    expect(countsAsResearched(run({ status: 'approved' }))).toBe(true);
    expect(countsAsResearched(run({ status: 'rejected' }))).toBe(true);
    expect(countsAsResearched(run({ status: 'running' }))).toBe(false);
    expect(countsAsResearched(run({ status: 'failed' }))).toBe(false);
    expect(countsAsResearched(run({ status: 'ai_analysis_pending' }))).toBe(false);
  });
});

describe('changes between runs are derived, never inferred', () => {
  const first = run({ id: 'run-1', created_at: '2026-08-10T10:00:00Z', completed_at: '2026-08-10T10:05:00Z' });

  it('reports a role change', () => {
    const second = run({ id: 'run-2', prospect_title: 'CTO' });
    const changes = diffRuns(first, second);
    expect(changes.map((c) => c.kind)).toContain('role_changed');
    const c = changes.find((x) => x.kind === 'role_changed')!;
    expect(c.from).toBe('VP Engineering');
    expect(c.to).toBe('CTO');
  });

  it('reports a company change', () => {
    const second = run({ id: 'run-2', company_name: 'XYZ Corp' });
    expect(diffRuns(first, second).map((c) => c.kind)).toContain('company_changed');
  });

  it('reports a qualification change', () => {
    const second = run({ id: 'run-2', qualification_status: 'NOT_QUALIFIED' });
    expect(diffRuns(first, second).map((c) => c.kind)).toContain('qualification_changed');
  });

  it('does NOT report a change when the newer run simply learned less', () => {
    // Company went from known to null: that is a gap in the research, not a
    // person who left their job. Reporting it would be fabrication.
    const second = run({ id: 'run-2', company_name: null, prospect_title: null, qualification_status: null });
    expect(diffRuns(first, second)).toEqual([]);
  });

  it('does NOT report a change when the newer run established a field for the first time', () => {
    const blank = run({ id: 'run-0', company_name: null, prospect_title: null, qualification_status: null });
    const later = run({ id: 'run-1' });
    expect(diffRuns(blank, later)).toEqual([]);
  });

  it('reports new signals and signals that were not re-verified', () => {
    const before = [signal('Hiring data engineers'), signal('Opened Berlin office')];
    const after = [signal('Hiring data engineers'), signal('Launched AI initiative')];

    const kinds = diffRuns(first, run({ id: 'run-2' }), before, after).map((c) => c.kind);
    expect(kinds).toContain('new_signal');
    expect(kinds).toContain('signal_no_longer_present');
  });

  it('matches signals regardless of whitespace and case', () => {
    const before = [signal('Hiring   Data Engineers')];
    const after = [signal('hiring data engineers')];
    expect(diffRuns(first, run({ id: 'run-2' }), before, after)).toEqual([]);
  });

  it('does not claim signals were lost when the newer run collected none', () => {
    // A run that failed before collect_signals has no signals. That is not the
    // same as "the signals stopped being true".
    const changes = diffRuns(first, run({ id: 'run-2', status: 'failed' }), [signal('Hiring')], []);
    expect(changes.filter((c) => c.kind === 'signal_no_longer_present')).toEqual([]);
  });

  it('builds a newest-first timeline across several runs', () => {
    const r1 = run({ id: 'r1', created_at: '2026-08-02T10:00:00Z', completed_at: '2026-08-02T10:01:00Z', company_name: 'ABC' });
    const r2 = run({ id: 'r2', created_at: '2026-08-10T10:00:00Z', completed_at: '2026-08-10T10:01:00Z', company_name: 'ABC', prospect_title: 'CTO' });
    const r3 = run({ id: 'r3', created_at: '2026-08-17T10:00:00Z', completed_at: '2026-08-17T10:01:00Z', company_name: 'XYZ', prospect_title: 'CTO' });

    const timeline = prospectTimeline([r1, r2, r3]);
    expect(timeline.length).toBeGreaterThanOrEqual(2);
    // Newest change first.
    expect(new Date(timeline[0].observed_at).getTime()).toBeGreaterThanOrEqual(
      new Date(timeline[timeline.length - 1].observed_at).getTime(),
    );
    expect(timeline[0].kind).toBe('company_changed');
  });

  it('a single run produces no changes', () => {
    expect(prospectTimeline([run()])).toEqual([]);
    expect(prospectTimeline([])).toEqual([]);
  });
});

describe('historical runs are never rewritten', () => {
  it('diffing does not mutate either run', () => {
    const before = run({ id: 'run-1' });
    const after = run({ id: 'run-2', company_name: 'XYZ Corp', prospect_title: 'CTO' });
    const snapshotBefore = JSON.stringify(before);
    const snapshotAfter = JSON.stringify(after);

    diffRuns(before, after, [signal('a')], [signal('b')]);
    prospectTimeline([before, after]);

    expect(JSON.stringify(before)).toBe(snapshotBefore);
    expect(JSON.stringify(after)).toBe(snapshotAfter);
  });

  it('an identity patch describes the prospect, and touches no run field', () => {
    const r = run();
    const patch = identityPatchFromRun(r);
    // Nothing in the patch is a run column the pipeline owns.
    for (const key of ['id', 'status', 'selected_hook', 'generated_message', 'created_at']) {
      expect(key in patch).toBe(false);
    }
  });
});

describe('incomplete prospect data', () => {
  it('a prospect never researched has no elapsed time', () => {
    expect(daysSince(null)).toBeNull();
    expect(daysSince(undefined)).toBeNull();
    expect(daysSince('not-a-date')).toBeNull();
  });

  it('elapsed days are counted from the last research', () => {
    const now = new Date('2026-08-17T00:00:00Z');
    expect(daysSince('2026-08-10T00:00:00Z', now)).toBe(7);
    expect(daysSince('2026-08-17T00:00:00Z', now)).toBe(0);
  });

  it('a run with no identity at all still yields a usable key from the URL', () => {
    const bare = run({ prospect_name: null, prospect_title: null, company_name: null, company_domain: null });
    expect(identityPatchFromRun(bare)).toEqual({});
    const key = prospectKeyFromUrl(bare.linkedin_url);
    expect(key.ok && key.key.slug).toBe('john-doe');
  });
});
