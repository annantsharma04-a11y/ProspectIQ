-- Migration 004 — resilience to AI-provider quota failures.
--
-- Additive only. When Bright Data and the web research succeed but the model
-- call fails (quota, rate limit, outage), the run is parked as
-- 'ai_analysis_pending' with the collected data intact, and only the analysis
-- is retried later. `runs.status` is plain text with no CHECK constraint, so the
-- new status needs no type change — this migration adds the error column that
-- drives the retry affordance in the UI.

begin;

alter table runs
  add column if not exists ai_error_type text;

comment on column runs.ai_error_type is
  'LLMErrorType (quota_exhausted | rate_limited | model_unavailable | authentication_error | invalid_request | provider_error) when AI analysis failed. Null once analysis succeeds.';

create index if not exists runs_status_idx on runs (status);

commit;
