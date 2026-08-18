'use client';

import { useEffect, useRef, useState } from 'react';
import type { DraftRow, RunRow } from '@/lib/types';
import { currentDraftText } from '@/lib/drafts/current-text';

/** Strip internal "[automatic]" markers from reader-facing text. */
function humanize(text: string): string {
  return text.replace(/\[automatic\]\s*/g, '').replace(/\s+/g, ' ').trim();
}

const VERDICT_STYLE: Record<string, string> = {
  SUPPORTED: 'bg-emerald-600/10 text-emerald-700',
  UNCERTAIN: 'bg-amber-600/10 text-amber-800',
  UNSUPPORTED: 'bg-red-600/10 text-red-700',
  ALLOWED: 'bg-accent/10 text-accent',
};

const VALIDATION_STYLE: Record<string, string> = {
  pass: 'bg-emerald-600/10 text-emerald-700',
  revised: 'bg-accent/10 text-accent',
  flagged: 'bg-amber-600/10 text-amber-800',
};

/** Shown once a review action is recorded. Every outcome restates the same
 *  guarantee — outreach is never sent by the app, only ever manually. */
const DONE_MESSAGE: Record<string, string> = {
  approved: 'Approved for outreach review. ProspectIQ prepares the message for you; outreach is always sent manually.',
  edited: 'Edit saved and approved for outreach review. ProspectIQ prepares the message for you; outreach is always sent manually.',
  rejected: 'Rejected. ProspectIQ prepares messages for review only — outreach is always sent manually, and this one will not be used.',
};

export function DraftReviewCard({
  runId,
  run,
  draft,
  onReviewed,
}: {
  runId: string;
  /** Watched only to know when a background regeneration has settled. */
  run: Pick<RunRow, 'status' | 'error'>;
  draft: DraftRow;
  onReviewed: () => void;
}) {
  const reviewedText = currentDraftText(draft);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(reviewedText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(draft.reviewer_action);

  // Regeneration replaces the draft row entirely (delete + insert, the same
  // pattern generate_message already uses), so a genuinely new draft arrives
  // here as a NEW `draft.id` — the parent remounts this component (keyed on
  // that id) once it does, which is the real "done" signal for success. This
  // local state exists only to show a busy state in between, and to surface a
  // failure — which does NOT produce a new draft.id, so has to be caught here.
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const wasRunning = useRef(false);

  useEffect(() => {
    if (run.status === 'running') {
      wasRunning.current = true;
      return;
    }
    if (regenerating && wasRunning.current) {
      // Settled. If this component is still mounted, no new draft.id arrived,
      // which means the regeneration failed rather than succeeded — success
      // would have remounted us with a fresh draft instead.
      setRegenerating(false);
      setRegenerateError(run.error ?? 'Could not generate a new draft. Try again.');
    }
    wasRunning.current = false;
  }, [run.status, run.error, regenerating]);

  async function regenerate() {
    setRegenerating(true);
    setRegenerateError(null);
    wasRunning.current = false;
    try {
      const res = await fetch(`/api/runs/${runId}/regenerate-message`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not start regeneration.');
      // Fires an immediate refetch; the run's own realtime subscription
      // (already active on this page) picks up further progress and the
      // eventual new draft without any polling here.
      onReviewed();
    } catch (err) {
      setRegenerating(false);
      setRegenerateError(err instanceof Error ? err.message : 'Something went wrong');
    }
  }

  async function review(action: 'approved' | 'edited' | 'rejected') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, edited_text: action === 'edited' ? text : undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not record the review');
      setDone(action);
      setEditing(false);
      onReviewed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const claims = draft.claims ?? [];

  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink/90">
          {'Personalised draft'}
        </h3>
        <div className="flex items-center gap-2">
          {draft.confidence !== null && (
            <span className="rounded-full bg-ink/6 px-2 py-0.5 text-xs font-medium text-muted">
              confidence {draft.confidence}/100
            </span>
          )}
          {draft.validation_status && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                VALIDATION_STYLE[draft.validation_status] ?? 'bg-ink/6 text-muted'
              }`}
            >
              {draft.validation_status}
            </span>
          )}
          <button
            onClick={regenerate}
            disabled={regenerating || busy}
            className="rounded-lg border border-hairline px-2.5 py-1 text-xs font-medium text-muted hover:bg-app disabled:opacity-50"
          >
            {regenerating ? 'Regenerating…' : 'Regenerate message'}
          </button>
        </div>
      </div>

      {regenerating && (
        <p className="mb-2 rounded-lg bg-accent/8 px-2.5 py-1.5 text-xs text-accent">
          Writing a new version of this message — same evidence, new wording. This page updates
          automatically when it is ready.
        </p>
      )}
      {regenerateError && (
        <p className="mb-2 rounded-lg bg-red-600/8 px-2.5 py-1.5 text-xs text-red-700">{regenerateError}</p>
      )}

      {draft.subject && (
        <p className="mb-2 text-sm text-ink/85">
          <span className="font-medium text-faint">Subject:</span> {draft.subject}
        </p>
      )}

      {editing ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={9}
          className="w-full rounded-lg border border-hairline p-3 text-sm focus:border-accent focus:outline-none"
        />
      ) : (
        <p className="whitespace-pre-wrap rounded-lg bg-app p-3 text-sm leading-relaxed text-ink/90">
          {reviewedText}
        </p>
      )}

      {draft.final_text && draft.final_text !== draft.message_text && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-faint">
            Claim validation revised this message — show the original
          </summary>
          <p className="mt-1 whitespace-pre-wrap rounded bg-app p-2 text-muted">
            {draft.message_text}
          </p>
        </details>
      )}

      {claims.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-faint">
            Claim check
          </p>
          {claims.some((c) => c.verdict === 'UNCERTAIN') && (
            <p className="mb-1.5 rounded bg-amber-600/6 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
              Some claims are marked uncertain: public search evidence was found, but the underlying
              page could not be fully retrieved, so they were not treated as fully corroborated.
              That is a confidence level, not an error.
            </p>
          )}
          <ul className="space-y-1.5">
            {claims.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <span
                  className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-semibold ${
                    VERDICT_STYLE[c.verdict] ?? 'bg-ink/6 text-muted'
                  }`}
                >
                  {c.verdict}
                </span>
                <span className="text-muted">
                  {c.claim}
                  {c.explanation && <span className="text-faint"> — {humanize(c.explanation)}</span>}
                  {c.evidence_url && (
                    <a
                      href={c.evidence_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1 text-accent hover:underline"
                    >
                      ↗
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {draft.sensitivity_note && (
        <p className="mt-2 rounded bg-amber-600/6 px-2 py-1.5 text-xs text-amber-800">
          {draft.sensitivity_note}
        </p>
      )}
      {draft.validation_notes && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-faint">Validator notes</summary>
          <p className="mt-1 whitespace-pre-wrap text-muted">{humanize(draft.validation_notes)}</p>
        </details>
      )}
      {draft.reasoning && (
        <details className="mt-1.5 text-xs">
          <summary className="cursor-pointer text-faint">Why it was written this way</summary>
          <p className="mt-1 text-muted">{draft.reasoning}</p>
        </details>
      )}

      {(draft.information_requests?.length ?? 0) > 0 && (
        <div className="mt-3 rounded-lg bg-app p-2.5">
          <p className="text-xs font-medium text-muted">
            Information that would make this stronger:
          </p>
          <ul className="mt-1 list-inside list-disc text-xs text-faint">
            {draft.information_requests!.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {done ? (
        <p className="mt-4 rounded-lg bg-ink/6 px-3 py-2 text-sm font-medium text-ink/85">
          {DONE_MESSAGE[done] ?? DONE_MESSAGE.approved}
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {editing ? (
            <>
              <button
                onClick={() => review('edited')}
                disabled={busy || regenerating}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
              >
                Save &amp; approve edit
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setText(reviewedText);
                }}
                className="rounded-lg border border-hairline px-3 py-1.5 text-sm font-medium text-ink/85"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => review('approved')}
                disabled={busy || regenerating}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Approve
              </button>
              <button
                onClick={() => setEditing(true)}
                disabled={regenerating}
                className="rounded-lg border border-hairline px-3 py-1.5 text-sm font-medium text-ink/85 hover:bg-app disabled:opacity-50"
              >
                Edit
              </button>
              <button
                onClick={() => review('rejected')}
                disabled={busy || regenerating}
                className="rounded-lg border border-red-600/30 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-600/8 disabled:opacity-50"
              >
                Reject
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
