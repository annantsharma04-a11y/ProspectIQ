-- Migration 006 — target qualification.
--
-- Additive. Stores whether the person and company were judged relevant enough
-- to contact, decided before any outreach is generated. Two new stage names
-- (qualify_prospect, qualify_company) need no DDL: run_stages.stage_name is
-- plain text with no constraint.

begin;

alter table runs
  add column if not exists qualification        jsonb,
  add column if not exists qualification_status text,
  add column if not exists overall_fit          integer;

comment on column runs.qualification is
  'Full TargetQualification: prospect fit, company fit, capability matches and the combined decision.';
comment on column runs.qualification_status is
  'QUALIFIED | BORDERLINE | NOT_QUALIFIED. Only QUALIFIED proceeds to hook selection and message generation.';

create index if not exists runs_qualification_idx on runs (qualification_status);

commit;
