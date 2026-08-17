// Presentation helpers shared by the history and prospect views.
//
// Extracted from the history page unchanged so the prospect pages label a run
// exactly the way the run list always has — one vocabulary, one place to change.

import type { RunRow } from '@/lib/types';

export const RUN_STATUS_STYLE: Record<string, string> = {
  ready_for_review: 'bg-green-100 text-green-700',
  needs_manual_review: 'bg-amber-100 text-amber-700',
  approved: 'bg-indigo-100 text-indigo-700',
  rejected: 'bg-slate-200 text-slate-600',
  failed: 'bg-red-100 text-red-700',
  running: 'bg-blue-100 text-blue-700',
  ai_analysis_pending: 'bg-amber-100 text-amber-700',
  queued: 'bg-slate-100 text-slate-500',
};

export const QUAL_STYLE: Record<string, string> = {
  QUALIFIED: 'bg-emerald-100 text-emerald-700',
  BORDERLINE: 'bg-amber-100 text-amber-700',
  NOT_QUALIFIED: 'bg-slate-200 text-slate-600',
};

/**
 * Errors shown to a user describe what happened to their run, not which
 * provider returned which status code. The raw error stays on the run record
 * and in the stage's technical details.
 */
export function friendlyError(run: RunRow): string | null {
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

export function duration(run: RunRow): string {
  if (!run.started_at || !run.completed_at) return '—';
  const ms = new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
