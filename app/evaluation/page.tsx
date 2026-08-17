import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import { loadEvaluationInput } from '@/lib/evaluation/query';
import {
  PERIODS,
  PERIOD_LABEL,
  previousWindow,
  windowFor,
  type Period,
  type Rate,
} from '@/lib/evaluation/types';
import InfoTip from '@/components/InfoTip';
import { identifyBottleneck, type Bottleneck } from '@/lib/evaluation/bottleneck';
import { contactDiscoveryMetrics } from '@/lib/evaluation/contacts';
import { OVERVIEW_DEFINITIONS, PANEL_DEFINITIONS } from '@/lib/evaluation/definitions';
import { milestones, strengthHighlights } from '@/lib/evaluation/presentation';
import {
  claimMetrics,
  evidenceMetrics,
  failureAnalysis,
  funnel,
  hookMetrics,
  identityMetrics,
  messageMetrics,
  providerMetrics,
  qualificationMetrics,
  reliabilityMetrics,
  trends,
  unavailableMetrics,
  volumeMetrics,
} from '@/lib/evaluation/metrics';

export const dynamic = 'force-dynamic';

/**
 * Performance dashboard.
 *
 * Observes the pipeline; changes nothing about it. Every figure is computed
 * from stored rows, and each rate is rendered with its denominator so no number
 * can be read without knowing what it is a fraction of.
 *
 * The page leads with metrics that are stable and defensible, and puts the
 * engineering detail under Diagnostics. That split is EDITORIAL ONLY — no
 * metric is recomputed, re-based, filtered or excluded for it, and Diagnostics
 * carries the complete set at its original values.
 */
export default async function EvaluationPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/login?next=/evaluation');

  const { period: rawPeriod } = await searchParams;
  const period: Period = (PERIODS as readonly string[]).includes(rawPeriod ?? '')
    ? (rawPeriod as Period)
    : '30d';

  const input = await loadEvaluationInput(user.id);
  const w = windowFor(period);

  const volume = volumeMetrics(input, w);
  const identity = identityMetrics(input, w);
  const qual = qualificationMetrics(input, w);
  const evidence = evidenceMetrics(input, w);
  const hooks = hookMetrics(input, w);
  const messages = messageMetrics(input, w);
  const claims = claimMetrics(input, w);
  const steps = funnel(input, w);
  const failures = failureAnalysis(input, w);
  const contactDiscovery = contactDiscoveryMetrics(input.runs, input.contactCandidates, w);
  const reliability = reliabilityMetrics(input, w);
  const providers = providerMetrics(input, w);
  const trendRows = trends(input, w, previousWindow(period));
  const gaps = unavailableMetrics();
  const bottleneck = identifyBottleneck(input, w);
  // Presentation-only selections. Both read the metrics above unchanged.
  const highlights = strengthHighlights(input, w);
  const steps4 = milestones(input, w);

  const empty = volume.totalRuns === 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">ProspectIQ performance</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Evidence-verified prospect research and outreach drafting, held for human review.
            Every figure below is computed from stored run data.
          </p>
        </div>
        <nav className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-sm">
          {PERIODS.map((p) => (
            <Link
              key={p}
              href={`/evaluation?period=${p}`}
              className={`rounded-md px-3 py-1.5 font-medium ${
                p === period ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {PERIOD_LABEL[p]}
            </Link>
          ))}
        </nav>
      </header>

      {empty ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">
          No runs in this period. Pick a wider range, or start a run from{' '}
          <Link href="/" className="font-medium text-indigo-600 hover:underline">New run</Link>.
        </p>
      ) : (
        <>
          {/* ── primary performance ──────────────────────────────────────── */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold">Performance</h2>
              <span className="text-xs text-slate-400">{PERIOD_LABEL[period]}</span>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
              <Overview
                label="Run success rate"
                value={fmtRate(reliability.successRate)}
                sub={`${reliability.successRate.numerator} of ${reliability.successRate.denominator} finished runs`}
                tip={reliability.successRate.definition}
                emphasis
              />
              <Overview
                label="Evidence-backed signal rate"
                value={fmtRate(evidence.evidenceBackedRate)}
                sub={`${evidence.accepted} of ${evidence.proposed} proposed signals`}
                tip={evidence.evidenceBackedRate.definition}
                emphasis
              />
              <Overview
                label="Citation verification"
                value={fmtRate(evidence.citationRate)}
                sub={`${evidence.withQuote} of ${evidence.persisted} accepted signals`}
                tip={evidence.citationRate.definition}
                emphasis
              />
              <Overview
                label="Median runtime"
                value={fmtMs(reliability.medianMs)}
                sub={`${reliability.timed} timed runs · p95 ${fmtMs(reliability.p95Ms)}`}
                tip={OVERVIEW_DEFINITIONS['Median runtime']}
              />
              <Overview
                label="Active prospects"
                value={volume.activeProspects}
                sub="with a run in this window"
                tip={OVERVIEW_DEFINITIONS['Active prospects']}
              />
              <Overview
                label="Research runs"
                value={volume.totalRuns}
                sub="run-level, by submission date"
                tip={OVERVIEW_DEFINITIONS['Research runs']}
              />
            </dl>

            <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
              <span className="font-semibold text-slate-800">Human review required.</span>
              <span>
                Nothing is ever sent. {messages.generated} drafts in this window,{' '}
                {messages.awaitingReview} awaiting a person&rsquo;s decision.
              </span>
              <InfoTip label="human review" definition={OVERVIEW_DEFINITIONS['Human review']} />
            </p>
          </section>

          {/* ── what the data supports ───────────────────────────────────── */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              What ProspectIQ does well
              <InfoTip
                label="what ProspectIQ does well"
                definition={PANEL_DEFINITIONS['What ProspectIQ does well']}
              />
            </h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {highlights.map((h) => (
                <li key={h.claim} className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                  <p className="text-sm font-medium leading-snug text-slate-800">{h.claim}</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">{h.basis}</p>
                  {h.byConstruction && (
                    <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      Enforced in code, not observed
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* ── pipeline at a glance ─────────────────────────────────────── */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              Pipeline at a glance
              <InfoTip
                label="pipeline at a glance"
                definition={PANEL_DEFINITIONS['Pipeline at a glance']}
              />
            </h2>
            <p className="mb-3 mt-0.5 text-xs text-slate-500">
              Milestones, not gates. A run can legitimately end early when no public evidence
              supports outreach.
            </p>
            <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {steps4.map((m, i) => (
                <li key={m.label} className="rounded-lg bg-slate-50 px-3 py-2.5" title={m.definition}>
                  <p className="text-2xl font-bold tabular-nums tracking-tight">{m.count}</p>
                  <p className="text-xs leading-snug text-slate-600">{m.label}</p>
                  {i > 0 && steps4[i - 1].count > 0 && (
                    <p className="mt-0.5 text-[11px] tabular-nums text-slate-400">
                      {Math.round((m.count / steps4[i - 1].count) * 1000) / 10}% of previous
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </section>

          {/* ── diagnostics: everything, at its original values ──────────── */}
          <details className="group rounded-xl border border-slate-200 bg-white shadow-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
              <span>
                <span className="text-sm font-semibold">Diagnostics</span>
                <span className="mt-0.5 block max-w-xl text-xs leading-relaxed text-slate-500">
                  Detailed pipeline metrics used to understand system behaviour and identify areas
                  for improvement. Same calculations, same denominators, same rows as above.
                </span>
              </span>
              <span className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 group-open:hidden">
                Show
              </span>
              <span className="hidden shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 group-open:inline-block">
                Hide
              </span>
            </summary>

            <div className="space-y-6 border-t border-slate-100 p-5">
            {/* ── bottleneck ───────────────────────────────────────────────── */}
            <BottleneckPanel bottleneck={bottleneck} />

            {/* ── funnel ─────────────────────────────────────────────────── */}
            <Panel
              title="Pipeline funnel"
              note="Run-level. Each step shows how many runs reached that point, so a step can never exceed the one above it."
              tip={PANEL_DEFINITIONS['Pipeline funnel']}
            >
              <ol className="space-y-1.5">
                {steps.map((s, i) => (
                  <li key={s.label}>
                    <div className="flex items-center gap-2 sm:gap-3">
                      <div
                        className="w-32 shrink-0 truncate text-xs font-medium text-slate-700 sm:w-52 sm:text-sm"
                        title={s.definition}
                      >
                        {s.label}
                      </div>
                      <div className="h-6 min-w-0 flex-1 overflow-hidden rounded bg-slate-100">
                        <div
                          className="h-full bg-indigo-500/80"
                          style={{ width: `${s.ofStart ?? 100}%` }}
                        />
                      </div>
                      <div className="w-10 shrink-0 text-right text-sm tabular-nums font-semibold sm:w-16">
                        {s.count}
                      </div>
                      <div className="hidden w-36 shrink-0 text-right text-xs tabular-nums text-slate-500 md:block">
                        {i === 0
                          ? 'submitted'
                          : s.label === 'Approved after human review'
                            ? `${messages.reviewed} of ${messages.generated} reviewed`
                            : `${s.ofPrevious ?? 0}% of prev · ${s.ofStart ?? 0}% total`}
                      </div>
                    </div>
                    <p className="ml-[8.5rem] text-[11px] tabular-nums text-slate-400 md:hidden">
                      {i === 0
                        ? 'submitted'
                        : s.label === 'Approved after human review'
                          ? `${messages.reviewed} of ${messages.generated} reviewed`
                          : `${s.ofPrevious ?? 0}% of prev · ${s.ofStart ?? 0}% total`}
                    </p>
                  </li>
                ))}
              </ol>
              {messages.reviewed === 0 && messages.generated > 0 && (
                <p className="mt-3 border-t border-slate-100 pt-2.5 text-xs text-slate-500">
                  Approvals are zero because no draft has been reviewed yet. {messages.generated} drafts
                  are waiting in the review queue; this is a pending human step, not a pipeline failure.
                </p>
              )}
            </Panel>

            {/* ── failures ───────────────────────────────────────────────── */}
            <Panel
              title="Failure analysis"
              note="Runs that did not reach a draft, bucketed by the earliest reason so no run is counted twice."
              tip={PANEL_DEFINITIONS['Failure analysis']}
            >
              {failures.length === 0 ? (
                <p className="text-sm text-slate-500">Every run in this period reached a draft.</p>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full min-w-[22rem] text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="pb-2 font-medium">Reason</th>
                      <th className="pb-2 text-right font-medium">Runs</th>
                      <th className="pb-2 text-right font-medium">Share</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {failures.map((f) => (
                      <tr key={f.label}>
                        <td className="py-1.5 text-slate-700" title={f.definition}>{f.label}</td>
                        <td className="py-1.5 text-right tabular-nums">{f.count}</td>
                        <td className="py-1.5 text-right tabular-nums text-slate-500">{f.share}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </Panel>

            {/* ── contact candidate discovery ──────────────────────────────── */}
            {contactDiscovery.applicable > 0 && (
              <Panel
                title="Contact candidate discovery"
                note="Runs where the company qualified but this contact did not. A distinct outcome from a company failing to qualify."
              >
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Mini label="Applicable runs" value={contactDiscovery.applicable} />
                  <Mini label="Runs with a candidate" value={contactDiscovery.candidatesFound} />
                  <Mini label="Candidates selected" value={contactDiscovery.selected} />
                  <Mini label="Candidates verified" value={contactDiscovery.verified} />
                </div>
                <RateLine label="Discovery yield" r={contactDiscovery.discoveryYieldRate} />
                <RateLine label="Selection rate" r={contactDiscovery.selectionRate} />
                <RateLine label="Verification rate" r={contactDiscovery.verificationRate} />
              </Panel>
            )}

            {/* ── volume detail ──────────────────────────────────────────── */}
            <Panel title="Volume" note="Run-level counts by status." tip={PANEL_DEFINITIONS['Volume']}>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Mini label="Completed" value={volume.completedRuns} />
                <Mini label="Failed" value={volume.failedRuns} />
                <Mini label="Processing" value={volume.processingRuns} />
                <Mini label="Prospects added" value={volume.prospectsAdded} />
                <Mini label="Runs / prospect" value={volume.runsPerProspect ?? '—'} />
              </div>
            </Panel>

            <div className="grid gap-6 lg:grid-cols-2">
              {/* ── identity ─────────────────────────────────────────────── */}
              <Panel title="Identity" note="Outcomes for runs that executed identity verification." tip={identity.verificationRate.definition}>
                <Bars
                  data={[
                    ['VERIFIED', identity.verified],
                    ['PARTIAL', identity.partial],
                    ['AMBIGUOUS', identity.ambiguous],
                    ['FAILED', identity.failed],
                  ]}
                  total={identity.reached}
                />
                <RateLine label="Identity verification rate" r={identity.verificationRate} />
                <p className="mt-2 text-xs text-slate-500">
                  {identity.automatic} resolved automatically · {identity.userConfirmed} confirmed by a
                  human · denominator {identity.reached} runs reaching verification
                </p>
              </Panel>

              {/* ── qualification ────────────────────────────────────────── */}
              <Panel title="Qualification" note="Outcomes for runs that reached a qualification stage." tip={qual.qualificationRate.definition}>
                <Bars
                  data={[
                    ['QUALIFIED', qual.qualified],
                    ['BORDERLINE', qual.borderline],
                    ['NOT_QUALIFIED', qual.notQualified],
                    ['UNKNOWN', qual.unknown],
                  ]}
                  total={qual.reached}
                />
                <RateLine label="Qualification rate" r={qual.qualificationRate} />
                <p className="mt-2 text-xs text-slate-500">
                  UNKNOWN is reported separately and never counted as disqualified. Company evidence
                  basis:{' '}
                  {Object.entries(qual.companyEvidenceBasis)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(' · ') || '—'}
                </p>
              </Panel>

              {/* ── evidence ─────────────────────────────────────────────── */}
              <Panel title="Evidence performance" note="Proposed signals versus those that survived evidence checking." tip={evidence.evidenceBackedRate.definition}>
                <div className="grid grid-cols-3 gap-3">
                  <Mini label="Proposed" value={evidence.proposed} />
                  <Mini label="Accepted" value={evidence.accepted} />
                  <Mini label="Rejected" value={evidence.rejected} />
                </div>
                <RateLine label="Evidence-backed signal rate" r={evidence.evidenceBackedRate} />
                <RateLine label="Citation verification" r={evidence.citationRate} />
                <p className="mt-1 text-xs text-slate-500">
                  {evidence.runsWithSignal} runs produced at least one verified signal.
                </p>
              </Panel>

              {/* ── hooks ────────────────────────────────────────────────── */}
              <Panel title="Hook performance" note="Whether a verified hook cleared the quality gate." tip={hooks.acceptanceRate.definition}>
                <div className="grid grid-cols-3 gap-3">
                  <Mini label="Selected" value={hooks.selected} />
                  <Mini label="No verified hook" value={hooks.insufficientEvidence} />
                  <Mini label="Candidates rejected" value={hooks.rejectedCandidates} />
                </div>
                <RateLine label="Hook acceptance rate" r={hooks.acceptanceRate} />
                {Object.keys(hooks.byCategory).length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 text-xs font-medium text-slate-500">Selected hooks by category</p>
                    <Bars
                      data={Object.entries(hooks.byCategory).sort((a, b) => b[1] - a[1])}
                      total={hooks.selected}
                    />
                  </div>
                )}
              </Panel>

              {/* ── messages ─────────────────────────────────────────────── */}
              <Panel title="Message and review" note="Drafts produced, and where they sit in review." tip={messages.approvalRate.definition}>
                <div className="grid grid-cols-3 gap-3">
                  <Mini label="Drafts generated" value={messages.generated} />
                  <Mini label="Awaiting review" value={messages.awaitingReview} />
                  <Mini label="Reviewed" value={messages.reviewed} />
                </div>
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <Mini label="Approved" value={messages.approved} />
                  <Mini label="Edited" value={messages.edited} />
                  <Mini label="Rejected" value={messages.rejected} />
                </div>
                {messages.reviewed === 0 ? (
                  <p className="mt-3 rounded bg-slate-50 px-2.5 py-2 text-xs text-slate-600">
                    No draft has been reviewed yet, so approval and edit rates have no denominator.
                    Edits <em>are</em> recorded when they happen — this is an empty queue, not missing
                    instrumentation.
                  </p>
                ) : (
                  <>
                    <RateLine label="Approval rate" r={messages.approvalRate} />
                    <RateLine label="Edit rate" r={messages.editRate} />
                  </>
                )}
                <p className="mt-2 text-xs text-slate-500">
                  {messages.personalized} personalized · {messages.conservative} conservative
                </p>
              </Panel>

              {/* ── claims ───────────────────────────────────────────────── */}
              <Panel title="Claim validation" note="Factual claims checked against the evidence." tip={claims.passRate.definition}>
                <div className="grid grid-cols-3 gap-3">
                  <Mini label="Claims checked" value={claims.total} />
                  <Mini label="Need evidence" value={claims.factual} />
                  <Mini label="Allowed by type" value={claims.allowedByType} />
                </div>
                <RateLine label="Factual claim pass rate" r={claims.passRate} />
                <div className="mt-3">
                  <p className="mb-1 text-xs font-medium text-slate-500">By claim type</p>
                  <Bars
                    data={Object.entries(claims.byType).sort((a, b) => b[1] - a[1])}
                    total={claims.total}
                  />
                </div>
                {claims.uncategorised > 0 && (
                  <p className="mt-2 text-xs text-slate-500">
                    {claims.uncategorised} claims predate claim typing and are excluded from the pass
                    rate rather than assumed factual.
                  </p>
                )}
              </Panel>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              {/* ── reliability ──────────────────────────────────────────── */}
              <Panel title="Reliability" note="Completion and timing for runs in this window." tip={reliability.successRate.definition}>
                <div className="grid grid-cols-2 gap-3">
                  <Mini label="Success rate" value={fmtRate(reliability.successRate)} />
                  <Mini label="Failure rate" value={fmtRate(reliability.failureRate)} />
                  <Mini label="Median runtime" value={fmtMs(reliability.medianMs)} />
                  <Mini label="P95 runtime" value={fmtMs(reliability.p95Ms)} />
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Average {fmtMs(reliability.avgMs)} over {reliability.timed} timed runs.
                </p>
                {reliability.slowestStages.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 text-xs font-medium text-slate-500">Slowest stages (mean)</p>
                    <ul className="space-y-1 text-xs">
                      {reliability.slowestStages.slice(0, 6).map((s) => (
                        <li key={s.stage} className="flex justify-between tabular-nums">
                          <span className="text-slate-600">{s.stage.replace(/_/g, ' ')}</span>
                          <span className="text-slate-500">
                            {fmtMs(s.avgMs)} avg · {fmtMs(s.p95Ms)} p95 · {s.runs} runs
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Panel>

              {/* ── providers ────────────────────────────────────────────── */}
              <Panel title="Provider performance" note="Outcomes as recorded on runs and sources." tip={PANEL_DEFINITIONS['Provider performance']}>
                <div className="grid grid-cols-3 gap-3">
                  <Mini label="Profile OK" value={providers.profileAccessible} />
                  <Mini label="Unavailable" value={providers.profileUnavailable} />
                  <Mini label="Blocked" value={providers.profileBlocked} />
                </div>
                <RateLine label="Profile retrieval success" r={providers.profileSuccessRate} />
                <RateLine
                  label={input.sourcesSampled ? 'Full-text sources in sampled set' : 'Full page text retrieved'}
                  r={providers.fullTextRate}
                />
                {input.sourcesSampled && (
                  <p className="mt-1 text-xs text-amber-700">
                    Sampled: based on {input.sourcesCounted.toLocaleString()} source rows, the maximum a
                    single query returns. Read it as the rate within that sample, not across every source.
                  </p>
                )}
                <div className="mt-3">
                  <p className="mb-1 text-xs font-medium text-slate-500">Search attribution (sources)</p>
                  <Bars
                    data={Object.entries(providers.searchAttribution).sort((a, b) => b[1] - a[1])}
                    total={Object.values(providers.searchAttribution).reduce((a, b) => a + b, 0)}
                  />
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Model errors:{' '}
                  {Object.keys(providers.modelErrors).length === 0
                    ? 'none recorded in this period'
                    : Object.entries(providers.modelErrors).map(([k, v]) => `${k} ${v}`).join(' · ')}
                </p>
              </Panel>
            </div>

            {/* ── trends ─────────────────────────────────────────────────── */}
            <Panel title="Trends" note="This window versus the one immediately before it." tip={PANEL_DEFINITIONS['Trends']}>
              {!trendRows ? (
                <p className="text-sm text-slate-500">
                  Not enough historical data — the preceding window contains no runs.
                </p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {trendRows.map((t) => (
                    <li key={t.label} className="flex items-baseline justify-between rounded-lg bg-slate-50 px-3 py-2">
                      <span className="text-sm text-slate-700">{t.label}</span>
                      <span className="text-sm tabular-nums font-medium">
                        {t.delta == null ? (
                          <span className="text-slate-400">no comparison</span>
                        ) : (
                          <span
                            className={
                              t.delta === 0
                                ? 'text-slate-500'
                                : (t.inverted ? t.delta < 0 : t.delta > 0)
                                  ? 'text-emerald-600'
                                  : 'text-red-600'
                            }
                          >
                            {t.delta > 0 ? '+' : ''}
                            {t.delta}
                            {t.unit}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          {/* ── gaps ─────────────────────────────────────────────────────── */}
          <Panel title="Not measured" note="Gaps are shown rather than hidden. No value here is estimated." tip={PANEL_DEFINITIONS['Not measured']}>
            <ul className="grid gap-2 sm:grid-cols-2">
              {gaps.map((g) => (
                <li key={g.name} className="border-l-2 border-slate-200 pl-3" title={`${g.reason} Would require: ${g.requires}`}>
                  <p className="text-sm font-medium text-slate-800">{g.name}</p>
                  <p className="text-xs leading-snug text-slate-500">{g.reason}</p>
                </li>
              ))}
            </ul>
          </Panel>
            </div>
          </details>

        </>
      )}

    </div>
  );
}

// ─── presentation ────────────────────────────────────────────────────────────

function Panel({
  title,
  note,
  tip,
  children,
}: {
  title: string;
  note?: string;
  /** Full formula, on hover. The visible note stays short. */
  tip?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        {title}
        {tip && <InfoTip label={title} definition={tip} />}
      </h2>
      {note && <p className="mb-3 mt-0.5 text-xs leading-relaxed text-slate-500">{note}</p>}
      {children}
    </section>
  );
}

/** One figure in the at-a-glance strip. Label, value, and its denominator. */
function Overview({
  label,
  value,
  sub,
  tip,
  emphasis = false,
}: {
  label: string;
  value: React.ReactNode;
  sub: string;
  tip?: string;
  /** Headline KPI: larger figure. The number itself is identical either way. */
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-xs font-medium text-slate-500">
        <span className="min-w-0 truncate">{label}</span>
        {tip && <InfoTip label={label} definition={tip} />}
      </dt>
      <dd
        className={`mt-0.5 font-bold tabular-nums tracking-tight ${
          emphasis ? 'text-3xl text-slate-900' : 'text-2xl text-slate-700'
        }`}
      >
        {value}
      </dd>
      <dd className="text-xs leading-snug text-slate-400">{sub}</dd>
    </div>
  );
}

/**
 * The single largest measured loss, named in plain terms.
 *
 * Deterministic: see lib/evaluation/bottleneck.ts. It states a measurement and
 * stops there — no recommendation, no severity theatre.
 */
function BottleneckPanel({ bottleneck }: { bottleneck: Bottleneck }) {
  const none = bottleneck.kind === 'none';
  return (
    <section
      className={`rounded-xl border p-5 shadow-sm ${
        none ? 'border-slate-200 bg-white' : 'border-amber-200 bg-amber-50'
      }`}
    >
      <h2
        className={`flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide ${
          none ? 'text-slate-400' : 'text-amber-700'
        }`}
      >
        Current bottleneck
        <InfoTip label="current bottleneck" definition={PANEL_DEFINITIONS['Current bottleneck']} />
      </h2>
      <p className={`mt-1 text-base font-semibold ${none ? 'text-slate-700' : 'text-amber-950'}`}>
        {bottleneck.headline}
      </p>
      {bottleneck.why && (
        <p className={`mt-1 text-sm leading-relaxed ${none ? 'text-slate-600' : 'text-amber-900'}`}>
          <span className="font-medium">Why: </span>
          {bottleneck.why}
        </p>
      )}
      {bottleneck.lost != null && bottleneck.share != null && (
        <p className="mt-1.5 text-xs text-amber-700">
          {bottleneck.lost} runs lost at this step, {bottleneck.share}% of those submitted.
        </p>
      )}
    </section>
  );
}

function Mini({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function RateLine({ label, r }: { label: string; r: Rate }) {
  return (
    <p className="mt-2 flex items-baseline justify-between text-sm" title={r.definition}>
      <span className="text-slate-600">{label}</span>
      <span className="tabular-nums font-medium">
        {fmtRate(r)}{' '}
        <span className="text-xs font-normal text-slate-400">
          ({r.numerator}/{r.denominator})
        </span>
      </span>
    </p>
  );
}

function Bars({ data, total }: { data: [string, number][]; total: number }) {
  if (data.length === 0 || total === 0) {
    return <p className="text-sm text-slate-400">No data in this period.</p>;
  }
  return (
    <ul className="space-y-1">
      {data.map(([label, n]) => (
        <li key={label} className="flex items-center gap-2">
          <span className="w-40 shrink-0 truncate text-xs text-slate-600">
            {label.replace(/_/g, ' ')}
          </span>
          <span className="h-4 flex-1 overflow-hidden rounded bg-slate-100">
            <span
              className="block h-full bg-indigo-400/70"
              style={{ width: `${total > 0 ? (n / total) * 100 : 0}%` }}
            />
          </span>
          <span className="w-10 shrink-0 text-right text-xs tabular-nums text-slate-600">{n}</span>
        </li>
      ))}
    </ul>
  );
}

function fmtRate(r: Rate): string {
  return r.rate == null ? '—' : `${r.rate}%`;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
