-- Migration 002 — real research pipeline.
--
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--
-- WHAT THIS DOES TO EXISTING DATA:
-- The previous tables only ever held stub-mode output (fabricated prospects,
-- fabricated signals, fabricated drafts). Stub mode is gone, and run history
-- must contain only real runs, so this migration drops those tables and their
-- contents and recreates them with the real schema. If you want the old rows,
-- export them before running this.

begin;

drop table if exists drafts cascade;
drop table if exists signals cascade;
drop table if exists sources cascade;
drop table if exists run_stages cascade;
drop table if exists runs cascade;

-- ─── runs ────────────────────────────────────────────────────────────────────
create table runs (
  id                     uuid primary key default gen_random_uuid(),

  -- Input. The LinkedIn URL is the primary key of the request.
  linkedin_url           text not null,
  linkedin_slug          text not null,
  input_name             text,
  input_company          text,
  input_title            text,

  -- Resolved identity (filled by the identify stage; may stay null).
  prospect_name          text,
  prospect_title         text,
  company_name           text,
  company_domain         text,
  identity_confidence    integer,

  -- How the LinkedIn page itself was handled: accessible | blocked |
  -- unavailable | not_attempted. Never claim access we did not have.
  linkedin_access_status text,
  linkedin_access_note   text,

  status                 text not null default 'queued',
    -- queued | running | ready_for_review | needs_manual_review
    -- | approved | rejected | failed
  overall_confidence     integer,
  selected_hook          text,
  generated_message      text,
  insufficient_evidence  boolean not null default false,
  error                  text,

  started_at             timestamptz,
  completed_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index runs_created_at_idx on runs (created_at desc);
create index runs_slug_idx on runs (linkedin_slug);

-- ─── run_stages ──────────────────────────────────────────────────────────────
-- One row per stage per run: the execution log the live view renders.
create table run_stages (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references runs (id) on delete cascade,
  stage_name     text not null,
    -- validate_input | identify_prospect | research_prospect | research_company
    -- | collect_signals | evaluate_signals | select_hook | generate_message
    -- | validate_claims | ready_for_review
  stage_order    integer not null,
  status         text not null,
    -- pending | running | complete | degraded | skipped | failed
  summary        text,
  output         jsonb,
  error          text,
  duration_ms    integer,
  started_at     timestamptz,
  completed_at   timestamptz,
  unique (run_id, stage_name)
);
create index run_stages_run_id_idx on run_stages (run_id);

-- ─── sources ─────────────────────────────────────────────────────────────────
-- The deduplicated evidence set behind a run.
create table sources (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references runs (id) on delete cascade,
  url             text not null,
  canonical_url   text not null,
  title           text,
  snippet         text,
  source_type     text,
  credibility     numeric,
  published_date  date,
  retrieved_at    timestamptz not null default now(),
  fetch_status    text,          -- snippet_only | scraped | scrape_failed
  providers       text[],
  found_via       text[],        -- query categories that surfaced it
  duplicate_count integer not null default 0
);
create index sources_run_id_idx on sources (run_id);

-- ─── signals ─────────────────────────────────────────────────────────────────
create table signals (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references runs (id) on delete cascade,
  signal              text not null,
  why_it_matters      text,
  category            text,
  source_url          text not null,
  source_title        text,
  source_type         text,
  published_date      date,
  supporting_quote    text,
  relevance_score     integer,
  specificity_score   integer,
  recency_score       integer,
  confidence_score    integer,
  credibility_score   integer,
  corroboration_count integer not null default 0,
  composite_score     integer,
  conflicts_with      text,
  selected_as_hook    boolean not null default false,
  retrieved_at        timestamptz not null default now()
);
create index signals_run_id_idx on signals (run_id);
create index signals_composite_idx on signals (run_id, composite_score desc);

-- ─── drafts ──────────────────────────────────────────────────────────────────
create table drafts (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references runs (id) on delete cascade,
  hook_signal_id    uuid references signals (id) on delete set null,
  mode              text not null default 'personalized', -- personalized | conservative
  subject           text,
  message_text      text not null,          -- the draft as written
  final_text        text,                   -- after claim validation
  personalization_basis text,
  reasoning         text,
  claims            jsonb,                  -- [{claim, verdict, evidence_url, explanation}]
  validation_status text,                   -- pass | revised | flagged
  validation_notes  text,
  sensitivity_note  text,
  confidence        integer,
  information_requests jsonb,
  reviewer_action   text,                   -- approved | edited | rejected
  edited_text       text,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now()
);
create index drafts_run_id_idx on drafts (run_id);

-- Live view subscribes to stage changes and run status.
alter publication supabase_realtime add table run_stages;
alter publication supabase_realtime add table runs;

commit;
