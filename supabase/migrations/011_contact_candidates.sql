-- Migration 011 — contact candidate discovery.
--
-- New capability: when a company qualifies but the submitted person does not
-- own the relevant workflow, ProspectIQ can propose OTHER people at the same
-- company who plausibly do. This adds one table and one linking column.
--
--   runs (qualified company, weak prospect)
--     └── contact_candidates (proposed, never auto-selected)
--           └── selection → a NEW prospect + a NEW run (via runs.origin_contact_candidate_id)
--
-- The originating run is NEVER mutated by this migration or by the feature it
-- supports. A selected candidate starts its own prospect and its own run; the
-- run that discovered them keeps its own history exactly as it was.
--
-- ADDITIVE AND NON-DESTRUCTIVE. No table is dropped, no row is deleted, no
-- existing column is altered.

begin;

-- ─── contact_candidates ────────────────────────────────────────────────────

create table if not exists contact_candidates (
  id uuid primary key default gen_random_uuid(),

  -- Owned through the run that discovered them, exactly like signals, sources
  -- and drafts. No separate user_id: ownership is never duplicated onto a
  -- child row when it can be derived through its parent.
  run_id uuid not null references runs (id) on delete cascade,

  -- What the discovery stage proposed. Never a fact until independently
  -- verified — see identity_status below.
  name text,
  role text,
  company text,
  linkedin_url text,

  -- Why this person was suggested, and what backs it. `reason` is the
  -- functional-ownership rationale (e.g. "role matches the qualified accounts
  -- payable workflow"); `evidence` is the supporting source and, where the
  -- model quoted one, the verbatim quote — verified against retrieved source
  -- text the same way an outreach hook is, before this row is ever written.
  reason text not null,
  evidence jsonb not null default '[]'::jsonb,

  -- Deterministic ranking score at discovery time (see lib/contacts/rank.ts).
  -- Stored so the UI can show why this order was chosen without recomputing it.
  confidence integer not null default 0,
  rank_score numeric not null default 0,

  -- DISCOVERED: proposed, unverified. PARTIAL/VERIFIED/AMBIGUOUS/FAILED: the
  -- outcome of independent identity verification, run only after a human
  -- selects this candidate. REJECTED: a human looked and declined.
  identity_status text not null default 'DISCOVERED'
    check (identity_status in ('DISCOVERED', 'PARTIAL', 'VERIFIED', 'AMBIGUOUS', 'FAILED', 'REJECTED')),
  -- Full verification result, once it has run. Same shape the run-level
  -- identity_verification column already carries.
  identity_verification jsonb,

  -- When a human selected this candidate, and what it produced. Selecting a
  -- candidate creates a NEW run for a NEW (or reused) prospect; it is recorded
  -- here rather than by rewriting anything on the discovering run.
  selected_at timestamptz,
  resulting_run_id uuid references runs (id) on delete set null,

  created_at timestamptz not null default now()
);

comment on table contact_candidates is
  'People proposed as alternative contacts at a qualified company whose submitted prospect did not qualify. Proposed only — selecting one is a human action, and verifying one reuses the existing identity-verification system.';
comment on column contact_candidates.identity_status is
  'DISCOVERED (proposed, unverified) | PARTIAL | VERIFIED | AMBIGUOUS | FAILED (post-selection verification outcomes) | REJECTED (a human declined this candidate). Only VERIFIED may produce a research run.';

create index if not exists contact_candidates_run_id_idx on contact_candidates (run_id);

-- ─── runs: where a selected candidate's run came from ──────────────────────

alter table runs
  add column if not exists origin_contact_candidate_id uuid references contact_candidates (id) on delete set null;

comment on column runs.origin_contact_candidate_id is
  'Set when this run exists because a human selected this person as an alternative contact discovered on another run. Null for every ordinary run.';

create index if not exists runs_origin_contact_candidate_idx on runs (origin_contact_candidate_id);

-- ─── row level security ─────────────────────────────────────────────────────
--
-- Same shape as run_stages/signals/sources/drafts in migration 009: ownership
-- is derived through the parent run, read-only for the browser, and no policy
-- is granted to `anon`.

alter table contact_candidates enable row level security;

drop policy if exists contact_candidates_select_own on contact_candidates;
create policy contact_candidates_select_own on contact_candidates
  for select to authenticated
  using (exists (
    select 1 from runs r where r.id = contact_candidates.run_id and r.user_id = (select auth.uid())
  ));

commit;
