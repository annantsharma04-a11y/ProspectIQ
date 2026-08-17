-- Migration 009 — run ownership and row-level security.
--
-- Two problems this closes:
--
--   1. Runs had no owner, so any caller who knew (or guessed) a run id could
--      read or mutate it through the API.
--   2. RLS was disabled on every table. The anon key is embedded in the browser
--      bundle and is therefore public, so anyone could read — and write — every
--      prospect, message and piece of research directly through PostgREST,
--      bypassing the application entirely.
--
-- ADDITIVE AND NON-DESTRUCTIVE. No table is dropped, no row is deleted, no
-- column is removed. Existing runs keep all their data and simply have a null
-- owner: they remain fully readable by the service-role pipeline, and are not
-- visible to signed-in users until claimed. See the claim helper at the bottom.

begin;

-- ─── ownership ───────────────────────────────────────────────────────────────

alter table runs
  add column if not exists user_id uuid references auth.users (id) on delete cascade;

comment on column runs.user_id is
  'Owner of this run (Supabase Auth user). Null for runs created before ownership existed; those are visible only to the service role until claimed.';

create index if not exists runs_user_id_idx on runs (user_id);

-- ─── row level security ──────────────────────────────────────────────────────
--
-- The service-role key bypasses RLS by design, so the pipeline keeps working
-- unchanged. These policies constrain the anon/authenticated keys — the ones
-- that reach the browser.

alter table runs       enable row level security;
alter table run_stages enable row level security;
alter table signals    enable row level security;
alter table sources    enable row level security;
alter table drafts     enable row level security;

-- runs: a user sees and mutates only their own.
drop policy if exists runs_select_own on runs;
create policy runs_select_own on runs
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists runs_insert_own on runs;
create policy runs_insert_own on runs
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists runs_update_own on runs;
create policy runs_update_own on runs
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists runs_delete_own on runs;
create policy runs_delete_own on runs
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- Child tables inherit ownership through their run. Read-only for the browser:
-- every write happens server-side through the service-role pipeline.
drop policy if exists run_stages_select_own on run_stages;
create policy run_stages_select_own on run_stages
  for select to authenticated
  using (exists (
    select 1 from runs r where r.id = run_stages.run_id and r.user_id = (select auth.uid())
  ));

drop policy if exists signals_select_own on signals;
create policy signals_select_own on signals
  for select to authenticated
  using (exists (
    select 1 from runs r where r.id = signals.run_id and r.user_id = (select auth.uid())
  ));

drop policy if exists sources_select_own on sources;
create policy sources_select_own on sources
  for select to authenticated
  using (exists (
    select 1 from runs r where r.id = sources.run_id and r.user_id = (select auth.uid())
  ));

drop policy if exists drafts_select_own on drafts;
create policy drafts_select_own on drafts
  for select to authenticated
  using (exists (
    select 1 from runs r where r.id = drafts.run_id and r.user_id = (select auth.uid())
  ));

-- No policy is granted to the `anon` role anywhere. With RLS enabled and no
-- permissive policy, an unauthenticated key reads nothing and writes nothing.

-- ─── claiming pre-ownership runs ─────────────────────────────────────────────
--
-- Existing runs are preserved with a null owner. This lets an operator adopt
-- them deliberately, rather than the migration guessing who they belong to.
-- Run manually when you know which account should own the historical data:
--
--   select claim_orphan_runs('<auth-user-uuid>');

create or replace function claim_orphan_runs(new_owner uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed integer;
begin
  update runs set user_id = new_owner where user_id is null;
  get diagnostics claimed = row_count;
  return claimed;
end;
$$;

revoke all on function claim_orphan_runs(uuid) from public, anon, authenticated;

commit;
