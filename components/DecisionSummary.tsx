import { StatusBadge, type StatusTone } from './StatusBadge';
import { buildDecisionSummary, ACTION_TONE } from '@/lib/ui/decision-summary';
import type { FitState, PersonRelevance } from '@/lib/qualification/types';
import type { RunRow } from '@/lib/types';

const FIT_TONE: Record<FitState, StatusTone> = {
  QUALIFIED: 'emerald',
  BORDERLINE: 'amber',
  NOT_QUALIFIED: 'neutral',
};

/**
 * The contact reads on its own four-tier scale, deliberately NOT the
 * account's. A weak contact at a strong account is a reason to find a better
 * contact — never a reason to read the account as unqualified.
 */
const RELEVANCE_TONE: Record<PersonRelevance, StatusTone> = {
  STRONG: 'emerald',
  REASONABLE: 'accent',
  WEAK: 'amber',
  UNRELATED: 'neutral',
};

const RELEVANCE_LABEL: Record<PersonRelevance, string> = {
  STRONG: 'Strong — owns this workflow',
  REASONABLE: 'Reasonable — plausible owner',
  WEAK: 'Weak — limited connection',
  UNRELATED: 'Unrelated function',
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
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">Contact relevance</dt>
          <dd className="mt-1">
            <StatusBadge tone={RELEVANCE_TONE[summary.personRelevance]}>
              {RELEVANCE_LABEL[summary.personRelevance]}
            </StatusBadge>
          </dd>
        </div>
      </dl>

      {/* Says plainly that a weak contact is not a verdict on the account —
          the account is the hard anchor, the person is the softer signal. */}
      {summary.accountStatus === 'QUALIFIED' && summary.personRelevance !== 'STRONG' && (
        <p className="mt-2 text-xs text-muted">
          The account qualified on verified evidence. This contact is a separate,
          softer judgment — a better contact can be found without re-qualifying the account.
        </p>
      )}

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
