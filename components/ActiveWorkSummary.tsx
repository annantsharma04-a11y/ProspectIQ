import Link from 'next/link';
import type { ActiveRunSummary } from '@/lib/dashboard/command-center';

/**
 * The one run currently working, in four lines.
 *
 * Deliberately NOT the pipeline. This replaced an embedded LiveRunView, which
 * put all fourteen stages — plus their retry affordances and a realtime
 * subscription — on a surface whose whole job is to say what needs attention.
 * The stages, the progress and the live updates live on /runs/[id]; this says
 * only that work is happening, on whom, and where it has reached.
 *
 * A plain server component with no state and no subscription, so the homepage
 * cannot drift back into rendering the run workspace.
 */
export function ActiveWorkSummary({ summary }: { summary: ActiveRunSummary }) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-faint">Live work</h2>

      <div className="rounded-xl border border-hairline bg-surface px-4 py-3">
        <Link
          href={`/runs/${summary.runId}`}
          className="flex items-center justify-between gap-3 hover:opacity-80"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">
              {summary.prospectName}
              {summary.companyName ? (
                <span className="text-muted"> · {summary.companyName}</span>
              ) : null}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
              {/* The only motion here — enough to read as live without
                  reproducing the stage list to prove it. */}
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              {summary.statusLabel}
            </p>
            {summary.currentStageLabel ? (
              <p className="mt-0.5 truncate text-xs text-faint">
                Current stage: {summary.currentStageLabel}
              </p>
            ) : null}
          </div>
          <span className="shrink-0 text-xs font-medium text-accent">Open run →</span>
        </Link>
      </div>
    </div>
  );
}
