// Functional-owner role mapping.
//
// "Candidate roles must be generated from the qualified use case, not
// hardcoded into every company." This is that mapping: it reads the workflow
// keywords already present in the run's OWN qualification result — the
// `company_signal` and `capability_name` text on each capability match — and
// resolves them to the job titles that plausibly own that workflow.
//
// Deliberately a lexicon, not a model call: the input is a short, bounded set
// of keywords the qualification stage already produced, and a keyword→role
// table is exactly as auditable as it needs to be. If a workflow doesn't match
// anything here, no roles are guessed for it — that keeps a thin qualification
// result from producing generic "CEO, Founder" suggestions with no functional
// basis, which is the exact failure mode this feature exists to avoid.

/** A workflow area and the titles that typically own it, most senior first. */
interface RoleFamily {
  /**
   * Stable id, set only on families that take part in fallback adjacency
   * (see ADJACENT_FAMILIES). Families with no defensible adjacent owner are
   * deliberately left without one rather than given a speculative link.
   */
  id?: string;
  keywords: RegExp;
  /** Tier 1 — the senior owners. Searched first, and ranked highest. */
  roles: string[];
  /**
   * The WORKFLOW NOUNS this family owns, used to build Tier 2/3 titles.
   *
   * Deliberately nouns rather than three hand-maintained title lists: the
   * seniority ladder is the same everywhere ("Director of X", "X Manager"),
   * so only the function differs per family. Writing the function once keeps
   * the three tiers from drifting apart, and keeps the lexicon auditable.
   */
  functions: string[];
}

const FAMILIES: RoleFamily[] = [
  {
    id: 'accounts_payable',
    keywords: /\b(accounts? payable|invoice|payment (dispute|processing|ops)|vendor payment|expense management|ap automation)\b/i,
    roles: ['CFO', 'VP Finance', 'Controller', 'Head of Accounts Payable', 'Finance Operations Director'],
    functions: ['Accounts Payable', 'Finance Operations', 'Invoice Processing'],
  },
  {
    keywords: /\b(accounts? receivable|billing|collections|revenue operations|revops)\b/i,
    roles: ['CFO', 'VP Finance', 'Revenue Operations Lead', 'Head of Billing', 'Controller'],
    functions: ['Accounts Receivable', 'Billing', 'Collections'],
  },
  {
    // Distinct from the AP family above: AP is about paying out invoices,
    // this is about contesting/defending incoming card and payment disputes
    // — a different function with different owners, even at the same company.
    keywords: /\b(chargebacks?|dispute handling|payment disputes?|payments? risk|dispute resolution|fraud)\b/i,
    roles: ['Head of Payments', 'VP Payments', 'Head of Risk', 'Fraud and Risk Director'],
    functions: ['Payments', 'Risk', 'Fraud Prevention', 'Disputes'],
  },
  {
    id: 'procurement',
    keywords: /\b(procurement|sourcing|vendor management|supply chain)\b/i,
    roles: ['Head of Procurement', 'VP Supply Chain', 'Chief Procurement Officer', 'Sourcing Director'],
    functions: ['Procurement', 'Sourcing', 'Vendor Management'],
  },
  {
    // "platform" is deliberately NOT a bare trigger here: e-commerce/SaaS
    // companies routinely describe themselves as "a platform" in ordinary
    // business language (a marketplace platform, a retail platform) with no
    // engineering-function content at all — that generic usage is what let
    // a chargebacks/payments company_signal ("an online retail platform...")
    // pull VP Engineering into an AP/payments discovery search. The other
    // five words are near-exclusively technical-team vocabulary and are not
    // similarly ambiguous.
    keywords: /\b(engineering|infrastructure|devops|reliability|sre)\b/i,
    roles: ['VP Engineering', 'CTO', 'Head of Infrastructure', 'Engineering Director'],
    functions: ['Engineering', 'Infrastructure', 'Platform'],
  },
  {
    keywords: /\b(data (pipeline|infrastructure|platform)|analytics engineering|data engineering)\b/i,
    roles: ['Head of Data', 'VP Data', 'Data Platform Lead', 'Chief Data Officer'],
    functions: ['Data', 'Data Platform', 'Analytics'],
  },
  {
    // Cybersecurity, kept separate from regulatory/financial compliance below:
    // a CISO owns infosec, not KYC/AML review or fraud-risk policy, and listing
    // them under both families is what let a security workflow's search list
    // leak into compliance/KYC discovery (the Shravan Koti / Zerodha case).
    keywords: /\bsecurity\b/i,
    roles: ['CISO', 'Head of Security'],
    functions: ['Security', 'Information Security'],
  },
  {
    keywords: /\b(compliance|risk|kyc|aml|fraud)\b/i,
    roles: ['Chief Compliance Officer', 'Head of Risk', 'Head of Trust and Safety'],
    functions: ['Compliance', 'Risk', 'Trust and Safety', 'KYC Operations'],
  },
  {
    keywords: /\b(customer support|customer success|support operations)\b/i,
    roles: ['VP Customer Success', 'Head of Support', 'Customer Operations Director'],
    functions: ['Customer Support', 'Customer Success', 'Support Operations'],
  },
  {
    keywords: /\b(hr|hiring|recruiting|talent|people operations|onboarding)\b/i,
    roles: ['VP People', 'Head of Talent', 'Chief People Officer', 'HR Operations Lead'],
    functions: ['People Operations', 'Talent', 'HR Operations'],
  },
  {
    keywords: /\b(sales operations|sales ops|crm|pipeline management)\b/i,
    roles: ['VP Sales Operations', 'Head of RevOps', 'Sales Operations Director'],
    functions: ['Sales Operations', 'Revenue Operations'],
  },
  {
    keywords: /\b(marketing operations|martech|campaign management)\b/i,
    roles: ['VP Marketing Operations', 'Head of Marketing Ops', 'Marketing Technology Lead'],
    functions: ['Marketing Operations', 'Campaign Operations'],
  },
  {
    keywords: /\b(legal|contract management|regulatory)\b/i,
    roles: ['General Counsel', 'Head of Legal', 'VP Legal'],
    functions: ['Legal', 'Contracts'],
  },
  {
    // "operations" is deliberately NOT a bare trigger here: it is generic
    // business English ("e-commerce operations", "global operations") that
    // says nothing about PHYSICAL logistics/fulfillment/warehouse ownership
    // — the actual function COO/VP Operations own. That genericness is what
    // let an AP-automation company_signal ("large-scale e-commerce
    // operations...") pull the company's COO into an accounts-payable
    // discovery search, purely because the word "operations" appeared in a
    // sentence about something else entirely. "logistics", "fulfillment"
    // and "warehouse" are specific enough on their own to keep meaning what
    // this family is actually for.
    keywords: /\b(logistics|fulfillment|warehouse)\b/i,
    roles: ['COO', 'VP Operations', 'Head of Operations'],
    functions: ['Operations', 'Logistics', 'Fulfillment'],
  },
];

/** Beyond this many role titles the search cost stops being worth it. */
export const MAX_ROLES = 5;

/**
 * Per-level cap for the fallback searches, which only ever run when the
 * primary search produced no ELIGIBLE candidate. Deliberately smaller than
 * MAX_ROLES: a fallback is a second chance, not a second full sweep.
 */
export const MAX_FALLBACK_ROLES = 3;

/**
 * Functions that could plausibly OWN the same verified workflow when its
 * primary owners cannot be found — used only as a fallback, never in the
 * primary search.
 *
 * The bar is ownership, not contact. A family qualifies only if its titles
 * could genuinely be accountable for running the workflow — not merely
 * interact with it, feed it, or receive work from it. Anything weaker widens
 * the search into people who cannot act on the outreach, which is the failure
 * this fallback exists to avoid rather than cause.
 *
 *   accounts_payable ↔ procurement   one purchase-to-pay chain. Procurement
 *                                    owns the vendor relationship and the PO
 *                                    side; at many companies it also owns
 *                                    vendor onboarding and invoice-matching
 *                                    policy, so its leaders are credible
 *                                    owners of the same payables workflow.
 *
 * Two mappings were considered and deliberately rejected:
 *
 *   chargebacks → customer_support   REJECTED. Support receives dispute
 *     contacts and supplies evidence, but representment, network filing and
 *     deadline management are owned by Payments/Risk — titles the chargebacks
 *     family already lists. Support interacts with the workflow; it does not
 *     own it.
 *
 *   compliance → operations          REJECTED. This family's keywords are
 *     logistics/fulfillment/warehouse — it is PHYSICAL operations, not
 *     "compliance operations". Its COO/VP Operations titles do not own
 *     KYC/KYB verification review, and the compliance family already carries
 *     the real owners (Chief Compliance Officer, Head of Trust and Safety).
 *
 * A family with no defensible owner-level neighbour is left out entirely.
 * Level 3 still reaches deeper into its own matched families, so nothing is
 * lost by declining to invent an adjacency here.
 */
const ADJACENT_FAMILIES: Record<string, string[]> = {
  accounts_payable: ['procurement'],
  procurement: ['accounts_payable'],
};

/** Families whose keywords the observed workflow text actually matched. */
function matchingFamilies(signals: string[]): RoleFamily[] {
  return FAMILIES.filter((family) => signals.some((s) => family.keywords.test(s)));
}

/** Case-insensitive membership, so an already-searched title is never repeated. */
function excluding(roles: string[], alreadySearched: string[], limit: number): string[] {
  const seen = new Set(alreadySearched.map((r) => r.toLowerCase()));
  const out: string[] = [];
  for (const role of roles) {
    const key = role.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(role);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * LEVEL 2 — owners of an ADJACENT function for the same observed workflow.
 *
 * Only families listed in ADJACENT_FAMILIES for a family the workflow text
 * actually matched. An unrelated function is never reached this way.
 */
export function adjacentRolesForWorkflows(
  signals: string[],
  alreadySearched: string[] = [],
  limit: number = MAX_FALLBACK_ROLES,
): string[] {
  const matchedIds = new Set(
    matchingFamilies(signals)
      .map((f) => f.id)
      .filter((id): id is string => Boolean(id)),
  );

  const adjacentIds = new Set<string>();
  for (const id of matchedIds) {
    for (const adjacent of ADJACENT_FAMILIES[id] ?? []) {
      // An adjacent family the workflow ALREADY matched is not a fallback —
      // its roles were available to the primary search.
      if (!matchedIds.has(adjacent)) adjacentIds.add(adjacent);
    }
  }

  const roles = FAMILIES.filter((f) => f.id && adjacentIds.has(f.id)).flatMap((f) => f.roles);
  return excluding(roles, alreadySearched, limit);
}

/**
 * Seniority tiers.
 *
 *   1  C-level, VP, Head — the senior decision-makers
 *   2  Director, Senior Director, Senior Manager — strong functional owners
 *   3  Manager, Lead — functional operators
 *
 * The live Myntra run is what this exists for: 45 sources named a Risk
 * Manager, a Senior Manager of Payments, a Director of Engineering and a
 * Fraud Prevention Manager, and discovery proposed exactly ONE person, because
 * the lexicon only ever asked for Head/VP/C-level titles. The sources had the
 * people; the search never named the band they occupy.
 *
 * Widening the BAND is not the same as widening the FUNCTION. Every tier is
 * built from the matched family's own workflow nouns, so a lower tier can only
 * ever reach further down inside a function the workflow actually implicated.
 * An unrelated function is no more reachable at Tier 3 than at Tier 1.
 */
export type SeniorityTier = 1 | 2 | 3;

/** Titles that mark each band, most senior first. Order within a tier is not significant. */
const TIER_MARKERS: Record<SeniorityTier, RegExp> = {
  1: /\b(chief|c[teofi]o|cfo|ciso|coo|cto|cpo|vp|vice president|head of|general counsel|president|founder|partner)\b/i,
  2: /\b(senior director|sr director|director|senior manager|sr manager|principal)\b/i,
  3: /\b(manager|lead|supervisor|specialist)\b/i,
};

/**
 * Which band a title sits in.
 *
 * Read from the TITLE TEXT rather than from which list produced it, so a role
 * the discovery model reports in its own words ("Director Engineering",
 * "Sr. Manager, Payments") is banded correctly even though no list contains
 * that exact string. Tier 1 is tested first so "Head of Engineering" is not
 * mistaken for a Tier 3 "Lead", and an unrecognized title falls to Tier 3 —
 * the conservative end, never the authoritative one.
 */
export function roleTier(title: string): SeniorityTier {
  if (TIER_MARKERS[1].test(title)) return 1;
  if (TIER_MARKERS[2].test(title)) return 2;
  return 3;
}

/** "Director of Payments", "Senior Manager Payments" — the Tier 2 ladder. */
function tier2Titles(fn: string): string[] {
  return [`Director of ${fn}`, `Senior Manager ${fn}`];
}

/** "Payments Manager", "Payments Lead" — the Tier 3 ladder. */
function tier3Titles(fn: string): string[] {
  return [`${fn} Manager`, `${fn} Lead`];
}

function tieredRoles(signals: string[], build: (fn: string) => string[]): string[] {
  return matchingFamilies(signals).flatMap((f) => f.functions.flatMap(build));
}

/**
 * LEVEL 4 — Director / Senior Manager owners inside the SAME matched families.
 *
 * Reached only after every Tier 1 title has been searched and produced nothing
 * eligible, which is what makes this expand coverage rather than dilute it.
 */
export function tier2RolesForWorkflows(
  signals: string[],
  alreadySearched: string[] = [],
  limit: number = MAX_FALLBACK_ROLES,
): string[] {
  return excluding(tieredRoles(signals, tier2Titles), alreadySearched, limit);
}

/**
 * LEVEL 5 — Manager / Lead operators inside the same matched families.
 *
 * The last widening. Still gated on the same evidence, role-consistency and
 * pre-verification checks as Tier 1: this changes who is looked for, never
 * what they must prove.
 */
export function tier3RolesForWorkflows(
  signals: string[],
  alreadySearched: string[] = [],
  limit: number = MAX_FALLBACK_ROLES,
): string[] {
  return excluding(tieredRoles(signals, tier3Titles), alreadySearched, limit);
}

/**
 * LEVEL 3 — deeper into the families the workflow already matched.
 *
 * The primary search stops at MAX_ROLES, so a matched family's more junior
 * (and often more hands-on) owners are cut. This reaches them. Still the same
 * observed workflow, still the same auditable lexicon — only further down the
 * seniority list.
 */
export function deeperRolesForWorkflows(
  signals: string[],
  alreadySearched: string[] = [],
  limit: number = MAX_FALLBACK_ROLES,
): string[] {
  const roles = matchingFamilies(signals).flatMap((f) => f.roles);
  return excluding(roles, alreadySearched, limit);
}

/**
 * Titles are allocated in ROUNDS across the matching families — every family
 * offers its most senior owner before any family offers its second.
 *
 * Sequential allocation starved later families: the accounts-payable family
 * holds exactly MAX_ROLES titles, so a company with BOTH an observed AP
 * workflow and an observed procurement workflow only ever had Finance titles
 * searched for, and procurement owners were never looked for at all. That is
 * a false negative in contact discovery, not a judgment about the company.
 *
 * Round-robin fixes that without changing the single-family case at all (one
 * matching family still contributes its whole list, in order) and without
 * raising the number of searches run — the global cap is unchanged.
 */

/**
 * Resolve functional-owner role titles from qualified-workflow text.
 *
 * `signals` should be the capability_name / company_signal / relevant_workflow
 * strings already on the run's TargetQualification — text that PASSED
 * evidence discipline, never a raw unverified guess. Roles are deduplicated
 * and returned in the order their owning family appears above, which is a
 * fixed, auditable priority rather than an incidental artifact of input order.
 */
export function rolesForWorkflows(signals: string[]): string[] {
  const roles: string[] = [];
  const seen = new Set<string>();

  const matched = FAMILIES.filter((family) => signals.some((s) => family.keywords.test(s)));
  if (matched.length === 0) return roles;

  const deepest = Math.max(...matched.map((f) => f.roles.length));

  // Round `i` takes each matching family's (i+1)th title, in the fixed family
  // priority order above — so the ordering stays auditable and independent of
  // input order, while no single family can exhaust the budget alone.
  for (let i = 0; i < deepest; i++) {
    for (const family of matched) {
      const role = family.roles[i];
      if (!role) continue;
      const key = role.toLowerCase();
      // A title shared by several families (CFO appears in more than one)
      // never consumes two slots.
      if (seen.has(key)) continue;
      seen.add(key);
      roles.push(role);
      if (roles.length >= MAX_ROLES) return roles;
    }
  }

  return roles;
}
