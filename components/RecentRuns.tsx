import Link from 'next/link';
import { listRuns } from '@/lib/supabase/queries';
import { getAuthenticatedUser } from '@/lib/supabase/server';

const STATUS_TONE: Record<string, string> = {
  ready_for_review: 'bg-emerald-500',
  needs_manual_review: 'bg-amber-500',
  approved: 'bg-indigo-500',
  rejected: 'bg-slate-400',
  failed: 'bg-red-500',
  ai_analysis_pending: 'bg-amber-500',
  running: 'bg-blue-500',
  queued: 'bg-slate-300',
};

/** Real recent runs only — never seeded, never sample data. */
export async function RecentRuns({ limit = 6 }: { limit?: number }) {
  const user = await getAuthenticatedUser();
  if (!user) return null;

  let runs;
  try {
    runs = await listRuns(user.id, limit);
  } catch {
    return null;
  }

  if (runs.length === 0) {
    return (
      <div className="mt-6">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          Recent runs
        </h2>
        <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-xs leading-relaxed text-slate-500">
          No runs yet. Analyze a prospect and the fifteen pipeline stages will report here as they
          execute.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Recent runs
        </h2>
        <Link href="/history" className="text-xs font-medium text-indigo-600 hover:underline">
          All
        </Link>
      </div>
      <ul className="space-y-1">
        {runs.map((run) => (
          <li key={run.id}>
            <Link
              href={`/runs/${run.id}`}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-100"
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_TONE[run.status] ?? 'bg-slate-300'}`}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-800">
                  {run.prospect_name ?? run.input_name ?? `/in/${run.linkedin_slug}`}
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {run.company_name ?? run.status.replace(/_/g, ' ')}
                </span>
              </span>
              {run.overall_confidence !== null && (
                <span className="shrink-0 text-xs tabular-nums text-slate-400">
                  {run.overall_confidence}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
