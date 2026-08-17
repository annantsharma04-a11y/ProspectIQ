// Google Gemini provider.
//
// Uses the Interactions API (POST /v1/interactions). The older
// `:generateContent` endpoint is NOT usable: current models return 404
// "no longer available to new users" and Google's docs redirect to Interactions.
// Verified shape (2026-08):
//
//   POST https://generativelanguage.googleapis.com/v1/interactions
//   header: x-goog-api-key
//   body:   { model, system_instruction, input, response_format:[...] }
//   reply:  { status:'completed', steps:[ {type:'thought'}, {type:'model_output',
//             content:[{type:'text', text:'<json>'}]} ] }
//
// Responsibilities kept inside this module: model selection, request, structured
// output, retry policy, quota detection, fallback model, error normalization.

import { LLMError, type JsonSchema, type LLMErrorType, type StructuredRequest, type StructuredResponse } from './types';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1/interactions';
const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Both models are configuration, never hardcoded into pipeline logic. */
export function primaryModel(): string {
  return process.env.GEMINI_MODEL?.trim() || 'gemini-3.7-flash';
}

export function fallbackModel(): string | null {
  const configured = process.env.GEMINI_FALLBACK_MODEL?.trim();
  if (!configured) return null;
  return configured === primaryModel() ? null : configured;
}

export function hasGeminiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export type { JsonSchema };
export { LLMError };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Turn a provider failure into one of our error types.
 *
 * The distinction that matters most: a hard quota cap (retrying is pointless,
 * try another model) versus a short-window throttle (a brief wait fixes it).
 * Google signals both with 429, so the body text is what separates them.
 */
export function classifyError(status: number, body: string): LLMErrorType {
  const text = body.toLowerCase();

  if (status === 429) {
    // Per-day / per-project caps and exhausted free tiers are hard stops.
    const hardQuota =
      /per\s*day|daily|requests per day|free_tier|free tier|exceeded your current quota|resource[_ ]exhausted|billing/.test(
        text,
      );
    // A retry hint of a few seconds means a short window, not a hard cap.
    const shortWindow = /per\s*minute|try again in|retry in|tokens per minute|requests per minute/.test(text);

    if (hardQuota && !shortWindow) return 'quota_exhausted';
    if (shortWindow && !hardQuota) return 'rate_limited';
    // Google's free-tier message contains both; treat as exhausted so we move
    // to the fallback model rather than hammering a capped one.
    return hardQuota ? 'quota_exhausted' : 'rate_limited';
  }

  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 404) return 'model_unavailable';
  if (status === 400) {
    if (/api key|credential|unauthenticated/.test(text)) return 'authentication_error';
    if (/not found|not supported|unsupported model|no longer available/.test(text)) {
      return 'model_unavailable';
    }
    return 'invalid_request';
  }
  if (status >= 500) return 'provider_error';
  return 'provider_error';
}

interface GeminiInteraction {
  status?: string;
  usage?: { total_tokens?: number };
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
}

/**
 * Run one schema-constrained generation.
 *
 * Retry policy:
 *   provider_error / rate_limited → bounded exponential retry on the same model
 *   quota_exhausted / model_unavailable → no retry; switch to the fallback model
 *   authentication_error / invalid_request → no retry at all
 *
 * Throws LLMError on every failure path. It never returns partial or invented
 * data, and a failure here is recorded, not papered over.
 */
export async function callStructured<T>(req: StructuredRequest): Promise<StructuredResponse<T>> {
  if (!hasGeminiKey()) {
    throw new LLMError('GEMINI_API_KEY is not configured', 'authentication_error');
  }

  const models = [primaryModel(), fallbackModel()].filter((m): m is string => Boolean(m));
  const startedAt = Date.now();
  let attempts = 0;
  let lastError: LLMError | null = null;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex];
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts++;
      try {
        const { data, tokens } = await callOnce<T>(req, model);
        if (modelIndex > 0) {
          console.info(`[gemini] ${req.purpose}: primary model failed, answered by fallback ${model}`);
        }
        return {
          data,
          meta: {
            model,
            used_fallback_model: modelIndex > 0,
            purpose: req.purpose,
            duration_ms: Date.now() - startedAt,
            attempts,
            total_tokens: tokens,
          },
        };
      } catch (err) {
        const error = err instanceof LLMError ? err : new LLMError(String(err), 'provider_error');
        lastError = error;

        if (error.shouldRetrySameModel && attempt < maxAttempts) {
          await sleep(600 * 2 ** (attempt - 1));
          continue;
        }
        // Quota/unavailable: stop retrying this model and try the next one.
        break;
      }
    }

    if (lastError && !lastError.shouldTryFallbackModel) {
      // Auth errors and bad requests will fail identically on every model.
      throw lastError;
    }
    if (modelIndex < models.length - 1) {
      console.info(
        `[gemini] ${req.purpose}: ${models[modelIndex]} unusable (${lastError?.type}), trying fallback ${models[modelIndex + 1]}`,
      );
    }
  }

  throw lastError ?? new LLMError(`Gemini call failed for ${req.purpose}`, 'provider_error');
}

async function callOnce<T>(
  req: StructuredRequest,
  model: string,
): Promise<{ data: T; tokens: number | null }> {
  const apiKey = process.env.GEMINI_API_KEY!;
  const timeoutMs = req.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model,
        system_instruction: req.system,
        input: req.input,
        response_format: [{ type: 'text', mime_type: 'application/json', schema: req.schema }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const type = classifyError(res.status, body);
      throw new LLMError(
        `Gemini ${res.status} (${type}) for ${req.purpose}`,
        type,
        res.status,
        model,
        body.slice(0, 300),
      );
    }

    const json = (await res.json()) as GeminiInteraction;
    const text = extractOutputText(json);
    if (!text) {
      throw new LLMError(
        `Gemini returned no model output for ${req.purpose}`,
        'provider_error',
        res.status,
        model,
      );
    }

    try {
      return { data: JSON.parse(text) as T, tokens: json.usage?.total_tokens ?? null };
    } catch {
      throw new LLMError(
        `Gemini returned unparseable JSON for ${req.purpose}`,
        'provider_error',
        res.status,
        model,
        text.slice(0, 300),
      );
    }
  } catch (err) {
    if (err instanceof LLMError) throw err;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    throw new LLMError(
      isAbort ? `Gemini timed out after ${timeoutMs}ms for ${req.purpose}` : `Gemini request failed for ${req.purpose}`,
      'provider_error',
      undefined,
      model,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Reasoning models emit a `thought` step first; only `model_output` has the JSON. */
function extractOutputText(json: GeminiInteraction): string | null {
  for (const step of json.steps ?? []) {
    if (step.type !== 'model_output') continue;
    const part = (step.content ?? []).find((c) => c.type === 'text' && c.text);
    if (part?.text) return part.text;
  }
  return null;
}

/**
 * Models this API key can actually reach. Used by the doctor script and tests
 * so a fallback is never configured on faith.
 */
export async function listAvailableModels(): Promise<string[]> {
  if (!hasGeminiKey()) return [];
  const res = await fetch(MODELS_ENDPOINT, {
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY! },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { models?: { name?: string }[] };
  return (json.models ?? [])
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean);
}
