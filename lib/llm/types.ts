// Provider-neutral LLM contracts.
//
// Nothing outside lib/llm should know which vendor is behind these types, so a
// different provider can be dropped in without touching the pipeline.

export type LLMErrorType =
  | 'quota_exhausted'      // hard cap (per-day / per-project) — retrying will not help
  | 'rate_limited'         // short-window throttle — a bounded retry can help
  | 'model_unavailable'    // model retired, not found, or not enabled for this key
  | 'authentication_error' // missing or rejected credentials
  | 'invalid_request'      // our payload was wrong (schema, size, encoding)
  | 'provider_error';      // 5xx, network, timeout, malformed or empty output

export class LLMError extends Error {
  constructor(
    message: string,
    readonly type: LLMErrorType,
    readonly status?: number,
    /** Model that produced the failure, for the run record. */
    readonly model?: string,
    /** Provider detail — never contains credentials. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'LLMError';
  }

  /** True when trying a different model is worth doing. */
  get shouldTryFallbackModel(): boolean {
    return this.type === 'quota_exhausted' || this.type === 'model_unavailable';
  }

  /** True when retrying the SAME model after a short wait is worth doing. */
  get shouldRetrySameModel(): boolean {
    return this.type === 'rate_limited' || this.type === 'provider_error';
  }

  /** Message safe to show a user — no provider internals, no identifiers. */
  get userMessage(): string {
    switch (this.type) {
      case 'quota_exhausted':
        return 'AI analysis is temporarily unavailable because the configured AI model quota has been exhausted. Your prospect data and research were collected successfully and the analysis can be retried later.';
      case 'rate_limited':
        return 'AI analysis was rate limited. Your prospect data and research were collected successfully — retry the analysis in a moment.';
      case 'model_unavailable':
        return 'The configured AI model is not available. Your prospect data and research were collected successfully; update the model configuration and retry the analysis.';
      case 'authentication_error':
        return 'AI analysis is not configured correctly. Your prospect data and research were collected successfully and can be analysed once credentials are valid.';
      case 'invalid_request':
        return 'AI analysis could not process this prospect. The collected data has been kept for retry.';
      default:
        return 'AI analysis failed unexpectedly. Your prospect data and research were collected successfully and can be retried.';
    }
  }
}

/** JSON Schema subset accepted as a structured-output contract. */
export type JsonSchema = Record<string, unknown>;

export interface StructuredRequest {
  /** Short label used in logs and the run record, e.g. "analyze_prospect". */
  purpose: string;
  system: string;
  input: string;
  schema: JsonSchema;
  timeoutMs?: number;
}

export interface StructuredResponse<T> {
  data: T;
  meta: {
    /** The model that actually produced this — may be the fallback. */
    model: string;
    /** True when the primary model failed and the fallback answered. */
    used_fallback_model: boolean;
    purpose: string;
    duration_ms: number;
    attempts: number;
    total_tokens: number | null;
  };
}
