-- Migration 003 — LinkedIn profile provider (Bright Data).
--
-- Additive only: stores the retrieved profile and its attribution alongside the
-- existing run record, so the UI can state exactly where profile data came from
-- and whether direct retrieval succeeded.

begin;

alter table runs
  add column if not exists linkedin_profile jsonb,   -- normalized LinkedInProfile
  add column if not exists profile_access   jsonb,   -- {directLinkedIn, primarySource, profileCompleteness, reason}
  add column if not exists profile_source   text;    -- 'brightdata' when retrieved directly

comment on column runs.linkedin_profile is
  'Normalized LinkedIn profile as returned by the profile provider. Null when direct retrieval failed.';
comment on column runs.profile_access is
  'Provenance for the profile: which source was primary and how complete the data is.';

commit;
