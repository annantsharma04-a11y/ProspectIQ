-- Migration 005 — persist extracted page content.
--
-- Retries previously rehydrated sources at snippet level only, because the
-- scraped page body lived in memory. Storing it means a retry reuses the
-- evidence that was already paid for instead of silently downgrading it.

begin;

alter table sources
  add column if not exists content       text,
  add column if not exists content_chars integer;

comment on column sources.content is
  'Extracted page text when the page was retrieved (evidence level FULL). Null for snippet-only sources.';

commit;
