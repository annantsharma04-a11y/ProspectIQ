// Prospect contracts and the pure logic that decides prospect identity.
//
// A prospect is the CURRENT known state of a person. A run is what ProspectIQ
// knew at one moment. Keeping those two ideas apart is the whole point of this
// module: nothing here ever rewrites a run.

import { parseLinkedInUrl } from '@/lib/linkedin/url';
import type { RunRow } from '@/lib/types';

export interface ProspectRow {
  id: string;
  user_id: string;
  /** Canonical /in/ slug — the deduplication key, unique per user. */
  linkedin_slug: string;
  linkedin_url: string;
  name: string | null;
  current_job_role: string | null;
  current_company: string | null;
  company_domain: string | null;
  created_at: string;
  updated_at: string;
  /** When research last completed. Null until a run finishes. */
  last_researched_at: string | null;
}

/** prospects + run rollup, served by the `prospect_overview` view in one query. */
export interface ProspectOverviewRow extends ProspectRow {
  run_count: number;
  latest_run_id: string | null;
  latest_run_status: string | null;
  latest_qualification_status: string | null;
  latest_confidence: number | null;
  latest_insufficient_evidence: boolean | null;
  latest_run_at: string | null;
}

export interface ProspectKey {
  slug: string;
  normalized_url: string;
}

export type ProspectKeyResult = { ok: true; key: ProspectKey } | { ok: false; error: string };

/**
 * The deduplication key for a submitted LinkedIn URL.
 *
 * This delegates to the existing parseLinkedInUrl rather than re-implementing
 * normalization, so the prospect key and the run's stored slug can never drift
 * apart. That canonical form already folds away scheme, `www.`, country
 * subdomains, trailing slashes, query strings and case, which is what makes
 *
 *   https://www.linkedin.com/in/john-doe
 *   https://linkedin.com/in/john-doe/
 *   https://www.linkedin.com/in/john-doe/?trk=profile
 *
 * resolve to one prospect.
 *
 * Names are deliberately not part of the key. Two different people share a name
 * far more often than they share a LinkedIn slug, and a run's name is derived
 * from research that may not have happened yet.
 */
export function prospectKeyFromUrl(raw: string | null | undefined): ProspectKeyResult {
  const parsed = parseLinkedInUrl(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, key: { slug: parsed.slug, normalized_url: parsed.normalized_url } };
}

/** Do two LinkedIn URLs refer to the same prospect? */
export function sameProspect(a: string, b: string): boolean {
  const ka = prospectKeyFromUrl(a);
  const kb = prospectKeyFromUrl(b);
  return ka.ok && kb.ok && ka.key.slug === kb.key.slug;
}

/**
 * The identity fields a completed run contributes back to its prospect.
 *
 * Only non-null values are returned: a run that failed before it learned the
 * company must not erase a company an earlier run established. This is what
 * keeps the prospect "latest KNOWN state" rather than "latest run's state".
 */
export function identityPatchFromRun(run: RunRow): Partial<ProspectRow> {
  const patch: Partial<ProspectRow> = {};
  if (run.prospect_name) patch.name = run.prospect_name;
  if (run.prospect_title) patch.current_job_role = run.prospect_title;
  if (run.company_name) patch.current_company = run.company_name;
  if (run.company_domain) patch.company_domain = run.company_domain;
  return patch;
}

/** A run counts as "research completed" only once it reaches a terminal state. */
const RESEARCHED_STATUSES = new Set([
  'ready_for_review',
  'needs_manual_review',
  'approved',
  'rejected',
]);

export function countsAsResearched(run: RunRow): boolean {
  return RESEARCHED_STATUSES.has(run.status);
}

/** "7 days ago" — for the re-research prompt. Null when never researched. */
export function daysSince(iso: string | null | undefined, now = new Date()): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}
