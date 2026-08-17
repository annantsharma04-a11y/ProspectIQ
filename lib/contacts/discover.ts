// Contact candidate discovery — "who else at this company owns the workflow
// that qualified it?"
//
// Runs only when a run's OWN qualification result already says the company is
// a plausible fit but the submitted person is not (see shouldDiscoverContacts
// below — the exact condition combineQualification already flags via
// `suggestion`). It costs one bounded round of search queries, reusing the
// existing provider abstraction, plus ONE structured model call to read named
// people out of the retrieved pages. The model call is a PROPOSAL only:
// nothing it returns is trusted until lib/contacts/rank.ts independently
// verifies the quote against retrieved source text, exactly like a hook.

import { quoted } from '@/lib/research/queries';
import { research } from '@/lib/research/engine';
import { callStructured } from '@/lib/llm/gemini';
import { renderSources } from '@/lib/llm/analyze';
import { parseLinkedInUrl } from '@/lib/linkedin/url';
import type { JsonSchema } from '@/lib/llm/types';
import type { NormalizedSource } from '@/lib/research/normalize';
import type { SearchQuery } from '@/lib/search/types';
import { rolesForWorkflows } from './roles';
import { MAX_CANDIDATES, type ProposedCandidate } from './rank';
import { findLinkedInUrlForCandidate } from './linkedin-lookup';

/** Deterministic queries for the functional-owner roles a qualified workflow implies. */
export function contactDiscoveryQueries(company: string, roles: string[]): SearchQuery[] {
  const c = quoted(company);
  return roles.map((role) => ({
    query: `${c} ${quoted(role)}`,
    category: 'contact_discovery' as const,
  }));
}

/**
 * Targeted follow-up queries, one per named candidate still missing a URL.
 *
 * The role-title queries above search for a FUNCTION ("PRISM" "Global COO"),
 * which is exactly why they never surface a specific person's own profile
 * page — especially for a common company name, where role queries return
 * mostly noise about unrelated companies that happen to share it. Once a
 * name has been extracted, searching for THAT PERSON specifically is a
 * different, much more precise query — the same escalation
 * verifyIdentityStage and the /select route already make once a candidate is
 * named, applied one step earlier.
 */
export function contactLinkedInLookupQueries(company: string, names: string[]): SearchQuery[] {
  const c = quoted(company);
  return names.map((name) => ({
    query: `${quoted(name)} ${c}`,
    category: 'contact_discovery' as const,
  }));
}

export interface DiscoverContactsInput {
  company: string;
  /** Qualified-workflow text the roles were derived from — carried through for the stored `reason`. */
  workflowSignals: string[];
  /** Already-gathered company research; new queries are merged into this, never replacing it. */
  existingSources: NormalizedSource[];
  companyDomains: string[];
}

export interface DiscoverContactsResult {
  proposed: ProposedCandidate[];
  sources: NormalizedSource[];
  roles: string[];
  queriesRun: number;
  queriesOk: number;
}

const SYSTEM = `You read public sources about a company and report named people who hold a
specific set of job titles there.

You are given a company name, a short list of target job titles (already
determined from the workflow that made this company worth contacting — you do
not choose the titles), and public sources gathered by searching for those
titles at that company.

WHAT TO REPORT
  candidates — every named person the sources show currently holding one of the
    target titles (or a title that is clearly the same function under a
    different name, e.g. "Head of Finance" for a "VP Finance" search) at this
    company. For each: name, their actual current title as the source states
    it, a linkedin_url ONLY if a source shows one, a verbatim quote from a
    supplied source establishing the person and the role, and the URL of that
    source.

RULES
  - Only report a person a supplied source actually names in this role at this
    company. Do not infer that a title must be filled by someone.
  - The quote must be copied verbatim from the supplied sources. If you cannot
    quote it, do not report the person. Quotes are checked mechanically.
  - Never invent a LinkedIn URL. Omit it if no source gives one.
  - A former holder of the role, or a person at a different company, is not a
    match — do not report them.
  - Do not rank or select. List everyone the sources support; the caller decides.
  - An empty list is the correct answer when no source names anyone in these roles.`;

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          linkedin_url: { type: 'string', nullable: true },
          quote: { type: 'string' },
          source_url: { type: 'string' },
        },
        required: ['name', 'role', 'quote', 'source_url'],
      },
    },
  },
  required: ['candidates'],
};

/**
 * Search for the qualified role titles, then extract named candidates from
 * whatever pages that turns up. Returns PROPOSALS — rank.ts verifies each
 * quote before anything becomes a persisted candidate.
 */
export async function discoverContacts(input: DiscoverContactsInput): Promise<DiscoverContactsResult> {
  const roles = rolesForWorkflows(input.workflowSignals);

  if (roles.length === 0) {
    // No workflow in this qualification maps to a known functional owner.
    // Guessing generic seniority here is exactly what this feature must not do.
    return { proposed: [], sources: input.existingSources, roles: [], queriesRun: 0, queriesOk: 0 };
  }

  const queries = contactDiscoveryQueries(input.company, roles);
  const result = await research('find_contact_candidates', queries, input.companyDomains, input.existingSources);

  if (result.all_failed || result.sources.length === 0) {
    return {
      proposed: [],
      sources: result.sources,
      roles,
      queriesRun: result.round.queries_run,
      queriesOk: result.round.queries_ok,
    };
  }

  const prompt = `Company: ${input.company}
Target job titles: ${roles.join(', ')}

PUBLIC SOURCES
${renderSources(result.sources, 3000)}

List named people the sources show currently holding one of the target titles at this company.`;

  const { data } = await callStructured<{
    candidates: { name: string; role: string; linkedin_url?: string | null; quote: string; source_url: string }[];
  }>({
    purpose: 'discover_contact_candidates',
    system: SYSTEM,
    input: prompt,
    schema: SCHEMA,
    timeoutMs: 90_000,
  });

  const proposed: ProposedCandidate[] = (data.candidates ?? [])
    .filter((c) => c.name && c.role && c.quote && c.source_url)
    .map((c) => ({
      name: c.name.trim(),
      role: c.role.trim(),
      // Normalized through the SAME LinkedIn URL logic every submitted URL in
      // the app goes through. A model-reported URL that is not actually a
      // valid personal profile link (a company page, a malformed string) is
      // dropped rather than persisted as-is — it becomes a candidate for the
      // lookup below instead of a silently-wrong stored value.
      linkedin_url: normalizeLinkedInUrl(c.linkedin_url),
      quote: c.quote,
      sourceUrl: c.source_url,
    }));

  let sources = result.sources;
  let lookupQueriesRun = 0;
  let lookupQueriesOk = 0;

  // One targeted, name-specific search per still-unresolved candidate — see
  // contactLinkedInLookupQueries for why the role-based search above misses
  // these. Capped at MAX_CANDIDATES: this only runs for the rare state this
  // whole stage is already scoped to, and never grows unbounded even if the
  // model proposed many names.
  const namesNeedingLookup = [
    ...new Set(proposed.filter((c) => !c.linkedin_url).map((c) => c.name)),
  ].slice(0, MAX_CANDIDATES);

  if (namesNeedingLookup.length > 0) {
    const lookupQueries = contactLinkedInLookupQueries(input.company, namesNeedingLookup);
    const lookup = await research('find_contact_candidates_linkedin_lookup', lookupQueries, input.companyDomains, sources);
    lookupQueriesRun = lookup.round.queries_run;
    lookupQueriesOk = lookup.round.queries_ok;
    if (!lookup.all_failed) sources = lookup.sources;
  }

  const resolved = proposed.map((c) =>
    c.linkedin_url ? c : { ...c, linkedin_url: findLinkedInUrlForCandidate(c.name, sources) },
  );

  return {
    proposed: resolved,
    sources,
    roles,
    queriesRun: result.round.queries_run + lookupQueriesRun,
    queriesOk: result.round.queries_ok + lookupQueriesOk,
  };
}

/** Only a genuinely valid, normalized profile URL is ever persisted — never the raw model string. */
function normalizeLinkedInUrl(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const parsed = parseLinkedInUrl(raw);
  return parsed.ok ? parsed.normalized_url : null;
}
