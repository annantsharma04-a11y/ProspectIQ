import { describe, it, expect } from 'vitest';
import { nameMatchesProfileSlug, preVerifyCandidate } from '@/lib/contacts/preverify';
import { canSelectCandidate } from '@/lib/contacts/select-ui';
import { parseLinkedInUrl } from '@/lib/linkedin/url';
import {
  roleTier,
  rolesForWorkflows,
  tier2RolesForWorkflows,
  tier3RolesForWorkflows,
} from '@/lib/contacts/roles';
import { rankCandidates, roleMatches, type ProposedCandidate } from '@/lib/contacts/rank';
import type { NormalizedSource } from '@/lib/research/normalize';

// Both fixes came out of one real run: Dheeraj Kamble / Myntra
// (d0c7cad6-d26b-40f0-a1bd-922a2dd4fdfc). Nine queries retrieved 45 sources
// containing eleven LinkedIn profiles, and the run offered ONE candidate,
// blocked. Two independent causes, fixed independently here.

// ─── FIX 1 — the slug false negative ─────────────────────────────────────────

describe('nameMatchesProfileSlug — run-together slugs are not conflicts', () => {
  const hintFor = (url: string) => {
    const p = parseLinkedInUrl(url);
    return p.ok ? p.name_hint : null;
  };

  it('1. accepts first-initial + surname — the live Myntra false negative', () => {
    // /in/padiddam is "p" + "adiddam". The old set-membership test could not
    // see that, and blocked a candidate whose other six checks all passed.
    expect(nameMatchesProfileSlug('Pramod Adiddam', hintFor('https://www.linkedin.com/in/padiddam'))).toBe(true);
  });

  it('accepts the separated and fully concatenated forms too', () => {
    for (const slug of ['pramod-adiddam', 'pramodadiddam', 'adiddam-pramod', 'adiddampramod']) {
      expect(
        nameMatchesProfileSlug('Pramod Adiddam', hintFor(`https://www.linkedin.com/in/${slug}`)),
        slug,
      ).toBe(true);
    }
  });

  it('accepts forename + surname initial, and a middle name being dropped', () => {
    expect(nameMatchesProfileSlug('Pramod Adiddam', hintFor('https://www.linkedin.com/in/pramoda'))).toBe(true);
    expect(nameMatchesProfileSlug('Anand R Krishna', hintFor('https://www.linkedin.com/in/anandkrishna'))).toBe(true);
    expect(nameMatchesProfileSlug('Anand R Krishna', hintFor('https://www.linkedin.com/in/akrishna'))).toBe(true);
  });

  it('2. still rejects a slug naming a genuinely different person', () => {
    expect(nameMatchesProfileSlug('Pramod Adiddam', hintFor('https://www.linkedin.com/in/rahul-mehta'))).toBe(false);
    expect(nameMatchesProfileSlug('Jane Kapoor', hintFor('https://www.linkedin.com/in/rahul-mehta'))).toBe(false);
  });

  it('rejects a run-together slug for a different person just as firmly', () => {
    expect(nameMatchesProfileSlug('Pramod Adiddam', hintFor('https://www.linkedin.com/in/rmehta'))).toBe(false);
    expect(nameMatchesProfileSlug('Jane Kapoor', hintFor('https://www.linkedin.com/in/rahulmehta'))).toBe(false);
    // A shared INITIAL is not a shared name.
    expect(nameMatchesProfileSlug('Pramod Adiddam', hintFor('https://www.linkedin.com/in/pmehta'))).toBe(false);
  });

  it('3. an opaque vanity slug is still no conflict either way', () => {
    expect(nameMatchesProfileSlug('Jane Kapoor', hintFor('https://www.linkedin.com/in/xk8f2p'))).toBeNull();
  });

  it('reports null rather than false when there is nothing to compare', () => {
    expect(nameMatchesProfileSlug('Jane Kapoor', null)).toBeNull();
    expect(nameMatchesProfileSlug('', 'Kapoor')).toBeNull();
  });
});

describe('1. the real Myntra candidate is now eligible end to end', () => {
  const pramod = {
    name: 'Pramod Adiddam',
    role: 'Chief Technology Officer',
    company: 'Myntra',
    linkedin_url: 'https://www.linkedin.com/in/padiddam',
    evidence: [
      {
        source_url: 'https://example.com/myntra-cto',
        quote: 'Myntra strengthens technology leadership with appointment of Pramod Adiddam as Chief Technology Officer.',
      },
    ],
  };

  // The exact role list run d0c7cad6 searched, so this reproduces the live
  // pre-verification input rather than a convenient approximation.
  const SEARCHED_ROLES = [
    'Head of Payments',
    'VP Engineering',
    'Chief Compliance Officer',
    'VP People',
    'VP Payments',
    'Head of Risk',
    'Fraud and Risk Director',
    'CTO',
  ];

  it('passes every pre-verification check, including the one that blocked it', () => {
    const result = preVerifyCandidate(pramod, { targetRoles: SEARCHED_ROLES });

    expect(result.checks.name_matches_profile).toBe(true);
    expect(result.eligibility).toBe('ELIGIBLE');
    expect(result.blockedReason).toBeNull();
  });

  it('and therefore becomes selectable', () => {
    expect(canSelectCandidate({ ...pramod, identity_status: 'DISCOVERED' } as never)).toBe(true);
  });

  it('8. while a genuinely bad candidate is still blocked', () => {
    // Same person, a profile URL naming somebody else.
    expect(
      preVerifyCandidate({ ...pramod, linkedin_url: 'https://www.linkedin.com/in/rahul-mehta' }).eligibility,
    ).not.toBe('ELIGIBLE');
    // No evidence at all.
    expect(preVerifyCandidate({ ...pramod, evidence: [] }).eligibility).toBe('EXCLUDED');
    // No usable profile URL.
    expect(preVerifyCandidate({ ...pramod, linkedin_url: null }).eligibility).toBe('EXCLUDED');
    // Evidence that never names this person.
    expect(
      preVerifyCandidate({
        ...pramod,
        evidence: [{ source_url: 'https://example.com/x', quote: 'Myntra announced quarterly results.' }],
      }).checks.name_in_evidence,
    ).toBe(false);
  });
});

// ─── FIX 2 — seniority tiers ─────────────────────────────────────────────────

const PAYMENTS = ['Processes high-volume consumer payment disputes and chargebacks'];
const AP = ['Automates accounts payable and invoice processing'];

describe('roleTier reads the band from the title itself', () => {
  it('bands Tier 1 senior decision-makers', () => {
    for (const t of ['CTO', 'CFO', 'VP Payments', 'Head of Risk', 'Chief Compliance Officer', 'General Counsel']) {
      expect(roleTier(t), t).toBe(1);
    }
  });

  it('bands Tier 2 functional owners', () => {
    for (const t of ['Director of Payments', 'Senior Director, Risk', 'Senior Manager Payments', 'Director Engineering']) {
      expect(roleTier(t), t).toBe(2);
    }
  });

  it('bands Tier 3 operators', () => {
    for (const t of ['Risk Manager', 'Payments Manager', 'Fraud Prevention Lead', 'Disputes Supervisor']) {
      expect(roleTier(t), t).toBe(3);
    }
  });

  it('reads Tier 1 first, so "Head of Engineering" is not mistaken for a lead', () => {
    expect(roleTier('Head of Engineering')).toBe(1);
    expect(roleTier('VP Engineering Manager')).toBe(1);
  });

  it('falls to the conservative end for an unrecognized title', () => {
    expect(roleTier('Cataloguer')).toBe(3);
  });
});

describe('7. tiers widen coverage only inside a RELEVANT family', () => {
  it('a payments workflow reaches payments/risk/fraud managers', () => {
    const t3 = tier3RolesForWorkflows(PAYMENTS, []);
    expect(t3.length).toBeGreaterThan(0);
    // The exact titles the real Myntra sources contained.
    expect(tier3RolesForWorkflows(PAYMENTS, [], 20)).toContain('Risk Manager');
    expect(tier2RolesForWorkflows(PAYMENTS, [], 20)).toContain('Senior Manager Payments');
  });

  it('an AP workflow reaches AP managers — and NOT payments-risk managers', () => {
    const t3 = tier3RolesForWorkflows(AP, [], 20);
    expect(t3).toContain('Accounts Payable Manager');
    expect(t3).not.toContain('Fraud Prevention Manager');
  });

  it('a workflow matching no family gets no tiers at all', () => {
    expect(tier2RolesForWorkflows(['artisanal candle subscriptions'], [])).toEqual([]);
    expect(tier3RolesForWorkflows(['artisanal candle subscriptions'], [])).toEqual([]);
  });

  it('never returns a title an earlier level already searched', () => {
    const searched = [...rolesForWorkflows(PAYMENTS), ...tier2RolesForWorkflows(PAYMENTS, [])];
    for (const r of tier3RolesForWorkflows(PAYMENTS, searched)) {
      expect(searched).not.toContain(r);
    }
  });

  it('stays bounded per level', () => {
    expect(tier2RolesForWorkflows(PAYMENTS, []).length).toBeLessThanOrEqual(3);
    expect(tier3RolesForWorkflows(PAYMENTS, []).length).toBeLessThanOrEqual(3);
  });

  it('Tier 1 is unchanged — the primary search still asks for the senior owners first', () => {
    const t1 = rolesForWorkflows(PAYMENTS);

    expect(t1).toContain('Head of Payments');
    expect(t1).toContain('VP Payments');
    // The primary list never reaches the Manager/Lead band; that is exactly
    // what levels 4 and 5 were added to cover. (It does carry a few
    // Director-level owners of its own — 'Fraud and Risk Director' — which is
    // why this asserts the FLOOR rather than uniform Tier 1.)
    for (const r of t1) expect(roleTier(r)).toBeLessThanOrEqual(2);
    expect(t1.some((r) => roleTier(r) === 1)).toBe(true);
    expect(t1).not.toContain('Risk Manager');
  });
});

describe('4-6. ranking — authority orders relevant people, never replaces relevance', () => {
  const source = (url: string): NormalizedSource =>
    ({
      url,
      canonical_url: url,
      title: 'Myntra leadership',
      snippet: 'Relevant excerpt about the person.',
      content: 'VP Payments at Myntra. Senior Manager Payments at Myntra. Payments Manager at Myntra. VP Engineering at Myntra.',
      source_type: 'web',
      credibility: 0.6,
      published_date: null,
      providers: [],
      queries: [],
      categories: [],
    }) as unknown as NormalizedSource;

  const SRC = 'https://example.com/leadership';
  const sources = [source(SRC)];

  const cand = (name: string, role: string): ProposedCandidate => ({
    name,
    role,
    linkedin_url: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\s+/g, '-')}`,
    quote: `${role} at Myntra.`,
    sourceUrl: SRC,
  });

  const targets = ['VP Payments', 'Senior Manager Payments', 'Payments Manager'];

  it('4. Tier 1 outranks an otherwise-identical Tier 2', () => {
    const ranked = rankCandidates(
      [cand('Bella Two', 'Senior Manager Payments'), cand('Ada One', 'VP Payments')],
      sources,
      targets,
      'payment disputes',
    );

    expect(ranked.map((c) => c.role)).toEqual(['VP Payments', 'Senior Manager Payments']);
  });

  it('5. Tier 2 outranks an otherwise-identical Tier 3', () => {
    const ranked = rankCandidates(
      [cand('Cara Three', 'Payments Manager'), cand('Bella Two', 'Senior Manager Payments')],
      sources,
      targets,
      'payment disputes',
    );

    expect(ranked.map((c) => c.role)).toEqual(['Senior Manager Payments', 'Payments Manager']);
  });

  it('the full ladder orders correctly in one pass', () => {
    const ranked = rankCandidates(
      [
        cand('Cara Three', 'Payments Manager'),
        cand('Ada One', 'VP Payments'),
        cand('Bella Two', 'Senior Manager Payments'),
      ],
      sources,
      targets,
      'payment disputes',
    );

    expect(ranked.map((c) => c.role)).toEqual(['VP Payments', 'Senior Manager Payments', 'Payments Manager']);
  });

  it('6. an unrelated function does not outrank a relevant one — it is not a candidate at all', () => {
    const ranked = rankCandidates(
      [cand('Vic Eng', 'VP Engineering'), cand('Cara Three', 'Payments Manager')],
      sources,
      targets,
      'payment disputes',
    );

    // Relevance is a hard gate BEFORE scoring, so seniority never gets the
    // chance to lift an unrelated senior person over a relevant junior one.
    expect(ranked.map((c) => c.name)).toEqual(['Cara Three']);
    expect(roleMatches('VP Engineering', targets)).toBe(false);
  });

  it('a Tier 3 title still has to own the workflow to be ranked', () => {
    const ranked = rankCandidates([cand('Rand Om', 'Cataloguing Manager')], sources, targets, 'payment disputes');
    expect(ranked).toEqual([]);
  });
});

// ─── 9-10. the safeguards the widening must not touch ────────────────────────

describe('9-10. nothing here selects or verifies anybody', () => {
  it('9. ranking proposes an order — it never marks a candidate selected', () => {
    const src = {
      url: 'https://example.com/a',
      canonical_url: 'https://example.com/a',
      title: 't',
      snippet: 'VP Payments at Myntra.',
      content: 'VP Payments at Myntra.',
      source_type: 'web',
      credibility: 0.6,
      published_date: null,
      providers: [],
      queries: [],
      categories: [],
    } as unknown as NormalizedSource;

    const ranked = rankCandidates(
      [{ name: 'Ada One', role: 'VP Payments', linkedin_url: 'https://www.linkedin.com/in/ada-one', quote: 'VP Payments at Myntra.', sourceUrl: 'https://example.com/a' }],
      [src],
      ['VP Payments'],
      'payment disputes',
    );

    expect(ranked).toHaveLength(1);
    // No selection state exists on a ranked candidate — selection is a human
    // action against the persisted row, and this shape cannot express it.
    expect(ranked[0]).not.toHaveProperty('selected');
    expect(ranked[0]).not.toHaveProperty('resulting_run_id');
  });

  it('10. an ELIGIBLE candidate is only PRE-verified — full identity verification still follows', async () => {
    const { decideIdentity } = await import('@/lib/identity/types');

    // Pre-verification passing says nothing about identity verification, which
    // runs independently after a human selects, and still fails on no evidence.
    const verification = decideIdentity({
      selected: null,
      selectionMethod: null,
      profile: { name: null, role: null, company: null, location: null, linkedin_url: null },
      hasProfile: false,
      candidates: [],
      conflicts: [],
      assessedConfidence: 0,
      missingFields: ['company', 'role'],
    });

    expect(verification.status).toBe('FAILED');
    expect(verification.proceed).toBe(false);
  });
});
