'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LiveRunView } from './LiveRunView';
import { ResultPanel } from './ResultPanel';
import type { RunSnapshot, RunStatus } from '@/lib/types';

/**
 * `/runs/[id]` — never the homepage's New Prospect form or Recent Runs, but
 * ALWAYS both the 14-stage Live Run and the Result/Decision view. Live Run is
 * core to ProspectIQ and must stay visible at every stage of a run's life,
 * not just while it is actively processing — it is how a reviewer checks
 * exactly how a decision was reached, and it is where retry lives
 * ("Retry AI analysis", "Re-run everything", "Retry run") for a parked or
 * failed run. ResultPanel is likewise always rendered — it degrades
 * gracefully on its own (an "Identifying…" placeholder, no draft yet, etc.)
 * when a run hasn't produced a given piece of data yet, so showing it early
 * is safe and is in fact how partial results are meant to surface.
 *
 * Only the ORDER of the two changes, based on where the run actually is:
 *   - still processing (queued/running) or stuck (ai_analysis_pending/failed)
 *     → Live Run first, as the primary visible workflow; the result panel
 *       follows, showing whatever has resolved so far.
 *   - reached a real outcome (ready_for_review/needs_manual_review/approved/
 *     rejected) → the decision comes first, Live Run stays right below it so
 *     a reviewer can immediately see WHY, without leaving the page.
 *
 * This replaced the generic `Workspace` component, which always rendered a
 * 3-column New Prospect / Live Run / Result layout — the actual cause of
 * Command Center clicks appearing to land back on a homepage-like page.
 * `Workspace` itself is untouched; it just has no callers left.
 */
const PROCESSING_STATUSES = new Set<RunStatus>(['queued', 'running', 'ai_analysis_pending', 'failed']);

export function RunDetail({ initial }: { initial: RunSnapshot }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<RunSnapshot>(initial);
  const [shownRunId, setShownRunId] = useState<string>(initial.run.id);

  // Navigating between runs (e.g. Command Center → a different run) swaps the
  // server-rendered snapshot underneath us — reset local state to match.
  if (initial.run.id !== shownRunId) {
    setShownRunId(initial.run.id);
    setSnapshot(initial);
  }

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/runs/${snapshot.run.id}`, { cache: 'no-store' });
    if (res.ok) setSnapshot(await res.json());
    router.refresh();
  }, [snapshot.run.id, router]);

  const liveRun = <LiveRunView runId={snapshot.run.id} snapshot={snapshot} onSnapshot={setSnapshot} />;
  const result = <ResultPanel snapshot={snapshot} onChange={refresh} />;

  const processing = PROCESSING_STATUSES.has(snapshot.run.status);

  return (
    <div className="space-y-6">
      {processing ? (
        <>
          {liveRun}
          {result}
        </>
      ) : (
        <>
          {result}
          {liveRun}
        </>
      )}
    </div>
  );
}
