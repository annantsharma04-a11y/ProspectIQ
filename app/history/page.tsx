import Link from 'next/link';
import { redirect } from 'next/navigation';
import { countProspects, listProspects } from '@/lib/supabase/queries';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import { daysSince } from '@/lib/prospects/types';
import { QUAL_TONE, RUN_STATUS_TONE } from '@/lib/ui/status-styles';
import { StatusBadge } from '@/components/StatusBadge';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

/**
 * Prospect history.
 *
 * The unit here is a PERSON, not a run: one row per prospect with its research
 * rollup. The runs themselves live on the prospect page, and the run detail
 * experience is unchanged.
 *
 * Everything on this page comes from one paginated view query — no per-prospect
 * follow-up queries.
 */
export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/login?next=/history');

  const { page: rawPage } = await searchParams;
  const page = Math.max(1, Number(rawPage) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [prospects, total] = await Promise.all([
    listProspects(user.id, { limit: PAGE_SIZE, offset }),
    countProspects(user.id),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <h1 className="font-display mb-1 text-2xl font-semibold tracking-tight text-ink">Prospect history</h1>
      <p className="mb-5 text-sm text-muted">
        One row per person. Each prospect keeps every run ever executed against them, exactly as it
        executed — nothing here is seeded or simulated.
      </p>

      {prospects.length === 0 ? (
        <p className="rounded-xl border border-dashed border-hairline p-8 text-center text-sm text-muted">
          No prospects yet. Research someone from{' '}
          <Link href="/" className="font-medium text-accent hover:underline">
            New run
          </Link>
          .
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-hairline text-xs uppercase tracking-wide text-faint">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Prospect</th>
                  <th className="px-4 py-2.5 font-medium">Company</th>
                  <th className="px-4 py-2.5 font-medium">LinkedIn</th>
                  <th className="px-4 py-2.5 font-medium">Latest target</th>
                  <th className="px-4 py-2.5 font-medium">Latest run</th>
                  <th className="px-4 py-2.5 text-right font-medium">Runs</th>
                  <th className="px-4 py-2.5 font-medium">Last researched</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {prospects.map((p) => {
                  const days = daysSince(p.last_researched_at);
                  return (
                    <tr key={p.id} className="hover:bg-app/60">
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/prospects/${p.id}`}
                          className="font-medium text-accent hover:underline"
                        >
                          {p.name ?? `/in/${p.linkedin_slug}`}
                        </Link>
                        {p.current_job_role && (
                          <p className="max-w-xs truncate text-xs text-faint">{p.current_job_role}</p>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted">{p.current_company ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        <a
                          href={p.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-faint hover:text-accent hover:underline"
                        >
                          /in/{p.linkedin_slug}
                        </a>
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge tone={QUAL_TONE[p.latest_qualification_status ?? ''] ?? 'neutral'}>
                          {p.latest_qualification_status?.replace(/_/g, ' ') ?? '—'}
                        </StatusBadge>
                      </td>
                      <td className="px-4 py-2.5">
                        {p.latest_run_id ? (
                          <Link href={`/runs/${p.latest_run_id}`} className="hover:underline">
                            <StatusBadge tone={RUN_STATUS_TONE[p.latest_run_status ?? ''] ?? 'neutral'}>
                              {p.latest_run_status?.replace(/_/g, ' ') ?? '—'}
                            </StatusBadge>
                          </Link>
                        ) : (
                          <span className="text-xs text-faint">no runs</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted">
                        {p.run_count}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-faint">
                        {p.last_researched_at
                          ? `${new Date(p.last_researched_at).toLocaleDateString()}${
                              days === 0 ? ' (today)' : days === 1 ? ' (1 day ago)' : ` (${days} days ago)`
                            }`
                          : 'never completed'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {lastPage > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="text-muted">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total} prospects
              </span>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link
                    href={`/history?page=${page - 1}`}
                    className="rounded-lg border border-hairline px-3 py-1.5 font-medium text-muted hover:border-accent/40 hover:text-accent"
                  >
                    Previous
                  </Link>
                )}
                {page < lastPage && (
                  <Link
                    href={`/history?page=${page + 1}`}
                    className="rounded-lg border border-hairline px-3 py-1.5 font-medium text-muted hover:border-accent/40 hover:text-accent"
                  >
                    Next
                  </Link>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
