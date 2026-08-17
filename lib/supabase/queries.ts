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

// Typed read/write helpers. All writes use the service-role client (server only).

// ─── runs ────────────────────────────────────────────────────────────────────

export async function createRun(input: {
  linkedin_url: string;
  linkedin_slug: string;
  input_name: string | null;
  input_company: string | null;
  input_title: string | null;
  sender_name: string | null;
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

export async function listRuns(limit = 100): Promise<RunRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('runs')
    .select()
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
