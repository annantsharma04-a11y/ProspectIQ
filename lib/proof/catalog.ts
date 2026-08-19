// Controlled customer-proof catalog — configuration, not invention.
//
// Same pattern, and same reasoning, as lib/solutions/catalog.ts: the real
// proof library names actual customers and their results, which is commercial
// information that belongs in the deployment environment
// (ZAMP_PROOF_CATALOG, a JSON array), never in a shared repository. What ships
// here is a neutral placeholder showing the required shape, so a misconfigured
// deployment falls back to something obviously fake rather than silently
// producing plausible-looking customer claims.
//
// The validation below is deliberately stricter than the solution catalog's.
// A malformed solution entry produces an irrelevant pitch; a malformed proof
// entry produces a false statement about a named company. Every field is
// checked, and any entry failing any check is dropped rather than repaired —
// there is no "best effort" reading of a customer claim.

import type { ApprovedProof } from './types';

const DEFAULT_CATALOG: ApprovedProof[] = [
  {
    id: 'example_proof',
    customer: 'Example Customer',
    workflow: 'Describe the workflow this proof demonstrates.',
    capability_id: 'example_capability',
    approved_statement:
      'Replace this by setting ZAMP_PROOF_CATALOG to a JSON array of approved, ready-to-send customer proof statements.',
    is_public: true,
  },
];

/** Every field must be present and correctly typed; a partial proof is not a proof. */
function isUsableProof(p: unknown): p is ApprovedProof {
  const x = p as Record<string, unknown> | null;
  return Boolean(
    x &&
      typeof x.id === 'string' &&
      x.id.trim().length > 0 &&
      typeof x.customer === 'string' &&
      x.customer.trim().length > 0 &&
      typeof x.workflow === 'string' &&
      x.workflow.trim().length > 0 &&
      typeof x.capability_id === 'string' &&
      x.capability_id.trim().length > 0 &&
      typeof x.approved_statement === 'string' &&
      x.approved_statement.trim().length > 0 &&
      typeof x.is_public === 'boolean',
  );
}

export function getProofCatalog(): ApprovedProof[] {
  const raw = process.env.ZAMP_PROOF_CATALOG?.trim();
  if (!raw) return DEFAULT_CATALOG;
  try {
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) {
      console.warn('[proof] ZAMP_PROOF_CATALOG is not a JSON array; using the configured defaults.');
      return DEFAULT_CATALOG;
    }
    const valid = parsed.filter(isUsableProof);
    if (valid.length !== parsed.length) {
      // Named loudly: a dropped proof silently narrows what outreach can say,
      // and that should be visible in logs rather than discovered later.
      console.warn(
        `[proof] ${parsed.length - valid.length} proof entr(ies) were dropped for missing or malformed fields.`,
      );
    }
    return valid.length > 0 ? valid : DEFAULT_CATALOG;
  } catch {
    // Malformed configuration must not silently change what we claim about customers.
    console.warn('[proof] ZAMP_PROOF_CATALOG is not valid JSON; using the configured defaults.');
    return DEFAULT_CATALOG;
  }
}
