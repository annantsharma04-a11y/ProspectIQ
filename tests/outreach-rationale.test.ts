import { describe, it, expect } from 'vitest';
import { buildOutreachRationale, NO_SOLUTION_MATCH_MESSAGE } from '@/lib/ui/outreach-rationale';
import type { DraftRow, RunRow, RunSnapshot, RunStageRow, SignalRow } from '@/lib/types';
import type { CompanyFit, EvidenceItem, ProspectFit, TargetQualification } from '@/lib/qualification/types';

// buildOutreachRationale reads ONLY what the pipeline already persisted — this
// file proves it never fabricates a field, and correctly reports "no match"
// when generateMessageStage recorded none.

const ev = (url: string): EvidenceItem => ({ url, quote: 'A verified excerpt.' });

const prospectFit = (): ProspectFit =>
  ({
    score: 80,
    classification: 'HIGH',
    role: 'VP Finance',
    seniority: 'VP',
    relevance_reason: 'Owns AP and reconciliation.',
    decision_authority: 'HIGH',
    product_relevance: 'HIGH',
    why_this_person: [],
    why_not_this_person: [],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence: [ev('https://example.com/prospect')],
  }) as ProspectFit;

const companyFit = (): CompanyFit =>
  ({
    score: 78,
    classification: 'HIGH',
    industry: 'Logistics',
    company_size: '1,000+',
    relevant_workflows: ['accounts payable'],
    capability_matches: [],
    fit_reasons: [{ reason: 'Multi-entity vendor payment volume observed.', basis: 'OBSERVED', evidence: [ev('https://example.com/report')] }],
    missing_information: [],
    evidence_basis: 'OBSERVED',
    evidence_adjustment: null,
  }) as CompanyFit;

const qualification = (): TargetQualification =>
  ({
    prospect_fit: prospectFit(),
    company_fit: companyFit(),
    overall_fit: 78,
    classification: 'QUALIFIED',
    reason: 'Strong evidenced fit.',
    proceed: true,
    suggestion: null,
    action: 'TARGET_DIRECTLY',
  }) as TargetQualification;

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'run-1',
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
    status: 'ready_for_review',
    overall_confidence: 80,
    selected_hook: 'Acme raised a $40M Series B',
    generated_message: 'Saw the hiring push around finance ops at Acme.',
    insufficient_evidence: false,
    error: null,
    ai_error_type: null,
    identity_status: 'VERIFIED',
    identity_resolution: 'AUTOMATIC',
    identity_verification: null,
    qualification: qualification(),
    qualification_status: 'QUALIFIED',
    overall_fit: 78,
    started_at: null,
    completed_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  }) as RunRow;

const hookSignal = (over: Partial<SignalRow> = {}): SignalRow =>
  ({
    id: 'sig-1',
    run_id: 'run-1',
    signal: 'Acme raised a $40M Series B',
    why_it_matters: 'Fresh capital usually precedes finance-ops hiring.',
    category: 'funding',
    source_url: 'https://techcrunch.com/acme-series-b',
    source_title: 'Acme raises $40M Series B',
    source_type: 'news_major',
    published_date: '2026-05-01',
    supporting_quote: 'Acme announced a $40M Series B',
    relevance_score: 80,
    specificity_score: 90,
    recency_score: 85,
    confidence_score: 85,
    credibility_score: 90,
    corroboration_count: 1,
    composite_score: 85,
    conflicts_with: null,
    selected_as_hook: true,
    retrieved_at: '2026-08-01T00:00:00.000Z',
    ...over,
  }) as SignalRow;

const draft = (over: Partial<DraftRow> = {}): DraftRow =>
  ({
    id: 'draft-1',
    run_id: 'run-1',
    hook_signal_id: 'sig-1',
    mode: 'personalized',
    subject: 'Quick note',
    message_text: 'Saw the hiring push around finance ops at Acme.',
    final_text: null,
    personalization_basis: 'Acme raised a $40M Series B',
    reasoning: null,
    claims: null,
    validation_status: 'pass',
    validation_notes: null,
    sensitivity_note: null,
    confidence: 80,
    information_requests: null,
    reviewer_action: null,
    edited_text: null,
    reviewed_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    ...over,
  }) as DraftRow;

const generateMessageStage = (output: unknown): RunStageRow =>
  ({
    id: 'stage-generate-message',
    run_id: 'run-1',
    stage_name: 'generate_message',
    stage_order: 12,
    status: 'complete',
    summary: 'Personalised draft.',
    output,
    error: null,
    duration_ms: 1000,
    started_at: '2026-08-01T00:00:00.000Z',
    completed_at: '2026-08-01T00:00:00.000Z',
  }) as RunStageRow;

const snapshot = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({
  run: run(),
  stages: [],
  signals: [hookSignal()],
  sources: [],
  draft: draft(),
  contactCandidates: [],
  ...over,
});

describe('buildOutreachRationale', () => {
  it('returns null when there is no draft yet', () => {
    expect(buildOutreachRationale(snapshot({ draft: null }))).toBeNull();
  });

  it('returns null when qualification never ran', () => {
    expect(buildOutreachRationale(snapshot({ run: run({ qualification: null }) }))).toBeNull();
  });

  it('surfaces account fit and contact fit exactly as qualification recorded them', () => {
    const r = buildOutreachRationale(snapshot())!;
    expect(r.accountFit.classification).toBe('HIGH');
    expect(r.accountFit.score).toBe(78);
    expect(r.accountFit.reason).toBe('Multi-entity vendor payment volume observed.');
    expect(r.contactFit.classification).toBe('HIGH');
    expect(r.contactFit.score).toBe(80);
    expect(r.contactFit.reason).toBe('Owns AP and reconciliation.');
  });

  it('surfaces the primary verified signal from the selected-hook signal row', () => {
    const r = buildOutreachRationale(snapshot())!;
    expect(r.primarySignal).toEqual({
      signal: 'Acme raised a $40M Series B',
      sourceUrl: 'https://techcrunch.com/acme-series-b',
      quote: 'Acme announced a $40M Series B',
    });
  });

  it('primary signal is null when the draft has no hook signal row (defensive, should not occur in practice)', () => {
    const r = buildOutreachRationale(snapshot({ signals: [] }))!;
    expect(r.primarySignal).toBeNull();
  });

  it('reads the approved solution from the generate_message stage output when present', () => {
    const r = buildOutreachRationale(
      snapshot({
        stages: [
          generateMessageStage({
            approved_solution: {
              name: 'AP Automation Suite',
              why_it_fits: 'AP Automation Suite addresses the observed vendor-payment workflow.',
            },
            solution_match_note: null,
          }),
        ],
      }),
    )!;
    expect(r.solutionName).toBe('AP Automation Suite');
    expect(r.whyItFits).toBe('AP Automation Suite addresses the observed vendor-payment workflow.');
  });

  it('falls back to "no match" wording when generate_message recorded none', () => {
    const r = buildOutreachRationale(
      snapshot({
        stages: [generateMessageStage({ approved_solution: null, solution_match_note: NO_SOLUTION_MATCH_MESSAGE })],
      }),
    )!;
    expect(r.solutionName).toBeNull();
    expect(r.whyItFits).toBe(NO_SOLUTION_MATCH_MESSAGE);
  });

  it('falls back to "no match" wording when the generate_message stage is missing entirely', () => {
    const r = buildOutreachRationale(snapshot({ stages: [] }))!;
    expect(r.solutionName).toBeNull();
    expect(r.whyItFits).toBe(NO_SOLUTION_MATCH_MESSAGE);
  });
});
