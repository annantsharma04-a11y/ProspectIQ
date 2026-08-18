import { describe, it, expect } from 'vitest';
import { classifyFailure, stageFromError, editableInputFrom } from '@/lib/pipeline/failure-classification';
import type { RunRow } from '@/lib/types';

// The rule this file guards: a user is asked to correct their input ONLY when
// their input is what broke. Offering an edit form for a Gemini quota outage
// implies they caused it and wastes their time; offering a bare Retry for a
// malformed LinkedIn URL loops forever, because nothing about the run changed.

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'run-1',
    linkedin_url: 'https://www.linkedin.com/in/jane-doe',
    linkedin_slug: 'jane-doe',
    input_name: null,
    input_company: null,
    input_title: null,
    user_id: 'u1',
    prospect_id: 'p1',
    status: 'failed',
    error: null,
    ai_error_type: null,
    identity_status: null,
    insufficient_evidence: false,
    qualification_status: null,
    ...over,
  }) as RunRow;

describe('stageFromError', () => {
  it('reads the stage prefix failRun() writes', () => {
    expect(stageFromError('validate_input: not a profile URL')).toBe('validate_input');
    expect(stageFromError('research_company: Search provider unavailable')).toBe('research_company');
  });

  it('returns null for an unprefixed or unknown-stage error', () => {
    expect(stageFromError('something exploded')).toBeNull();
    expect(stageFromError('not_a_stage: whatever')).toBeNull();
    expect(stageFromError(null)).toBeNull();
  });
});

// ─── not a failure at all ───────────────────────────────────────────────────

describe('a run that did not fail has nothing to classify', () => {
  it('returns null for a completed run', () => {
    expect(classifyFailure(run({ status: 'ready_for_review' }))).toBeNull();
    expect(classifyFailure(run({ status: 'approved' }))).toBeNull();
  });

  it('returns null for a run held for review after a VERIFIED identity', () => {
    // Not qualified / no verified hook are real OUTCOMES, not failures — there
    // is nothing here for the user to correct or retry.
    expect(
      classifyFailure(
        run({
          status: 'needs_manual_review',
          identity_status: 'VERIFIED',
          qualification_status: 'NOT_QUALIFIED',
          insufficient_evidence: true,
        }),
      ),
    ).toBeNull();
  });

  it('returns null for a run still in progress', () => {
    expect(classifyFailure(run({ status: 'running' }))).toBeNull();
    expect(classifyFailure(run({ status: 'queued' }))).toBeNull();
  });
});

// ─── editable: the user's input caused it ───────────────────────────────────

describe('EDITABLE — an invalid LinkedIn URL', () => {
  const invalidUrl = run({ error: 'validate_input: "acme" is not a valid LinkedIn profile name.' });

  it('is editable and offers only the URL', () => {
    const c = classifyFailure(invalidUrl)!;
    expect(c.kind).toBe('EDITABLE');
    expect(c.isEditable).toBe(true);
    expect(c.editableFields).toEqual(['linkedin_url']);
  });

  it('explains the problem without leaking parser internals, and says what to do', () => {
    const c = classifyFailure(invalidUrl)!;
    expect(c.explanation).toMatch(/not a valid public profile link/i);
    expect(c.editHint).toMatch(/linkedin\.com\/in\//i);
  });

  it('restarts from validate_input', () => {
    expect(classifyFailure(invalidUrl)!.retryFromStage).toBe('validate_input');
    expect(classifyFailure(invalidUrl)!.retryAction).toBe('retry');
  });
});

describe('EDITABLE — identity could not be settled', () => {
  it('treats an AMBIGUOUS identity as correctable, offering hints AND the URL', () => {
    const c = classifyFailure(
      run({ status: 'needs_manual_review', identity_status: 'AMBIGUOUS', insufficient_evidence: true }),
    )!;
    expect(c.isEditable).toBe(true);
    expect(c.editableFields).toEqual(['linkedin_url', 'input_name', 'input_company', 'input_title']);
    expect(c.explanation).toMatch(/more than one public identity/i);
  });

  it('treats a FAILED identity as correctable', () => {
    const c = classifyFailure(run({ status: 'needs_manual_review', identity_status: 'FAILED' }))!;
    expect(c.isEditable).toBe(true);
    expect(c.explanation).toMatch(/could not be verified/i);
  });

  it('treats a PARTIAL identity as correctable', () => {
    expect(classifyFailure(run({ status: 'needs_manual_review', identity_status: 'PARTIAL' }))!.isEditable).toBe(true);
  });

  it('does NOT treat a VERIFIED identity as correctable, whatever else happened', () => {
    expect(classifyFailure(run({ status: 'needs_manual_review', identity_status: 'VERIFIED' }))).toBeNull();
  });
});

describe('EDITABLE — input-driven stage failures', () => {
  for (const [stage, label] of [
    ['identify_prospect', 'profile retrieval'],
    ['resolve_candidate', 'candidate resolution'],
    ['verify_identity', 'identity verification'],
  ] as const) {
    it(`${stage} (${label}) is editable and offers every input field`, () => {
      const c = classifyFailure(run({ error: `${stage}: something about the person` }))!;
      expect(c.kind).toBe('EDITABLE');
      expect(c.editableFields).toContain('linkedin_url');
      expect(c.editableFields).toContain('input_company');
      expect(c.editHint).toBeTruthy();
    });
  }
});

// ─── infrastructure: valid input, provider problem ──────────────────────────

describe('INFRASTRUCTURE — never asks the user to edit anything', () => {
  const cases: [string, Partial<RunRow>][] = [
    ['model quota exhausted', { ai_error_type: 'quota_exhausted', status: 'ai_analysis_pending' }],
    ['model rate limited', { ai_error_type: 'rate_limited', status: 'ai_analysis_pending' }],
    ['model unavailable', { ai_error_type: 'model_unavailable', status: 'ai_analysis_pending' }],
    ['provider error', { ai_error_type: 'provider_error', status: 'failed' }],
    ['invalid request to provider', { ai_error_type: 'invalid_request', status: 'failed' }],
    ['search provider down', { error: 'research_prospect: Search provider unavailable: timeout' }],
    ['company research failed', { error: 'research_company: Search provider unavailable: 503' }],
    ['analysis stage failed', { error: 'evaluate_signals: Gemini timed out' }],
    ['scrape/collect failed', { error: 'collect_signals: nothing usable was collected' }],
    ['unrecognised failure', { error: 'something exploded' }],
  ];

  for (const [label, patch] of cases) {
    it(`${label}: not editable, no fields offered`, () => {
      const c = classifyFailure(run(patch))!;
      expect(c.kind).toBe('INFRASTRUCTURE');
      expect(c.isEditable).toBe(false);
      expect(c.editableFields).toEqual([]);
      expect(c.editHint).toBeNull();
    });
  }

  it('says plainly that the input was not the problem', () => {
    const c = classifyFailure(run({ error: 'collect_signals: nothing usable' }))!;
    expect(c.explanation).toMatch(/not caused by your input/i);
  });

  it('resumes analysis-only failures from evaluate_signals, not the whole pipeline', () => {
    const c = classifyFailure(run({ status: 'ai_analysis_pending', ai_error_type: 'quota_exhausted' }))!;
    expect(c.retryAction).toBe('retry-analysis');
    expect(c.retryFromStage).toBe('evaluate_signals');
  });

  it('re-runs everything when the failure was not analysis-only', () => {
    const c = classifyFailure(run({ status: 'failed', ai_error_type: 'provider_error' }))!;
    expect(c.retryAction).toBe('retry');
    expect(c.retryFromStage).toBe('validate_input');
  });

  it('handles ai_analysis_pending with no error type recorded', () => {
    const c = classifyFailure(run({ status: 'ai_analysis_pending' }))!;
    expect(c.kind).toBe('INFRASTRUCTURE');
    expect(c.retryAction).toBe('retry-analysis');
  });
});

// ─── configuration: neither editing nor retrying helps ──────────────────────

describe('CONFIGURATION — retrying provably cannot help', () => {
  it('classifies a rejected API credential as a deployment problem', () => {
    const c = classifyFailure(run({ ai_error_type: 'authentication_error' }))!;
    expect(c.kind).toBe('CONFIGURATION');
    expect(c.isEditable).toBe(false);
    expect(c.retryAction).toBeNull();
    expect(c.explanation).toMatch(/not configured correctly/i);
  });

  it('classifies a missing search provider as a deployment problem', () => {
    const c = classifyFailure(
      run({ error: 'validate_input: No search provider is configured (set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY).' }),
    )!;
    expect(c.kind).toBe('CONFIGURATION');
    expect(c.retryAction).toBeNull();
  });

  it('wins over the validate_input stage prefix, which would otherwise look editable', () => {
    // The message is emitted BY validate_input, but no amount of correcting
    // the URL will conjure an API key — so it must not offer an edit form.
    const c = classifyFailure(
      run({ error: 'validate_input: No search provider is configured (set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY).' })
    )!;
    expect(c.isEditable).toBe(false);
    expect(c.editableFields).toEqual([]);
  });
});

// ─── the editable snapshot handed to the form ───────────────────────────────

describe('editableInputFrom', () => {
  it('carries exactly the four correctable fields', () => {
    const r = run({
      linkedin_url: 'https://www.linkedin.com/in/jane-doe',
      input_name: 'Jane Doe',
      input_company: 'Acme',
      input_title: 'VP Finance',
    });
    expect(editableInputFrom(r)).toEqual({
      linkedin_url: 'https://www.linkedin.com/in/jane-doe',
      input_name: 'Jane Doe',
      input_company: 'Acme',
      input_title: 'VP Finance',
    });
  });
});
