// Pure decision logic behind the Select button, extracted out of
// ContactCandidates.tsx so the exact behavior that was broken — a candidate
// with no LinkedIn URL still showing an enabled Select button, and a
// non-success server response leaving the UI looking unchanged — can be
// tested directly, without a DOM.

import type { ContactCandidateRow } from './types';

export const NO_LINKEDIN_MESSAGE = 'Cannot select: no public profile available for verification.';

/**
 * Whether Select should be an active, clickable action for this candidate.
 *
 * False once the server has already resolved the candidate (VERIFIED,
 * AMBIGUOUS, FAILED, PARTIAL, REJECTED — anything but DISCOVERED), and false
 * when there is no LinkedIn URL to verify against. The identity system has
 * nothing to check a name-only candidate against, and the server already
 * refuses with a 422 for exactly this reason — the button must not invite a
 * click that can only fail.
 */
export function canSelectCandidate(c: Pick<ContactCandidateRow, 'identity_status' | 'linkedin_url'>): boolean {
  return c.identity_status === 'DISCOVERED' && Boolean(c.linkedin_url && c.linkedin_url.trim());
}

export interface SelectApiResult {
  ok: boolean;
  status: number;
  /** The parsed JSON body. Only run_id/message/error are read; other fields (e.g. identity_status) are ignored here. */
  body: Record<string, unknown>;
}

export type SelectOutcome =
  | { type: 'navigate'; runId: string }
  | { type: 'message'; kind: 'error' | 'info'; message: string };

/**
 * What the UI should do with a /select response.
 *
 * Every branch produces a visible, specific outcome — there is no path here
 * that leaves the caller with nothing to show. `ok: true` with no `run_id`
 * (an AMBIGUOUS/FAILED/PARTIAL verification, or an idempotent re-select of an
 * already-resolved candidate) is reported as 'info', not silently treated as
 * success; anything else — a rejection status, a malformed body, a genuinely
 * unreadable response — is reported as 'error'.
 */
export function interpretSelectResponse(result: SelectApiResult): SelectOutcome {
  const runId = typeof result.body.run_id === 'string' ? result.body.run_id : null;
  if (result.ok && runId) {
    return { type: 'navigate', runId };
  }

  const message = typeof result.body.message === 'string' ? result.body.message : null;
  const error = typeof result.body.error === 'string' ? result.body.error : null;

  return {
    type: 'message',
    kind: result.ok ? 'info' : 'error',
    message: message ?? error ?? `Could not verify this candidate (HTTP ${result.status}). Try again.`,
  };
}
