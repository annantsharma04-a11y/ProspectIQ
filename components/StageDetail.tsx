'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  STAGE_LABELS,
  type DraftRow,
  type RunRow,
  type RunStageRow,
  type SignalRow,
  type SourceRow,
  type StageName,
} from '@/lib/types';
import { TopSources } from './TopSources';
import { ContactCandidates } from './ContactCandidates';
import { StatusBadge, type StatusTone } from './StatusBadge';
import type { ContactCandidateRow } from '@/lib/contacts/types';
import type { EvidenceItem } from '@/lib/qualification/types';
import { buildQualificationPanels } from '@/lib/ui/qualification-panels';
import { findSourceByUrl, displayDate } from '@/lib/research/top-sources';
import { hostOf } from '@/lib/url-identity';
import { currentDraftText } from '@/lib/drafts/current-text';

// Human-readable stage explanations.
//
// Everything shown here is derived from the stage's recorded output — nothing
// about the execution is invented. Where a value is absent from the backend
// record, the row is simply not rendered. Raw JSON stays available under
// Technical details.

const PURPOSE: Record<StageName, string> = {
  validate_input:
    'Checks that the submitted link is a real public LinkedIn profile URL and reduces it to one canonical identity before any paid API call is made.',
  identify_prospect:
    'Retrieves the LinkedIn profile and discovers every person this input could plausibly represent. It does not prove identity — that is the verification stage.',
  research_prospect:
    'Searches public sources for what this specific person has said or done recently, and fetches the most promising pages.',
  research_company:
    'Searches public sources for company-level developments — funding, launches, hiring, partnerships and strategy.',
  resolve_candidate:
    'Decides which discovered person the run should analyse. One plausible candidate is selected automatically; several means a human chooses, because guessing which person was meant is how the wrong human gets analysed.',
  verify_identity:
    'Tests the selected candidate against independent public sources. A human picking a candidate is a preference, not proof, so this runs the same either way.',
  qualify_prospect:
    'Judges whether this person is a meaningful target — their function, seniority and likely influence over the workflows the product addresses. This is a targeting decision about the role, not a comment on the person.',
  qualify_company:
    'Judges whether this company plausibly needs what you sell, matching observable characteristics against your configured capabilities, then makes the go/no-go call.',
  find_contact_candidates:
    'Runs only when the company qualified but this person did not: proposes other people at the company who plausibly own the workflow that qualified it. Nothing here is auto-selected — a human chooses.',
  collect_signals:
    'Consolidates everything found into one deduplicated evidence set and grades how strong each source is.',
  evaluate_signals:
    'The single AI analysis pass. Reads the profile and evidence, proposes candidate signals with citations, and drafts the outreach. Every citation is then verified mechanically.',
  select_hook:
    'Decides whether the proposed opening angle is good enough to use, applying quality and safety rules in code rather than trusting the model.',
  generate_message:
    'Records the outreach draft, but only when a hook survived verification. With no verified hook, no message is written at all.',
  validate_claims:
    'Checks every factual statement in the draft against the collected evidence, distinguishing claims about the prospect from claims about your own product.',
  ready_for_review:
    'Finalises the run and hands it to a human. Outreach is always sent manually.',
};

const STATUS_TONE: Record<string, StatusTone> = {
  complete: 'emerald',
  degraded: 'amber',
  failed: 'red',
  skipped: 'neutral',
  running: 'accent',
  pending: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  complete: 'Completed',
  degraded: 'Completed with warnings',
  failed: 'Failed',
  skipped: 'Skipped',
  running: 'Running',
  pending: 'Queued',
};

type Output = Record<string, unknown>;

const FIT_TONE: Record<string, string> = {
  HIGH: 'border-emerald-600/20 bg-emerald-600/6 text-emerald-900',
  MEDIUM: 'border-accent/20 bg-accent/6 text-accent',
  LOW: 'border-amber-600/20 bg-amber-600/6 text-amber-900',
  UNKNOWN: 'border-hairline bg-app text-muted',
};

const BASIS_TONE: Record<string, string> = {
  OBSERVED: 'bg-emerald-600/10 text-emerald-800',
  INFERRED: 'bg-amber-600/10 text-amber-800',
  UNKNOWN: 'bg-ink/6 text-faint',
};

const QUAL_TONE: Record<string, string> = {
  QUALIFIED: 'border-emerald-600/20 bg-emerald-600/6 text-emerald-900',
  BORDERLINE: 'border-amber-600/20 bg-amber-600/6 text-amber-900',
  NOT_QUALIFIED: 'border-hairline bg-app text-ink',
};

/** One line per qualification decision-matrix cell — see lib/qualification/types.ts's QualificationAction. */
const ACTION_LABEL: Record<string, string> = {
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

function get<T>(o: Output | null, path: string): T | undefined {
  if (!o) return undefined;
  return path.split('.').reduce<unknown>((acc, k) => (acc as Output)?.[k], o) as T | undefined;
}

/**
 * Validator notes are tagged "[automatic]" so the raw record shows which checks
 * were machine-applied. That marker is internal bookkeeping, not something to
 * show a reader — it stays in the raw JSON under Technical details.
 */
function humanize(text: string): string {
  return text.replace(/\[automatic\]\s*/g, '').replace(/\s+/g, ' ').trim();
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** A labelled key/value row. Renders nothing when the value is absent. */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <dt className="w-44 shrink-0 text-faint">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-ink/90">{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-hairline py-4 first:border-t-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">{title}</h3>
      {children}
    </section>
  );
}

/**
 * One self-contained box for one axis of qualification — company fit,
 * contact fit, or the overall decision. Each box carries its own explicit
 * label and text, so a reader never has to infer which score belongs to
 * which question by position alone (the confusion this fixes: company fit
 * and overall fit rendered as adjacent, unlabeled numbers read as one
 * contradictory statement about the same thing). Color (via `tone`) is a
 * secondary cue only — the label and text carry the meaning on their own.
 */
function FitPanel({
  label,
  tone,
  headline,
  score,
  detail,
  note,
}: {
  /** "Company fit" / "Contact fit" / "Overall decision" — never omitted. */
  label: string;
  tone: string;
  /** e.g. "QUALIFIED", "BORDERLINE — VERIFY BETTER CONTACT" */
  headline: string;
  score: number;
  /** e.g. "Evidence: OBSERVED" or "Recommended action: …" */
  detail: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border p-4 ${tone}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-faint">{label}</p>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold uppercase tracking-wider">{headline}</span>
        <span className="text-sm tabular-nums opacity-80">{score}/100</span>
      </div>
      <p className="mt-1.5 text-sm opacity-90">{detail}</p>
      {note ? <p className="mt-2 text-xs opacity-80">{note}</p> : null}
    </div>
  );
}

/**
 * A compact "which source backs this" line for an individual signal — title,
 * domain, date, and a clickable link, exactly the fields TopSources shows,
 * just for one item rather than a ranked list. Only ever called with a
 * `SourceRow` already resolved from this run's persisted sources — never
 * with a bare, unverified URL string.
 */
function SourceLine({ source }: { source: SourceRow }) {
  const date = displayDate(source.published_date);
  const domain = hostOf(source.canonical_url || source.url);
  const title = source.title?.trim();
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-hairline pt-2 text-xs">
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="min-w-0 truncate font-medium text-accent hover:underline"
      >
        {title || 'Open source'}
      </a>
      {domain && <span className="text-faint">· {domain}</span>}
      {date && <span className="text-faint">· {date}</span>}
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="ml-auto shrink-0 font-medium text-muted hover:text-accent hover:underline"
      >
        Open ↗
      </a>
    </div>
  );
}

/**
 * The same "Regenerate message" action the main run page offers on the draft
 * card, reused here (same POST route, same `regenerateMessageOnly()` backend
 * — nothing about the generation is duplicated) so it is also available from
 * the stage detail page itself.
 *
 * This page has no live subscription of its own (unlike the main run page's
 * LiveRunView, which watches the run over Supabase Realtime), so "show the
 * new draft immediately" is done by polling the run's own status after the
 * fire-and-forget POST, then asking the server component that owns this page
 * to re-fetch via `router.refresh()` — which pulls in the regenerated
 * draft's freshly persisted text.
 *
 * The polling loop must not conclude "settled" from the first read that
 * simply isn't `running` — `regenerateMessageOnly()` does real work
 * (rehydrating the run, then writing `status: 'running'`) BEFORE that status
 * change actually lands in Postgres, so an early poll can read the run's
 * PREVIOUS terminal status and mistake "hasn't started yet" for "already
 * finished". That false read is what made the button flip back to "Regenerate
 * message" almost immediately while the real regeneration was still running
 * in the background — the first click looked like a no-op, and a second
 * click was needed to actually see anything change. The fix: only trust a
 * non-running read once we have genuinely observed `running` at least once
 * (or a short grace period has passed, in case the whole job — rehydrate,
 * model call, validate — finishes inside a single poll interval).
 */

/** Generous margin over the rehydrate-then-write-'running' latency before the job has had any real chance to start. */
export const REGENERATION_SETTLE_GRACE_MS = 3000;

/**
 * Pure decision at the heart of the fix above — exported so it is directly
 * testable without a browser: given the latest polled status, whether we've
 * ever observed `running` in this polling session, and how long it has been
 * since the click, should THIS poll be treated as "the job has settled"?
 *
 * A `false` result means "keep polling" — either the job is genuinely still
 * running, or it hasn't had a fair chance to start yet and this status read
 * cannot be trusted as final.
 */
export function shouldTreatAsSettled(
  status: string | undefined,
  sawRunning: boolean,
  elapsedMs: number,
  graceMs: number = REGENERATION_SETTLE_GRACE_MS,
): boolean {
  if (status === 'running') return false;
  return sawRunning || elapsedMs >= graceMs;
}

function RegenerateMessageButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function regenerate() {
    if (state === 'working') return; // belt-and-braces against a double click racing the disabled state
    setState('working');
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/regenerate-message`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not start regeneration.');

      const startedAt = Date.now();
      let sawRunning = false;

      // Poll for the background job to settle — up to a minute — then refresh.
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const check = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
        if (!check.ok) continue;
        const snapshot = await check.json();
        const status = snapshot.run?.status as string | undefined;

        if (!shouldTreatAsSettled(status, sawRunning, Date.now() - startedAt)) {
          if (status === 'running') sawRunning = true;
          continue;
        }

        // error is explicitly cleared on success and explicitly set on
        // failure by regenerateMessageOnly() — never stale from before this
        // attempt, since it is also explicitly cleared the moment it starts.
        if (snapshot.run?.error) {
          setError(snapshot.run.error as string);
          setState('error');
        } else {
          setState('idle');
        }
        router.refresh();
        return;
      }
      setError('Regeneration is taking longer than expected — refresh the page to check.');
      setState('error');
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={regenerate}
        disabled={state === 'working'}
        aria-busy={state === 'working'}
        className="inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-muted hover:bg-app disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state === 'working' && (
          <span
            aria-hidden
            className="h-3 w-3 animate-spin rounded-full border-2 border-muted/40 border-t-muted"
          />
        )}
        {state === 'working' ? 'Regenerating…' : 'Regenerate message'}
      </button>
      {state === 'working' && (
        <p className="mt-1.5 rounded-lg bg-accent/8 px-2.5 py-1.5 text-xs text-accent">
          Writing a new version of this message — same selected hook and evidence, new wording. This
          keeps the current draft until the new one is validated.
        </p>
      )}
      {error && (
        <p className="mt-1.5 rounded-lg bg-red-600/8 px-2.5 py-1.5 text-xs text-red-700">{error}</p>
      )}
    </div>
  );
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: React.ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const tones = {
    neutral: 'bg-app text-ink',
    good: 'bg-emerald-600/8 text-emerald-800',
    warn: 'bg-amber-600/8 text-amber-800',
    bad: 'bg-red-600/8 text-red-800',
  };
  return (
    <div className={`rounded-lg px-3 py-2 ${tones[tone]}`}>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs opacity-70">{label}</div>
    </div>
  );
}

export function StageDetail({
  run,
  stage,
  draft = null,
  sources = [],
  signals = [],
  contactCandidates = [],
}: {
  run: RunRow;
  stage: RunStageRow;
  /**
   * The run's current draft row — the same one the main run page's
   * Personalized draft card reads. Passed through so the generate_message
   * stage shows this text, not its own stage-output snapshot, which is why
   * this and the main page could previously disagree (see StageBody below).
   */
  draft?: DraftRow | null;
  /** Persisted sources for this run. Already loaded; nothing is re-fetched. */
  sources?: SourceRow[];
  /** Verified signals, used only to mark which sources became evidence. */
  signals?: SignalRow[];
  /** Discovered alternative contacts, when this is the find_contact_candidates stage. */
  contactCandidates?: ContactCandidateRow[];
}) {
  const [showJson, setShowJson] = useState(false);
  const [copied, setCopied] = useState(false);
  const output = (stage.output ?? null) as Output | null;
  const name = stage.stage_name;

  async function copyJson() {
    await navigator.clipboard.writeText(JSON.stringify(stage.output ?? {}, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <article className="rounded-xl border border-hairline bg-surface">
      <header className="border-b border-hairline px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-faint">
              Stage {stage.stage_order + 1} of {14}
            </p>
            <h1 className="font-display mt-0.5 text-xl font-semibold tracking-tight text-ink">
              {STAGE_LABELS[name]}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm tabular-nums text-faint">{formatDuration(stage.duration_ms)}</span>
            <StatusBadge tone={STATUS_TONE[stage.status] ?? STATUS_TONE.pending}>
              {STATUS_LABEL[stage.status] ?? stage.status}
            </StatusBadge>
          </div>
        </div>
      </header>

      <div className="px-5">
        <Section title="What this stage does">
          <p className="text-sm leading-relaxed text-muted">{PURPOSE[name]}</p>
        </Section>

        {stage.summary && (
          <Section title="Result">
            <p className="text-sm leading-relaxed text-ink/90">{stage.summary}</p>
          </Section>
        )}

        {stage.error && (
          <Section title="What went wrong">
            <p className="rounded-lg bg-red-600/8 px-3 py-2 text-sm leading-relaxed text-red-800">
              {stage.error}
            </p>
          </Section>
        )}

        <StageBody name={name} output={output} run={run} draft={draft} sources={sources} signals={signals} contactCandidates={contactCandidates} />

        <Section title="Technical details">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowJson((v) => !v)}
              className="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-muted hover:bg-app"
            >
              {showJson ? 'Hide raw JSON' : 'Show raw JSON'}
            </button>
            {showJson && (
              <button
                onClick={copyJson}
                className="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-muted hover:bg-app"
              >
                {copied ? 'Copied' : 'Copy JSON'}
              </button>
            )}
          </div>
          {showJson && (
            <pre className="mt-3 max-h-[28rem] overflow-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">
              {JSON.stringify(stage.output ?? { output: null }, null, 2)}
            </pre>
          )}
        </Section>
      </div>
    </article>
  );
}

/** Stage-specific presentation, driven entirely by recorded output. */
function StageBody({
  name,
  output,
  run,
  draft,
  sources,
  signals,
  contactCandidates,
}: {
  name: StageName;
  output: Output | null;
  run: RunRow;
  draft: DraftRow | null;
  sources: SourceRow[];
  signals: SignalRow[];
  contactCandidates: ContactCandidateRow[];
}) {
  if (!output) return null;

  switch (name) {
    case 'validate_input': {
      const user = get<Output>(output, 'user_supplied');
      return (
        <>
          <Section title="Input">
            <dl>
              <Row label="Submitted URL" value={<code className="text-xs">{run.linkedin_url}</code>} />
              <Row label="Name supplied" value={user?.name as string} />
              <Row label="Company supplied" value={user?.company as string} />
              <Row label="Role supplied" value={user?.title as string} />
            </dl>
          </Section>
          <Section title="Checks performed">
            <dl>
              <Row label="Canonical URL" value={<code className="text-xs">{get<string>(output, 'normalized_url')}</code>} />
              <Row label="Profile key" value={<code className="text-xs">in/{get<string>(output, 'slug')}</code>} />
              <Row label="Name inferred from URL" value={get<string>(output, 'name_hint') ?? '—'} />
              <Row label="Search providers ready" value={(get<string[]>(output, 'search_providers') ?? []).join(', ')} />
            </dl>
          </Section>
          <Section title="Why it matters">
            <p className="text-sm text-ink/85">
              Every locale of a LinkedIn URL collapses to one profile key, so a citation from any
              country subdomain is recognised later as the same source.
            </p>
          </Section>
        </>
      );
    }

    case 'identify_prospect': {
      const access = get<Output>(output, 'profile_access');
      const profile = get<Output>(output, 'profile');
      const identity = get<Output>(output, 'identity');
      const direct = Boolean(access?.directLinkedIn);
      const found: string[] = [];
      const missing: string[] = [];
      if (profile) {
        for (const [label, key] of [
          ['Name', 'name'], ['Headline', 'headline'], ['About', 'about'],
          ['Location', 'location'], ['Current company', 'currentCompany'],
        ] as const) {
          (profile[key] ? found : missing).push(label);
        }
        (Array.isArray(profile.experience) && profile.experience.length ? found : missing).push('Experience');
        (Array.isArray(profile.education) && profile.education.length ? found : missing).push('Education');
        (Array.isArray(profile.skills) && profile.skills.length ? found : missing).push('Skills');
      }

      return (
        <>
          <Section title="Profile retrieval">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Direct profile" value={direct ? 'Yes' : 'No'} tone={direct ? 'good' : 'warn'} />
              <Stat label="Completeness" value={String(access?.profileCompleteness ?? '—')} tone={access?.profileCompleteness === 'full' ? 'good' : 'warn'} />
              <Stat label="Identity confidence" value={`${identity?.confidence ?? '—'}`} />
              <Stat label="Retrieval time" value={formatDuration(get<number>(output, 'profile_fetch_ms') ?? null)} />
            </div>
            {access?.reason ? (
              <p className="mt-3 rounded-lg bg-app px-3 py-2 text-sm text-ink/85">{String(access.reason)}</p>
            ) : null}
          </Section>

          {profile && (
            <Section title="What the profile contained">
              <dl>
                <Row label="Name" value={profile.name as string} />
                <Row label="Headline" value={profile.headline as string} />
                <Row label="Location" value={profile.location as string} />
                <Row label="Current company" value={(profile.currentCompany as Output)?.name as string} />
                <Row label="Followers" value={profile.followers ? Number(profile.followers).toLocaleString() : null} />
                <Row label="Connections" value={profile.connections ? Number(profile.connections).toLocaleString() : null} />
              </dl>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {found.map((f) => (
                  <span key={f} className="rounded bg-emerald-600/8 px-2 py-0.5 text-xs text-emerald-700">{f}</span>
                ))}
                {missing.map((f) => (
                  <span key={f} className="rounded bg-ink/6 px-2 py-0.5 text-xs text-faint line-through">{f}</span>
                ))}
              </div>
            </Section>
          )}

          <Section title="Why it matters">
            <p className="text-sm text-ink/85">
              {identity?.company
                ? `Because the employer resolved to "${identity.company}", the next stage can research the company as well as the person.`
                : 'Without a resolved employer, company-level research cannot be built and the run relies on person-level sources only.'}
            </p>
          </Section>
        </>
      );
    }

    case 'research_prospect':
    case 'research_company': {
      const evidence = get<Record<string, number>>(output, 'evidence');
      const round = get<Output>(output, 'round');
      const queries = get<string[]>(output, 'queries') ?? [];
      const note = get<string>(output, 'extraction_note');
      return (
        <>
          <Section title="Searches performed">
            <ul className="space-y-1">
              {queries.map((q, i) => (
                <li key={i} className="rounded bg-app px-2.5 py-1.5 text-xs text-ink/85">{q}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-faint">
              {String(round?.queries_ok ?? 0)} of {String(round?.queries_run ?? 0)} search calls succeeded.
            </p>
          </Section>
          <Section title="Evidence collected">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Sources found" value={String(round?.sources_after_dedupe ?? 0)} />
              <Stat label="Full evidence" value={String(evidence?.FULL ?? 0)} tone="good" />
              <Stat label="Snippet only" value={String(evidence?.SNIPPET ?? 0)} tone="warn" />
              <Stat label="Unavailable" value={String(evidence?.UNAVAILABLE ?? 0)} tone={evidence?.UNAVAILABLE ? 'bad' : 'neutral'} />
            </div>
            {note && (
              <p className="mt-3 rounded-lg bg-amber-600/6 px-3 py-2 text-sm text-amber-800">{note}</p>
            )}
          </Section>
          <Section title="Top sources">
            <TopSources
              sources={sources}
              signals={signals}
              stage={name}
              prospect={
                name === 'research_prospect'
                  ? { name: run.prospect_name ?? run.input_name, slug: run.linkedin_slug }
                  : undefined
              }
            />
          </Section>
          <Section title="Why it matters">
            <p className="text-sm text-ink/85">
              Full evidence means a page was retrieved and read. Snippet evidence still counts, but
              carries lower confidence and needs corroboration before it can support a claim.
              Retrieving a source is not the same as using it: only sources marked{' '}
              <span className="font-medium">Used as evidence</span> survived verification and
              support a signal.
            </p>
          </Section>
        </>
      );
    }

    case 'verify_identity': {
      const fe = get<Output>(output, 'field_evidence');
      const recovery = get<Output[]>(output, 'field_recovery');
      const identity = get<Output>(output, 'identity');
      if (!identity) return null;
      return (
        <>
          <Section title="Evidence checked">
            {fe ? (
              <>
                <p className="text-sm text-ink/90">{String(fe.summary)}</p>
                <ul className="mt-2 space-y-1 text-sm">
                  {((fe.corroborated as string[]) ?? []).map((f) => (
                    <li key={f} className="text-emerald-700">✓ {f} — corroborated</li>
                  ))}
                  {((fe.conflicting as string[]) ?? []).map((f) => (
                    <li key={f} className="text-amber-700">⚠ {f} — conflicting</li>
                  ))}
                  {((fe.unavailable as string[]) ?? []).map((f) => (
                    <li key={f} className="text-faint">· {f} — unavailable</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-faint">
                  A field the candidate never carried cannot have been corroborated, so unavailable
                  fields are never counted as evidence.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted">No field-level evidence was recorded.</p>
            )}
          </Section>

          {recovery ? (
            <Section title="Missing field verification">
              <p className="text-sm text-ink/85">
                Some identity fields were unavailable, so ProspectIQ checked public sources to
                verify the missing information.
              </p>
              <ul className="mt-2 space-y-2">
                {(recovery as Output[]).map((r, i) => (
                  <li
                    key={i}
                    className={`rounded-lg px-3 py-2 text-sm ${
                      r.recovered ? 'bg-emerald-600/8 text-emerald-900' : 'bg-amber-600/6 text-amber-900'
                    }`}
                  >
                    <span className="font-medium capitalize">{String(r.field)}: </span>
                    {r.recovered ? (
                      <>
                        {String(r.value)} <span aria-hidden="true">✓</span> corroborated
                        {r.evidence_url ? (
                          <a
                            href={String(r.evidence_url)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-1 break-all text-xs underline"
                          >
                            source
                          </a>
                        ) : null}
                        {r.supporting_quote ? (
                          <span className="mt-0.5 block text-xs italic opacity-80">
                            “{String(r.supporting_quote)}”
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <>
                        Unavailable — {String(r.reason)}
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-faint">
                A value is accepted only when a retrieved source states it for this person. A source
                describing someone else with the same name is treated as a conflict, never a match.
              </p>
            </Section>
          ) : null}

          <Section title="Decision">
            <dl>
              <Row label="Status" value={String(identity.status)} />
              <Row label="Confidence" value={`${String(identity.confidence)}/100`} />
              <Row
                label="Resolution"
                value={identity.resolution === 'USER_CONFIRMED' ? 'User confirmed' : 'Automatically selected'}
              />
              <Row label="Reason" value={String(identity.reason ?? '')} />
            </dl>
          </Section>
        </>
      );
    }

    case 'qualify_prospect': {
      const fit = get<Output>(output, 'prospect_fit');
      if (!fit) return null;
      const cls = String(fit.classification);
      return (
        <>
          <Section title="Prospect fit">
            <div className={`rounded-lg border p-4 ${FIT_TONE[cls] ?? FIT_TONE.UNKNOWN}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold uppercase tracking-wider">
                  {cls} relevance
                </span>
                <span className="text-sm tabular-nums opacity-80">{String(fit.score)}/100</span>
              </div>
              <p className="mt-1.5 text-sm">{String(fit.relevance_reason ?? '')}</p>
            </div>
            <dl className="mt-3">
              <Row label="Role" value={fit.role ? String(fit.role) : '—'} />
              <Row label="Seniority" value={fit.seniority ? String(fit.seniority) : 'Not established'} />
              <Row label="Decision authority" value={String(fit.decision_authority)} />
              <Row label="Relevance to the product" value={String(fit.product_relevance)} />
              <Row
                label="Qualifying score"
                value={`${String(fit.score)} — the bar is ${String(get<number>(output, 'floor') ?? 45)}`}
              />
            </dl>
          </Section>

          {(fit.why_this_person as string[])?.length ? (
            <Section title="Why this person">
              <ul className="list-inside list-disc space-y-1 text-sm text-ink/85">
                {(fit.why_this_person as string[]).map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </Section>
          ) : null}

          {(fit.why_not_this_person as string[])?.length ? (
            <Section title="Why not this person">
              <ul className="list-inside list-disc space-y-1 text-sm text-ink/85">
                {(fit.why_not_this_person as string[]).map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </Section>
          ) : null}

          {(fit.missing_information as string[])?.length ? (
            <Section title="What we could not establish">
              <ul className="list-inside list-disc space-y-1 text-sm text-muted">
                {(fit.missing_information as string[]).map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </Section>
          ) : null}

          <Section title="Why it matters">
            <p className="text-sm text-ink/85">
              A person who does not own or influence the relevant workflows is not a good target,
              however interesting their company is. This is a targeting judgment about the role —
              not an assessment of the individual.
            </p>
          </Section>
        </>
      );
    }

    case 'qualify_company': {
      const fit = get<Output>(output, 'company_fit');
      const tq = get<Output>(output, 'target_qualification');
      if (!fit) return null;
      const cls = String(fit.classification);
      const matches = (fit.capability_matches as Output[]) ?? [];

      // The run's own final, canonical qualification (same source Decision
      // Summary and Account Decision read) rather than re-deriving company/
      // contact state from this one stage's narrower recorded output, which
      // never carried prospect_fit at all.
      const panels = run.qualification ? buildQualificationPanels(run.qualification) : null;

      return (
        <>
          <Section title="Company fit">
            <div className={`rounded-lg border p-4 ${FIT_TONE[cls] ?? FIT_TONE.UNKNOWN}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold uppercase tracking-wider">{cls} fit</span>
                <span className="text-sm tabular-nums opacity-80">{String(fit.score)}/100</span>
              </div>
              {(fit.fit_reasons as Output[])?.length ? (
                <p className="mt-1.5 text-sm">{String((fit.fit_reasons as Output[])[0].reason)}</p>
              ) : null}
            </div>
            <dl className="mt-3">
              <Row label="Industry" value={fit.industry ? String(fit.industry) : 'Not established'} />
              <Row label="Size" value={fit.company_size ? String(fit.company_size) : 'Not established'} />
              <Row
                label="Relevant workflows"
                value={(fit.relevant_workflows as string[])?.join(', ') || 'None identified'}
              />
            </dl>
          </Section>

          {matches.length > 0 ? (
            <Section title="Capability matching">
              <p className="mb-2 text-sm text-muted">
                Qualification basis:{' '}
                {matches.filter((m) => m.basis === 'OBSERVED' && ((m.evidence as EvidenceItem[]) ?? []).length > 0).length}{' '}
                observed use case
                {matches.filter((m) => m.basis === 'OBSERVED' && ((m.evidence as EvidenceItem[]) ?? []).length > 0).length === 1
                  ? ''
                  : 's'}
                . Inferred entries are shown for research context and did not qualify this company.
              </p>
              <ul className="space-y-2">
                {matches.map((m, i) => (
                  <li key={i} className="rounded-lg border border-hairline p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-ink/90">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${BASIS_TONE[String(m.basis)] ?? BASIS_TONE.UNKNOWN}`}>
                          {String(m.basis ?? 'UNKNOWN')}
                        </span>
                        {String(m.capability_name)}
                      </span>
                      <span className="text-xs tabular-nums text-faint">
                        fit {String(m.fit_strength)}/100
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-ink/85">{String(m.reason)}</p>
                    {m.company_signal ? (
                      <p className="mt-1 text-xs text-faint">
                        Observed: {String(m.company_signal)}
                      </p>
                    ) : null}
                    {(m.evidence as EvidenceItem[])?.length ? (
                      <ul className="mt-1 space-y-0.5">
                        {(m.evidence as EvidenceItem[]).slice(0, 3).map((e, j) => (
                          <li key={j} className="truncate text-xs text-faint" title={`${e.url} — "${e.quote}"`}>
                            {e.url}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : (
            <Section title="Capability matching">
              <p className="rounded-lg bg-app px-3 py-2 text-sm text-muted">
                No configured capability could be matched to observable characteristics of this
                company.
              </p>
            </Section>
          )}

          {(fit.missing_information as string[])?.length ? (
            <Section title="What we could not establish">
              <ul className="list-inside list-disc space-y-1 text-sm text-muted">
                {(fit.missing_information as string[]).map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </Section>
          ) : null}

          {tq && panels ? (
            <Section title="Qualification">
              {/*
                Three separate, explicitly labeled boxes — company fit,
                contact fit, overall decision — instead of one number next to
                another. Company fit and contact fit are each the same
                QUALIFIED/BORDERLINE/NOT_QUALIFIED scale the Decision Summary
                and Account Decision panels use (companyFitState /
                prospectFitState, via lib/ui/qualification-panels.ts), so a
                reader never has to reconcile this score against a different
                scale shown elsewhere on the page. The reported confusion
                this replaces: a company that qualified (QUALIFIED, 60/100)
                shown directly above an overall BORDERLINE, 45/100 box —
                easy to misread as the company itself being borderline, when
                the weaker CONTACT side is what drove the overall number
                down.
              */}
              <div className="grid gap-3 sm:grid-cols-3">
                <FitPanel
                  label="Company fit"
                  tone={QUAL_TONE[panels.company.state] ?? QUAL_TONE.BORDERLINE}
                  headline={panels.company.state.replace(/_/g, ' ')}
                  score={panels.company.score}
                  detail={`Evidence: ${panels.company.evidenceBasis}`}
                />
                <FitPanel
                  label="Contact fit"
                  tone={QUAL_TONE[panels.contact.state] ?? QUAL_TONE.BORDERLINE}
                  headline={panels.contact.state.replace(/_/g, ' ')}
                  score={panels.contact.score}
                  detail={`Evidence: ${panels.contact.evidenceBasis}`}
                />
                <FitPanel
                  label="Overall decision"
                  tone={QUAL_TONE[panels.overall.classification] ?? QUAL_TONE.BORDERLINE}
                  headline={
                    panels.overall.classification.replace(/_/g, ' ') +
                    (panels.overall.action === 'EXPLORATORY_OUTREACH' ||
                    panels.overall.action === 'EXPLORATORY_OUTREACH_IF_SIGNAL'
                      ? ' · exploratory'
                      : '')
                  }
                  score={panels.overall.score}
                  detail={<>Recommended action: {ACTION_LABEL[panels.overall.action] ?? panels.overall.action}</>}
                  note={panels.overall.suggestion ?? undefined}
                />
              </div>

              {panels.noAccountDecisionNeeded ? (
                <p className="mt-3 rounded-lg bg-app px-3 py-2 text-xs text-muted">
                  No Account Decision is required here — the company qualified on its own evidence.
                  Only the submitted contact is uncertain, so the system is looking for a better
                  contact at this same, already-qualified company.
                </p>
              ) : null}

              <p className="mt-3 text-xs text-faint">{panels.overall.reason}</p>
              <p className="mt-2 text-xs text-faint">
                Overall fit is the weaker of the two scores, not an average — a strong company does
                not rescue an irrelevant prospect, and vice versa. OBSERVED means a retrieved source
                shows the workflow; INFERRED means it is plausible from context but unconfirmed, and
                inference alone cannot produce a high company fit.
              </p>
              {fit.evidence_adjustment ? (
                <p className="mt-2 rounded bg-amber-600/6 px-3 py-2 text-xs text-amber-800">
                  {String(fit.evidence_adjustment)}
                </p>
              ) : null}
            </Section>
          ) : null}
        </>
      );
    }

    case 'find_contact_candidates': {
      if (get<boolean>(output, 'skipped')) {
        // The accurate, case-specific reason is already shown above in
        // "Result" (stage.summary) — this only needs to confirm the stage
        // is a no-op here, not re-derive or guess WHY from a status code.
        return (
          <Section title="Not applicable">
            <p className="text-sm text-muted">
              This run did not reach the specific state — a qualified company paired with a contact
              who is not — so no alternative contacts were searched for. See Result above for why.
            </p>
          </Section>
        );
      }
      const company = get<string>(output, 'company');
      const roles = get<string[]>(output, 'roles') ?? [];
      return (
        <>
          {roles.length > 0 && (
            <Section title="Roles searched">
              <p className="text-sm text-ink/85">
                Derived from the qualified workflow, not guessed by seniority: {roles.join(', ')}
                {company ? ` at ${company}` : ''}.
              </p>
            </Section>
          )}
          {get<string>(output, 'persistence_error') && (
            <Section title="Could not be saved">
              <p className="rounded-lg bg-amber-600/6 px-3 py-2 text-sm text-amber-800">
                Candidates were found but could not be stored ({get<string>(output, 'persistence_error')}), so
                they cannot be selected yet. Retry this run once the issue is resolved.
              </p>
            </Section>
          )}
          <Section title="Suggested contacts">
            <ContactCandidates runId={run.id} candidates={contactCandidates} />
          </Section>
        </>
      );
    }

    case 'collect_signals': {
      const evidence = get<Record<string, number>>(output, 'evidence');
      return (
        <>
          <Section title="Evidence set">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Total sources" value={String(get<number>(output, 'source_count') ?? 0)} />
              <Stat label="Full evidence" value={String(evidence?.FULL ?? 0)} tone="good" />
              <Stat label="Snippet only" value={String(evidence?.SNIPPET ?? 0)} tone="warn" />
              <Stat label="Dated" value={String(get<number>(output, 'dated') ?? 0)} />
            </div>
          </Section>
          <Section title="Sources in the evidence set">
            <TopSources sources={sources} signals={signals} stage="collect_signals" />
          </Section>
          <Section title="Why it matters">
            <p className="text-sm text-ink/85">
              This is the complete set of material the AI analysis is allowed to use. It cannot cite
              anything outside this set — citations are checked against it mechanically.
            </p>
          </Section>
        </>
      );
    }

    case 'evaluate_signals': {
      const ranked = get<Output[]>(output, 'ranked') ?? [];
      const rejected = get<Output[]>(output, 'rejected') ?? [];
      const llm = get<Output>(output, 'llm');
      return (
        <>
          <Section title="AI analysis">
            <dl>
              <Row label="Model used" value={<code className="text-xs">{String(llm?.model ?? '—')}</code>} />
              <Row
                label="Model status"
                value={
                  llm?.used_fallback_model
                    ? 'Primary model unavailable — fallback model used'
                    : 'Primary model responded'
                }
              />
              <Row label="Attempts" value={String(llm?.attempts ?? '—')} />
              <Row label="Analysis time" value={formatDuration((llm?.duration_ms as number) ?? null)} />
            </dl>
          </Section>

          {ranked.length > 0 && (
            <Section title="Candidate signals, scored">
              <div className="space-y-2">
                {ranked.map((r, i) => {
                  const c = r.components as Record<string, number>;
                  const source = findSourceByUrl(sources, r.source_url as string | undefined);
                  return (
                    <div key={i} className="rounded-lg border border-hairline p-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm text-ink/90">{String(r.signal)}</p>
                        <span className="shrink-0 rounded bg-ink/6 px-2 py-0.5 text-sm font-semibold tabular-nums">
                          {String(r.composite_score)}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
                        {Object.entries(c ?? {}).map(([k, v]) => (
                          <span key={k}>{k} {v}</span>
                        ))}
                      </div>
                      {/* Only rendered when the citation resolves to a source this run
                          actually retrieved and persisted — nothing here is invented. */}
                      {source ? <SourceLine source={source} /> : null}
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {rejected.length > 0 && (
            <Section title="Signals rejected by verification">
              <div className="space-y-2">
                {rejected.map((r, i) => (
                  <div key={i} className="rounded-lg bg-amber-600/6 p-3">
                    <p className="text-sm text-amber-900">{String(r.signal)}</p>
                    <p className="mt-1 text-xs text-amber-800">{String(r.reason)}</p>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Why it matters">
            <p className="text-sm text-ink/85">
              A signal is only eligible if it cites a source we actually retrieved and quotes text
              that genuinely appears there. Rejected signals are shown rather than silently dropped.
            </p>
          </Section>
        </>
      );
    }

    case 'select_hook': {
      const selected = get<Output>(output, 'selected');
      const alternatives = get<Output[]>(output, 'alternatives_considered') ?? [];
      const rejectedCandidates = get<Output[]>(output, 'rejected_candidates') ?? [];
      const coverage = get<Output>(output, 'research_coverage');
      const missing = get<string[]>(output, 'missing_information') ?? [];

      if (selected) {
        return (
          <>
            <Section title="Selected hook">
              <div className="space-y-3 rounded-lg border border-accent/25 bg-accent/8/40 p-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-accent">Signal</p>
                  <p className="mt-0.5 text-sm font-medium text-ink">{String(selected.signal)}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-faint">
                    <span className="rounded bg-surface px-1.5 py-0.5 ring-1 ring-hairline">
                      {selected.signal_level === 'COMPANY' ? 'Company-level' : 'Person-level'}
                    </span>
                    <span>{String(selected.published_date ?? 'undated')}</span>
                    <span className="rounded bg-surface px-1.5 py-0.5 ring-1 ring-hairline">
                      {String(selected.evidence_level ?? 'SNIPPET')} evidence
                    </span>
                  </div>
                </div>

                {selected.why_it_matters ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-accent">Why this matters</p>
                    <p className="mt-0.5 text-sm text-ink/85">{String(selected.why_it_matters)}</p>
                  </div>
                ) : null}

                {selected.role_relevance || selected.prospect_role ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-accent">Why this prospect</p>
                    <p className="mt-0.5 text-sm text-ink/85">
                      {String(
                        selected.role_relevance ??
                          `The signal concerns their employer, and their role is ${selected.prospect_role}.`,
                      )}
                    </p>
                  </div>
                ) : null}

                {selected.outreach_rationale ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                      Why this creates an outreach opportunity
                    </p>
                    <p className="mt-0.5 text-sm text-ink/85">{String(selected.outreach_rationale)}</p>
                  </div>
                ) : null}

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                    Source supporting this hook
                  </p>
                  {selected.supporting_quote ? (
                    <blockquote className="mt-0.5 border-l-2 border-accent/25 pl-2 text-sm italic text-muted">
                      “{String(selected.supporting_quote)}”
                    </blockquote>
                  ) : null}
                  <div className="mt-1.5 rounded-lg border border-accent/20 bg-surface px-2.5 py-2">
                    <a
                      href={String(selected.source_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block break-words text-sm font-medium text-accent hover:underline"
                    >
                      {String(selected.source_title || selected.source_url)}
                    </a>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
                      <span className="truncate">{hostOf(String(selected.source_url ?? ''))}</span>
                      {selected.published_date ? (
                        <>
                          <span aria-hidden>·</span>
                          <span>{String(selected.published_date)}</span>
                        </>
                      ) : null}
                      <a
                        href={String(selected.source_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto shrink-0 font-medium text-faint hover:text-accent hover:underline"
                      >
                        Open ↗
                      </a>
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-accent">Confidence</p>
                  <p className="mt-0.5 text-sm tabular-nums text-ink/90">
                    {String(get<number>(output, 'confidence') ?? selected.composite_score)}/100
                    <span className="ml-2 text-xs text-faint">
                      (signal score {String(selected.composite_score)})
                    </span>
                  </p>
                </div>
              </div>
            </Section>

            {get<string>(output, 'selection_reason') ? (
              <Section title="Why this one over the others">
                <p className="text-sm text-ink/85">{get<string>(output, 'selection_reason')}</p>
              </Section>
            ) : null}

            {rejectedCandidates.length > 0 ? (
              <Section title="Candidates turned down">
                <ul className="space-y-1.5">
                  {rejectedCandidates.map((r, i) => (
                    <li key={i} className="text-sm">
                      <span className="text-ink/90">{String(r.signal)}</span>
                      <span className="text-faint"> — {String(r.reason)}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {alternatives.length > 0 ? (
              <Section title="Alternatives considered">
                <ul className="space-y-1.5">
                  {alternatives.map((a, i) => (
                    <li key={i} className="text-sm">
                      <span className="text-ink/90">{String(a.signal)}</span>
                      <span className="text-faint"> — {String(a.why_not)}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
          </>
        );
      }

      // No hook: this is a considered outcome, not a technical failure.
      return (
        <>
          <Section title="Needs manual review">
            <div className="rounded-lg border border-amber-600/25 bg-amber-600/6 p-4">
              <p className="text-sm font-semibold uppercase tracking-wider text-amber-900">
                No verified outreach hook found
              </p>
              <p className="mt-1.5 text-sm text-amber-900">
                No sufficiently verified and prospect-relevant outreach hook was found.
              </p>
              <p className="mt-2 text-sm text-amber-800">
                {String(get<string>(output, 'insufficient_reason') ?? get<string>(output, 'selection_reason') ?? '')}
              </p>
            </div>
          </Section>

          {coverage ? (
            <Section title="Research coverage">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Sources reviewed" value={String(coverage.sources ?? 0)} />
                <Stat label="Signals verified" value={String(coverage.signals_verified ?? 0)} />
                <Stat
                  label="Signals rejected"
                  value={String(coverage.signals_rejected ?? 0)}
                  tone={Number(coverage.signals_rejected ?? 0) > 0 ? 'warn' : 'neutral'}
                />
              </div>
            </Section>
          ) : null}

          {rejectedCandidates.length > 0 ? (
            <Section title="Candidate signals and why each was rejected">
              <ul className="space-y-1.5">
                {rejectedCandidates.map((r, i) => (
                  <li key={i} className="rounded-lg bg-app px-3 py-2 text-sm">
                    <span className="text-ink/90">{String(r.signal)}</span>
                    <span className="block text-xs text-faint">{String(r.reason)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {missing.length > 0 ? (
            <Section title="What would unblock this">
              <ul className="list-inside list-disc text-sm text-ink/85">
                {missing.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </Section>
          ) : null}

          <Section title="Why it matters">
            <p className="text-sm text-ink/85">
              ProspectIQ does not invent personalization when the available evidence is
              insufficient. A human can review the coverage above and decide whether to supply more
              context or move on.
            </p>
          </Section>
        </>
      );
    }

    case 'generate_message': {
      const mode = get<string>(output, 'mode');

      if (get<boolean>(output, 'skipped')) {
        return (
          <>
            <Section title="No message generated">
              <div className="rounded-lg border border-amber-600/25 bg-amber-600/6 p-3">
                <p className="text-sm font-semibold uppercase tracking-wide text-amber-900">
                  No verified outreach hook found
                </p>
                <p className="mt-1 text-sm text-amber-800">{get<string>(output, 'explanation')}</p>
              </div>
            </Section>
            <Section title="Why it matters">
              <p className="text-sm text-ink/85">
                The run stops short of writing outreach rather than producing a message that only
                looks personalised. A human can review the evidence and decide how to proceed.
              </p>
            </Section>
          </>
        );
      }

      const gate = get<Output>(output, 'personalization_gate');
      const opener = get<Output>(output, 'opener_check');

      // The SAME current draft the main run page's Personalized draft card
      // shows — computed by the same shared function (lib/drafts/current-text.ts)
      // so the two pages cannot disagree. This stage's own `output.message_text`
      // is a snapshot of what generate_message produced at the moment it ran;
      // it does not move when the draft is later regenerated, revised or
      // edited, so showing it here would let this page silently disagree with
      // the main page. `output.message_text` is kept only as a fallback for
      // the case no draft row exists at all.
      const currentText = draft ? currentDraftText(draft) : get<string>(output, 'message_text');
      const currentWordCount = currentText ? currentText.trim().split(/\s+/).filter(Boolean).length : null;

      return (
        <>
          <RegenerateMessageButton runId={run.id} />
          <Section title="Draft produced">
            <dl>
              <Row label="Type" value={mode === 'personalized' ? 'Personalised (based on a verified hook)' : 'Conservative (no verified hook)'} />
              <Row label="Subject" value={get<string>(output, 'subject')} />
              <Row label="Personalisation basis" value={get<string>(output, 'outreach_angle')} />
            </dl>
            <p className="mt-3 whitespace-pre-wrap rounded-lg bg-app p-3 text-sm leading-relaxed text-ink/90">
              {currentText}
            </p>
            {currentWordCount ? (
              <p className="mt-1.5 text-xs text-faint">{currentWordCount} words</p>
            ) : null}
            <p className="mt-1.5 text-xs text-faint">
              Same draft shown in Personalized draft on the run page.
            </p>
          </Section>

          {opener ? (
            <Section title="Opener quality">
              <p className={`rounded-lg px-3 py-2 text-sm ${opener.passed ? 'bg-emerald-600/8 text-emerald-800' : 'bg-amber-600/6 text-amber-800'}`}>
                {opener.passed
                  ? `The opening reads as an observation rather than a research summary (${String(opener.word_count)} words).`
                  : ((opener.final_failures as string[]) ?? []).join(' ')}
              </p>
            </Section>
          ) : null}

          {gate ? (
            <Section title="Personalisation check">
              <p className={`rounded-lg px-3 py-2 text-sm ${gate.passed ? 'bg-emerald-600/8 text-emerald-800' : 'bg-amber-600/6 text-amber-800'}`}>
                {gate.passed
                  ? 'The draft engages with the specifics of the selected hook, so it could not be sent unchanged to a different prospect.'
                  : String(gate.final_reason ?? 'The draft still reads as generic.')}
                {gate.regenerated ? ' It was regenerated once to improve specificity.' : ''}
              </p>
            </Section>
          ) : null}
          <Section title="Why it matters">
            <p className="text-sm text-ink/85">
              {mode === 'personalized'
                ? 'This draft opens on a signal that survived verification, so its personalisation is traceable to a real source.'
                : 'Because no hook survived verification, this draft deliberately references no research findings rather than inventing personalisation.'}
            </p>
          </Section>
        </>
      );
    }

    case 'validate_claims': {
      const claims = get<Output[]>(output, 'claims') ?? [];
      const tone: Record<string, string> = {
        SUPPORTED: 'bg-emerald-600/8 text-emerald-700',
        ALLOWED: 'bg-accent/8 text-accent',
        UNCERTAIN: 'bg-amber-600/6 text-amber-700',
        UNSUPPORTED: 'bg-red-600/8 text-red-700',
      };
      return (
        <>
          <Section title="Claims checked">
            <div className="space-y-2">
              {claims.map((c, i) => (
                <div key={i} className="rounded-lg border border-hairline p-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-ink/90">{String(c.claim)}</p>
                    <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-semibold ${tone[String(c.verdict)] ?? 'bg-ink/6 text-muted'}`}>
                      {String(c.verdict)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
                    <span className="rounded bg-ink/6 px-1.5 py-0.5">{String(c.type ?? '').replace(/_/g, ' ').toLowerCase()}</span>
                    <span>{c.requires_external_evidence ? 'evidence required' : 'no external evidence required'}</span>
                    {c.evidence_url ? (
                      <a href={String(c.evidence_url)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                        source
                      </a>
                    ) : null}
                  </div>
                  {c.explanation ? (
                    <p className="mt-1 text-xs text-muted">{humanize(String(c.explanation))}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </Section>
          <Section title="How to read these verdicts">
            <dl className="space-y-1.5 text-sm text-ink/85">
              <div>
                <dt className="inline font-medium text-emerald-700">SUPPORTED — </dt>
                <dd className="inline">a retrieved source establishes the claim.</dd>
              </div>
              <div>
                <dt className="inline font-medium text-accent">ALLOWED — </dt>
                <dd className="inline">
                  a statement about your own product or ordinary outreach phrasing; no third-party
                  evidence is required.
                </dd>
              </div>
              <div>
                <dt className="inline font-medium text-amber-700">UNCERTAIN — </dt>
                <dd className="inline">
                  public search evidence was found, but the underlying page could not be fully
                  retrieved, so the claim was not treated as fully corroborated. This is a
                  confidence level, not an error — the claim may well be true.
                </dd>
              </div>
              <div>
                <dt className="inline font-medium text-red-700">UNSUPPORTED — </dt>
                <dd className="inline">
                  nothing in the collected evidence establishes the claim. These are kept out of the
                  final message or escalated for review.
                </dd>
              </div>
            </dl>
          </Section>
        </>
      );
    }

    case 'ready_for_review': {
      const reasons = get<string[]>(output, 'reasons') ?? [];
      return (
        <>
          <Section title="Outcome">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Overall confidence" value={String(get<number>(output, 'overall_confidence') ?? '—')} />
              <Stat label="AI calls used" value={String(get<number>(output, 'model_calls_used') ?? 1)} />
              <Stat
                label="Needs human review"
                value={get<boolean>(output, 'needs_manual_review') ? 'Yes' : 'Ready'}
                tone={get<boolean>(output, 'needs_manual_review') ? 'warn' : 'good'}
              />
            </div>
            {reasons.length > 0 && (
              <ul className="mt-3 list-inside list-disc text-sm text-ink/85">
                {reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
          </Section>
          <Section title="Why it matters">
            <p className="text-sm text-ink/85">
              The run stops here. Outreach is always sent manually — a human reviews, edits and
              approves the draft before it is ever used.
            </p>
          </Section>
        </>
      );
    }

    default:
      return null;
  }
}
