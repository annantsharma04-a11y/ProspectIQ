-- Migration 007 — per-run sender identity.
--
-- The sender name was deployment-wide configuration (SENDER_NAME). Capturing it
-- per run lets whoever is actually sending sign their own outreach, while the
-- environment value stays as the fallback.

begin;

alter table runs
  add column if not exists sender_name text;

comment on column runs.sender_name is
  'Name the requester gave for this run''s signature. Falls back to SENDER_NAME, then the team signature.';

commit;
