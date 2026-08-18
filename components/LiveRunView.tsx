'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createBrowserSupabase } from '@/lib/supabase/client';
import { STAGE_ORDER, STAGE_LABELS, type RunSnapshot, type RunStageRow, type StageName } from '@/lib/types';
import { contactCandidatesStageIsVisible } from '@/lib/contacts/types';
import { classifyFailure } from '@/lib/pipeline/failure-classification';
import { StatusBadge, type StatusTone } from './StatusBadge';
import { FailureRecovery } from './FailureRecovery';

const ACTIVE = new Set(['queued', 'running']);

const STATUS_TONE: Record<string, StatusTone> = {
  pending: 'neutral',
  running: 'accent',
  complete: 'emerald',
  degraded: 'amber',
  skipped: 'neutral',
  failed: 'red',
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

  // Why this run stopped, and who can fix it. Only surfaced when it changes
  // what the user should DO: a correctable input gets an edit form, and a
  // deployment misconfiguration gets an explanation instead of a retry that
  // cannot succeed. An ordinary provider failure is already covered by the
  // retry affordances below, so it is not repeated here.
  const failure = classifyFailure(snapshot.run);
  const showRecovery = Boolean(failure && (failure.isEditable || failure.kind === 'CONFIGURATION'));
  const retryCannotHelp = failure?.retryAction === null;

  // find_contact_candidates is shown only in the one state it actually did
  // something in — see contactCandidatesStageIsVisible for why.
  const showContactCandidatesStage = contactCandidatesStageIsVisible(
    byName.get('find_contact_candidates')?.output,
  );
  const visibleStages = STAGE_ORDER.filter(
    (name) => name !== 'find_contact_candidates' || showContactCandidatesStage,
  );

  return (
    <section className="rounded-xl border border-hairline bg-surface p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">Live run</h2>
        <span className="text-xs text-faint">
          {active ? `live via ${transport}` : snapshot.run.status.replace(/_/g, ' ')}
        </span>
      </div>

      <ol className="space-y-1.5">
        {visibleStages.map((name, i) => {
          const stage = byName.get(name);
          const status = stage?.status ?? 'pending';
          return (
            <li key={name} className="rounded-lg border border-hairline px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm text-ink">
                  <span className="w-4 text-right text-xs text-faint">{i + 1}</span>
                  {STAGE_LABELS[name]}
                </span>
                <span className="flex items-center gap-2">
                  {stage?.duration_ms != null && (
                    <span className="text-xs text-faint">{formatDuration(stage.duration_ms)}</span>
                  )}
                  <StatusBadge tone={STATUS_TONE[status]} className={status === 'running' ? 'animate-pulse' : ''}>
                    {status}
                  </StatusBadge>
                </span>
              </div>

              {stage?.summary && (
                <p className="mt-1 pl-6 text-xs leading-relaxed text-muted">{stage.summary}</p>
              )}
              {stage?.error && (
                <p className="mt-1 pl-6 text-xs leading-relaxed text-red-600">{stage.error}</p>
              )}
              {stage && stage.status !== 'pending' && (
                <Link
                  href={`/runs/${runId}/stages/${name}`}
                  className="mt-1 inline-block pl-6 text-xs font-medium text-accent hover:underline"
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
        <div className="mt-4 rounded-lg border border-amber-600/25 bg-amber-600/6 p-3">
          <p className="text-sm font-medium text-amber-900">AI analysis pending</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800">{snapshot.run.error}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={() => retry('retry-analysis')}
              disabled={retrying}
              className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
            >
              {retrying ? 'Retrying analysis…' : 'Retry AI analysis'}
            </button>
            <button
              onClick={() => retry('retry')}
              disabled={retrying}
              className="rounded-lg border border-amber-600/30 bg-surface px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-600/10 disabled:opacity-50"
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
        <div className="mt-4 rounded-lg border border-red-600/25 bg-red-600/6 p-3">
          <p className="text-sm font-medium text-red-800">Run failed</p>
          <p className="mt-1 text-xs text-red-700">{snapshot.run.error}</p>
          {/* Suppressed when retrying provably cannot help (a missing API key
              does not become present on a second attempt). */}
          {!retryCannotHelp && (
            <button
              onClick={() => retry('retry')}
              disabled={retrying}
              className="mt-2 rounded-lg border border-red-600/30 bg-surface px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-600/10 disabled:opacity-50"
            >
              {retrying ? 'Retrying…' : 'Retry run'}
            </button>
          )}
        </div>
      )}

      {showRecovery && <FailureRecovery run={snapshot.run} onRetried={refresh} />}

      {!active && !failed && !pendingAnalysis && (
        <button
          onClick={() => retry('retry')}
          disabled={retrying}
          className="mt-4 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-muted hover:bg-app disabled:opacity-50"
        >
          {retrying ? 'Re-running…' : 'Re-run research'}
        </button>
      )}
    </section>
  );
}
