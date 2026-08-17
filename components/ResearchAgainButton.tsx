'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Start a NEW run for an existing prospect.
 *
 * Deliberately explicit: re-researching adds to the history, it does not
 * refresh the previous run in place, and the button says so.
 */
export default function ResearchAgainButton({ prospectId }: { prospectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/prospects/${prospectId}/research`, { method: 'POST' });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !body.id) {
        setError(body.error ?? 'Could not start research.');
        return;
      }
      router.push(`/runs/${body.id}`);
    } catch {
      setError('Could not start research.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        {busy ? 'Starting…' : 'Research again'}
      </button>
      <p className="mt-1 text-xs text-slate-400">Adds a new run; earlier runs stay untouched.</p>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
