import { createServiceClient } from './client';
import { STAGE_ORDER } from '@/lib/types';
import type {
  DraftRow,
  RunRow,
  RunStageRow,
  RunStatus,
  SignalRow,
  SourceRow,
  StageName,
  StageStatus,
} from '@/lib/types';
import type { ProspectOverviewRow, ProspectRow } from '@/lib/prospects/types';
import type { ContactCandidateRow } from '@/lib/contacts/types';
import { countsAsResearched, identityPatchFromRun } from '@/lib/prospects/types';

// Typed read/write helpers. All writes use the service-role client (server only).

// ─── prospects ───────────────────────────────────────────────────────────────

/**
 * The prospect for this user and slug, creating it if it is new.
 *
 * The (user_id, linkedin_slug) unique index is what makes this safe under
 * concurrency: two simultaneous submissions of the same URL race to insert, one
 * wins, and the loser reads the winner's row instead of creating a duplicate.
 */
export async function findOrCreateProspect(input: {
  user_id: string;
  linkedin_slug: string;
  linkedin_url: string;
}): Promise<{ prospect: ProspectRow; created: boolean }> {
  const supabase = createServiceClient();

  const existing = await findProspectBySlug(input.user_id, input.linkedin_slug);
  if (existing) return { prospect: existing, created: false };

  const { data, error } = await supabase
    .from('prospects')
    .insert(input)
    .select()
    .single();

  if (error) {
    // 23505 = unique violation: someone else created it between our read and
    // our write. Their row is just as good as ours.
    if ((error as { code?: string }).code === '23505') {
      const won = await findProspectBySlug(input.user_id, input.linkedin_slug);
      if (won) return { prospect: won, created: false };
    }
    throw error;
  }
  return { prospect: data as ProspectRow, created: true };
}

export async function findProspectBySlug(
  userId: string,
  slug: string,
): Promise<ProspectRow | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('prospects')
    .select()
    .eq('user_id', userId)
    .eq('linkedin_slug', slug)
    .maybeSingle();
  if (error) throw error;
  return (data as ProspectRow) ?? null;
}

export async function getProspect(prospectId: string): Promise<ProspectRow | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('prospects')
    .select()
    .eq('id', prospectId)
    .maybeSingle();
  if (error) throw error;
  return (data as ProspectRow) ?? null;
}

/**
 * A user's prospects with their run rollup, newest research first.
 *
 * Reads the `prospect_overview` view so the run count and latest-run summary
 * arrive in ONE query. Listing prospects and then querying runs per prospect
 * would be an N+1 that grows with the history.
 */
export async function listProspects(
  userId: string,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<ProspectOverviewRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('prospect_overview')
    .select()
    .eq('user_id', userId)
    .order('last_researched_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return (data as ProspectOverviewRow[]) ?? [];
}

export async function countProspects(userId: string): Promise<number> {
  const supabase = createServiceClient();
  const { count, error } = await supabase
    .from('prospects')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw error;
  return count ?? 0;
}

/** A prospect's runs, newest first. Ownership is checked by the caller's guard. */
export async function listProspectRuns(prospectId: string, limit = 100): Promise<RunRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('runs')
    .select()
    .eq('prospect_id', prospectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as RunRow[]) ?? [];
}

/**
 * Signals for several runs in one query, keyed by run.
 *
 * The prospect page needs signals for the timeline across N runs; fetching them
 * per run would be the N+1 this avoids.
 */
export async function listSignalsForRuns(runIds: string[]): Promise<Record<string, SignalRow[]>> {
  if (runIds.length === 0) return {};
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('signals')
    .select()
    .in('run_id', runIds)
    .order('composite_score', { ascending: false, nullsFirst: false });
  if (error) throw error;

  const byRun: Record<string, SignalRow[]> = {};
  for (const row of (data as SignalRow[]) ?? []) {
    (byRun[row.run_id] ??= []).push(row);
  }
  return byRun;
}

/**
 * Push a finished run's identity back onto its prospect.
 *
 * Only non-null fields are written (see identityPatchFromRun), so a run that
 * failed early cannot blank out what an earlier run established. The run itself
 * is never modified — history stays immutable.
 */
export async function syncProspectFromRun(run: RunRow): Promise<void> {
  if (!run.prospect_id) return;
  const supabase = createServiceClient();

  const patch: Record<string, unknown> = {
    ...identityPatchFromRun(run),
    updated_at: new Date().toISOString(),
  };
  if (countsAsResearched(run)) {
    patch.last_researched_at = run.completed_at ?? new Date().toISOString();
  }

  const { error } = await supabase.from('prospects').update(patch).eq('id', run.prospect_id);
  if (error) throw error;
}

// ─── runs ────────────────────────────────────────────────────────────────────

export async function createRun(input: {
  linkedin_url: string;
  linkedin_slug: string;
  input_name: string | null;
  input_company: string | null;
  input_title: string | null;
  sender_name: string | null;
  /** Owner of the run. Required — every new run belongs to someone. */
  user_id: string;
  /** The persistent prospect this run researches. */
  prospect_id: string;
  /** Set only when this run exists because a human selected a discovered contact candidate. */
  origin_contact_candidate_id?: string | null;
}): Promise<RunRow> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('runs')
    .insert({ ...input, status: 'queued' })
    .select()
    .single();
  if (error) throw error;
  return data as RunRow;
}

export async function updateRun(runId: string, patch: Partial<RunRow>): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from('runs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', runId);
  if (error) throw error;
}

export async function updateRunStatus(runId: string, status: RunStatus): Promise<void> {
  await updateRun(runId, { status });
}

export async function getRun(runId: string): Promise<RunRow | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.from('runs').select().eq('id', runId).maybeSingle();
  if (error) throw error;
  return (data as RunRow) ?? null;
}

/**
 * Runs belonging to one user.
 *
 * userId is required: an unscoped listing would return every user's prospects,
 * and the service-role client would happily comply.
 */
export async function listRuns(userId: string, limit = 100): Promise<RunRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('runs')
    .select()
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as RunRow[]) ?? [];
}

// ─── stages ──────────────────────────────────────────────────────────────────

/**
 * Pre-create every stage as `pending` so the UI shows the whole workflow from
 * the first render instead of stages appearing one by one.
 */
export async function initStages(runId: string): Promise<void> {
  const supabase = createServiceClient();
  const rows = STAGE_ORDER.map((stage_name, i) => ({
    run_id: runId,
    stage_name,
    stage_order: i,
    status: 'pending' as StageStatus,
  }));
  const { error } = await supabase.from('run_stages').upsert(rows, { onConflict: 'run_id,stage_name' });
  if (error) throw error;
}

export async function startStage(runId: string, stageName: StageName): Promise<string> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('run_stages')
    .upsert(
      {
        run_id: runId,
        stage_name: stageName,
        stage_order: STAGE_ORDER.indexOf(stageName),
        status: 'running',
        error: null,
        output: null,
        summary: null,
        duration_ms: null,
        started_at: new Date().toISOString(),
        completed_at: null,
      },
      { onConflict: 'run_id,stage_name' },
    )
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function finishStage(
  stageId: string,
  fields: {
    status: StageStatus;
    summary?: string | null;
    output?: unknown;
    error?: string | null;
    duration_ms?: number | null;
  },
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from('run_stages')
    .update({
      status: fields.status,
      summary: fields.summary ?? null,
      output: fields.output ?? null,
      error: fields.error ?? null,
      duration_ms: fields.duration_ms ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', stageId);
  if (error) throw error;
}

/** Mark the stages after a failure as skipped, so the UI doesn't show them pending forever. */
export async function skipRemainingStages(runId: string, afterStage: StageName): Promise<void> {
  const supabase = createServiceClient();
  const startIndex = STAGE_ORDER.indexOf(afterStage) + 1;
  const remaining = STAGE_ORDER.slice(startIndex);
  if (remaining.length === 0) return;

  const { error } = await supabase
    .from('run_stages')
    .update({ status: 'skipped', summary: 'Skipped — an earlier stage failed.' })
    .eq('run_id', runId)
    .in('stage_name', remaining as unknown as string[])
    .eq('status', 'pending');
  if (error) throw error;
}

export async function listStages(runId: string): Promise<RunStageRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('run_stages')
    .select()
    .eq('run_id', runId)
    .order('stage_order', { ascending: true });
  if (error) throw error;
  return (data as RunStageRow[]) ?? [];
}

export async function getStage(runId: string, stageName: StageName): Promise<RunStageRow | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('run_stages')
    .select()
    .eq('run_id', runId)
    .eq('stage_name', stageName)
    .maybeSingle();
  if (error) throw error;
  return (data as RunStageRow) ?? null;
}

// ─── sources ─────────────────────────────────────────────────────────────────

export async function replaceSources(
  runId: string,
  sources: Omit<SourceRow, 'id' | 'run_id'>[],
): Promise<SourceRow[]> {
  const supabase = createServiceClient();
  await supabase.from('sources').delete().eq('run_id', runId);
  if (sources.length === 0) return [];
  const { data, error } = await supabase
    .from('sources')
    .insert(sources.map((s) => ({ ...s, run_id: runId })))
    .select();
  if (error) throw error;
  return (data as SourceRow[]) ?? [];
}

export async function listSources(runId: string): Promise<SourceRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('sources')
    .select()
    .eq('run_id', runId)
    .order('credibility', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return (data as SourceRow[]) ?? [];
}

// ─── signals ─────────────────────────────────────────────────────────────────

export async function replaceSignals(
  runId: string,
  signals: Omit<SignalRow, 'id' | 'run_id'>[],
): Promise<SignalRow[]> {
  const supabase = createServiceClient();
  await supabase.from('signals').delete().eq('run_id', runId);
  if (signals.length === 0) return [];
  const { data, error } = await supabase
    .from('signals')
    .insert(signals.map((s) => ({ ...s, run_id: runId })))
    .select();
  if (error) throw error;
  return (data as SignalRow[]) ?? [];
}

export async function listSignals(runId: string): Promise<SignalRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('signals')
    .select()
    .eq('run_id', runId)
    .order('composite_score', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return (data as SignalRow[]) ?? [];
}

export async function markSignalAsHook(runId: string, signalId: string): Promise<void> {
  const supabase = createServiceClient();
  await supabase.from('signals').update({ selected_as_hook: false }).eq('run_id', runId);
  const { error } = await supabase.from('signals').update({ selected_as_hook: true }).eq('id', signalId);
  if (error) throw error;
}

// ─── drafts ──────────────────────────────────────────────────────────────────

export async function createDraft(draft: Partial<DraftRow> & { run_id: string; message_text: string }): Promise<DraftRow> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.from('drafts').insert(draft).select().single();
  if (error) throw error;
  return data as DraftRow;
}

export async function updateDraft(draftId: string, patch: Partial<DraftRow>): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.from('drafts').update(patch).eq('id', draftId);
  if (error) throw error;
}

export async function getDraft(runId: string): Promise<DraftRow | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('drafts')
    .select()
    .eq('run_id', runId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as DraftRow) ?? null;
}

/** Delete a run's prior draft — used when the draft stage is retried. */
export async function deleteDrafts(runId: string): Promise<void> {
  const supabase = createServiceClient();
  await supabase.from('drafts').delete().eq('run_id', runId);
}

// ─── contact candidates ──────────────────────────────────────────────────────

/**
 * `identity_status` is optional and defaults to DISCOVERED in the database.
 * Discovery now sets it explicitly to PARTIAL for a candidate that failed
 * lightweight pre-verification (see lib/contacts/preverify.ts), so the row
 * arrives already non-selectable rather than being offered and then refused.
 * Only values the table's own CHECK constraint allows are accepted.
 */
export async function createContactCandidates(
  runId: string,
  candidates: (Omit<ContactCandidateRow, 'id' | 'run_id' | 'identity_status' | 'identity_verification' | 'selected_at' | 'resulting_run_id' | 'created_at'> & {
    identity_status?: ContactCandidateRow['identity_status'];
  })[],
): Promise<ContactCandidateRow[]> {
  if (candidates.length === 0) return [];
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('contact_candidates')
    .insert(candidates.map((c) => ({ ...c, run_id: runId })))
    .select();
  if (error) throw error;
  return (data as ContactCandidateRow[]) ?? [];
}

/** A run's discovered candidates, best-ranked first. */
export async function listContactCandidates(runId: string): Promise<ContactCandidateRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('contact_candidates')
    .select()
    .eq('run_id', runId)
    .order('rank_score', { ascending: false });
  if (error) throw error;
  return (data as ContactCandidateRow[]) ?? [];
}

export async function getContactCandidate(candidateId: string): Promise<ContactCandidateRow | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('contact_candidates')
    .select()
    .eq('id', candidateId)
    .maybeSingle();
  if (error) throw error;
  return (data as ContactCandidateRow) ?? null;
}

export async function updateContactCandidate(
  candidateId: string,
  patch: Partial<
    Pick<ContactCandidateRow, 'identity_status' | 'identity_verification' | 'selected_at' | 'resulting_run_id'>
  >,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.from('contact_candidates').update(patch).eq('id', candidateId);
  if (error) throw error;
}

/**
 * Atomically claim a DISCOVERED candidate for selection.
 *
 * A plain read-then-write ("is identity_status still DISCOVERED?" followed by
 * a separate update) is a TOCTOU race: two near-simultaneous POSTs to the
 * select endpoint can both read DISCOVERED before either write lands, and
 * both go on to run paid verification and create a run for the same
 * candidate. Gating the UPDATE itself on `selected_at is null` makes the
 * claim atomic — Postgres serializes concurrent UPDATEs on the same row, so
 * only the first one to commit affects a row; the second re-evaluates the
 * WHERE clause against the now-committed `selected_at` and matches nothing.
 * Returns the claimed row, or null if some other request already claimed (or
 * previously attempted) this candidate first.
 */
export async function claimContactCandidateForSelection(
  candidateId: string,
): Promise<ContactCandidateRow | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('contact_candidates')
    .update({ selected_at: new Date().toISOString() })
    .eq('id', candidateId)
    .is('selected_at', null)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as ContactCandidateRow) ?? null;
}
