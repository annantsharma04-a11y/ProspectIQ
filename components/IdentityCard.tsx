'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { IdentityVerification } from '@/lib/identity/types';
import { explainCandidate } from '@/lib/identity/explain';

const STATUS_TONE: Record<string, string> = {
  VERIFIED: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  PARTIAL: 'border-amber-300 bg-amber-50 text-amber-900',
  AMBIGUOUS: 'border-amber-400 bg-amber-50 text-amber-900',
  FAILED: 'border-red-300 bg-red-50 text-red-900',
};

/**
 * Who the run decided this person is — shown before any targeting, because
 * everything downstream is meaningless if this is the wrong human.
 *
 * When several public identities match, the run stops here and asks rather than
 * silently picking one.
 */
export function IdentityCard({
  runId,
  verification,
  onResolved,
}: {
  runId: string;
  verification: IdentityVerification;
  onResolved: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needsChoice = verification.status === 'AMBIGUOUS' && verification.candidates.length > 1;

  async function select(candidateId: string) {
    setBusy(candidateId);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/identity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate_id: candidateId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not record the selection');
      onResolved();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  }

  if (needsChoice) {
    return (
      <div className="rounded-xl border border-amber-300 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-amber-900">
          Identity needs confirmation
        </h3>
        <p className="mt-1 text-sm text-slate-700">
          Multiple public identities may match this prospect. Select the person you want ProspectIQ
          to analyze.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Qualification and outreach have not started.
        </p>

        <ul className="mt-4 space-y-3">
          {verification.candidates.map((c) => (
            <li key={c.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900">{c.name ?? 'Unnamed'}</p>
                  <p className="mt-0.5 text-sm text-slate-700">
                    {c.role ?? 'Role unknown'}
                    {c.company ? ` · ${c.company}` : ''}
                  </p>
                  {c.location ? <p className="text-xs text-slate-500">{c.location}</p> : null}
                  {c.headline ? (
                    <p className="mt-1 text-xs italic text-slate-500">{c.headline}</p>
                  ) : null}

                  {/* Secondary to name/role/company, but scannable side by side. */}
                  <div className="mt-2 rounded bg-slate-50 px-2 py-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      Why this candidate?
                    </p>
                    <p className="mt-0.5 text-xs leading-snug text-slate-700">
                      {explainCandidate(c, verification.conflicts, verification.candidates)}
                    </p>
                  </div>

                  {c.linkedin_url ? (
                    <a
                      href={c.linkedin_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 block break-all text-xs text-indigo-600 hover:underline"
                    >
                      {c.linkedin_url}
                    </a>
                  ) : null}
                  {c.sources.length > 0 ? (
                    <details className="mt-1 text-[11px]">
                      <summary className="cursor-pointer text-slate-500">
                        Sources: {c.sources.length}
                      </summary>
                      <ul className="mt-0.5 space-y-0.5">
                        {c.sources.slice(0, 3).map((sourceUrl, i) => (
                          <li key={i} className="truncate text-slate-400" title={sourceUrl}>
                            {sourceUrl}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <p className="mt-1 text-[11px] text-slate-400">Sources: 0</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs tabular-nums text-slate-500">{c.confidence}</p>
                  <p className="text-[10px] uppercase tracking-wide text-slate-400">confidence</p>
                </div>
              </div>
              <button
                onClick={() => select(c.id)}
                disabled={busy !== null}
                className="mt-2 w-full rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {busy === c.id ? 'Confirming…' : 'Select this person'}
              </button>
            </li>
          ))}
        </ul>

        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      </div>
    );
  }

  const selected = verification.selected_candidate_id
    ? verification.candidates.find((c) => c.id === verification.selected_candidate_id)
    : null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {verification.status === 'VERIFIED' ? 'Identity verified' : 'Identity verification'}
      </h3>

      {selected ? (
        <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Selected identity
          </p>
          <p className="mt-0.5 text-sm font-medium text-slate-900">{selected.name ?? 'Unnamed'}</p>
          <p className="text-xs text-slate-600">
            {[selected.role, selected.company].filter(Boolean).join(' · ') || 'Role and company unknown'}
          </p>
          {selected.location ? <p className="text-xs text-slate-500">{selected.location}</p> : null}
        </div>
      ) : null}

      <div className={`rounded-lg border p-3 ${STATUS_TONE[verification.status] ?? STATUS_TONE.PARTIAL}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-semibold uppercase tracking-wider">
            {verification.status === 'VERIFIED'
              ? 'Verified'
              : verification.status === 'FAILED'
                ? 'Identity could not be verified'
                : `Identity ${verification.status.toLowerCase()}`}
          </span>
          <span
            className="text-xs tabular-nums opacity-80"
            title={
              verification.status === 'VERIFIED'
                ? 'Confidence that this is the right person.'
                : 'How strongly the evidence that COULD be checked supports this person. It does not override the decision above.'
            }
          >
            {verification.status === 'VERIFIED'
              ? `${verification.confidence}/100`
              : `evidence ${verification.confidence}/100`}
          </span>
        </div>
        <p className="mt-1 text-sm">{verification.reason}</p>
      </div>

      {verification.field_evidence ? (
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Evidence checked
          </p>
          <p className="mt-0.5 text-xs text-slate-700">{verification.field_evidence.summary}</p>
          <ul className="mt-1.5 space-y-0.5">
            {verification.field_evidence.corroborated.map((f) => (
              <li key={f} className="text-[11px] text-emerald-700">
                <span aria-hidden="true">✓</span> {f} — corroborated
              </li>
            ))}
            {verification.field_evidence.conflicting.map((f) => (
              <li key={f} className="text-[11px] text-amber-700">
                <span aria-hidden="true">⚠</span> {f} — conflicting
              </li>
            ))}
            {verification.field_evidence.unavailable.map((f) => (
              <li key={f} className="text-[11px] text-slate-400">
                <span aria-hidden="true">·</span> {f} — unavailable
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <dl className="mt-3 space-y-1 text-xs">
        <Row label="Name" value={verification.resolved.name} />
        <Row label="Role" value={verification.resolved.role} />
        <Row label="Company" value={verification.resolved.company} />
        <Row label="Location" value={verification.resolved.location} />
        <Row
          label="Resolution"
          value={verification.resolution === 'USER_CONFIRMED' ? 'User confirmed' : 'Automatically selected'}
        />
        <Row
          label="Sources"
          value={
            verification.field_evidence
              ? String(verification.field_evidence.supporting_sources.length)
              : selected
                ? String(selected.sources.length)
                : null
          }
        />
      </dl>

      {verification.resolution === 'USER_CONFIRMED' ? (
        <p className="mt-2 rounded bg-indigo-50 px-2 py-1.5 text-xs text-indigo-800">
          Identity confirmed by user — ProspectIQ used the selected identity for this run.
        </p>
      ) : null}

      {verification.conflicts.length > 0 ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-amber-700">
            Conflicting evidence ({verification.conflicts.length})
          </summary>
          <ul className="mt-1 space-y-1">
            {verification.conflicts.map((c, i) => (
              <li key={i} className="text-slate-600">
                <span className="font-medium">{c.field}:</span> profile says{' '}
                {c.profile_value ?? 'unknown'}, sources say {c.public_value ?? 'unknown'}.{' '}
                {c.explanation}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-slate-800">{value}</dd>
    </div>
  );
}
