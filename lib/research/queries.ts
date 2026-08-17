// Query planning. Every query is derived from the actual input — nothing here
// is keyed to a known prospect, and no result is assumed.

import type { QueryCategory, SearchQuery } from '@/lib/search/types';

export interface QuerySeed {
  /** Name we believe the prospect has; may be a slug-derived guess. */
  name: string | null;
  slug: string;
  company: string | null;
  title: string | null;
}

export function quoted(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}

/**
 * Round 1 — establish WHO this is. Cheap, few queries, no assumptions about
 * the company beyond what the user supplied.
 */
export function identityQueries(seed: QuerySeed): SearchQuery[] {
  const queries: SearchQuery[] = [];
  const { name, slug, company, title } = seed;

  // The profile URL itself is public and indexed; searching for it is the most
  // reliable way to attach a name/employer to the slug without touching LinkedIn.
  queries.push({
    query: `linkedin.com/in/${slug}`,
    category: 'prospect_identity',
  });

  if (name) {
    queries.push({
      query: company ? `${quoted(name)} ${quoted(company)}` : `${quoted(name)} linkedin profile`,
      category: company ? 'prospect_company' : 'prospect_identity',
    });

    if (title && company) {
      queries.push({ query: `${quoted(name)} ${title} ${company}`, category: 'prospect_company' });
    }
  }

  if (company && !name) {
    queries.push({ query: `${quoted(company)} leadership team`, category: 'prospect_company' });
  }

  return queries;
}

/**
 * Round 2 — now that identity is resolved, research the person and company for
 * outreach-worthy signals. Categories map to the signal types worth finding.
 */
export function signalQueries(name: string | null, company: string | null): SearchQuery[] {
  const queries: SearchQuery[] = [];

  if (name) {
    queries.push({
      query: company ? `${quoted(name)} ${quoted(company)} interview OR announcement OR appointed` : `${quoted(name)} interview`,
      category: 'prospect_activity',
      recent_only: true,
    });
  }

  if (company) {
    const c = quoted(company);
    queries.push(
      { query: `${c} news`, category: 'company_news', recent_only: true },
      { query: `${c} funding round raised investment`, category: 'company_funding', recent_only: true },
      { query: `${c} hiring expansion new office`, category: 'company_hiring' },
      { query: `${c} launches new product`, category: 'company_product', recent_only: true },
      { query: `${c} partnership acquisition strategy`, category: 'company_strategy', recent_only: true },
    );
  }

  return queries;
}

/**
 * Enrichment queries built from retrieved LinkedIn profile data.
 *
 * These exist because the profile gives us facts search alone would not: the
 * exact employer, the exact title, prior companies. Enrichment looks for public
 * commentary ABOUT those facts — it never tries to re-derive the profile.
 */
export function profileEnrichmentQueries(profile: {
  name: string | null;
  currentCompany: { name: string | null; title: string | null } | null;
  experience: { company: string | null }[];
}): SearchQuery[] {
  const queries: SearchQuery[] = [];
  const name = profile.name;
  const company = profile.currentCompany?.name ?? null;
  const title = profile.currentCompany?.title ?? null;

  if (!name) return queries;

  if (company) {
    queries.push({
      query: `${quoted(name)} ${quoted(company)} interview OR keynote OR announcement`,
      category: 'prospect_activity',
      recent_only: true,
    });
    if (title) {
      queries.push({
        query: `${quoted(name)} ${title} ${quoted(company)}`,
        category: 'prospect_company',
      });
    }
  } else {
    queries.push({ query: `${quoted(name)} interview OR talk OR article`, category: 'prospect_activity', recent_only: true });
  }

  // A previous employer often explains what the prospect was hired to do next.
  const previous = profile.experience
    .map((e) => e.company)
    .filter((c): c is string => Boolean(c) && c !== company)[0];
  if (previous && name) {
    queries.push({ query: `${quoted(name)} ${quoted(previous)}`, category: 'prospect_identity' });
  }

  return queries;
}

/**
 * Employer-discovery queries, used when the profile provider gave us a person
 * but no company. These look for who someone works for, so company research is
 * not blocked by a partial profile.
 */
export function employerDiscoveryQueries(name: string): SearchQuery[] {
  return [
    { query: `${quoted(name)} company OR employer OR "works at"`, category: 'prospect_company' },
    { query: `${quoted(name)} title OR role OR appointed`, category: 'prospect_identity', recent_only: true },
  ];
}

/**
 * Round 3 — targeted follow-ups on entities the model actually saw in round 2
 * (a named funding round, a product, an initiative). Capped to keep cost bounded.
 */
export function followUpQueries(
  entities: string[],
  company: string | null,
  limit = 3,
): SearchQuery[] {
  const seen = new Set<string>();
  const queries: SearchQuery[] = [];

  for (const entity of entities) {
    const cleaned = entity.trim();
    if (cleaned.length < 3) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    queries.push({
      query: company ? `${quoted(company)} ${cleaned}` : cleaned,
      category: 'followup' as QueryCategory,
      recent_only: true,
    });

    if (queries.length >= limit) break;
  }

  return queries;
}
