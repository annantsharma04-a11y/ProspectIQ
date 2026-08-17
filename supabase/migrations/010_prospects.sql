-- Migration 010 — persistent prospects.
--
-- Until now a run was the only durable object, so researching the same person
-- twice produced two unrelated rows and the app had no way to say "this is the
-- same human, researched again". This adds the missing entity:
--
--   auth.users → prospects → runs → (run_stages, signals, sources, drafts)
--
-- A prospect is the CURRENT known state of a person. A run stays exactly what it
-- was: an immutable snapshot of what ProspectIQ knew at one point in time. No
-- run column is dropped, rewritten or recomputed by this migration.
--
-- ADDITIVE AND NON-DESTRUCTIVE. No table is dropped, no row is deleted.

begin;

-- ─── prospects ───────────────────────────────────────────────────────────────

create table if not exists prospects (
  id uuid primary key default gen_random_uuid(),

  -- Every prospect belongs to exactly one account. There is deliberately no
  -- global/shared prospect: two users researching the same person each own their
  -- own record and never see each other's research.
  user_id uuid not null references auth.users (id) on delete cascade,

  -- The deduplication key. `linkedin_slug` is already the canonical form
  -- produced by parseLinkedInUrl(): lowercased, query string and trailing slash
  -- stripped, country subdomains folded away. Matching on it is what makes
  -- /in/john-doe, /in/john-doe/ and /in/john-doe/?trk=profile one prospect.
  linkedin_slug text not null,
  linkedin_url  text not null,

  -- Latest known identity, refreshed from each completed run.
  --
  -- `current_job_role` rather than `current_role`: CURRENT_ROLE is a reserved
  -- word in the SQL standard and in PostgreSQL, so the bare form is a syntax
  -- error at parse time. Quoting it would work but would force every future
  -- query, view and tool to quote it too — a permanent trap for one column name.
  name              text,
  current_job_role  text,
  current_company   text,
  company_domain    text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- When research last actually completed for this prospect — distinct from
  -- updated_at, which also moves when identity fields are refreshed.
  last_researched_at timestamptz
);

comment on table prospects is
  'A person, owned by one user, with a stable identity across many runs. Holds the LATEST known state; historical state lives on runs.';
comment on column prospects.linkedin_slug is
  'Canonical LinkedIn /in/ slug from parseLinkedInUrl(). The deduplication key, unique per user.';

-- Per-user uniqueness, NOT global: the same public profile may legitimately be
-- researched by different accounts, and each owns its own prospect record.
create unique index if not exists prospects_user_slug_key
  on prospects (user_id, linkedin_slug);

create index if not exists prospects_user_id_idx on prospects (user_id);
-- History listings order by recency of research, newest first.
create index if not exists prospects_user_last_researched_idx
  on prospects (user_id, last_researched_at desc nulls last);

-- ─── runs → prospects ────────────────────────────────────────────────────────

alter table runs
  add column if not exists prospect_id uuid references prospects (id) on delete cascade;

comment on column runs.prospect_id is
  'The persistent prospect this run researched. Null only for runs that predate prospects and could not be safely associated.';

create index if not exists runs_prospect_id_idx on runs (prospect_id);
-- The prospect detail page reads "this prospect''s runs, newest first".
create index if not exists runs_prospect_created_idx
  on runs (prospect_id, created_at desc);

-- ─── backfill ────────────────────────────────────────────────────────────────
--
-- Existing runs already carry `linkedin_slug` (canonicalized at creation) and,
-- since migration 009, an owner. That is exactly the prospect key, so the
-- association is derived from stored data — nothing is guessed.
--
-- A run with no owner or no slug is LEFT UNASSIGNED rather than attached to an
-- invented prospect. Identity is never fabricated to make a migration tidy.

insert into prospects (user_id, linkedin_slug, linkedin_url, name, current_job_role, current_company, company_domain, created_at, updated_at, last_researched_at)
select
  r.user_id,
  r.linkedin_slug,
  -- Canonical URL for the slug; the stored value is already normalized.
  min(r.linkedin_url)                                            as linkedin_url,
  -- Latest non-null value wins, matching "current known state".
  (array_remove(array_agg(r.prospect_name  order by r.created_at desc), null))[1] as name,
  (array_remove(array_agg(r.prospect_title order by r.created_at desc), null))[1] as current_job_role,
  (array_remove(array_agg(r.company_name   order by r.created_at desc), null))[1] as current_company,
  (array_remove(array_agg(r.company_domain order by r.created_at desc), null))[1] as company_domain,
  min(r.created_at)                                              as created_at,
  max(r.updated_at)                                              as updated_at,
  max(r.completed_at)                                            as last_researched_at
from runs r
where r.user_id is not null
  and coalesce(nullif(trim(r.linkedin_slug), ''), null) is not null
group by r.user_id, r.linkedin_slug
on conflict (user_id, linkedin_slug) do nothing;

update runs r
set prospect_id = p.id
from prospects p
where r.prospect_id is null
  and r.user_id = p.user_id
  and r.linkedin_slug = p.linkedin_slug;

-- ─── prospect overview (one query, no N+1) ───────────────────────────────────
--
-- The history page needs each prospect plus its run rollup. Without this it
-- would be "list prospects, then query runs per prospect". DISTINCT ON gives the
-- latest run per prospect in a single scan.
--
-- security_invoker makes the view respect the CALLER's RLS rather than the
-- view owner's, so it cannot become a way around the policies below.

create or replace view prospect_overview
with (security_invoker = on) as
select
  p.*,
  coalesce(agg.run_count, 0)      as run_count,
  latest.id                       as latest_run_id,
  latest.status                   as latest_run_status,
  latest.qualification_status     as latest_qualification_status,
  latest.overall_confidence       as latest_confidence,
  latest.insufficient_evidence    as latest_insufficient_evidence,
  latest.created_at               as latest_run_at
from prospects p
left join (
  select prospect_id, count(*) as run_count
  from runs
  where prospect_id is not null
  group by prospect_id
) agg on agg.prospect_id = p.id
left join lateral (
  select r.id, r.status, r.qualification_status, r.overall_confidence,
         r.insufficient_evidence, r.created_at
  from runs r
  where r.prospect_id = p.id
  order by r.created_at desc
  limit 1
) latest on true;

comment on view prospect_overview is
  'Prospects with their run rollup (count + latest run) in a single query. security_invoker: RLS is the caller''s, not the owner''s.';

-- ─── row level security ──────────────────────────────────────────────────────
--
-- Same shape as migration 009: the service-role pipeline bypasses RLS by
-- design; these policies constrain the anon/authenticated keys that reach the
-- browser. No policy is granted to `anon`, so an unauthenticated key reads
-- nothing and writes nothing.

alter table prospects enable row level security;

drop policy if exists prospects_select_own on prospects;
create policy prospects_select_own on prospects
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists prospects_insert_own on prospects;
create policy prospects_insert_own on prospects
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists prospects_update_own on prospects;
create policy prospects_update_own on prospects
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists prospects_delete_own on prospects;
create policy prospects_delete_own on prospects
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- runs and the child tables keep the policies from 009: they are still gated on
-- runs.user_id, which remains authoritative. prospect_id is an additional link,
-- never a second, weaker path to the same rows.

commit;
