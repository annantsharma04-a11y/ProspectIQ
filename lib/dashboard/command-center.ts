// The homepage Command Center — a compact TRIAGE surface, not a second
// workspace. It answers exactly one question: "what needs my attention?" —
// nothing here duplicates the Run page's decisions, the Stage Detail page's
// evidence, History's full run list, or Evaluation's performance metrics.
// Every field is read straight off `RunRow` (the same rows `listRuns()`
// already returns everywhere else); nothing is re-derived by a model, nothing
// is written, and no new query is introduced.
//
// Four lenses over the same run list, because "what needs attention" looks
// different depending on the question:
//   needsAttention — the run itself is stuck (manual review, parked on a
//                     quota error, or genuinely failed)
//   ready           — a drafted message is waiting for a human decision
//   contactsNeedingWork — the qualification matrix itself said so
//                     (VERIFY BETTER CONTACT / FIND BETTER CONTACT)
//   exploratory     — the qualification matrix said EXPLORATORY OUTREACH
// A run can appear in more than one lens (a "find better contact" run is
// also, structurally, `needs_manual_review`) — that overlap is real, not a
// bug: the same run is a legitimate answer to two different questions.
//
// Every row is deliberately ONE short label, never the qualification
// paragraph, never the evidence, never the full run detail — that stays on
// the Run page, the Stage Detail page and History, exactly where it already
// lives.

import { STAGE_LABELS, type RunRow, type RunStageRow, type RunStatus } from '@/lib/types';
import { buildDecisionSummary, type DecisionAction } from '@/lib/ui/decision-summary';
import {
  accountDecisionState,
  type AccountDecisionState,
} from '@/lib/qualification/account-decision';

/** How many rows each section previews before "View all". Configurable from one place. */
export const PREVIEW_LIMIT = 3;

const ATTENTION_STATUSES: RunStatus[] = ['needs_manual_review', 'ai_analysis_pending', 'failed'];
const ACTIVE_STATUSES: RunStatus[] = ['queued', 'running'];

const STATUS_LABEL: Record<string, string> = {
  needs_manual_review: 'Needs manual review',
  ai_analysis_pending: 'Analysis pending',
  failed: 'Failed',
};

export interface TriageItem {
  runId: string;
  prospectName: string;
  companyName: string | null;
  /** One short label — a decision action or a run-status word. Never a reason paragraph. */
  label: string;
}

export interface CommandCenterSummary {
  needsAttention: TriageItem[];
  ready: TriageItem[];
  contactsNeedingWork: TriageItem[];
  exploratory: TriageItem[];
  counts: {
    total: number;
    needsAttention: number;
    ready: number;
    contactsNeedingWork: number;
    exploratory: number;
  };
  /** The most recent run still queued or running, if any — drives the Live Run section. */
  activeRunId: string | null;
}

/**
 * Whether a triage section should render at all. A section with nothing in
 * it is not a "nothing here" placeholder — it is not shown, at all: no
 * heading, no card, no empty-state copy. One place decides this so the
 * component and any future consumer agree on the rule.
 */
export function shouldRenderSection(items: TriageItem[]): boolean {
  return items.length > 0;
}

function displayName(run: RunRow): string {
  return run.prospect_name ?? run.input_name ?? `/in/${run.linkedin_slug}`;
}

function toItem(run: RunRow, label: string): TriageItem {
  return { runId: run.id, prospectName: displayName(run), companyName: run.company_name, label };
}

/**
 * A borderline account's human-decision label, or null when none applies.
 *
 * Takes priority over the matrix action wherever it exists: "Exploratory
 * outreach" describes what the system would do, while this describes what is
 * actually blocking — and a triage surface exists to answer the second.
 */
const DECISION_LABEL: Record<AccountDecisionState, string | null> = {
  NONE: null,
  REQUIRED: 'Account decision needed',
  CONTINUED: 'Account continued',
  HELD: 'Account held',
};

function accountDecisionLabel(run: RunRow): string | null {
  return DECISION_LABEL[accountDecisionState(run.qualification)];
}

function needsAttentionLabel(run: RunRow): string {
  const action = buildDecisionSummary(run)?.action;
  return (
    accountDecisionLabel(run) ?? action ?? STATUS_LABEL[run.status] ?? run.status.replace(/_/g, ' ')
  );
}

const CONTACT_WORK_ACTIONS: DecisionAction[] = ['VERIFY BETTER CONTACT', 'FIND BETTER CONTACT'];

/**
 * Derive the four triage lists from a run list the caller already fetched
 * (`listRuns()` — no new query). Each list is capped at `limit`, newest
 * first, matching the order `listRuns()` already returns.
 */
export function buildCommandCenterSummary(runs: RunRow[], limit = PREVIEW_LIMIT): CommandCenterSummary {
  const attentionRuns = runs.filter((r) => ATTENTION_STATUSES.includes(r.status));
  const readyRuns = runs.filter((r) => r.status === 'ready_for_review');

  const decisions = new Map(runs.map((r) => [r.id, buildDecisionSummary(r)] as const));
  const contactRuns = runs.filter((r) => {
    const action = decisions.get(r.id)?.action;
    return action ? CONTACT_WORK_ACTIONS.includes(action) : false;
  });
  const exploratoryRuns = runs.filter((r) => decisions.get(r.id)?.action === 'EXPLORATORY OUTREACH');

  const activeRun = runs.find((r) => ACTIVE_STATUSES.includes(r.status)) ?? null;

  return {
    needsAttention: attentionRuns.slice(0, limit).map((r) => toItem(r, needsAttentionLabel(r))),
    ready: readyRuns.slice(0, limit).map((r) => toItem(r, 'Ready for review')),
    contactsNeedingWork: contactRuns.slice(0, limit).map((r) => toItem(r, decisions.get(r.id)!.action)),
    exploratory: exploratoryRuns
      .slice(0, limit)
      .map((r) => toItem(r, accountDecisionLabel(r) ?? 'Exploratory outreach')),
    counts: {
      total: runs.length,
      needsAttention: attentionRuns.length,
      ready: readyRuns.length,
      contactsNeedingWork: contactRuns.length,
      exploratory: exploratoryRuns.length,
    },
    activeRunId: activeRun?.id ?? null,
  };
}

/**
 * A COMPACT description of the one run currently working — deliberately not
 * the pipeline.
 *
 * The homepage used to embed the real LiveRunView here, which meant `/`
 * rendered all fourteen stages, their statuses, their retry affordances and a
 * realtime subscription: the run workspace, on the triage surface. This
 * returns four short strings instead. Everything it omits is one click away on
 * /runs/[id], which is the page that owns that answer.
 *
 * `currentStageLabel` is the stage actually RUNNING where there is one; before
 * the first stage starts it names the next pending stage, so a just-queued run
 * still says something truthful rather than nothing.
 */
export interface ActiveRunSummary {
  runId: string;
  prospectName: string;
  companyName: string | null;
  /** One short line: what is happening to this run right now. */
  statusLabel: string;
  /** Human-readable name of the stage in progress, or null if none has begun. */
  currentStageLabel: string | null;
}

const ACTIVE_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Research in progress',
};

export function buildActiveRunSummary(
  run: RunRow,
  stages: Pick<RunStageRow, 'stage_name' | 'status' | 'stage_order'>[],
): ActiveRunSummary {
  const ordered = [...stages].sort((a, b) => a.stage_order - b.stage_order);
  const current =
    ordered.find((s) => s.status === 'running') ?? ordered.find((s) => s.status === 'pending') ?? null;

  return {
    runId: run.id,
    prospectName: displayName(run),
    companyName: run.company_name,
    statusLabel: ACTIVE_STATUS_LABEL[run.status] ?? run.status.replace(/_/g, ' '),
    currentStageLabel: current ? STAGE_LABELS[current.stage_name] : null,
  };
}

/**
 * Who to greet, and when — reads the most recent non-empty `sender_name`
 * already stored on the user's own runs (the "Your name" field on every
 * submission), never a new profile field. Falls back to the email's local
 * part, then to no name at all.
 */
export function greetingName(runs: RunRow[], email: string | null): string | null {
  const fromRun = runs.find((r) => r.sender_name?.trim())?.sender_name?.trim() ?? null;
  if (fromRun) return fromRun;
  const local = email?.split('@')[0]?.trim();
  return local ? local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

export function timeOfDayGreeting(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
