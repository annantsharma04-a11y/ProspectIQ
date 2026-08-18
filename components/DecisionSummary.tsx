import { StatusBadge, type StatusTone } from './StatusBadge';
import { buildDecisionSummary, type DecisionAction } from '@/lib/ui/decision-summary';
import type { FitState } from '@/lib/qualification/types';
import type { RunRow } from '@/lib/types';

const FIT_TONE: Record<FitState, StatusTone> = {
  QUALIFIED: 'emerald',
  BORDERLINE: 'amber',
  NOT_QUALIFIED: 'neutral',
};

const ACTION_TONE: Record<DecisionAction, StatusTone> = {
  'TARGET DIRECTLY': 'emerald',
  'VERIFY BETTER CONTACT': 'amber',
  'FIND BETTER CONTACT': 'amber',
  'EXPLORATORY OUTREACH': 'accent',
  'DO NOT CONTACT': 'neutral',
};

/**
 * The TL;DR at the top of a run: is the account qualified, is the contact
 * qualified, what should happen next, and why — one line of evidence-based
 * reason, no more. The full Target Qualification panel further down carries
 * the complete evidence breakdown; this exists so that answer doesn't require
 * scrolling to find.
 */
export function DecisionSummary({ run }: { run: Pick<RunRow, 'qualification'> }) {
  const summary = buildDecisionSummary(run);
  if (!summary) return null;

  return (
    <div className="rounded-xl border border-hairline bg-surface p-5">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-faint">Decision summary</h3>

      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">Account status</dt>
          <dd className="mt-1">
            <StatusBadge tone={FIT_TONE[summary.accountStatus]}>
              {summary.accountStatus.replace(/_/g, ' ')}
            </StatusBadge>
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">Contact status</dt>
          <dd className="mt-1">
            <StatusBadge tone={FIT_TONE[summary.contactStatus]}>
              {summary.contactStatus.replace(/_/g, ' ')}
            </StatusBadge>
          </dd>
        </div>
      </dl>

      <div className="mt-3 border-t border-hairline pt-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-faint">
          Recommended action
        </span>
        <div className="mt-1">
          <StatusBadge tone={ACTION_TONE[summary.action]}>{summary.action}</StatusBadge>
        </div>
        <p className="mt-2 text-sm text-ink/85">{summary.reason}</p>
      </div>
    </div>
  );
}
