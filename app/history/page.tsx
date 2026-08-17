import Link from 'next/link';
import { listRuns } from '@/lib/supabase/queries';
import type { RunRow } from '@/lib/types';
import { deriveOutreachStatus, OUTREACH_LABEL } from '@/lib/qualification/outreach-status';

export const dynamic = 'force-dynamic';

const STATUS_STYLE: Record<string, string> = {
  ready_for_review: 'bg-green-100 text-green-700',
  needs_manual_review: 'bg-amber-100 text-amber-700',
  approved: 'bg-indigo-100 text-indigo-700',
  rejected: 'bg-slate-200 text-slate-600',
  failed: 'bg-red-100 text-red-700',
  running: 'bg-blue-100 text-blue-700',
  ai_analysis_pending: 'bg-amber-100 text-amber-700',
  queued: 'bg-slate-100 text-slate-500',
};

/**
 * Errors shown to a user describe what happened to their run, not which
 * provider returned which status code. The raw error stays on the run record
 * and in the stage's technical details.
 */
const QUAL_STYLE: Record<string, string> = {
  QUALIFIED: 'bg-emerald-100 text-emerald-700',
  BORDERLINE: 'bg-amber-100 text-amber-700',
  NOT_QUALIFIED: 'bg-slate-200 text-slate-600',
};

function friendlyError(run: RunRow): string | null {
  if (!run.error) return null;

  switch (run.ai_error_type) {
    case 'quota_exhausted':
      return 'AI analysis unavailable — model quota exhausted. Research was saved and can be retried.';
    case 'rate_limited':
      return 'AI analysis was rate limited. Research was saved and can be retried.';
    case 'model_unavailable':
      return 'The configured AI model was unavailable. Research was saved and can be retried.';
    case 'authentication_error':
      return 'AI analysis is not configured correctly.';
    default:
      break;
  }

  const stage = run.error.split(':')[0]?.replace(/_/g, ' ');
  if (/search provider|tavily|brave/i.test(run.error)) {
    return 'Web search was unavailable during this run.';
  }
  if (/gemini|model/i.test(run.error)) {
    return 'AI analysis did not complete for this run.';
  }
  return stage ? `Run stopped during ${stage}.` : 'Run did not complete.';
}

function duration(run: RunRow): string {
  if (!run.started_at || !run.completed_at) return '—';
  const ms = new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default async function HistoryPage() {
  const runs = await listRuns();

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Run history</h1>
      <p className="mb-5 text-sm text-slate-600">
        Every real run, exactly as it executed. Nothing here is seeded or simulated.
      </p>

      {runs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">
          No runs yet. Start one from{' '}
          <Link href="/" className="font-medium text-indigo-600 hover:underline">
            New run
          </Link>
          .
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Prospect</th>
                <th className="px-4 py-2.5 font-medium">Company</th>
                <th className="px-4 py-2.5 font-medium">LinkedIn</th>
                <th className="px-4 py-2.5 font-medium">Target</th>
                <th className="px-4 py-2.5 font-medium">Outreach</th>
                <th className="px-4 py-2.5 font-medium">Hook</th>
                <th className="px-4 py-2.5 text-right font-medium">Conf.</th>
                <th className="px-4 py-2.5 text-right font-medium">Took</th>
                <th className="px-4 py-2.5 font-medium">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/runs/${run.id}`} className="font-medium text-indigo-700 hover:underline">
                      {run.prospect_name ?? run.input_name ?? `/in/${run.linkedin_slug}`}
                    </Link>
                    {friendlyError(run) && (
                      <p className="max-w-xs text-xs leading-snug text-red-600" title={run.error ?? ''}>
                        {friendlyError(run)}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {run.company_name ?? run.input_company ?? '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <a
                      href={run.linkedin_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-slate-500 hover:text-indigo-600 hover:underline"
                    >
                      /in/{run.linkedin_slug}
                    </a>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        QUAL_STYLE[run.qualification_status ?? ''] ?? 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {run.qualification_status?.replace(/_/g, ' ') ?? '—'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_STYLE[run.status] ?? 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {OUTREACH_LABEL[deriveOutreachStatus(run)]}
                    </span>
                  </td>
                  <td className="max-w-xs px-4 py-2.5">
                    <span className="line-clamp-2 text-xs text-slate-600">
                      {run.qualification_status === 'NOT_QUALIFIED' ||
                      run.qualification_status === 'BORDERLINE'
                        ? `Not pitched — ${run.qualification_status === 'BORDERLINE' ? 'borderline fit' : 'target did not qualify'}`
                        : run.insufficient_evidence
                          ? 'No verified hook — no message generated'
                          : (run.selected_hook ?? '—')}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                    {run.overall_confidence ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{duration(run)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">
                    {new Date(run.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
