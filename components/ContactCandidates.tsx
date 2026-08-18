'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ContactCandidateRow } from '@/lib/contacts/types';
import { NO_LINKEDIN_MESSAGE, canSelectCandidate, interpretSelectResponse } from '@/lib/contacts/select-ui';
import { StatusBadge, type StatusTone } from './StatusBadge';

const STATUS_TONE: Record<string, StatusTone> = {
  DISCOVERED: 'neutral',
  PARTIAL: 'amber',
  VERIFIED: 'emerald',
  AMBIGUOUS: 'amber',
  FAILED: 'red',
  REJECTED: 'neutral',
};

interface Outcome {
  kind: 'error' | 'info';
  message: string;
}

/**
 * Suggested contacts at a company that qualified when the submitted person did
 * not. Selecting one runs the SAME identity verification every prospect goes
 * through — nothing here is trusted just because discovery proposed it, and
 * nothing is ever selected automatically.
 *
 * Two things this component must never do, both fixed here after a live
 * report of a silent no-op button:
 *   - offer Select on a candidate with no LinkedIn URL. The identity system
 *     has nothing to verify against, and the server correctly refuses (422) —
 *     but a caller should never be invited to click a button that can only
 *     fail. The button is disabled before the click, not after.
 *   - leave the UI looking unchanged after a real server response. Every
 *     outcome — success, ambiguous, failed, network error — gets a visible,
 *     specific state, and a non-success response refreshes the page's server
 *     data so a stale "Select" button never lingers on a candidate the server
 *     already resolved.
 */
export function ContactCandidates({
  runId,
  candidates,
}: {
  runId: string;
  candidates: ContactCandidateRow[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  if (candidates.length === 0) {
    return (
      <div className="rounded-xl border border-hairline bg-surface p-5">
        <p className="text-sm font-semibold uppercase tracking-wide text-faint">
          Account qualified &middot; Contact not qualified
        </p>
        <p className="mt-2 text-sm text-ink/85">
          This company appears relevant, but this person is not the best contact for the identified
          workflow.
        </p>
        <p className="mt-2 text-sm text-muted">
          No verified contact candidates found. ProspectIQ could not establish a suitable contact
          from public evidence.
        </p>
      </div>
    );
  }

  async function select(candidateId: string) {
    setBusyId(candidateId);
    setOutcomes((prev) => {
      const next = { ...prev };
      delete next[candidateId];
      return next;
    });

    let res: Response;
    try {
      res = await fetch(`/api/runs/${runId}/contact-candidates/${candidateId}/select`, {
        method: 'POST',
      });
    } catch {
      setBusyId(null);
      setOutcomes((prev) => ({
        ...prev,
        [candidateId]: { kind: 'error', message: 'Could not reach the server. Check your connection and try again.' },
      }));
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await res.json();
    } catch {
      setBusyId(null);
      setOutcomes((prev) => ({
        ...prev,
        [candidateId]: { kind: 'error', message: 'The server returned an unreadable response. Try again.' },
      }));
      return;
    }

    const outcome = interpretSelectResponse({ ok: res.ok, status: res.status, body });

    if (outcome.type === 'navigate') {
      // Navigating away — no need to clear busyId, the component is leaving.
      router.push(`/runs/${outcome.runId}`);
      return;
    }

    setBusyId(null);
    setOutcomes((prev) => ({ ...prev, [candidateId]: { kind: outcome.kind, message: outcome.message } }));
    // The server already persisted the real outcome (AMBIGUOUS/FAILED/etc, or
    // a rejection like "no LinkedIn URL") even though this request did not
    // produce a run. Refresh so this candidate's status — and its Select
    // button — reflect that instead of staying on stale, pre-click data.
    router.refresh();
  }

  const anyBusy = busyId !== null;

  return (
    <div className="rounded-xl border border-hairline bg-surface p-5">
      <p className="text-sm font-semibold uppercase tracking-wide text-faint">
        Account qualified &middot; Contact not qualified
      </p>
      <p className="mt-1 text-sm text-ink/85">
        This company appears relevant, but this person is not the best contact for the identified
        workflow.
      </p>

      <h4 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-faint">
        Suggested contacts at this company
      </h4>
      <ul className="space-y-2.5">
        {candidates.map((c) => {
          const resolved = c.identity_status !== 'DISCOVERED';
          const hasLinkedIn = Boolean(c.linkedin_url);
          const selectable = canSelectCandidate(c);
          const isBusy = busyId === c.id;
          const outcome = outcomes[c.id];

          return (
            <li
              key={c.id}
              className={`rounded-lg border p-3 transition-opacity ${
                isBusy ? 'border-accent/25 bg-accent/6' : 'border-hairline'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{c.name ?? 'Unnamed candidate'}</p>
                  <p className="truncate text-xs text-faint">
                    {[c.role, c.company].filter(Boolean).join(' · ') || 'Role not established'}
                  </p>
                </div>
                <StatusBadge tone={STATUS_TONE[c.identity_status] ?? STATUS_TONE.DISCOVERED} className="shrink-0">
                  {c.identity_status === 'DISCOVERED' ? 'Not yet verified' : c.identity_status}
                </StatusBadge>
              </div>

              <p className="mt-1.5 text-xs text-muted">{c.reason}</p>
              {c.evidence[0] && (
                <p className="mt-1 truncate text-[11px] text-faint" title={c.evidence[0].quote}>
                  Evidence: &ldquo;{c.evidence[0].quote}&rdquo;
                </p>
              )}

              <div className="mt-2 flex items-center justify-between gap-3">
                {hasLinkedIn ? (
                  <a
                    href={c.linkedin_url!}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    LinkedIn ↗
                  </a>
                ) : (
                  <span className="text-xs text-faint">No LinkedIn URL</span>
                )}

                {resolved ? (
                  c.resulting_run_id ? (
                    <a
                      href={`/runs/${c.resulting_run_id}`}
                      className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover"
                    >
                      View run
                    </a>
                  ) : (
                    <span className="text-xs text-faint">
                      {c.identity_status === 'AMBIGUOUS'
                        ? 'Ambiguous — choose another or confirm manually'
                        : `${c.identity_status.toLowerCase()} — not eligible to continue`}
                    </span>
                  )
                ) : !selectable ? (
                  <button
                    type="button"
                    disabled
                    title={NO_LINKEDIN_MESSAGE}
                    className="cursor-not-allowed rounded-lg bg-ink/8 px-3 py-1 text-xs font-medium text-faint"
                  >
                    Select
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => select(c.id)}
                    disabled={anyBusy}
                    aria-busy={isBusy}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isBusy && (
                      <span
                        aria-hidden
                        className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white"
                      />
                    )}
                    {isBusy ? 'Verifying…' : 'Select'}
                  </button>
                )}
              </div>

              {!resolved && !selectable && (
                <p className="mt-2 text-xs text-faint">{NO_LINKEDIN_MESSAGE}</p>
              )}

              {outcome?.message && (
                <p
                  className={`mt-2 rounded px-2 py-1.5 text-xs ${
                    outcome.kind === 'error' ? 'bg-red-600/8 text-red-800' : 'bg-amber-600/8 text-amber-800'
                  }`}
                  role="status"
                >
                  {outcome.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
