'use client';

import { useState } from 'react';
import type { RunRow } from '@/lib/types';
import {
  classifyFailure,
  editableInputFrom,
  type EditableField,
  type FailureClassification,
} from '@/lib/pipeline/failure-classification';

const FIELD =
  'mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

const FIELD_LABEL: Record<EditableField, string> = {
  linkedin_url: 'LinkedIn profile URL',
  input_name: 'Name',
  input_company: 'Company',
  input_title: 'Role',
};

const FIELD_PLACEHOLDER: Record<EditableField, string> = {
  linkedin_url: 'https://www.linkedin.com/in/jane-doe',
  input_name: 'Jane Doe',
  input_company: 'Acme Inc',
  input_title: 'VP Finance',
};

/**
 * What to do about a run that stopped.
 *
 * Branches on lib/pipeline/failure-classification.ts, so the action offered
 * always matches the cause: a correctable input gets an edit form, a provider
 * outage gets a plain retry, and a deployment misconfiguration gets neither —
 * because neither would help, and pretending otherwise sends the user round a
 * loop that cannot succeed.
 *
 * The retry buttons for the infrastructure case already live in LiveRunView
 * (which owns the retry/retry-analysis calls and their busy state); this
 * component renders only the explanation for those, and owns the edit form
 * for the correctable case.
 */
export function FailureRecovery({
  run,
  onRetried,
}: {
  run: RunRow;
  /** Refetch the snapshot once a corrected run has been dispatched. */
  onRetried: () => void;
}) {
  const classification = classifyFailure(run);
  if (!classification) return null;

  return classification.isEditable ? (
    <EditAndRetry run={run} classification={classification} onRetried={onRetried} />
  ) : (
    <NonEditableExplanation classification={classification} />
  );
}

/** Infrastructure/configuration: say what happened, and whose problem it is. */
function NonEditableExplanation({ classification }: { classification: FailureClassification }) {
  const configuration = classification.kind === 'CONFIGURATION';
  return (
    <div
      className={`mt-4 rounded-lg border p-3 ${
        configuration ? 'border-red-600/25 bg-red-600/6' : 'border-amber-600/25 bg-amber-600/6'
      }`}
    >
      <p className={`text-sm font-medium ${configuration ? 'text-red-800' : 'text-amber-900'}`}>
        {configuration ? 'Deployment configuration problem' : 'This was not caused by your details'}
      </p>
      <p className={`mt-1 text-xs leading-relaxed ${configuration ? 'text-red-700' : 'text-amber-800'}`}>
        {classification.explanation}
      </p>
      {!configuration && (
        <p className="mt-1.5 text-xs text-amber-700">
          Your input looks fine, so there is nothing to correct — retrying is the right action.
        </p>
      )}
    </div>
  );
}

/** Editable: explain, let the user correct the input, then re-run. */
function EditAndRetry({
  run,
  classification,
  onRetried,
}: {
  run: RunRow;
  classification: FailureClassification;
  onRetried: () => void;
}) {
  const initial = editableInputFrom(run);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({
    linkedin_url: initial.linkedin_url ?? '',
    input_name: initial.input_name ?? '',
    input_company: initial.input_company ?? '',
    input_title: initial.input_title ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${run.id}/edit-retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only the fields this failure actually offers are sent, so an
        // untouched field is never rewritten by a form that showed it.
        body: JSON.stringify(
          Object.fromEntries(classification.editableFields.map((f) => [f, values[f]])),
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not save and retry.');
      setOpen(false);
      onRetried();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-amber-600/25 bg-amber-600/6 p-3">
      <p className="text-sm font-medium text-amber-900">This run needs a correction</p>
      <p className="mt-1 text-xs leading-relaxed text-amber-800">{classification.explanation}</p>
      {classification.editHint && (
        <p className="mt-1.5 text-xs leading-relaxed text-amber-700">{classification.editHint}</p>
      )}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-2 rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
        >
          Edit &amp; retry
        </button>
      ) : (
        <div className="mt-3 space-y-3">
          {classification.editableFields.map((field) => (
            <div key={field}>
              <label htmlFor={`edit-${field}`} className="block text-xs font-medium text-amber-900">
                {FIELD_LABEL[field]}
                {field !== 'linkedin_url' && <span className="ml-1 text-amber-700">(optional)</span>}
              </label>
              <input
                id={`edit-${field}`}
                value={values[field]}
                onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
                placeholder={FIELD_PLACEHOLDER[field]}
                autoComplete="off"
                className={FIELD}
              />
            </div>
          ))}

          <p className="text-xs leading-relaxed text-amber-700">
            Saving re-runs this prospect from the start with the corrected details. Earlier runs are
            untouched, and nothing is ever sent automatically.
          </p>

          {error && (
            <p className="rounded-lg bg-red-600/8 px-2.5 py-1.5 text-xs text-red-700" role="alert">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy || !values.linkedin_url.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && (
                <span
                  aria-hidden
                  className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white"
                />
              )}
              {busy ? 'Saving & retrying…' : 'Save & retry'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              disabled={busy}
              className="rounded-lg border border-amber-600/30 bg-surface px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-600/10 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
