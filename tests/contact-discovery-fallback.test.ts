import { describe, it, expect } from 'vitest';
import {
  rolesForWorkflows,
  adjacentRolesForWorkflows,
  deeperRolesForWorkflows,
  MAX_ROLES,
  MAX_FALLBACK_ROLES,
} from '@/lib/contacts/roles';

// The reported failure: a strongly qualified AP company with a medium-relevance
// submitted contact ended at "No verified contact candidates found" after a
// single pass over five finance titles. The account was good; the system just
// stopped looking too early.
//
// The rule these lock in: STRICT about verification, MORE FLEXIBLE about
// discovery. Widening changes only WHERE the system looks — never what a
// candidate must prove, and never into a function unrelated to the observed
// workflow.

const AP_SIGNAL = ['Automates accounts payable and invoice processing'];
const CHARGEBACK_SIGNAL = ['High chargeback volume from card-not-present transactions'];
const COMPLIANCE_SIGNAL = ['Regulated onboarding requires KYC and KYB verification'];

describe('LEVEL 1 — primary functional owners (unchanged)', () => {
  it('returns the workflow’s own owners first', () => {
    const roles = rolesForWorkflows(AP_SIGNAL);
    expect(roles).toContain('CFO');
    expect(roles).toContain('Head of Accounts Payable');
    expect(roles.length).toBeLessThanOrEqual(MAX_ROLES);
  });

  it('still returns nothing when no workflow maps to a known owner', () => {
    expect(rolesForWorkflows(['artisanal candle subscriptions'])).toEqual([]);
  });
});

describe('LEVEL 2 — adjacent function for the SAME workflow', () => {
  it('reaches procurement owners for an AP workflow', () => {
    // Purchase-to-pay is one chain: procurement raises the PO and owns the
    // vendor, AP pays the invoice against it.
    const primary = rolesForWorkflows(AP_SIGNAL);
    const adjacent = adjacentRolesForWorkflows(AP_SIGNAL, primary);

    expect(adjacent).toContain('Head of Procurement');
    expect(adjacent.length).toBeGreaterThan(0);
  });

  it('never repeats a title the primary search already covered', () => {
    const primary = rolesForWorkflows(AP_SIGNAL);
    const adjacent = adjacentRolesForWorkflows(AP_SIGNAL, primary);
    for (const role of adjacent) expect(primary).not.toContain(role);
  });

  // Adjacency requires potential OWNERSHIP of the same workflow — not merely
  // interacting with it, feeding it, or receiving work from it. Two mappings
  // were considered and rejected on exactly that test; these lock the
  // rejections in so neither reappears as a plausible-sounding shortcut.

  it('does NOT reach support for a chargeback workflow — support handles disputes, it does not own them', () => {
    const primary = rolesForWorkflows(CHARGEBACK_SIGNAL);
    const adjacent = adjacentRolesForWorkflows(CHARGEBACK_SIGNAL, primary);

    // Representment, network filing and deadlines belong to Payments/Risk —
    // already the chargebacks family's own titles.
    expect(adjacent).not.toContain('VP Customer Success');
    expect(adjacent).not.toContain('Head of Support');
    expect(adjacent).toEqual([]);
  });

  it('does NOT reach physical operations for a KYC/KYB workflow', () => {
    const primary = rolesForWorkflows(COMPLIANCE_SIGNAL);
    const adjacent = adjacentRolesForWorkflows(COMPLIANCE_SIGNAL, primary);

    // That family is logistics/fulfillment/warehouse operations; a COO or
    // Head of Operations there does not own verification review, and the
    // compliance family already carries the real owners.
    expect(adjacent).not.toContain('COO');
    expect(adjacent).not.toContain('Head of Operations');
    expect(adjacent).toEqual([]);
  });

  it('does NOT wander into an unrelated function to pad the count', () => {
    const primary = rolesForWorkflows(AP_SIGNAL);
    const adjacent = adjacentRolesForWorkflows(AP_SIGNAL, primary);

    // Engineering, recruiting and marketing own no part of an AP workflow.
    for (const unrelated of ['VP Engineering', 'CTO', 'Head of Talent', 'VP People', 'VP Marketing Operations']) {
      expect(adjacent).not.toContain(unrelated);
    }
  });

  it('returns nothing when the workflow family has no defensible neighbour', () => {
    // The engineering family is deliberately given no adjacency.
    expect(adjacentRolesForWorkflows(['core platform infrastructure and SRE work'], [])).toEqual([]);
  });

  it('purchase-to-pay is the ONLY adjacency — every other family declines to widen', () => {
    // Guards the map as a whole: a future addition has to be a deliberate,
    // justified change here rather than something that slips in unnoticed.
    const nonAdjacent = [
      ['chargeback and dispute resolution', 'chargebacks'],
      ['KYC and KYB onboarding verification', 'compliance'],
      ['core platform infrastructure', 'engineering'],
      ['customer support operations', 'support'],
      ['recruiting and talent', 'hr'],
      ['contract management and regulatory', 'legal'],
      ['logistics and fulfillment', 'operations'],
      ['accounts receivable and billing', 'receivables'],
    ] as const;

    for (const [signal, label] of nonAdjacent) {
      const primary = rolesForWorkflows([signal]);
      expect(adjacentRolesForWorkflows([signal], primary), `${label} must not widen`).toEqual([]);
    }

    // ...while purchase-to-pay still does, in both directions.
    expect(adjacentRolesForWorkflows(AP_SIGNAL, rolesForWorkflows(AP_SIGNAL)).length).toBeGreaterThan(0);
    const procurementSignal = ['vendor management and sourcing procurement'];
    expect(
      adjacentRolesForWorkflows(procurementSignal, rolesForWorkflows(procurementSignal)).length,
    ).toBeGreaterThan(0);
  });

  it('returns nothing for a workflow that matched no family at all', () => {
    expect(adjacentRolesForWorkflows(['artisanal candle subscriptions'], [])).toEqual([]);
  });

  it('does not treat an already-matched family as a fallback', () => {
    // When the signal names BOTH AP and procurement, procurement owners were
    // available to the primary search — so they are not a widening step.
    const both = ['accounts payable invoice processing and vendor management procurement'];
    const primary = rolesForWorkflows(both);
    expect(adjacentRolesForWorkflows(both, primary)).toEqual([]);
  });
});

describe('LEVEL 3 — deeper into the families already matched', () => {
  it('reaches owners the primary cap cut off', () => {
    const both = ['accounts payable invoice processing and vendor management procurement'];
    const primary = rolesForWorkflows(both);
    const deeper = deeperRolesForWorkflows(both, primary);

    expect(deeper.length).toBeGreaterThan(0);
    // Everything it returns still belongs to a family the workflow matched.
    for (const role of deeper) expect(primary).not.toContain(role);
  });

  it('stays inside the observed workflow’s own families', () => {
    const primary = rolesForWorkflows(AP_SIGNAL);
    const deeper = deeperRolesForWorkflows(AP_SIGNAL, primary);
    for (const unrelated of ['VP Engineering', 'Head of Talent', 'General Counsel']) {
      expect(deeper).not.toContain(unrelated);
    }
  });

  it('returns nothing once every matched-family owner has been searched', () => {
    const primary = rolesForWorkflows(COMPLIANCE_SIGNAL);
    const deeper = deeperRolesForWorkflows(COMPLIANCE_SIGNAL, primary);
    // Whatever it returns, asking again with those included must be empty.
    expect(deeperRolesForWorkflows(COMPLIANCE_SIGNAL, [...primary, ...deeper])).toEqual([]);
  });
});

describe('the search budget stays bounded', () => {
  it('each fallback level is capped, and smaller than the primary sweep', () => {
    const primary = rolesForWorkflows(AP_SIGNAL);
    expect(adjacentRolesForWorkflows(AP_SIGNAL, primary).length).toBeLessThanOrEqual(MAX_FALLBACK_ROLES);
    expect(deeperRolesForWorkflows(AP_SIGNAL, primary).length).toBeLessThanOrEqual(MAX_FALLBACK_ROLES);
    expect(MAX_FALLBACK_ROLES).toBeLessThan(MAX_ROLES);
  });

  it('the worst case across all three levels is bounded and knowable', () => {
    const primary = rolesForWorkflows(AP_SIGNAL);
    const adjacent = adjacentRolesForWorkflows(AP_SIGNAL, primary);
    const deeper = deeperRolesForWorkflows(AP_SIGNAL, [...primary, ...adjacent]);

    const totalRoleQueries = primary.length + adjacent.length + deeper.length;
    expect(totalRoleQueries).toBeLessThanOrEqual(MAX_ROLES + MAX_FALLBACK_ROLES * 2);
  });

  it('every level returns a deduplicated list', () => {
    const primary = rolesForWorkflows(AP_SIGNAL);
    const adjacent = adjacentRolesForWorkflows(AP_SIGNAL, primary);
    const all = [...primary, ...adjacent].map((r) => r.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
  });
});
