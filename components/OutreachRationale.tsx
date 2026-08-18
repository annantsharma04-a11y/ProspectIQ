import { buildOutreachRationale } from '@/lib/ui/outreach-rationale';
import type { RunSnapshot } from '@/lib/types';

const FIT_TONE: Record<string, string> = {
  HIGH: 'bg-emerald-600/10 text-emerald-800',
  MEDIUM: 'bg-accent/10 text-accent',
  LOW: 'bg-amber-600/10 text-amber-800',
  UNKNOWN: 'bg-ink/6 text-muted',
};

/**
 * Shown directly above the drafted message: why this account, why this
 * contact, the one verified signal the message rests on, and which approved
 * solution (if any) the message was allowed to reference. Every value here
 * was computed once, before the message was written — this is not a
 * post-hoc justification, it is what the model was actually given.
 */
export function OutreachRationale({ snapshot }: { snapshot: RunSnapshot }) {
  const rationale = buildOutreachRationale(snapshot);
  if (!rationale) return null;

  return (
    <div className="rounded-xl border border-hairline bg-surface p-5">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-faint">Outreach rationale</h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-hairline p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-faint">Account fit</span>
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${FIT_TONE[rationale.accountFit.classification]}`}>
              {rationale.accountFit.classification} {rationale.accountFit.score}
            </span>
          </div>
          {rationale.accountFit.reason ? (
            <p className="mt-1.5 text-xs text-ink/85">{rationale.accountFit.reason}</p>
          ) : null}
        </div>

        <div className="rounded-lg border border-hairline p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-faint">Contact fit</span>
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${FIT_TONE[rationale.contactFit.classification]}`}>
              {rationale.contactFit.classification} {rationale.contactFit.score}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-ink/85">{rationale.contactFit.reason}</p>
        </div>
      </div>

      <div className="mt-3 border-t border-hairline pt-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-faint">
          Primary verified signal
        </span>
        {rationale.primarySignal ? (
          <p className="mt-1 text-sm text-ink/85">
            {rationale.primarySignal.signal}
            <a
              href={rationale.primarySignal.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1.5 text-xs text-accent hover:underline"
            >
              source ↗
            </a>
          </p>
        ) : (
          <p className="mt-1 text-sm text-faint">No linked signal on this draft.</p>
        )}
      </div>

      <div className="mt-3 border-t border-hairline pt-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-faint">
          Recommended solution
        </span>
        {rationale.solutionName ? (
          <>
            <p className="mt-1 text-sm font-medium text-ink">{rationale.solutionName}</p>
            <p className="mt-1 text-xs text-muted">
              <span className="font-medium text-faint">Why it fits: </span>
              {rationale.whyItFits}
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm text-faint">{rationale.whyItFits}</p>
        )}
      </div>
    </div>
  );
}
