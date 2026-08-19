import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listRuns, listStages } from '@/lib/supabase/queries';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import {
  buildActiveRunSummary,
  buildCommandCenterSummary,
  greetingName,
  timeOfDayGreeting,
  shouldRenderSection,
  type TriageItem,
} from '@/lib/dashboard/command-center';
import type { RunRow } from '@/lib/types';
import { ActiveWorkSummary } from './ActiveWorkSummary';

/**
 * The homepage — a compact TRIAGE surface, not a second workspace.
 *
 * It answers exactly one question: what needs attention right now? For
 * anything deeper it links out to the page that already owns that answer —
 * the Run page for "what happened and why", Stage Detail for "how did the
 * system arrive here", History for "what have I run", Evaluation for "how
 * well is the system performing". Nothing here re-renders that content.
 *
 * Everything is read from `listRuns()` — the same rows History already
 * uses — and derived in lib/dashboard/command-center.ts. No new query, no
 * new write, no pipeline/qualification/identity logic.
 */
export async function CommandCenter() {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/login');

  let runs: RunRow[];
  try {
    runs = await listRuns(user.id, 100);
  } catch {
    runs = [];
  }

  const summary = buildCommandCenterSummary(runs);
  const name = greetingName(runs, user.email ?? null);
  const greeting = timeOfDayGreeting();
  const allCaughtUp = summary.counts.needsAttention === 0 && summary.counts.ready === 0;

  // A compact description of the one run currently working. Only the stage
  // list is fetched — the run row is already in `runs` — because this surface
  // shows four short strings, not the run workspace.
  const activeRun = summary.activeRunId
    ? (runs.find((r) => r.id === summary.activeRunId) ?? null)
    : null;
  const activeSummary = activeRun
    ? buildActiveRunSummary(activeRun, await listStages(activeRun.id).catch(() => []))
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header + compact work summary */}
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          {greeting}{name ? `, ${name}` : ''}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {allCaughtUp
            ? 'Prospect research and outreach — everything is caught up.'
            : `Prospect research and outreach — ${summary.counts.needsAttention} need${summary.counts.needsAttention === 1 ? 's' : ''} attention, ${summary.counts.ready} ready for review.`}
        </p>
      </div>

      <TriageSection
        title="Needs your attention"
        items={summary.needsAttention}
        total={summary.counts.needsAttention}
        actionText="Review"
      />

      <TriageSection
        title="Ready for review"
        items={summary.ready}
        total={summary.counts.ready}
        actionText="Review"
      />

      <TriageSection
        title="Contacts needing work"
        items={summary.contactsNeedingWork}
        total={summary.counts.contactsNeedingWork}
        actionText="Open"
      />

      <TriageSection
        title="Exploratory outreach"
        items={summary.exploratory}
        total={summary.counts.exploratory}
        actionText="Review"
      />

      {activeSummary ? <ActiveWorkSummary summary={activeSummary} /> : null}
    </div>
  );
}

/** Renders nothing at all when there are no items — no heading, no empty placeholder. */
function TriageSection({
  title,
  items,
  total,
  actionText,
}: {
  title: string;
  items: TriageItem[];
  total: number;
  actionText: string;
}) {
  if (!shouldRenderSection(items)) return null;

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">{title}</h2>
        <span className="text-xs tabular-nums text-faint">
          {total} item{total === 1 ? '' : 's'}
        </span>
      </div>

      <div className="rounded-xl border border-hairline bg-surface">
        <ul className="divide-y divide-hairline px-4">
          {items.map((item) => (
            <li key={item.runId}>
              <Link
                href={`/runs/${item.runId}`}
                className="flex items-center justify-between gap-3 py-3 hover:bg-ink/5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {item.prospectName}
                    {item.companyName ? <span className="text-muted"> · {item.companyName}</span> : null}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted">{item.label}</p>
                </div>
                <span className="shrink-0 text-xs font-medium text-accent">{actionText} →</span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="border-t border-hairline px-4 py-2">
          <Link href="/history" className="text-xs font-medium text-accent hover:underline">
            View all →
          </Link>
        </div>
      </div>
    </div>
  );
}
