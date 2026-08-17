// What changed between two runs of the same prospect.
//
// Every change reported here is derived from two stored run rows (and their
// stored signals). Nothing is inferred, and absence of data is never reported as
// a change: if an earlier run never learned the company, a later run learning it
// is "company established", not "company changed".
//
// This is the honest version of a "what's new" feed. A field that went from a
// value to null means the newer run did not establish it — which is a fact about
// the research, not about the person — so it is not reported at all.

import type { RunRow, SignalRow } from '@/lib/types';

export type ProspectChangeKind =
  | 'role_changed'
  | 'company_changed'
  | 'qualification_changed'
  | 'new_signal'
  | 'signal_no_longer_present'
  | 'research_completed';

export interface ProspectChange {
  kind: ProspectChangeKind;
  /** One line, already phrased for a human. */
  summary: string;
  from?: string | null;
  to?: string | null;
  /** The newer run this change was observed in. */
  run_id: string;
  observed_at: string;
}

/** A signal's identity for comparison purposes: its text, loosely normalized. */
function signalKey(s: SignalRow): string {
  return s.signal.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Compare an older run to the newer one that followed it.
 *
 * `previous` is the chronologically earlier run. Signals are optional: pass them
 * to get signal-level changes, omit them for a cheap identity-only diff.
 */
export function diffRuns(
  previous: RunRow,
  current: RunRow,
  previousSignals: SignalRow[] = [],
  currentSignals: SignalRow[] = [],
): ProspectChange[] {
  const changes: ProspectChange[] = [];
  const at = current.completed_at ?? current.created_at;
  const base = { run_id: current.id, observed_at: at };

  // Identity. Only a value → different value counts. null on either side means
  // "not established by that run", which says nothing about the person.
  if (previous.prospect_title && current.prospect_title && previous.prospect_title !== current.prospect_title) {
    changes.push({
      ...base,
      kind: 'role_changed',
      summary: `Role changed from "${previous.prospect_title}" to "${current.prospect_title}"`,
      from: previous.prospect_title,
      to: current.prospect_title,
    });
  }

  if (previous.company_name && current.company_name && previous.company_name !== current.company_name) {
    changes.push({
      ...base,
      kind: 'company_changed',
      summary: `Company changed from ${previous.company_name} to ${current.company_name}`,
      from: previous.company_name,
      to: current.company_name,
    });
  }

  if (
    previous.qualification_status &&
    current.qualification_status &&
    previous.qualification_status !== current.qualification_status
  ) {
    changes.push({
      ...base,
      kind: 'qualification_changed',
      summary: `Qualification changed from ${label(previous.qualification_status)} to ${label(current.qualification_status)}`,
      from: previous.qualification_status,
      to: current.qualification_status,
    });
  }

  // Signals. Only compared when the newer run actually collected some —
  // otherwise every signal would look "lost" because the run failed early.
  if (currentSignals.length > 0) {
    const before = new Map(previousSignals.map((s) => [signalKey(s), s]));
    const after = new Map(currentSignals.map((s) => [signalKey(s), s]));

    for (const [key, s] of after) {
      if (!before.has(key)) {
        changes.push({ ...base, kind: 'new_signal', summary: `New signal: ${s.signal}`, to: s.signal });
      }
    }
    // Only meaningful if the earlier run had found signals to begin with.
    if (previousSignals.length > 0) {
      for (const [key, s] of before) {
        if (!after.has(key)) {
          changes.push({
            ...base,
            kind: 'signal_no_longer_present',
            summary: `Previously found signal not re-verified: ${s.signal}`,
            from: s.signal,
          });
        }
      }
    }
  }

  return changes;
}

/**
 * The full timeline for a prospect, newest change first.
 *
 * `runs` must be chronological (oldest first). Runs with no signals loaded
 * simply produce identity-level changes.
 */
export function prospectTimeline(
  runs: RunRow[],
  signalsByRun: Record<string, SignalRow[]> = {},
): ProspectChange[] {
  const changes: ProspectChange[] = [];

  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1];
    const cur = runs[i];
    changes.push(...diffRuns(prev, cur, signalsByRun[prev.id] ?? [], signalsByRun[cur.id] ?? []));
  }

  return changes.sort(
    (a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime(),
  );
}

function label(status: string): string {
  return status.replace(/_/g, ' ').toLowerCase();
}
