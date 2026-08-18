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
  keywords: RegExp;
  roles: string[];
}

const FAMILIES: RoleFamily[] = [
  {
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

  for (const family of FAMILIES) {
    if (!signals.some((s) => family.keywords.test(s))) continue;
    for (const role of family.roles) {
      const key = role.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      roles.push(role);
      if (roles.length >= MAX_ROLES) return roles;
    }
  }

  return roles;
}
