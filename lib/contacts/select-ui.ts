// Pure decision logic behind the Select button, extracted out of
// ContactCandidates.tsx so the exact behavior that was broken — a candidate
// with no LinkedIn URL still showing an enabled Select button, and a
// non-success server response leaving the UI looking unchanged — can be
// tested directly, without a DOM.

import type { ContactCandidateRow, ContactCandidateStatus } from './types';
import { preVerifyCandidate, type PreVerificationResult } from './preverify';

export const NO_LINKEDIN_MESSAGE = 'Cannot select: no public profile available for verification.';

/** What a row needs to carry for the Select gate to reach a decision. */
type SelectableCandidate = Pick<
  ContactCandidateRow,
  'identity_status' | 'linkedin_url' | 'name' | 'role' | 'company' | 'evidence'
>;

/**
 * Whether Select should be an active, clickable action for this candidate.
 *
 * Two independent conditions, both required:
 *
 *   1. The server has not already resolved this candidate. Anything but
 *      DISCOVERED (VERIFIED, AMBIGUOUS, FAILED, PARTIAL, REJECTED) is a
 *      finished outcome, not a pending choice.
 *   2. It passes lightweight pre-verification (lib/contacts/preverify.ts) —
 *      a real, normalizable profile URL, evidence that actually names this
 *      person, and evidence that actually ties them to this company.
 *
 * (2) is the fix for the reported failure: the button used to be enabled for
 * any DISCOVERED row with a non-empty URL string, so a candidate whose
 * evidence described a different person looked exactly as ready to select as
 * a good one, and the conflict only surfaced after the user had spent a full
 * verification pass on it. The button must not invite a click that can only
 * fail. This does NOT replace verification on selection — that still runs in
 * full, unchanged.
 */
export function canSelectCandidate(c: SelectableCandidate): boolean {
  if (c.identity_status !== 'DISCOVERED') return false;
  return preVerifyCandidate(c).eligibility === 'ELIGIBLE';
}

/** The full pre-verification result for a row, for the UI's state label and reason text. */
export function candidatePreVerification(c: SelectableCandidate): PreVerificationResult {
  return preVerifyCandidate(c);
}

/**
 * The identity_status this row should be treated as having for rendering —
 * fixes a real production report: a candidate card showed the "Pre-verified"
 * badge and an enabled Select button at the same time as an "already
 * reviewed and could not be verified (partial)" message. The message came
 * from a genuine, fresh /select response — the server had already persisted
 * PARTIAL for this candidate — but the badge and Select button were still
 * derived from the page's server-rendered `candidates` prop, which had not
 * yet caught up to that write.
 *
 * The fix is not to identity verification or persistence — both already do
 * the right thing — but to make every part of the card read the SAME
 * status: the freshest one actually known, which is whatever the server
 * most recently reported directly to this client (`freshStatus`), falling
 * back to the row's persisted status only when nothing fresher exists.
 */
export function effectiveIdentityStatus(
  persistedStatus: ContactCandidateStatus,
  freshStatus: ContactCandidateStatus | null | undefined,
): ContactCandidateStatus {
  return freshStatus ?? persistedStatus;
}

/** True when `value` is one of the real, persisted candidate statuses — never trusts an arbitrary API response string as one. */
export function isContactCandidateStatus(value: unknown): value is ContactCandidateStatus {
  return (
    typeof value === 'string' &&
    (['DISCOVERED', 'PARTIAL', 'VERIFIED', 'AMBIGUOUS', 'FAILED', 'REJECTED'] as string[]).includes(value)
  );
}

// ─── the /select response contract ──────────────────────────────────────────
//
// HTTP status and VERIFICATION RESULT are two different questions, and
// conflating them is what produced the reported bug: an idempotent re-select
// returned a perfectly successful HTTP 200 whose body the client could not
// read, and the fallback text announced "Could not verify this candidate
// (HTTP 200)" — reporting a transport code as though it were a verification
// verdict, for a request that had in fact succeeded.
//
// So the body now states the verification outcome explicitly instead of
// leaving the client to infer it from which fields happen to be present:
//
//   { ok: true,  status: 'verified',  runId }              → research started
//   { ok: false, status: 'ambiguous' | 'failed' | 'partial', message }
//   { ok: false, status: 'blocked',   message }            → pre-verification
//   HTTP 4xx/5xx                                           → transport/server
//
// `ok` here answers "did VERIFICATION succeed", never "did the HTTP request
// succeed" — the latter is `SelectApiResult.ok`, kept separate on purpose.

/** The verification verdict, reported independently of the HTTP status code. */
export type SelectionStatus = 'verified' | 'ambiguous' | 'failed' | 'partial' | 'blocked';

const SELECTION_STATUSES: SelectionStatus[] = ['verified', 'ambiguous', 'failed', 'partial', 'blocked'];

/** Map the persisted candidate status onto the wire contract's vocabulary. */
export function selectionStatusFor(identityStatus: string): SelectionStatus {
  switch (identityStatus) {
    case 'VERIFIED':
      return 'verified';
    case 'AMBIGUOUS':
      return 'ambiguous';
    case 'FAILED':
      return 'failed';
    case 'PARTIAL':
      return 'partial';
    default:
      return 'blocked';
  }
}

export interface SelectApiResult {
  /** Whether the HTTP request itself succeeded (`res.ok`) — NOT the verification verdict. */
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

export type SelectOutcome =
  | { type: 'navigate'; runId: string; message: string }
  | { type: 'message'; kind: 'error' | 'info'; message: string };

/** Shown when the response cannot be read at all — never phrased as a verification verdict. */
export const UNREADABLE_RESPONSE_MESSAGE =
  'The server returned an unexpected response, so this selection could not be confirmed. Try again.';

export const VERIFIED_MESSAGE = 'Candidate verified. Starting research…';

/**
 * What the UI should do with a /select response.
 *
 * Reads the explicit contract above when present, and only falls back to the
 * legacy field-shape for responses predating it. Two rules the old version
 * broke:
 *
 *   1. A verification VERDICT is only ever reported from the body, never
 *      inferred from the HTTP code. A 200 that says "ambiguous" is an
 *      ambiguous candidate; a 200 whose body is unreadable is a transport
 *      problem, and must not be announced as a failed verification.
 *   2. An already-resolved candidate that DID produce a run navigates to it.
 *      The old code looked for `run_id` while that path returns
 *      `resulting_run_id`, found neither a run nor a message, and fell all
 *      the way through to the generic HTTP fallback.
 */
export function interpretSelectResponse(result: SelectApiResult): SelectOutcome {
  const body = result.body ?? {};
  const message = typeof body.message === 'string' && body.message.trim() ? body.message : null;
  const error = typeof body.error === 'string' && body.error.trim() ? body.error : null;

  // Both field names are accepted: `run_id` from the success path, and
  // `resulting_run_id` from the idempotent already-resolved path.
  const runId =
    typeof body.runId === 'string'
      ? body.runId
      : typeof body.run_id === 'string'
        ? body.run_id
        : typeof body.resulting_run_id === 'string'
          ? body.resulting_run_id
          : null;

  // ── Transport/server failure: HTTP itself did not succeed ───────────────
  if (!result.ok) {
    return {
      type: 'message',
      kind: 'error',
      message: message ?? error ?? `The request failed (HTTP ${result.status}). Try again.`,
    };
  }

  // ── HTTP succeeded: the body states the verification verdict ────────────
  const status =
    typeof body.status === 'string' && (SELECTION_STATUSES as string[]).includes(body.status)
      ? (body.status as SelectionStatus)
      : null;

  if (status === 'verified' && runId) {
    return { type: 'navigate', runId, message: VERIFIED_MESSAGE };
  }

  if (status) {
    // A real verification verdict: candidate-specific, and never dressed up
    // as a transport error the user could fix by retrying the request.
    return {
      type: 'message',
      kind: 'info',
      message: message ?? error ?? `This candidate could not be verified (${status}). Choose another candidate.`,
    };
  }

  // ── Legacy shape (no explicit `status`) ─────────────────────────────────
  if (runId) {
    return { type: 'navigate', runId, message: VERIFIED_MESSAGE };
  }
  if (message ?? error) {
    return { type: 'message', kind: 'info', message: (message ?? error)! };
  }

  // Genuinely unreadable. Honest about which of the two things went wrong.
  return { type: 'message', kind: 'error', message: UNREADABLE_RESPONSE_MESSAGE };
}
