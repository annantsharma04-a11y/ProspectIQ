import { buildOutreachRationale } from '@/lib/ui/outreach-rationale';
import type { RunSnapshot } from '@/lib/types';

/**
 * Shown directly above the drafted message — a compact synthesis, not a
 * second copy of Target Qualification. That panel already owns the full
 * "why is this account/contact qualified" story: scores, reasoning
 * paragraphs, evidence, capability matches, sources.
 *
 * Account fit / Contact fit / Why now are one line each, no score repeated.
 * Recommended Solution is deliberately the primary element on this card —
 * the one thing a reviewer needs to understand without reading anything
 * else: WHICH approved solution, WHY it fits (one sentence, not the catalog
 * description dump), the EVIDENCE that justified it (capability + score +
 * source, not the full qualification writeup), and what to actually lead
 * with when writing outreach.
 */
export function OutreachRationale({ snapshot }: { snapshot: RunSnapshot }) {
  const rationale = buildOutreachRationale(snapshot);
  if (!rationale) return null;

  return (
    <div className="rounded-xl border border-hairline bg-surface p-5">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-faint">Outreach rationale</h3>

      <dl className="space-y-2.5 text-sm">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">Account fit</dt>
          <dd className="mt-0.5 text-ink/85">{rationale.accountFit}</dd>
        </div>

        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">Contact fit</dt>
          <dd className="mt-0.5 text-ink/85">{rationale.contactFit}</dd>
        </div>

        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">Why now</dt>
          <dd className="mt-0.5 text-ink/85">
            {rationale.primarySignal ? (
              <>
                {rationale.primarySignal.signal}
                <a
                  href={rationale.primarySignal.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1.5 text-xs text-accent hover:underline"
                >
                  source ↗
                </a>
              </>
            ) : (
              <span className="text-faint">No linked signal on this draft.</span>
            )}
          </dd>
        </div>
      </dl>

      {/* Recommended solution — the primary decision element on this card. */}
      <div className="mt-4 rounded-lg border-2 border-accent/30 bg-accent/6 p-4">
        <p className="text-[10px] font-bold uppercase tracking-wider text-accent">Recommended solution</p>

        {rationale.solutionName ? (
          <>
            <p className="mt-1 font-display text-lg font-semibold leading-tight text-ink">
              {rationale.solutionName}
            </p>

            <div className="mt-3 space-y-3 border-t border-accent/20 pt-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-faint">Why it fits</p>
                <p className="mt-0.5 text-sm text-ink/90">{rationale.whyItFits}</p>
              </div>

              {rationale.solutionEvidence ? (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-faint">Evidence</p>
                  <p className="mt-0.5 text-sm text-ink/90">
                    {rationale.solutionEvidence.capabilityName}
                    <span className="ml-1.5 text-xs tabular-nums text-faint">
                      {rationale.solutionEvidence.fitStrength}/100
                    </span>
                    {rationale.solutionEvidence.sourceUrl ? (
                      <a
                        href={rationale.solutionEvidence.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1.5 text-xs text-accent hover:underline"
                      >
                        source ↗
                      </a>
                    ) : null}
                  </p>
                </div>
              ) : null}

              {rationale.useInOutreach ? (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-faint">Use in outreach</p>
                  <p className="mt-0.5 text-sm text-ink/90">{rationale.useInOutreach}</p>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <p className="mt-1 text-sm text-faint">{rationale.whyItFits}</p>
        )}
      </div>
    </div>
  );
}
