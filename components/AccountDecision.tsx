'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { StatusBadge } from './StatusBadge';
import {
  ACCOUNT_DECISION_COPY,
  accountDecisionRecord,
  accountDecisionState,
  continuationPath,
  type AccountDecisionChoice,
} from '@/lib/qualification/account-decision';
import type { RunRow } from '@/lib/types';

/**
 * The human account decision for a BORDERLINE company.
 *
 * Framed as a decision, never as an override. The wording matters: "Continue"
 * asks whether the ACCOUNT is worth pursuing, and the panel says plainly that
 * the qualification does not change and every downstream check still runs. It
 * deliberately avoids "Override AI" / "Force continue" / "Ignore warning" —
 * all three describe a power the user does not have here, and inviting someone
 * to think they are switching the safeguards off is how they stop reading them.
 *
 * Renders nothing at all unless this run actually asks for a decision, so a
 * QUALIFIED or NOT_QUALIFIED account never sees an override affordance.
 */
export function AccountDecision({
  run,
  onDecided,
}: {
  run: Pick<RunRow, 'id' | 'qualification'>;
  onDecided?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<AccountDecisionChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const state = accountDecisionState(run.qualification);
  const path = continuationPath(run.qualification);
  if (state === 'NONE' || !path) return null;

  const copy = ACCOUNT_DECISION_COPY[path];
  const record = accountDecisionRecord(run.qualification);

  async function decide(decision: AccountDecisionChoice) {
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${run.id}/account-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not record your decision');
      onDecided?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={`rounded-xl border p-5 ${
        state === 'REQUIRED' ? 'border-amber-600/30 bg-surface' : 'border-hairline bg-surface'
      }`}
    >
      {/* The two states side by side, so it is always visible that continuing
          did not change what the evidence concluded. */}
      <dl className="mb-3 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">Account</dt>
          <dd className="mt-1">
            <StatusBadge tone="amber">BORDERLINE</StatusBadge>
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">
            Human decision
          </dt>
          <dd className="mt-1">
            <StatusBadge
              tone={state === 'REQUIRED' ? 'amber' : state === 'CONTINUED' ? 'accent' : 'neutral'}
            >
              {state}
            </StatusBadge>
          </dd>
        </div>
      </dl>

      {state === 'REQUIRED' ? (
        <>
          <h3 className="text-sm font-semibold text-ink">{copy.heading}</h3>
          <p className="mt-1 text-sm text-ink/85">{copy.body}</p>

          <div className="mt-4 space-y-3">
            <div className="rounded-lg border border-hairline p-3">
              <button
                type="button"
                onClick={() => decide('CONTINUED')}
                disabled={busy !== null}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {busy === 'CONTINUED' ? 'Continuing…' : copy.continueLabel}
              </button>
              <p className="mt-2 text-xs text-muted">{copy.continueBody}</p>
            </div>

            <div className="rounded-lg border border-hairline p-3">
              <button
                type="button"
                onClick={() => decide('HELD')}
                disabled={busy !== null}
                className="rounded-lg border border-hairline px-3 py-1.5 text-sm font-semibold text-ink hover:bg-app disabled:opacity-50"
              >
                {busy === 'HELD' ? 'Holding…' : copy.holdLabel}
              </button>
              <p className="mt-2 text-xs text-muted">{copy.holdBody}</p>
            </div>
          </div>

          {/* Says outright what continuing does and does not do. */}
          <p className="mt-3 border-t border-hairline pt-3 text-xs text-faint">
            Continuing does not change the qualification. The account stays BORDERLINE, and every
            evidence, identity, contact-verification, solution and claim check still applies.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-ink/85">
            {state === 'CONTINUED' ? copy.continuedBody : copy.heldBody}
          </p>
          {record?.decided_at ? (
            <p className="mt-1 text-xs text-faint">
              Decided {new Date(record.decided_at).toLocaleString()}.
            </p>
          ) : null}
          <p className="mt-2 text-xs text-faint">
            The account qualification is unchanged — still BORDERLINE on the evidence.
          </p>
        </>
      )}

      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
