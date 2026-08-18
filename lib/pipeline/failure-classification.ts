// Why a run stopped, and what — if anything — the user can do about it.
//
// The distinction this draws is the whole point: some failures are the user's
// input being wrong (a mistyped profile URL, a hint naming the wrong company),
// and some are a provider having a bad day. Offering "Edit your details" for a
// Gemini quota outage wastes the user's time and implies they caused it;
// offering a bare "Retry" for a malformed LinkedIn URL loops forever, because
// nothing about the run changed.
//
// Everything below is derived from data the pipeline ALREADY records — the
// stage-prefixed `error` string failRun() writes, `ai_error_type` from the LLM
// error classifier, and `identity_status` from verification. No new signal is
// invented and no judgment is re-litigated; this only reads what happened and
// names who can fix it.

import { STAGE_ORDER, type RunRow, type StageName } from '@/lib/types';

/**
 * Who can act on this failure.
 *
 *   EDITABLE       the user controls the input that caused it — correct and retry
 *   INFRASTRUCTURE valid input, provider/model/transient problem — plain retry
 *   CONFIGURATION  neither helps: the deployment itself is misconfigured
 *
 * CONFIGURATION is deliberately separate from INFRASTRUCTURE even though the
 * user cannot edit their way out of either. A missing API key does not become
 * available by retrying, and showing a Retry button for it produces a loop
 * that always fails — this is an operator problem and says so.
 */
export type FailureKind = 'EDITABLE' | 'INFRASTRUCTURE' | 'CONFIGURATION';

/** The run fields an EDITABLE failure lets the user correct. */
export type EditableField = 'linkedin_url' | 'input_name' | 'input_company' | 'input_title';

/** Which recovery endpoint applies. `null` when retrying cannot help. */
export type RetryAction = 'retry' | 'retry-analysis' | null;

export interface FailureClassification {
  kind: FailureKind;
  /** True only for EDITABLE — the single flag the UI branches on. */
  isEditable: boolean;
  /** Fields to offer for correction, in display order. Empty unless EDITABLE. */
  editableFields: EditableField[];
  /** Plain-language statement of what failed, for the user. Never provider internals. */
  explanation: string;
  /** What correcting this is expected to fix, shown alongside the edit form. Null unless EDITABLE. */
  editHint: string | null;
  retryAction: RetryAction;
  /**
   * The earliest stage a retry must re-run from. Any input edit invalidates
   * identity, and every later stage is built on identity, so a corrected
   * input always restarts at validate_input — there is no cheaper honest
   * resume point. An analysis-only failure resumes at evaluate_signals.
   */
  retryFromStage: StageName;
}

/**
 * Every field, in the order the edit form shows them.
 *
 * Identity failures offer the URL alongside the hints on purpose: "ambiguous
 * identity" is at least as often the wrong profile link as it is a thin hint,
 * and offering only the hints would quietly rule out the likeliest fix.
 */
const ALL_EDITABLE_FIELDS: EditableField[] = ['linkedin_url', 'input_name', 'input_company', 'input_title'];

/**
 * The stage name failRun() prefixes onto `run.error` (`"<stage>: <message>"`).
 * Returns null for an error that carries no recognised stage prefix.
 */
export function stageFromError(error: string | null): StageName | null {
  if (!error) return null;
  const prefix = error.split(':')[0]?.trim();
  return (STAGE_ORDER as readonly string[]).includes(prefix) ? (prefix as StageName) : null;
}

/** Deployment misconfiguration, recognised from the exact messages the pipeline emits. */
function isConfigurationProblem(run: RunRow): boolean {
  if (run.ai_error_type === 'authentication_error') return true;
  return /no search provider is configured/i.test(run.error ?? '');
}

/**
 * Classify a stopped run.
 *
 * Order matters: configuration is checked before everything (it masquerades as
 * an ordinary provider failure), then genuine input problems, then anything
 * left is treated as infrastructure. The default is deliberately
 * INFRASTRUCTURE rather than EDITABLE — asking someone to re-type correct
 * details to fix a problem they did not cause is worse than offering a retry
 * that turns out not to help.
 */
export function classifyFailure(run: RunRow): FailureClassification | null {
  const stoppedOnFailure = run.status === 'failed' || run.status === 'ai_analysis_pending';
  const identityUnresolved =
    run.status === 'needs_manual_review' &&
    Boolean(run.identity_status) &&
    run.identity_status !== 'VERIFIED';

  // A run that simply did not qualify, or found no verified hook, is a real
  // outcome and not a failure — it has nothing to retry or correct.
  if (!stoppedOnFailure && !identityUnresolved) return null;

  if (isConfigurationProblem(run)) {
    return {
      kind: 'CONFIGURATION',
      isEditable: false,
      editableFields: [],
      explanation:
        run.ai_error_type === 'authentication_error'
          ? 'AI analysis is not configured correctly for this deployment. Retrying will not help until the credentials are fixed.'
          : 'No search provider is configured for this deployment. Retrying will not help until one is set.',
      editHint: null,
      retryAction: null,
      retryFromStage: 'validate_input',
    };
  }

  // ── Model/provider failures: the input was fine ─────────────────────────
  if (run.ai_error_type) {
    const analysisOnly = run.status === 'ai_analysis_pending';
    return {
      kind: 'INFRASTRUCTURE',
      isEditable: false,
      editableFields: [],
      explanation: EXPLANATION_BY_AI_ERROR[run.ai_error_type] ?? 'AI analysis did not complete for this run.',
      editHint: null,
      // Research is already saved on the pending path, so recovery costs one
      // model call rather than a fresh round of provider spend.
      retryAction: analysisOnly ? 'retry-analysis' : 'retry',
      retryFromStage: analysisOnly ? 'evaluate_signals' : 'validate_input',
    };
  }

  if (run.status === 'ai_analysis_pending') {
    return {
      kind: 'INFRASTRUCTURE',
      isEditable: false,
      editableFields: [],
      explanation: 'AI analysis did not complete. The profile and research are saved and can be retried.',
      editHint: null,
      retryAction: 'retry-analysis',
      retryFromStage: 'evaluate_signals',
    };
  }

  // ── Identity could not be settled: usually a hint problem ───────────────
  if (identityUnresolved) {
    const ambiguous = run.identity_status === 'AMBIGUOUS';
    return {
      kind: 'EDITABLE',
      isEditable: true,
      // The URL is offered too: "ambiguous identity" is very often the wrong
      // profile URL rather than a weak hint.
      editableFields: ALL_EDITABLE_FIELDS,
      explanation: ambiguous
        ? 'More than one public identity matched this person, so the run stopped rather than guessing which one you meant.'
        : 'This person could not be verified against independent public sources, so the run stopped before researching them.',
      editHint:
        'Adding or correcting the name, company and role makes the identity check far more precise. Check the profile URL points at the right person.',
      retryAction: 'retry',
      retryFromStage: 'validate_input',
    };
  }

  // ── Stage-specific input failures ───────────────────────────────────────
  const stage = stageFromError(run.error);

  if (stage === 'validate_input') {
    return {
      kind: 'EDITABLE',
      isEditable: true,
      editableFields: ['linkedin_url'],
      explanation: 'The submitted LinkedIn URL is not a valid public profile link.',
      editHint: 'Paste the profile’s own URL, in the form linkedin.com/in/their-name.',
      retryAction: 'retry',
      retryFromStage: 'validate_input',
    };
  }

  if (stage === 'identify_prospect') {
    return {
      kind: 'EDITABLE',
      isEditable: true,
      editableFields: ALL_EDITABLE_FIELDS,
      explanation: 'The profile behind this URL could not be retrieved or matched to a person.',
      editHint:
        'Check the profile URL is correct and public. Adding the name, company and role also helps when the profile itself cannot be read.',
      retryAction: 'retry',
      retryFromStage: 'validate_input',
    };
  }

  if (stage === 'resolve_candidate' || stage === 'verify_identity') {
    return {
      kind: 'EDITABLE',
      isEditable: true,
      editableFields: ALL_EDITABLE_FIELDS,
      explanation: 'The run could not establish which person this profile refers to.',
      editHint: 'Correcting the name, company or role usually resolves this. Check the URL points at the right person.',
      retryAction: 'retry',
      retryFromStage: 'validate_input',
    };
  }

  // ── Everything else: valid input, something else went wrong ─────────────
  return {
    kind: 'INFRASTRUCTURE',
    isEditable: false,
    editableFields: [],
    explanation: infrastructureExplanation(run, stage),
    editHint: null,
    retryAction: 'retry',
    retryFromStage: 'validate_input',
  };
}

const EXPLANATION_BY_AI_ERROR: Record<string, string> = {
  quota_exhausted: 'AI analysis was unavailable because the model quota is exhausted. The research already collected is saved.',
  rate_limited: 'AI analysis was rate limited. The research already collected is saved.',
  model_unavailable: 'The configured AI model was unavailable. The research already collected is saved.',
  provider_error: 'The AI provider returned an error. The research already collected is saved.',
  invalid_request: 'The AI provider rejected the request. The research already collected is saved.',
};

/** Plain description of a non-input failure, without leaking provider internals. */
function infrastructureExplanation(run: RunRow, stage: StageName | null): string {
  const error = run.error ?? '';
  if (/search provider|tavily|brave/i.test(error)) {
    return 'Web search was unavailable during this run, so there was nothing to research from.';
  }
  if (/gemini|model/i.test(error)) {
    return 'AI analysis did not complete for this run.';
  }
  if (stage === 'research_prospect' || stage === 'research_company') {
    return 'Public research could not be completed for this run.';
  }
  return stage
    ? `The run stopped during ${stage.replace(/_/g, ' ')}. Your details look fine — this was not caused by your input.`
    : 'The run did not complete. Your details look fine — this was not caused by your input.';
}

/** The subset of a run a user may correct, as the edit form reads it. */
export interface EditableInput {
  linkedin_url: string;
  input_name: string | null;
  input_company: string | null;
  input_title: string | null;
}

export function editableInputFrom(run: RunRow): EditableInput {
  return {
    linkedin_url: run.linkedin_url,
    input_name: run.input_name,
    input_company: run.input_company,
    input_title: run.input_title,
  };
}
