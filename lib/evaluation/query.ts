// Evaluation data access.
//
// PERFORMANCE — the dashboard must never become "fetch every run, then query
// per run". This module issues a FIXED number of queries (7) regardless of how
// many prospects or runs exist, joins them in memory by id, and aggregates the
// two large child tables (sources: 2,259 rows today) in the database so their
// rows never cross the wire.
//
// SECURITY — every query is scoped to one user. The runs table carries the
// authoritative user_id, and the child tables are reached through the caller's
// own run ids, so there is no path by which another user's rows enter the
// aggregate. Aggregates are not exempt from ownership: a mean computed over
// someone else's data is still their data.

import { createServiceClient } from '@/lib/supabase/client';
import type { EvaluationInput, HookOutcome, SignalProposal } from './types';
import type { DraftRow, RunRow, RunStageRow, SignalRow } from '@/lib/types';

/** Stage outputs are large; only these two are read, and only their counts used. */
const OUTPUT_STAGES = ['evaluate_signals', 'select_hook'];

/** PostgREST's default maximum rows per response. */
const POSTGREST_PAGE_CAP = 1000;

export async function loadEvaluationInput(userId: string): Promise<EvaluationInput> {
  const supabase = createServiceClient();

  // 1. The caller's runs. Everything else keys off these ids.
  const { data: runData, error: runErr } = await supabase
    .from('runs')
    .select(
      'id, prospect_id, user_id, status, identity_status, identity_resolution, qualification_status, qualification, insufficient_evidence, ai_error_type, error, selected_hook, linkedin_access_status, profile_source, started_at, completed_at, created_at',
    )
    .eq('user_id', userId);
  if (runErr) throw runErr;

  const runs = (runData ?? []) as RunRow[];
  const runIds = runs.map((r) => r.id);

  // 2. Prospects, for prospect-level counting.
  const { data: prospectData, error: pErr } = await supabase
    .from('prospects')
    .select('id, created_at')
    .eq('user_id', userId);
  if (pErr) throw pErr;

  if (runIds.length === 0) {
    return {
      prospects: prospectData ?? [],
      runs: [],
      stages: [],
      signals: [],
      drafts: [],
      proposals: [],
      hooks: [],
      sourceProviders: {},
      sourceFetchStatus: {},
      sourcesSampled: false,
      sourcesCounted: 0,
      contactCandidates: [],
    };
  }

  // 3–8. Child rows for those runs, one query each — never one per run.
  const [stages, signals, drafts, outputs, sources, contactCandidates] = await Promise.all([
    supabase
      .from('run_stages')
      .select('run_id, stage_name, status, duration_ms')
      .in('run_id', runIds),
    supabase
      .from('signals')
      .select('run_id, selected_as_hook, supporting_quote, composite_score, category')
      .in('run_id', runIds),
    supabase
      .from('drafts')
      .select('run_id, reviewer_action, validation_status, claims, mode')
      .in('run_id', runIds),
    supabase
      .from('run_stages')
      .select('run_id, stage_name, output')
      .in('run_id', runIds)
      .in('stage_name', OUTPUT_STAGES),
    // Only the two columns needed for provider attribution, never page content.
    // PostgREST caps this at 1,000 rows; the cap is reported rather than papered
    // over, and no extra query is spent widening it for a presentational number.
    supabase.from('sources').select('providers, fetch_status').in('run_id', runIds),
    supabase
      .from('contact_candidates')
      .select('run_id, identity_status, selected_at, created_at')
      .in('run_id', runIds),
  ]);

  for (const r of [stages, signals, drafts, outputs, sources]) {
    if (r.error) throw r.error;
  }
  // contact_candidates is read separately: until migration 011 is applied the
  // table does not exist, and the dashboard's five other panels must not go
  // down because of it. An empty list is the correct reading either way —
  // "no candidates" and "no table yet" look identical to every metric here.
  const contactCandidateRows = contactCandidates.error ? [] : (contactCandidates.data ?? []);

  const proposals: SignalProposal[] = [];
  const hooks: HookOutcome[] = [];
  for (const row of (outputs.data ?? []) as { run_id: string; stage_name: string; output: unknown }[]) {
    const o = row.output;
    if (!o || typeof o !== 'object') continue;
    const out = o as Record<string, unknown>;

    if (row.stage_name === 'evaluate_signals') {
      proposals.push({
        run_id: row.run_id,
        ranked: Array.isArray(out.ranked) ? out.ranked.length : 0,
        rejected: Array.isArray(out.rejected) ? out.rejected.length : 0,
      });
    } else if (row.stage_name === 'select_hook') {
      hooks.push({
        run_id: row.run_id,
        selected: Boolean(out.selected),
        insufficient_evidence: out.insufficient_evidence === true,
        rejected_candidates: Array.isArray(out.rejected_candidates) ? out.rejected_candidates.length : 0,
      });
    }
  }

  // Sources are the largest table; reduce to counts immediately.
  const sourceProviders: Record<string, number> = {};
  const sourceFetchStatus: Record<string, number> = {};
  const sourceRows = (sources.data ?? []) as { providers: string[] | null; fetch_status: string | null }[];
  for (const s of sourceRows) {
    for (const p of s.providers ?? []) sourceProviders[p] = (sourceProviders[p] ?? 0) + 1;
    const f = s.fetch_status ?? 'unknown';
    sourceFetchStatus[f] = (sourceFetchStatus[f] ?? 0) + 1;
  }

  return {
    prospects: prospectData ?? [],
    runs,
    stages: (stages.data ?? []) as Pick<RunStageRow, 'run_id' | 'stage_name' | 'status' | 'duration_ms'>[],
    signals: (signals.data ?? []) as Pick<
      SignalRow,
      'run_id' | 'selected_as_hook' | 'supporting_quote' | 'composite_score' | 'category'
    >[],
    drafts: (drafts.data ?? []) as Pick<
      DraftRow,
      'run_id' | 'reviewer_action' | 'validation_status' | 'claims' | 'mode'
    >[],
    proposals,
    hooks,
    sourceProviders,
    sourceFetchStatus,
    // At the cap we cannot tell "exactly 1,000 sources" from "the first 1,000",
    // so the honest reading is: assume sampled.
    sourcesSampled: sourceRows.length >= POSTGREST_PAGE_CAP,
    sourcesCounted: sourceRows.length,
    contactCandidates: contactCandidateRows as {
      run_id: string;
      identity_status: string;
      selected_at: string | null;
      created_at: string;
    }[],
  };
}
