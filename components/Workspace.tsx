'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProspectForm } from './ProspectForm';
import { LiveRunView } from './LiveRunView';
import { ResultPanel } from './ResultPanel';
import type { RunSnapshot } from '@/lib/types';

/**
 * Three-panel workspace: new prospect (left), live run (middle), result (right).
 *
 * The form stays mounted at all times, so a new LinkedIn URL can be submitted
 * the moment the previous run finishes — or while it is still running.
 */
export function Workspace({
  initial,
  recentRuns,
}: {
  initial: RunSnapshot | null;
  /** Server-rendered list of real recent runs. */
  recentRuns?: React.ReactNode;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(initial);
  const [shownRunId, setShownRunId] = useState<string | null>(initial?.run.id ?? null);

  // Navigating between runs swaps the server-rendered snapshot underneath us.
  // Adjusting state during render (rather than in an effect) is the supported
  // way to reset state when a prop changes — it avoids a cascading re-render.
  const incomingRunId = initial?.run.id ?? null;
  if (incomingRunId !== shownRunId) {
    setShownRunId(incomingRunId);
    setSnapshot(initial);
  }

  const refresh = useCallback(async () => {
    if (!snapshot) return;
    const res = await fetch(`/api/runs/${snapshot.run.id}`, { cache: 'no-store' });
    if (res.ok) setSnapshot(await res.json());
    router.refresh();
  }, [snapshot, router]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <div className="lg:col-span-3">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          New prospect
        </h2>
        <ProspectForm />
        {recentRuns}
      </div>

      <div className="lg:col-span-4">
        {snapshot ? (
          <LiveRunView runId={snapshot.run.id} snapshot={snapshot} onSnapshot={setSnapshot} />
        ) : (
          <EmptyPanel
            title="Live run"
            body="Paste a public LinkedIn profile URL and the fifteen pipeline stages will report here as they execute."
          />
        )}
      </div>

      <div className="lg:col-span-5">
        {snapshot ? (
          <ResultPanel snapshot={snapshot} onChange={refresh} />
        ) : (
          <EmptyPanel
            title="Result"
            body="The resolved prospect, the selected hook and its evidence, the drafted message, and the human review controls appear here once a run completes."
          />
        )}
      </div>
    </div>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <section className="rounded-xl border border-dashed border-slate-200 bg-white/50 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-500">{body}</p>
    </section>
  );
}
