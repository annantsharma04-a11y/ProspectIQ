import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import {
  getDraft,
  getProspect,
  listProspectRuns,
  listSignalsForRuns,
} from '@/lib/supabase/queries';
import { daysSince } from '@/lib/prospects/types';
import { prospectTimeline } from '@/lib/prospects/changes';
import { deriveOutreachStatus, OUTREACH_LABEL } from '@/lib/qualification/outreach-status';
import { QUAL_TONE, RUN_STATUS_TONE, duration, friendlyError } from '@/lib/ui/status-styles';
import { StatusBadge } from '@/components/StatusBadge';
import ResearchAgainButton from '@/components/ResearchAgainButton';

export const dynamic = 'force-dynamic';

/**
 * Prospect detail — the CURRENT known state of a person, plus the history that
 * produced it.
 *
 * The distinction this page has to keep clear: everything in "Current" is the
 * latest thing ProspectIQ established, while each row under "Research history"
 * is what it knew at that moment. Opening a run hands off to the existing run
 * detail view, which is untouched.
 */
export default async function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getAuthenticatedUser();
  if (!user) redirect(`/login?next=/prospects/${id}`);

  const prospect = await getProspect(id);
  // A prospect belonging to someone else is indistinguishable from one that
  // does not exist — same reasoning as the API's 404.
  if (!prospect || prospect.user_id !== user.id) notFound();

  const runs = await listProspectRuns(prospect.id);
  const signalsByRun = await listSignalsForRuns(runs.map((r) => r.id));

  // Latest run that actually produced something to show.
  const latestRun = runs[0] ?? null;
  const latestWithSignals = runs.find((r) => (signalsByRun[r.id] ?? []).length > 0) ?? null;
  const latestSignals = latestWithSignals ? signalsByRun[latestWithSignals.id] : [];
  const latestDraft = latestRun ? await getDraft(latestRun.id) : null;

  // Oldest → newest for the diff; the timeline itself comes back newest first.
  const changes = prospectTimeline([...runs].reverse(), signalsByRun);
  const days = daysSince(prospect.last_researched_at);

  return (
    <div className="space-y-6">
      {/* ── current identity ─────────────────────────────────────────────── */}
      <header className="rounded-xl border border-hairline bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-faint">
              Current known state
            </p>
            <h1 className="font-display mt-1 text-2xl font-semibold tracking-tight text-ink">
              {prospect.name ?? `/in/${prospect.linkedin_slug}`}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {[prospect.current_job_role, prospect.current_company].filter(Boolean).join(' · ') ||
                'Role and company not yet established'}
            </p>
            <a
              href={prospect.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block text-xs text-faint hover:text-accent hover:underline"
            >
              {prospect.linkedin_url}
            </a>
          </div>

          <div className="text-right">
            <p className="text-xs text-faint">
              {prospect.last_researched_at
                ? `Last researched ${new Date(prospect.last_researched_at).toLocaleDateString()}${
                    days === 0 ? ' (today)' : days === 1 ? ' (1 day ago)' : ` (${days} days ago)`
                  }`
                : 'Never completed a research run'}
            </p>
            <p className="mt-0.5 text-xs text-faint">
              {runs.length} {runs.length === 1 ? 'run' : 'runs'} on record
            </p>
            <div className="mt-3">
              <ResearchAgainButton prospectId={prospect.id} />
            </div>
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── latest qualification ───────────────────────────────────────── */}
        <section className="rounded-xl border border-hairline bg-surface p-5">
          <h2 className="mb-3 text-sm font-semibold text-ink">Latest qualification</h2>
          {latestRun?.qualification_status ? (
            <div className="space-y-2 text-sm">
              <StatusBadge tone={QUAL_TONE[latestRun.qualification_status] ?? 'neutral'}>
                {latestRun.qualification_status.replace(/_/g, ' ')}
              </StatusBadge>
              {latestRun.overall_fit != null && (
                <p className="text-muted">Overall fit: {latestRun.overall_fit}</p>
              )}
              <p className="text-xs text-faint">
                From the run of {new Date(latestRun.created_at).toLocaleString()} —{' '}
                <Link href={`/runs/${latestRun.id}`} className="text-accent hover:underline">
                  open that run
                </Link>
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted">No qualification recorded yet.</p>
          )}
        </section>

        {/* ── latest draft ───────────────────────────────────────────────── */}
        <section className="rounded-xl border border-hairline bg-surface p-5">
          <h2 className="mb-3 text-sm font-semibold text-ink">Latest draft</h2>
          {latestDraft ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-ink/6 px-2 py-0.5 font-medium text-muted">
                  {latestDraft.reviewer_action ?? 'awaiting review'}
                </span>
                <span className="text-faint">
                  Human review only — outreach is always sent manually
                </span>
              </div>
              <p className="whitespace-pre-wrap rounded-lg bg-app p-3 text-sm leading-relaxed text-ink">
                {latestDraft.edited_text ?? latestDraft.final_text ?? latestDraft.message_text}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted">
              No draft yet. A message is only generated once a verified hook exists.
            </p>
          )}
        </section>
      </div>

      {/* ── latest signals ───────────────────────────────────────────────── */}
      <section className="rounded-xl border border-hairline bg-surface p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">
          Latest signals
          {latestWithSignals && (
            <span className="ml-2 font-normal text-xs text-faint">
              from the run of {new Date(latestWithSignals.created_at).toLocaleDateString()}
            </span>
          )}
        </h2>
        {latestSignals.length === 0 ? (
          <p className="text-sm text-muted">No verified signals on record for this prospect.</p>
        ) : (
          <ul className="space-y-2.5">
            {latestSignals.slice(0, 6).map((s) => (
              <li key={s.id} className="border-l-2 border-hairline pl-3">
                <p className="text-sm text-ink">{s.signal}</p>
                <p className="mt-0.5 text-xs text-faint">
                  {s.category && <span className="mr-2">{s.category.replace(/_/g, ' ')}</span>}
                  {s.composite_score != null && <span className="mr-2">score {s.composite_score}</span>}
                  <a
                    href={s.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-accent hover:underline"
                  >
                    {s.source_title ?? 'source'}
                  </a>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── changes over time ────────────────────────────────────────────── */}
      {changes.length > 0 && (
        <section className="rounded-xl border border-hairline bg-surface p-5">
          <h2 className="mb-1 text-sm font-semibold text-ink">Changes over time</h2>
          <p className="mb-3 text-xs text-faint">
            Derived only from what consecutive runs actually recorded. A field one run never
            established is not reported as a change.
          </p>
          <ul className="space-y-2">
            {changes.slice(0, 15).map((c, i) => (
              <li key={`${c.run_id}-${i}`} className="flex gap-3 text-sm">
                <span className="w-24 shrink-0 text-xs text-faint">
                  {new Date(c.observed_at).toLocaleDateString()}
                </span>
                <span className="text-muted">{c.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── research history ─────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-1 text-sm font-semibold text-ink">Research history</h2>
        <p className="mb-3 text-xs text-faint">
          Each row is what ProspectIQ knew at that moment. Historical runs are never rewritten by a
          later one.
        </p>
        <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-hairline text-xs uppercase tracking-wide text-faint">
              <tr>
                <th className="px-4 py-2.5 font-medium">Run</th>
                <th className="px-4 py-2.5 font-medium">Company at the time</th>
                <th className="px-4 py-2.5 font-medium">Target</th>
                <th className="px-4 py-2.5 font-medium">Outreach</th>
                <th className="px-4 py-2.5 font-medium">Hook</th>
                <th className="px-4 py-2.5 text-right font-medium">Conf.</th>
                <th className="px-4 py-2.5 text-right font-medium">Took</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-app/60">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/runs/${run.id}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {new Date(run.created_at).toLocaleString()}
                    </Link>
                    {friendlyError(run) && (
                      <p className="max-w-xs text-xs leading-snug text-red-600" title={run.error ?? ''}>
                        {friendlyError(run)}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {run.company_name ?? run.input_company ?? '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge tone={QUAL_TONE[run.qualification_status ?? ''] ?? 'neutral'}>
                      {run.qualification_status?.replace(/_/g, ' ') ?? '—'}
                    </StatusBadge>
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge tone={RUN_STATUS_TONE[run.status] ?? 'neutral'}>
                      {OUTREACH_LABEL[deriveOutreachStatus(run)]}
                    </StatusBadge>
                  </td>
                  <td className="max-w-xs px-4 py-2.5">
                    <span className="line-clamp-2 text-xs text-muted">
                      {run.qualification_status === 'NOT_QUALIFIED' ||
                      run.qualification_status === 'BORDERLINE'
                        ? `Not pitched — ${run.qualification_status === 'BORDERLINE' ? 'borderline fit' : 'target did not qualify'}`
                        : run.insufficient_evidence
                          ? 'No verified hook — no message generated'
                          : (run.selected_hook ?? '—')}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">
                    {run.overall_confidence ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-faint">
                    {duration(run)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
