'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createBrowserSupabase } from '@/lib/supabase/client';
import { STAGE_ORDER, STAGE_LABELS, type RunSnapshot, type RunStageRow, type StageName } from '@/lib/types';
import { contactCandidatesStageIsVisible } from '@/lib/contacts/types';

const ACTIVE = new Set(['queued', 'running']);

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-400',
  running: 'bg-indigo-100 text-indigo-700 animate-pulse',
  complete: 'bg-green-100 text-green-700',
  degraded: 'bg-amber-100 text-amber-700',
  skipped: 'bg-slate-100 text-slate-400',
  failed: 'bg-red-100 text-red-700',
};

function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function LiveRunView({
  runId,
  snapshot,
  onSnapshot,
}: {
  runId: string;
  snapshot: RunSnapshot;
  onSnapshot: (snap: RunSnapshot) => void;
}) {
  const [transport, setTransport] = useState<'realtime' | 'polling'>('realtime');
  const [retrying, setRetrying] = useState(false);
  // Initialized in the subscribe effect: Date.now() is impure and must not run
  // during render. 0 means "no event seen yet".
  const lastEventAt = useRef<number>(0);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
    if (res.ok) onSnapshot(await res.json());
  }, [runId, onSnapshot]);

  // Realtime on both tables the run writes to.
  useEffect(() => {
    lastEventAt.current = Date.now();
    const supabase = createBrowserSupabase();
    const channel = supabase
      .channel(`run-${runId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'run_stages', filter: `run_id=eq.${runId}` },
        () => {
          lastEventAt.current = Date.now();
          setTransport('realtime');
          refresh();
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'runs', filter: `id=eq.${runId}` },
        () => {
          lastEventAt.current = Date.now();
          refresh();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [runId, refresh]);

  // Fall back to polling if Realtime goes quiet while the run is active.
  useEffect(() => {
    const active = ACTIVE.has(snapshot.run.status);
    if (!active) {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
      return;
    }
    const check = setInterval(() => {
      if (Date.now() - lastEventAt.current > 5000) {
        setTransport('polling');
        if (!pollTimer.current) pollTimer.current = setInterval(refresh, 3000);
      }
    }, 1000);

    return () => {
      clearInterval(check);
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
    };
  }, [snapshot.run.status, refresh]);

  async function retry(endpoint: 'retry' | 'retry-analysis' = 'retry') {
    setRetrying(true);
    await fetch(`/api/runs/${runId}/${endpoint}`, { method: 'POST' });
    lastEventAt.current = 0;
    await refresh();
    setRetrying(false);
  }

  const byName = new Map<StageName, RunStageRow>(
    snapshot.stages.map((s) => [s.stage_name, s] as const),
  );
  const active = ACTIVE.has(snapshot.run.status);
  const failed = snapshot.run.status === 'failed';
  const pendingAnalysis = snapshot.run.status === 'ai_analysis_pending';

  // find_contact_candidates is shown only in the one state it actually did
  // something in — see contactCandidatesStageIsVisible for why.
  const showContactCandidatesStage = contactCandidatesStageIsVisible(
    byName.get('find_contact_candidates')?.output,
  );
  const visibleStages = STAGE_ORDER.filter(
    (name) => name !== 'find_contact_candidates' || showContactCandidatesStage,
  );

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Live run</h2>
        <span className="text-xs text-slate-400">
          {active ? `live via ${transport}` : snapshot.run.status.replace(/_/g, ' ')}
        </span>
      </div>

      <ol className="space-y-1.5">
        {visibleStages.map((name, i) => {
          const stage = byName.get(name);
          const status = stage?.status ?? 'pending';
          return (
            <li key={name} className="rounded-lg border border-slate-100 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm text-slate-700">
                  <span className="w-4 text-right text-xs text-slate-400">{i + 1}</span>
                  {STAGE_LABELS[name]}
                </span>
                <span className="flex items-center gap-2">
                  {stage?.duration_ms != null && (
                    <span className="text-xs text-slate-400">{formatDuration(stage.duration_ms)}</span>
                  )}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>
                    {status}
                  </span>
                </span>
              </div>

              {stage?.summary && (
                <p className="mt-1 pl-6 text-xs leading-relaxed text-slate-500">{stage.summary}</p>
              )}
              {stage?.error && (
                <p className="mt-1 pl-6 text-xs leading-relaxed text-red-600">{stage.error}</p>
              )}
              {stage && stage.status !== 'pending' && (
                <Link
                  href={`/runs/${runId}/stages/${name}`}
                  className="mt-1 inline-block pl-6 text-xs font-medium text-indigo-600 hover:underline"
                >
                  View working →
                </Link>
              )}
            </li>
          );
        })}
      </ol>

      {/* The research succeeded and is saved; only the AI analysis still owes us. */}
      {pendingAnalysis && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-900">AI analysis pending</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800">{snapshot.run.error}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={() => retry('retry-analysis')}
              disabled={retrying}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {retrying ? 'Retrying analysis…' : 'Retry AI analysis'}
            </button>
            <button
              onClick={() => retry('retry')}
              disabled={retrying}
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
            >
              Re-run everything
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-amber-700">
            Retrying the analysis reuses the profile and sources already collected — it does not
            repeat the research.
          </p>
        </div>
      )}

      {failed && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-medium text-red-800">Run failed</p>
          <p className="mt-1 text-xs text-red-700">{snapshot.run.error}</p>
          <button
            onClick={() => retry('retry')}
            disabled={retrying}
            className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {retrying ? 'Retrying…' : 'Retry run'}
          </button>
        </div>
      )}

      {!active && !failed && !pendingAnalysis && (
        <button
          onClick={() => retry('retry')}
          disabled={retrying}
          className="mt-4 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {retrying ? 'Re-running…' : 'Re-run research'}
        </button>
      )}
    </section>
  );
}
