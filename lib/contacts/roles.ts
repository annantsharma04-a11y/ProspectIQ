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
  roles: string[];
}

const FAMILIES: RoleFamily[] = [
  {
    id: 'accounts_payable',
    keywords: /\b(accounts? payable|invoice|payment (dispute|processing|ops)|vendor payment|expense management|ap automation)\b/i,
    roles: ['CFO', 'VP Finance', 'Controller', 'Head of Accounts Payable', 'Finance Operations Director'],
  },
  {
    keywords: /\b(accounts? receivable|billing|collections|revenue operations|revops)\b/i,
    roles: ['CFO', 'VP Finance', 'Revenue Operations Lead', 'Head of Billing', 'Controller'],
  },
  {
    // Distinct from the AP family above: AP is about paying out invoices,
    // this is about contesting/defending incoming card and payment disputes
    // — a different function with different owners, even at the same company.
    keywords: /\b(chargebacks?|dispute handling|payment disputes?|payments? risk|dispute resolution|fraud)\b/i,
    roles: ['Head of Payments', 'VP Payments', 'Head of Risk', 'Fraud and Risk Director'],
  },
  {
    id: 'procurement',
    keywords: /\b(procurement|sourcing|vendor management|supply chain)\b/i,
    roles: ['Head of Procurement', 'VP Supply Chain', 'Chief Procurement Officer', 'Sourcing Director'],
  },
  {
    keywords: /\b(engineering|infrastructure|platform|devops|reliability|sre)\b/i,
    roles: ['VP Engineering', 'CTO', 'Head of Infrastructure', 'Engineering Director'],
  },
  {
    keywords: /\b(data (pipeline|infrastructure|platform)|analytics engineering|data engineering)\b/i,
    roles: ['Head of Data', 'VP Data', 'Data Platform Lead', 'Chief Data Officer'],
  },
  {
    keywords: /\b(security|compliance|risk|kyc|aml|fraud)\b/i,
    roles: ['Chief Compliance Officer', 'Head of Risk', 'CISO', 'Head of Trust and Safety'],
  },
  {
    keywords: /\b(customer support|customer success|support operations)\b/i,
    roles: ['VP Customer Success', 'Head of Support', 'Customer Operations Director'],
  },
  {
    keywords: /\b(hr|hiring|recruiting|talent|people operations|onboarding)\b/i,
    roles: ['VP People', 'Head of Talent', 'Chief People Officer', 'HR Operations Lead'],
  },
  {
    keywords: /\b(sales operations|sales ops|crm|pipeline management)\b/i,
    roles: ['VP Sales Operations', 'Head of RevOps', 'Sales Operations Director'],
  },
  {
    keywords: /\b(marketing operations|martech|campaign management)\b/i,
    roles: ['VP Marketing Operations', 'Head of Marketing Ops', 'Marketing Technology Lead'],
  },
  {
    keywords: /\b(legal|contract management|regulatory)\b/i,
    roles: ['General Counsel', 'Head of Legal', 'VP Legal'],
  },
  {
    keywords: /\b(operations|logistics|fulfillment|warehouse)\b/i,
    roles: ['COO', 'VP Operations', 'Head of Operations'],
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
