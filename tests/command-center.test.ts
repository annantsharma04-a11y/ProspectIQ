import { describe, it, expect } from 'vitest';
import {
  buildActiveRunSummary,
  buildCommandCenterSummary,
  greetingName,
  timeOfDayGreeting,
  shouldRenderSection,
  PREVIEW_LIMIT,
} from '@/lib/dashboard/command-center';
import type { CompanyFit, EvidenceItem, ProspectFit, TargetQualification } from '@/lib/qualification/types';
import type { RunRow, RunStatus } from '@/lib/types';

// buildCommandCenterSummary() only selects and labels rows listRuns() already
// returns — these tests exist to prove the four triage lenses (needs
// attention / ready / contacts needing work / exploratory) read the right
// fields, never show more than one short label per row, and never invent a
// status or action the run itself doesn't already carry.

const ev = (url: string): EvidenceItem => ({ url, quote: 'A verified excerpt.' });

const prospectFit = (over: Partial<ProspectFit> = {}): ProspectFit =>
  ({
    score: 80,
    classification: 'HIGH',
    role: 'VP Finance',
    seniority: 'VP',
    relevance_reason: 'Owns AP.',
    decision_authority: 'HIGH',
    product_relevance: 'HIGH',
    why_this_person: [],
    why_not_this_person: [],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence: [ev('https://example.com/prospect')],
    ...over,
  }) as ProspectFit;

const companyFit = (over: Partial<CompanyFit> = {}): CompanyFit =>
  ({
    score: 80,
    classification: 'HIGH',
    industry: 'Logistics',
    company_size: '1,000+',
    relevant_workflows: ['accounts payable'],
    capability_matches: [],
    fit_reasons: [],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence_adjustment: null,
    ...over,
  }) as CompanyFit;

const qualification = (over: Partial<TargetQualification> = {}): TargetQualification =>
  ({
    prospect_fit: prospectFit(),
    company_fit: companyFit(),
    overall_fit: 80,
    classification: 'QUALIFIED',
    reason: 'Strong evidenced fit on both sides.',
    proceed: true,
    suggestion: null,
    action: 'TARGET_DIRECTLY',
    ...over,
  }) as TargetQualification;

let seq = 0;
const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: `run-${++seq}`,
    linkedin_url: 'https://www.linkedin.com/in/example',
    linkedin_slug: 'example',
    input_name: null,
    input_company: null,
    input_title: null,
    user_id: 'u1',
    prospect_id: 'p1',
    origin_contact_candidate_id: null,
    sender_name: null,
    prospect_name: 'Jamie Prospect',
    prospect_title: 'VP Finance',
    company_name: 'Acme Logistics',
    company_domain: null,
    identity_confidence: 90,
    linkedin_access_status: 'accessible',
    linkedin_access_note: null,
    linkedin_profile: null,
    profile_access: null,
    profile_source: null,
    status: 'ready_for_review' as RunStatus,
    overall_confidence: 80,
    selected_hook: 'Acme raised a $40M Series B',
    generated_message: 'Saw the hiring push around finance ops at Acme.',
    insufficient_evidence: false,
    error: null,
    ai_error_type: null,
    identity_status: 'VERIFIED',
    identity_resolution: 'AUTOMATIC',
    identity_verification: null,
    qualification: null,
    qualification_status: null,
    overall_fit: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  }) as RunRow;

describe('buildCommandCenterSummary — needs attention', () => {
  it('includes needs_manual_review, ai_analysis_pending and failed runs, nothing else', () => {
    const runs = [
      run({ status: 'needs_manual_review' }),
      run({ status: 'ai_analysis_pending' }),
      run({ status: 'failed' }),
      run({ status: 'ready_for_review' }),
      run({ status: 'approved' }),
      run({ status: 'rejected' }),
      run({ status: 'running' }),
      run({ status: 'queued' }),
    ];
    const summary = buildCommandCenterSummary(runs, 10);
    expect(summary.counts.needsAttention).toBe(3);
    expect(summary.needsAttention).toHaveLength(3);
  });

  it('labels a row with the qualification action when one exists', () => {
    const r = run({
      status: 'needs_manual_review',
      qualification: qualification({ action: 'FIND_BETTER_CONTACT' }),
    });
    const summary = buildCommandCenterSummary([r]);
    expect(summary.needsAttention[0].label).toBe('FIND BETTER CONTACT');
  });

  it('never shows the qualification reasoning paragraph — only the one-word status/action label', () => {
    const r = run({
      status: 'needs_manual_review',
      qualification: qualification({ reason: 'A'.repeat(300) }),
    });
    const summary = buildCommandCenterSummary([r]);
    expect(summary.needsAttention[0].label.length).toBeLessThan(30);
  });

  it('falls back to a plain status label for a failed run with no qualification', () => {
    const r = run({ status: 'failed', qualification: null });
    const summary = buildCommandCenterSummary([r]);
    expect(summary.needsAttention[0].label).toBe('Failed');
  });

  it('falls back to a plain status label for ai_analysis_pending with no qualification', () => {
    const r = run({ status: 'ai_analysis_pending', qualification: null });
    const summary = buildCommandCenterSummary([r]);
    expect(summary.needsAttention[0].label).toBe('Analysis pending');
  });

  it('respects the limit while still reporting the true total count', () => {
    const runs = Array.from({ length: 10 }, () => run({ status: 'needs_manual_review' }));
    const summary = buildCommandCenterSummary(runs, 3);
    expect(summary.needsAttention).toHaveLength(3);
    expect(summary.counts.needsAttention).toBe(10);
  });

  it('defaults to PREVIEW_LIMIT when no limit is given', () => {
    const runs = Array.from({ length: 10 }, () => run({ status: 'needs_manual_review' }));
    const summary = buildCommandCenterSummary(runs);
    expect(summary.needsAttention).toHaveLength(PREVIEW_LIMIT);
  });
});

describe('buildCommandCenterSummary — ready for review', () => {
  it('includes only ready_for_review runs, labeled uniformly', () => {
    const runs = [
      run({ status: 'ready_for_review' }),
      run({ status: 'approved' }),
      run({ status: 'needs_manual_review' }),
    ];
    const summary = buildCommandCenterSummary(runs);
    expect(summary.counts.ready).toBe(1);
    expect(summary.ready[0].label).toBe('Ready for review');
  });
});

describe('buildCommandCenterSummary — contacts needing work', () => {
  it('includes a run whose decision action is VERIFY BETTER CONTACT', () => {
    const r = run({ qualification: qualification({ action: 'VERIFY_BETTER_CONTACT' }) });
    const summary = buildCommandCenterSummary([r]);
    expect(summary.counts.contactsNeedingWork).toBe(1);
    expect(summary.contactsNeedingWork[0].label).toBe('VERIFY BETTER CONTACT');
  });

  it('includes a run whose decision action is FIND BETTER CONTACT (including the _OR_HOLD variant)', () => {
    const r = run({ qualification: qualification({ action: 'FIND_BETTER_CONTACT_OR_HOLD' }) });
    const summary = buildCommandCenterSummary([r]);
    expect(summary.counts.contactsNeedingWork).toBe(1);
    expect(summary.contactsNeedingWork[0].label).toBe('FIND BETTER CONTACT');
  });

  it('excludes a run with a different action', () => {
    const r = run({ qualification: qualification({ action: 'TARGET_DIRECTLY' }) });
    const summary = buildCommandCenterSummary([r]);
    expect(summary.counts.contactsNeedingWork).toBe(0);
  });

  it('excludes a run with no qualification at all', () => {
    const r = run({ qualification: null });
    const summary = buildCommandCenterSummary([r]);
    expect(summary.counts.contactsNeedingWork).toBe(0);
  });
});

describe('buildCommandCenterSummary — exploratory outreach', () => {
  it('includes both EXPLORATORY_OUTREACH variants, labeled uniformly', () => {
    const runs = [
      run({ qualification: qualification({ action: 'EXPLORATORY_OUTREACH' }) }),
      run({ qualification: qualification({ action: 'EXPLORATORY_OUTREACH_IF_SIGNAL' }) }),
    ];
    const summary = buildCommandCenterSummary(runs, 10);
    expect(summary.counts.exploratory).toBe(2);
    // Both are borderline accounts that now pause for a person, so both read
    // as the decision that is actually blocking them rather than as the
    // outreach the system would otherwise have done. Still uniform.
    expect(summary.exploratory.every((i) => i.label === 'Account decision needed')).toBe(true);
  });

  it('excludes runs with a different action', () => {
    const r = run({ qualification: qualification({ action: 'DO_NOT_CONTACT' }) });
    const summary = buildCommandCenterSummary([r]);
    expect(summary.counts.exploratory).toBe(0);
  });
});

// Requirement: a triage section with nothing in it must not render at all —
// no heading, no "nothing here" placeholder. shouldRenderSection() is the one
// place that decides that, and CommandCenter.tsx calls it for every section;
// these tests prove (a) the rule itself, and (b) that each lens genuinely
// returns an EMPTY ARRAY — not a placeholder item — when nothing qualifies,
// which is what makes the rule safe to apply uniformly.
describe('shouldRenderSection — a section with zero items renders nothing at all', () => {
  it('is false for an empty list', () => {
    expect(shouldRenderSection([])).toBe(false);
  });

  it('is true for a non-empty list', () => {
    const r = run();
    const summary = buildCommandCenterSummary([r]);
    expect(shouldRenderSection(summary.ready)).toBe(true);
  });

  it('a run set with no exploratory cases produces a genuinely empty exploratory list', () => {
    // Mirrors validation scenario "homepage with no exploratory cases": a
    // realistic mix of needs-attention, ready and contact-work runs, none of
    // them exploratory.
    const runs = [
      run({ status: 'needs_manual_review', qualification: qualification({ action: 'DO_NOT_CONTACT' }) }),
      run({ status: 'ready_for_review', qualification: qualification({ action: 'TARGET_DIRECTLY' }) }),
      run({ qualification: qualification({ action: 'VERIFY_BETTER_CONTACT' }) }),
    ];
    const summary = buildCommandCenterSummary(runs, 10);
    expect(summary.exploratory).toEqual([]);
    expect(shouldRenderSection(summary.exploratory)).toBe(false);
  });

  it('each lens is an empty array (not a placeholder) when a run set has nothing for it', () => {
    const runs = [run({ status: 'approved' }), run({ status: 'rejected' })];
    const summary = buildCommandCenterSummary(runs, 10);
    expect(summary.needsAttention).toEqual([]);
    expect(summary.ready).toEqual([]);
    expect(summary.contactsNeedingWork).toEqual([]);
    expect(summary.exploratory).toEqual([]);
    for (const list of [summary.needsAttention, summary.ready, summary.contactsNeedingWork, summary.exploratory]) {
      expect(shouldRenderSection(list)).toBe(false);
    }
  });
});

describe('buildCommandCenterSummary — overlap is real, not a bug', () => {
  it('a run can appear in both needsAttention and contactsNeedingWork', () => {
    const r = run({
      status: 'needs_manual_review',
      qualification: qualification({ action: 'VERIFY_BETTER_CONTACT' }),
    });
    const summary = buildCommandCenterSummary([r]);
    expect(summary.needsAttention.some((i) => i.runId === r.id)).toBe(true);
    expect(summary.contactsNeedingWork.some((i) => i.runId === r.id)).toBe(true);
  });
});

describe('buildCommandCenterSummary — active run', () => {
  it('reports the most recent queued or running run as active', () => {
    const runs = [
      run({ status: 'ready_for_review' }),
      run({ status: 'running' }),
      run({ status: 'needs_manual_review' }),
    ];
    const summary = buildCommandCenterSummary(runs);
    expect(summary.activeRunId).toBe(runs[1].id);
  });

  it('is null when nothing is queued or running', () => {
    const runs = [run({ status: 'ready_for_review' }), run({ status: 'approved' })];
    const summary = buildCommandCenterSummary(runs);
    expect(summary.activeRunId).toBeNull();
  });
});

describe('greetingName', () => {
  it('prefers the most recent non-empty sender_name already stored on a run', () => {
    const runs = [run({ sender_name: null }), run({ sender_name: 'Annant Sharma' }), run({ sender_name: 'Old Name' })];
    expect(greetingName(runs, 'someone@example.com')).toBe('Annant Sharma');
  });

  it('falls back to a titleized version of the email local part', () => {
    expect(greetingName([], 'annant.sharma@example.com')).toBe('Annant Sharma');
  });

  it('falls back to null when nothing is available', () => {
    expect(greetingName([], null)).toBeNull();
  });
});

describe('timeOfDayGreeting', () => {
  it('greets morning, afternoon and evening correctly', () => {
    expect(timeOfDayGreeting(new Date('2026-01-01T08:00:00'))).toBe('Good morning');
    expect(timeOfDayGreeting(new Date('2026-01-01T14:00:00'))).toBe('Good afternoon');
    expect(timeOfDayGreeting(new Date('2026-01-01T20:00:00'))).toBe('Good evening');
    expect(timeOfDayGreeting(new Date('2026-01-01T02:00:00'))).toBe('Good evening');
  });
});

// The homepage used to embed the real LiveRunView, which meant `/` rendered
// all fourteen stages, their retry affordances and a realtime subscription —
// the run workspace on a triage surface. It now shows four short strings and
// a link. These pin that shape: enough to say work is happening and where it
// has reached, and nothing that belongs to /runs/[id].

describe('buildActiveRunSummary — compact, never the pipeline', () => {
  const stage = (name: string, order: number, status: string) =>
    ({ stage_name: name, stage_order: order, status }) as never;

  const activeRun = (over: Partial<RunRow> = {}): RunRow =>
    run({
      status: 'running',
      prospect_name: 'Kannan Ganesan',
      company_name: 'Myntra',
      ...over,
    });

  it('names the stage actually running', () => {
    const s = buildActiveRunSummary(activeRun(), [
      stage('validate_input', 1, 'complete'),
      stage('identify_prospect', 2, 'running'),
      stage('resolve_candidate', 3, 'pending'),
    ]);

    expect(s.prospectName).toBe('Kannan Ganesan');
    expect(s.companyName).toBe('Myntra');
    expect(s.statusLabel).toBe('Research in progress');
    expect(s.currentStageLabel).toBe('Identify prospect');
  });

  it('falls back to the next pending stage before anything has started', () => {
    const s = buildActiveRunSummary(activeRun({ status: 'queued' }), [
      stage('validate_input', 1, 'pending'),
      stage('identify_prospect', 2, 'pending'),
    ]);

    expect(s.statusLabel).toBe('Queued');
    expect(s.currentStageLabel).toBe('Validate input');
  });

  it('reads stage order, not array order', () => {
    const s = buildActiveRunSummary(activeRun(), [
      stage('resolve_candidate', 3, 'pending'),
      stage('identify_prospect', 2, 'pending'),
    ]);
    expect(s.currentStageLabel).toBe('Identify prospect');
  });

  it('survives an empty stage list rather than throwing', () => {
    const s = buildActiveRunSummary(activeRun(), []);
    expect(s.currentStageLabel).toBeNull();
    expect(s.runId).toBeTruthy();
  });

  it('carries only the four display fields — no stages, signals, draft or sources', () => {
    const s = buildActiveRunSummary(activeRun(), [stage('identify_prospect', 2, 'running')]);

    expect(Object.keys(s).sort()).toEqual([
      'companyName',
      'currentStageLabel',
      'prospectName',
      'runId',
      'statusLabel',
    ]);
  });
});
