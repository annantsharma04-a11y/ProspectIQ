// Presentation helpers shared by the history and prospect views.
//
// Extracted from the history page unchanged so the prospect pages label a run
// exactly the way the run list always has — one vocabulary, one place to change.
//
// Exposed as StatusTone keys (see components/StatusBadge.tsx) rather than raw
// class strings, so every status pill in the app renders through the same
// dot + translucent-label primitive instead of each page inventing its own.

import type { RunRow } from '@/lib/types';
import type { StatusTone } from '@/components/StatusBadge';

export const RUN_STATUS_TONE: Record<string, StatusTone> = {
  ready_for_review: 'emerald',
  needs_manual_review: 'amber',
  approved: 'accent',
  rejected: 'neutral',
  failed: 'red',
  running: 'accent',
  ai_analysis_pending: 'amber',
  queued: 'neutral',
};

export const QUAL_TONE: Record<string, StatusTone> = {
  QUALIFIED: 'emerald',
  BORDERLINE: 'amber',
  NOT_QUALIFIED: 'neutral',
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
