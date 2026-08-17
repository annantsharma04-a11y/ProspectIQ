-- Migration 008 — identity verification before qualification.
--
-- Additive. A name match is not an identity: several people share a name, and
-- the profile provider is one evidence source. These columns record who the run
-- decided the prospect is, how sure it was, whether a human confirmed it, and
-- the full candidate list so the decision stays auditable.

begin;

alter table runs
  add column if not exists identity_status       text,
  add column if not exists identity_resolution   text,
  add column if not exists identity_verification jsonb;

comment on column runs.identity_status is
  'VERIFIED | PARTIAL | AMBIGUOUS | FAILED. Only VERIFIED may proceed to qualification.';
comment on column runs.identity_resolution is
  'AUTOMATIC | USER_CONFIRMED — how the identity was settled.';
comment on column runs.identity_verification is
  'Full IdentityVerification: candidates, conflicts, resolved identity and evidence.';

create index if not exists runs_identity_status_idx on runs (identity_status);

commit;
