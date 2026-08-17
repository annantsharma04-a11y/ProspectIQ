'use client';

import { useState } from 'react';
import type { DraftRow } from '@/lib/types';

/** Strip internal "[automatic]" markers from reader-facing text. */
function humanize(text: string): string {
  return text.replace(/\[automatic\]\s*/g, '').replace(/\s+/g, ' ').trim();
}

const VERDICT_STYLE: Record<string, string> = {
  SUPPORTED: 'bg-green-100 text-green-700',
  UNCERTAIN: 'bg-amber-100 text-amber-700',
  UNSUPPORTED: 'bg-red-100 text-red-700',
  ALLOWED: 'bg-sky-100 text-sky-700',
};

const VALIDATION_STYLE: Record<string, string> = {
  pass: 'bg-green-100 text-green-700',
  revised: 'bg-blue-100 text-blue-700',
  flagged: 'bg-amber-100 text-amber-700',
};

export function DraftReviewCard({
  runId,
  draft,
  onReviewed,
}: {
  runId: string;
  draft: DraftRow;
  onReviewed: () => void;
}) {
  const reviewedText = draft.edited_text ?? draft.final_text ?? draft.message_text;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(reviewedText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(draft.reviewer_action);

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
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">
          {'Personalised draft'}
        </h3>
        <div className="flex items-center gap-2">
          {draft.confidence !== null && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
              confidence {draft.confidence}/100
            </span>
          )}
          {draft.validation_status && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                VALIDATION_STYLE[draft.validation_status] ?? 'bg-slate-100 text-slate-600'
              }`}
            >
              {draft.validation_status}
            </span>
          )}
        </div>
      </div>

      {draft.subject && (
        <p className="mb-2 text-sm text-slate-700">
          <span className="font-medium text-slate-500">Subject:</span> {draft.subject}
        </p>
      )}

      {editing ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={9}
          className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:border-indigo-500 focus:outline-none"
        />
      ) : (
        <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm leading-relaxed text-slate-800">
          {reviewedText}
        </p>
      )}

      {draft.final_text && draft.final_text !== draft.message_text && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-slate-500">
            Claim validation revised this message — show the original
          </summary>
          <p className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 text-slate-600">
            {draft.message_text}
          </p>
        </details>
      )}

      {claims.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
            Claim check
          </p>
          {claims.some((c) => c.verdict === 'UNCERTAIN') && (
            <p className="mb-1.5 rounded bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
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
                    VERDICT_STYLE[c.verdict] ?? 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {c.verdict}
                </span>
                <span className="text-slate-600">
                  {c.claim}
                  {c.explanation && <span className="text-slate-400"> — {humanize(c.explanation)}</span>}
                  {c.evidence_url && (
                    <a
                      href={c.evidence_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1 text-indigo-600 hover:underline"
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
        <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          {draft.sensitivity_note}
        </p>
      )}
      {draft.validation_notes && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-slate-500">Validator notes</summary>
          <p className="mt-1 whitespace-pre-wrap text-slate-600">{humanize(draft.validation_notes)}</p>
        </details>
      )}
      {draft.reasoning && (
        <details className="mt-1.5 text-xs">
          <summary className="cursor-pointer text-slate-500">Why it was written this way</summary>
          <p className="mt-1 text-slate-600">{draft.reasoning}</p>
        </details>
      )}

      {(draft.information_requests?.length ?? 0) > 0 && (
        <div className="mt-3 rounded-lg bg-slate-50 p-2.5">
          <p className="text-xs font-medium text-slate-600">
            Information that would make this stronger:
          </p>
          <ul className="mt-1 list-inside list-disc text-xs text-slate-500">
            {draft.information_requests!.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {done ? (
        <p className="mt-4 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700">
          Recorded: {done}. Nothing was sent — this app never contacts a prospect.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {editing ? (
            <>
              <button
                onClick={() => review('edited')}
                disabled={busy}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Save &amp; approve edit
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setText(reviewedText);
                }}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => review('approved')}
                disabled={busy}
                className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                Approve
              </button>
              <button
                onClick={() => setEditing(true)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Edit
              </button>
              <button
                onClick={() => review('rejected')}
                disabled={busy}
                className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
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
