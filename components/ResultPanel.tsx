'use client';

import { SignalList } from './SignalList';
import { SourceList } from './SourceList';
import Link from 'next/link';
import { DraftReviewCard } from './DraftReviewCard';
import { IdentityCard } from './IdentityCard';
import { ContactCandidates } from './ContactCandidates';
import { DecisionSummary } from './DecisionSummary';
import { AccountDecision } from './AccountDecision';
import { OutreachRationale } from './OutreachRationale';
import { StatusBadge, type StatusTone } from './StatusBadge';
import type { RunSnapshot } from '@/lib/types';
import { deriveOutreachStatus, OUTREACH_LABEL } from '@/lib/qualification/outreach-status';
import type { QualificationAction } from '@/lib/qualification/types';
import { RUN_STATUS_TONE } from '@/lib/ui/status-styles';

interface HookStageOutput {
  selected: {
    signal: string;
    why_it_matters: string;
    role_relevance?: string | null;
    outreach_rationale?: string | null;
    signal_level?: string;
    evidence_level?: string;
    source_url: string;
    published_date: string | null;
  } | null;
  rejected_candidates?: { signal: string; reason: string }[];
  research_coverage?: { sources?: number; signals_verified?: number; signals_rejected?: number };
  selection_reason?: string;
  confidence?: number;
  alternatives_considered?: { signal: string; why_not: string }[];
  insufficient_evidence?: boolean;
  insufficient_reason?: string | null;
}

const PROVIDER_LABEL: Record<string, string> = {
  brightdata: 'Bright Data',
  public_web: 'public web research',
};

/**
 * Plain-language status for the three things that can independently succeed or
 * fail: profile retrieval, public research, and AI analysis. Internal provider
 * errors are never shown here.
 */
function PipelineStatusLines({ snapshot }: { snapshot: RunSnapshot }) {
  const { run, stages } = snapshot;
  const stageOf = (name: string) => stages.find((s) => s.stage_name === name);

  const research = [stageOf('research_prospect'), stageOf('research_company')];
  const researchRan = research.some((s) => s?.status === 'complete' || s?.status === 'degraded');
  const analysis = stageOf('evaluate_signals');
  const analysisMeta = (analysis?.output ?? null) as { llm?: { used_fallback_model?: boolean } } | null;

  if (run.status === 'queued' || run.status === 'running') return null;

  const line = (ok: boolean | null, text: string) => (
    <li className={ok === null ? 'text-faint' : ok ? 'text-emerald-700' : 'text-amber-700'}>
      <span aria-hidden="true">{ok === null ? '·' : ok ? '✓' : '⚠'}</span> {text}
    </li>
  );

  return (
    <ul className="mt-3 space-y-0.5 rounded-lg bg-app px-3 py-2 text-xs">
      {run.profile_access?.directLinkedIn
        ? line(true, 'LinkedIn profile retrieved')
        : line(false, 'LinkedIn profile data unavailable — public web research used instead')}

      {researchRan
        ? line(true, `Public research completed (${snapshot.sources.length} sources)`)
        : line(false, 'Public research did not complete')}

      {run.status === 'ai_analysis_pending'
        ? line(false, 'AI analysis pending — your prospect data and research were saved')
        : analysis?.status === 'complete' || analysis?.status === 'degraded'
          ? line(
              true,
              `AI analysis completed${analysisMeta?.llm?.used_fallback_model ? ' using fallback model' : ''}`,
            )
          : line(null, 'AI analysis not run')}
    </ul>
  );
}

/**
 * States plainly where profile data came from. When direct retrieval fails the
 * UI says so — it never implies a profile was read when it wasn't.
 */
function ProfileSourceCard({ run }: { run: RunSnapshot['run'] }) {
  const access = run.profile_access;
  const profile = run.linkedin_profile;

  // Before the identify stage has run there is nothing to report yet.
  if (!access) return null;

  if (access.directLinkedIn) {
    return (
      <div className="mt-3 rounded-lg border border-emerald-600/20 bg-emerald-600/5 px-3 py-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
          LinkedIn profile
        </p>
        <p className="mt-0.5 text-sm text-emerald-800">
          <span aria-hidden="true">✓</span> Profile data retrieved
          {access.profileCompleteness === 'partial' && ' (partial)'}
        </p>
        <p className="text-xs text-emerald-700">
          Source: {PROVIDER_LABEL[access.primarySource] ?? access.primarySource}
        </p>

        {profile && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-emerald-800/80">
            {profile.headline && <span className="truncate">{profile.headline}</span>}
            {profile.experience.length > 0 && <span>{profile.experience.length} roles</span>}
            {profile.education.length > 0 && <span>{profile.education.length} education</span>}
            {profile.skills.length > 0 && <span>{profile.skills.length} skills</span>}
            {profile.followers !== null && (
              <span>{profile.followers.toLocaleString()} followers</span>
            )}
          </div>
        )}
        {access.reason && <p className="mt-1 text-[11px] text-emerald-700">{access.reason}</p>}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-amber-600/20 bg-amber-600/5 px-3 py-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
        LinkedIn profile
      </p>
      <p className="mt-0.5 text-sm text-amber-800">
        <span aria-hidden="true">⚠</span> Direct profile retrieval unavailable
      </p>
      <p className="text-xs text-amber-700">Using public web research instead</p>
      {access.reason && <p className="mt-1 text-[11px] text-amber-700">{access.reason}</p>}
    </div>
  );
}

const FIT_TONE: Record<string, string> = {
  HIGH: 'bg-emerald-600/10 text-emerald-800',
  MEDIUM: 'bg-accent/10 text-accent',
  LOW: 'bg-amber-600/10 text-amber-800',
  UNKNOWN: 'bg-ink/6 text-muted',
};

const BASIS_TONE: Record<string, string> = {
  OBSERVED: 'bg-emerald-600/10 text-emerald-800',
  INFERRED: 'bg-amber-600/10 text-amber-800',
  UNKNOWN: 'bg-ink/6 text-faint',
};

const QUAL_TONE: Record<string, StatusTone> = {
  QUALIFIED: 'emerald',
  BORDERLINE: 'amber',
  NOT_QUALIFIED: 'neutral',
};

/** Full-block treatment for the headline decision callout — same tones, heavier context. */
const QUAL_BLOCK_TONE: Record<string, string> = {
  QUALIFIED: 'border-emerald-600/25 bg-emerald-600/6 text-emerald-900',
  BORDERLINE: 'border-amber-600/25 bg-amber-600/6 text-amber-900',
  NOT_QUALIFIED: 'border-hairline bg-app text-ink',
};

/**
 * One line per matrix cell, shown as the qualification decision. Two of
 * these (the EXPLORATORY_* actions) still `proceed`, but never say "target
 * directly" — a BORDERLINE company earns cautious, discovery-oriented
 * outreach at most, never a confident pitch.
 */
const ACTION_LABEL: Record<QualificationAction, string> = {
  TARGET_DIRECTLY: 'Proceed — target directly.',
  VERIFY_BETTER_CONTACT: 'Do not pitch yet — verify this contact’s connection to the workflow, or find a better one.',
  FIND_BETTER_CONTACT: 'Do not pitch this contact — find a better contact at this company.',
  EXPLORATORY_OUTREACH:
    'Proceed cautiously — exploratory outreach only, asking rather than assuming the workflow exists.',
  EXPLORATORY_OUTREACH_IF_SIGNAL:
    'Proceed only if a genuinely verified signal is found — cautious, exploratory outreach, not a confident pitch.',
  FIND_BETTER_CONTACT_OR_HOLD:
    'Hold — company fit is unconfirmed. A human may look for a better contact or wait for stronger signal.',
  DO_NOT_CONTACT: 'Do not contact — the available evidence does not establish sufficient fit.',
};

/** True for the two matrix cells where a BORDERLINE company still proceeds. */
function isExploratory(action: QualificationAction): boolean {
  return action === 'EXPLORATORY_OUTREACH' || action === 'EXPLORATORY_OUTREACH_IF_SIGNAL';
}

/**
 * Whether this person at this company is worth contacting at all — shown before
 * any signal or hook, because it is the first question the product asks.
 */
function QualificationCard({ snapshot }: { snapshot: RunSnapshot }) {
  const q = snapshot.run.qualification;
  if (!q) return null;

  const { prospect_fit: p, company_fit: c } = q;
  // Only observed, evidenced capabilities qualify a company; the rest are shown
  // separately so inference is never mistaken for an established need.
  const observedCaps = c.capability_matches.filter(
    (m) => m.basis === 'OBSERVED' && m.evidence.length > 0,
  );
  const otherCaps = c.capability_matches.filter(
    (m) => !(m.basis === 'OBSERVED' && m.evidence.length > 0),
  );

  return (
    <div className="rounded-xl border border-hairline bg-surface p-5">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-faint">
        Target qualification
      </h3>

      <div className={`rounded-lg border p-3 ${QUAL_BLOCK_TONE[q.classification] ?? QUAL_BLOCK_TONE.BORDERLINE}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider">
            {q.classification.replace(/_/g, ' ')}
            {isExploratory(q.action) ? (
              <span className="rounded-full bg-surface/70 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-amber-900">
                exploratory outreach
              </span>
            ) : null}
          </span>
          <span className="text-xs tabular-nums opacity-80">overall fit {q.overall_fit}/100</span>
        </div>
        <p className="mt-1 text-sm">{q.reason}</p>
        {q.suggestion ? <p className="mt-1.5 text-xs opacity-90">{q.suggestion}</p> : null}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-hairline p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-faint">
              Prospect fit
            </span>
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${FIT_TONE[p.classification]}`}>
              {p.classification} {p.score}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-ink/85">{p.relevance_reason}</p>
          <dl className="mt-1.5 space-y-0.5 text-[11px] text-faint">
            {p.role ? <div>Role: {p.role}</div> : null}
            {p.seniority ? <div>Seniority: {p.seniority}</div> : null}
            <div>Decision authority: {p.decision_authority}</div>
          </dl>
        </div>

        <div className="rounded-lg border border-hairline p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-faint">
              Company fit
            </span>
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${FIT_TONE[c.classification]}`}>
              {c.classification} {c.score}
            </span>
          </div>
          {c.fit_reasons[0] ? (
            <p className="mt-1.5 text-xs text-ink/85">
              {c.fit_reasons[0].reason}
              <span className="ml-1 text-[10px] uppercase tracking-wide text-faint">
                {c.fit_reasons[0].basis}
              </span>
            </p>
          ) : null}
          <dl className="mt-1.5 space-y-0.5 text-[11px] text-faint">
            {c.industry ? <div>Industry: {c.industry}</div> : null}
            {c.relevant_workflows.length > 0 ? (
              <div>Workflows: {c.relevant_workflows.slice(0, 3).join(', ')}</div>
            ) : null}
          </dl>

          {observedCaps.length > 0 ? (
            <div className="mt-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                Primary qualification evidence
              </p>
              <ul className="mt-1 space-y-1">
                {observedCaps.map((m, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px]">
                    <span
                      className={`mt-px shrink-0 rounded px-1 py-px font-medium ${BASIS_TONE.OBSERVED}`}
                      title="A retrieved source describes this workflow at this company."
                    >
                      OBSERVED
                    </span>
                    <span className="min-w-0 flex-1 text-ink/85">
                      {m.capability_name}
                      <span className="text-faint"> · {m.fit_strength}/100</span>
                      {m.evidence.length > 0 ? (
                        <a
                          href={m.evidence[0].url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-1 text-accent hover:underline"
                        >
                          ↗
                        </a>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[10px] text-faint">
                Qualification basis: {observedCaps.length} observed use case
                {observedCaps.length === 1 ? '' : 's'}.
              </p>
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-faint">
              No observed use case — nothing evidenced qualified this company.
            </p>
          )}

          {otherCaps.length > 0 ? (
            <div className="mt-2 border-t border-hairline pt-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-faint">
                Additional inferred / unknown capabilities
              </p>
              <ul className="mt-1 space-y-1">
                {otherCaps.map((m, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px]">
                    <span
                      className={`mt-px shrink-0 rounded px-1 py-px font-medium ${BASIS_TONE[m.basis]}`}
                      title="Plausible from available context, but no source confirms it for this company."
                    >
                      {m.basis}
                    </span>
                    <span className="min-w-0 flex-1 text-muted">
                      {m.capability_name}
                      <span className="text-faint"> · {m.fit_strength}/100</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[10px] italic text-faint">
                Potential fit — inferred from available context. These did not contribute to
                qualification and are not used as outreach angles.
              </p>
            </div>
          ) : null}

          {c.evidence_adjustment ? (
            <p className="mt-1.5 rounded bg-amber-600/8 px-1.5 py-1 text-[10px] leading-relaxed text-amber-800">
              {c.evidence_adjustment}
            </p>
          ) : null}
        </div>
      </div>

      <p className="mt-3 border-t border-hairline pt-2 text-xs text-muted">
        <span className="font-medium text-ink">Decision: </span>
        {ACTION_LABEL[q.action]}
      </p>
    </div>
  );
}

export function ResultPanel({
  snapshot,
  onChange,
}: {
  snapshot: RunSnapshot;
  onChange: () => void;
}) {
  const { run, signals, sources, draft, stages } = snapshot;

  const hookStage = stages.find((s) => s.stage_name === 'select_hook');
  const hookOut = (hookStage?.output ?? null) as HookStageOutput | null;
  const hookSignal = signals.find((s) => s.selected_as_hook) ?? null;

  const identityStage = stages.find((s) => s.stage_name === 'identify_prospect');
  const identityOut = identityStage?.output as
    | { identity?: { reasoning?: string; employer_change_note?: string | null; alternates?: { name: string | null; company: string | null; why: string }[] } }
    | null;

  const inProgress = run.status === 'queued' || run.status === 'running';

  return (
    <section className="space-y-4">
      {/* Decision summary — the TL;DR, before anything else on the page */}
      <DecisionSummary run={run} />

      {/* A borderline account waiting on a person sits directly under the
          summary that explains why — renders nothing on any other run. */}
      <AccountDecision run={run} onDecided={onChange} />

      {/* Prospect summary */}
      <div className="rounded-xl border border-hairline bg-surface p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight text-ink">
              {run.prospect_name ?? run.input_name ?? 'Identifying…'}
            </h2>
            <p className="text-sm text-muted">
              {[run.prospect_title ?? run.input_title, run.company_name ?? run.input_company]
                .filter(Boolean)
                .join(' · ') || 'Company not yet resolved'}
            </p>
            <a
              href={run.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block max-w-full break-all text-xs text-accent hover:underline"
            >
              {run.linkedin_url} ↗
            </a>
          </div>
          <div className="flex flex-col items-end gap-1 text-right">
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {run.qualification_status ? (
                <span title="Target qualification — should we contact this person about this product?">
                  <StatusBadge tone={QUAL_TONE[run.qualification_status] ?? 'neutral'}>
                    {run.qualification_status.replace(/_/g, ' ')}
                  </StatusBadge>
                </span>
              ) : null}
              <span title="Outreach status — what has happened to the message itself.">
                <StatusBadge tone={RUN_STATUS_TONE[run.status] ?? 'neutral'}>
                  {OUTREACH_LABEL[deriveOutreachStatus(run, stages, draft)]}
                </StatusBadge>
              </span>
            </div>
            {run.overall_confidence !== null && (
              <p className="text-xs text-faint">
                confidence {run.overall_confidence}/100
              </p>
            )}
            {run.identity_confidence !== null && (
              <p
                className={`text-xs ${run.identity_confidence < 50 ? 'text-amber-700' : 'text-faint'}`}
                title="How confident we are that this is the right person, based on the evidence retrieved."
              >
                identity {run.identity_confidence}/100
                {run.identity_confidence < 50 ? ' — verify before use' : ''}
              </p>
            )}
          </div>
        </div>

        <ProfileSourceCard run={run} />
        <PipelineStatusLines snapshot={snapshot} />

        {identityOut?.identity?.employer_change_note && (
          <p className="mt-2 rounded-lg border border-amber-600/20 bg-amber-600/6 px-3 py-2 text-xs text-amber-800">
            <span className="font-medium">Employer change:</span>{' '}
            {identityOut.identity.employer_change_note}
          </p>
        )}

        {(identityOut?.identity?.alternates?.length ?? 0) > 0 && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted">
              Other people who could match this profile ({identityOut!.identity!.alternates!.length})
            </summary>
            <ul className="mt-1 list-inside list-disc text-muted">
              {identityOut!.identity!.alternates!.map((a, i) => (
                <li key={i}>
                  {[a.name, a.company].filter(Boolean).join(' — ')}: {a.why}
                </li>
              ))}
            </ul>
          </details>
        )}

        {identityOut?.identity?.reasoning && (
          <details className="mt-1.5 text-xs">
            <summary className="cursor-pointer text-muted">How this identity was determined</summary>
            <p className="mt-1 text-muted">{identityOut.identity.reasoning}</p>
          </details>
        )}
      </div>

      {/* Identity comes first: everything below assumes we know who this is. */}
      {run.identity_verification ? (
        <IdentityCard
          runId={run.id}
          verification={run.identity_verification}
          onResolved={onChange}
        />
      ) : null}

      {/* Target qualification — shown before signals and hook */}
      <QualificationCard snapshot={snapshot} />

      {/* Alternative contacts — only when the company qualified but this person
          did not. Absent from every other run, including a fully unqualified one. */}
      {run.qualification?.suggestion ? (
        <ContactCandidates runId={run.id} candidates={snapshot.contactCandidates} />
      ) : null}

      {/* Selected hook */}
      {hookOut && (
        <div className="rounded-xl border border-hairline bg-surface p-5">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-faint">
            Selected hook
          </h3>

          {hookOut.selected ? (
            <>
              <p className="text-sm font-medium text-ink">{hookOut.selected.signal}</p>
              <p className="mt-1 text-xs text-muted">{hookOut.selected.why_it_matters}</p>
              {hookOut.selected.role_relevance ? (
                <p className="mt-1 text-xs text-muted">
                  <span className="font-medium text-faint">Why this prospect: </span>
                  {hookOut.selected.role_relevance}
                </p>
              ) : null}
              {hookOut.selected.outreach_rationale ? (
                <p className="mt-1 text-xs text-muted">
                  <span className="font-medium text-faint">Why now: </span>
                  {hookOut.selected.outreach_rationale}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 text-[11px] text-faint">
                <span>{hookOut.selected.published_date ?? 'undated'}</span>
                <a
                  href={hookOut.selected.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  evidence ↗
                </a>
                {hookOut.confidence !== undefined && <span>selection confidence {hookOut.confidence}/100</span>}
              </div>
              {hookSignal?.supporting_quote && (
                <blockquote className="mt-2 border-l-2 border-accent/25 pl-2 text-xs italic text-muted">
                  “{hookSignal.supporting_quote}”
                </blockquote>
              )}
            </>
          ) : (
            <div className="rounded-lg border border-amber-600/25 bg-amber-600/6 p-3">
              <p className="text-sm font-semibold uppercase tracking-wide text-amber-900">
                No verified outreach hook found
              </p>
              <p className="mt-1 text-sm text-amber-800">
                {hookOut.insufficient_reason ?? hookOut.selection_reason}
              </p>
              <p className="mt-2 text-xs text-amber-700">
                ProspectIQ does not invent personalization when the available evidence is
                insufficient, so no message was drafted.
              </p>
              {hookOut.research_coverage ? (
                <p className="mt-2 text-xs text-amber-800">
                  Reviewed {hookOut.research_coverage.sources ?? 0} sources ·{' '}
                  {hookOut.research_coverage.signals_verified ?? 0} signals verified ·{' '}
                  {hookOut.research_coverage.signals_rejected ?? 0} rejected
                </p>
              ) : null}
              {(hookOut.rejected_candidates?.length ?? 0) > 0 ? (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-amber-800">
                    Candidate signals and why each was rejected
                  </summary>
                  <ul className="mt-1 space-y-1">
                    {hookOut.rejected_candidates!.map((r, i) => (
                      <li key={i} className="text-amber-900">
                        {r.signal}
                        <span className="block text-amber-700">{r.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <Link
                href={`/runs/${run.id}/stages/select_hook`}
                className="mt-2 inline-block text-xs font-medium text-amber-900 underline"
              >
                See the full research coverage →
              </Link>
            </div>
          )}

          {hookOut.selection_reason && hookOut.selected && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-muted">Why this hook was chosen</summary>
              <p className="mt-1 text-muted">{hookOut.selection_reason}</p>
            </details>
          )}

          {(hookOut.alternatives_considered?.length ?? 0) > 0 && (
            <details className="mt-1.5 text-xs">
              <summary className="cursor-pointer text-muted">
                Alternatives considered ({hookOut.alternatives_considered!.length})
              </summary>
              <ul className="mt-1 space-y-1 text-muted">
                {hookOut.alternatives_considered!.map((a, i) => (
                  <li key={i}>
                    <span className="text-ink/85">{a.signal}</span> — {a.why_not}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Draft + human review */}
      {draft ? (
        <>
          {/* Outreach rationale — why this account, this contact, this signal,
              this solution — shown directly above the message it explains. */}
          <OutreachRationale snapshot={snapshot} />
          {/* Keyed on the draft's own id: a regenerated draft is a delete+insert
              (the same pattern generate_message always used), so a genuinely new
              draft arrives with a new id — remounting on that id is what makes a
              freshly regenerated message replace stale local component state
              (the in-progress edit text, the approve/reject outcome) instead of
              leaving the old draft's state visible under the new draft's data. */}
          <DraftReviewCard key={draft.id} runId={run.id} run={run} draft={draft} onReviewed={onChange} />
        </>
      ) : inProgress ? (
        <p className="rounded-xl border border-dashed border-hairline p-4 text-sm text-muted">
          No draft yet — the pipeline is still running.
        </p>
      ) : null}

      {/* Evidence */}
      {signals.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-faint">
            Evidence ({signals.length} signals)
          </h3>
          <SignalList signals={signals} />
        </div>
      )}

      {sources.length > 0 && (
        <details className="rounded-xl border border-hairline bg-surface p-4">
          <summary className="cursor-pointer text-sm font-semibold text-ink">
            Sources ({sources.length})
          </summary>
          <div className="mt-3">
            <SourceList sources={sources} />
          </div>
        </details>
      )}
    </section>
  );
}
