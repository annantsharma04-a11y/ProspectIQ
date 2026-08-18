import { describe, it, expect } from 'vitest';
import { rolesForWorkflows, MAX_ROLES } from '@/lib/contacts/roles';
import { rankCandidates, MAX_CANDIDATES, type ProposedCandidate } from '@/lib/contacts/rank';
import { contactCandidatesStageIsVisible } from '@/lib/contacts/types';
import type { NormalizedSource } from '@/lib/research/normalize';

// Two failure modes this file guards against:
//
//   1. Guessing generic seniority ("CEO, Founder") instead of deriving roles
//      from the workflow that actually qualified the company.
//   2. Trusting the model's own claim of relevance or quote instead of
//      independently verifying it, the same discipline hooks already get.

describe('role derivation is workflow-driven, never generic', () => {
  it('maps accounts payable language to finance-function titles', () => {
    const roles = rolesForWorkflows(['Automates accounts payable and invoice processing']);
    expect(roles).toContain('CFO');
    expect(roles).toContain('Head of Accounts Payable');
    expect(roles).not.toContain('CEO');
    expect(roles).not.toContain('Founder');
    expect(roles).not.toContain('Marketing Director');
  });

  it('maps engineering-infrastructure language to engineering titles, not finance', () => {
    const roles = rolesForWorkflows(['Reduces incidents in core platform infrastructure']);
    expect(roles).toContain('VP Engineering');
    expect(roles).not.toContain('CFO');
  });

  it('a workflow that matches nothing produces no roles, not a generic fallback', () => {
    // This is the case that must NOT silently degrade to "senior person".
    expect(rolesForWorkflows(['artisanal candle subscriptions'])).toEqual([]);
    expect(rolesForWorkflows([])).toEqual([]);
  });

  it('deduplicates a role that multiple matched families would both suggest', () => {
    const roles = rolesForWorkflows(['accounts payable', 'accounts receivable and billing']);
    expect(roles.filter((r) => r === 'CFO')).toHaveLength(1);
  });

  it('never exceeds the role cap', () => {
    const many = ['accounts payable', 'procurement', 'engineering', 'security', 'legal', 'hr', 'sales operations'];
    expect(rolesForWorkflows(many).length).toBeLessThanOrEqual(MAX_ROLES);
  });

  it('returns roles in a fixed, auditable order regardless of input order', () => {
    const a = rolesForWorkflows(['accounts payable invoice processing']);
    const b = rolesForWorkflows(['invoice processing', 'accounts payable']);
    expect(a).toEqual(b);
  });
});

// ─── regression: Myntra — a chargebacks-only observed capability found no
// roles at all, because lib/contacts/roles.ts had no family for chargebacks
// or payment disputes. The AP family only matches the compound phrase
// "payment dispute", never "chargeback" alone. This left the qualified-but-
// unstaffed company (company_fit HIGH, prospect_fit LOW) with 0 role queries,
// 0 searches, and a dishonest-looking "no candidates found" even though the
// qualified workflow was a real, configured capability with an obvious set of
// functional owners.

describe('chargeback / payment-dispute role family (Myntra regression)', () => {
  it('maps chargeback language to payments/risk titles', () => {
    const roles = rolesForWorkflows(['High chargeback volume from card-not-present transactions']);
    expect(roles).toContain('Head of Payments');
    expect(roles).toContain('Head of Risk');
    expect(roles).not.toContain('CFO');
    expect(roles).not.toContain('VP Engineering');
  });

  it('maps each documented match term individually', () => {
    for (const term of ['chargeback', 'chargebacks', 'dispute handling', 'payment disputes', 'fraud', 'payments risk']) {
      expect(rolesForWorkflows([term]).length).toBeGreaterThan(0);
    }
  });

  it('stays distinct from the AP family — dispute handling is not accounts payable', () => {
    const roles = rolesForWorkflows(['dispute handling']);
    expect(roles).not.toContain('CFO');
    expect(roles).not.toContain('Head of Accounts Payable');
  });

  it('the exact Myntra company_signal text alone still matches nothing — the gap is real, not fixed by keyword luck', () => {
    // This is the actual company_signal the qualification model produced for
    // the run that regressed: it describes the workflow in free prose without
    // ever using a word this or any family keys on. Proves the fix has to be
    // (and is) "also search capability_name", not just "add more keywords".
    const companySignalAlone =
      'High-volume online retail and e-commerce consumer transactions with massive monthly active users.';
    expect(rolesForWorkflows([companySignalAlone])).toEqual([]);
  });

  it('the capability_name for that same match DOES resolve roles — proving the stages.ts fix closes the gap', () => {
    const capabilityNameAlone = 'Chargebacks and Dispute Handling';
    const roles = rolesForWorkflows([capabilityNameAlone]);
    expect(roles.length).toBeGreaterThan(0);
    expect(roles).toContain('Head of Payments');
  });

  it('chargebacks combined with a non-finance family surfaces both role sets', () => {
    // AP and AR are both already sized at MAX_ROLES on their own (5 roles),
    // so combined with any other matched family the earlier-ordered family
    // alone fills the global cap — the same fixed-priority behavior already
    // exercised for AP+AR above. Pairing chargebacks with a smaller family
    // (KYC/compliance, 4 roles) leaves room to prove BOTH families' roles can
    // surface together, not just that the new family works in isolation.
    const roles = rolesForWorkflows(['chargeback and dispute resolution', 'KYC and compliance onboarding']);
    expect(roles).toContain('Head of Payments'); // chargebacks family (matched first, in FAMILIES order)
    expect(roles).toContain('Chief Compliance Officer'); // compliance family, still has room under the cap
  });
});

// ─── unrelated capabilities are unaffected by the new family ────────────────

describe('unrelated capabilities keep their existing role sets unchanged', () => {
  it('KYC/compliance language is untouched by the new chargebacks family', () => {
    const roles = rolesForWorkflows(['Regulated onboarding requires KYC and KYB verification']);
    expect(roles).toContain('Chief Compliance Officer');
    expect(roles).toContain('Head of Risk');
    expect(roles).not.toContain('Head of Payments');
  });

  it('procurement language is untouched', () => {
    const roles = rolesForWorkflows(['Centralized vendor sourcing and supply chain procurement']);
    expect(roles).toContain('Head of Procurement');
    expect(roles).not.toContain('Head of Payments');
  });

  it('engineering language is untouched', () => {
    const roles = rolesForWorkflows(['Core platform infrastructure and SRE reliability work']);
    expect(roles).toContain('VP Engineering');
    expect(roles).not.toContain('Head of Payments');
  });

  it('a workflow matching nothing still produces no roles, not a fallback', () => {
    expect(rolesForWorkflows(['artisanal candle subscriptions'])).toEqual([]);
  });
});

// ─── existing AP / payment-dispute-compound family behavior is preserved ────

describe('existing AP and compound payment-dispute matching still works', () => {
  it('"payment dispute" (the AP family compound phrase) still resolves to finance roles', () => {
    const roles = rolesForWorkflows(['High volume of payment dispute cases in AP']);
    expect(roles).toContain('CFO');
    // Still finance-led, as this test has always asserted.
    expect(roles).toContain('VP Finance');
    expect(roles).toContain('Controller');
  });

  it('a signal naming BOTH an AP and a dispute workflow now surfaces owners of each', () => {
    // This phrase matches the AP family AND the chargebacks family. Sequential
    // allocation let AP consume the whole budget, so payments/dispute owners
    // were never searched for — the starvation bug. Both are represented now.
    const roles = rolesForWorkflows(['High volume of payment dispute cases in AP']);
    expect(roles).toContain('CFO'); // AP family
    expect(roles).toContain('Head of Payments'); // chargebacks family
  });

  it('plain accounts payable / invoice / vendor payment language is unaffected', () => {
    const roles = rolesForWorkflows(['Automates accounts payable and invoice processing']);
    expect(roles).toContain('CFO');
    expect(roles).toContain('Head of Accounts Payable');
    expect(roles).not.toContain('Head of Payments');
  });
});

// ─── ranking ─────────────────────────────────────────────────────────────────

let seq = 0;
const source = (over: Partial<NormalizedSource> = {}): NormalizedSource => {
  seq += 1;
  const url = over.url ?? `https://example${seq}.com/leadership`;
  return {
    url,
    canonical_url: url,
    title: 'Leadership team',
    snippet: '',
    source_type: 'web',
    credibility: 0.6,
    published_date: '2026-06-01',
    providers: ['tavily'],
    queries: [],
    categories: ['contact_discovery'],
    duplicate_count: 0,
    retrieved_at: '2026-06-02T00:00:00Z',
    content: 'Jane Kapoor serves as VP Finance at Acme, overseeing accounts payable operations.',
    fetch_status: 'scraped',
    ...over,
  } as NormalizedSource;
};

const candidate = (over: Partial<ProposedCandidate> = {}): ProposedCandidate => ({
  name: 'Jane Kapoor',
  role: 'VP Finance',
  linkedin_url: 'https://www.linkedin.com/in/jane-kapoor',
  quote: 'Jane Kapoor serves as VP Finance at Acme',
  sourceUrl: 'https://example1.com/leadership',
  ...over,
});

describe('evidence gate: verbatim quote in a retrieved source', () => {
  it('accepts a candidate whose quote genuinely appears in the cited source', () => {
    const s = source({ url: 'https://a.com/1' });
    const ranked = rankCandidates([candidate({ sourceUrl: s.url })], [s], ['VP Finance'], 'accounts payable');
    expect(ranked).toHaveLength(1);
    expect(ranked[0].evidence.quote).toBe(candidate().quote);
  });

  it('rejects a candidate whose quote does not appear in the cited source', () => {
    const s = source({ url: 'https://a.com/1', content: 'Completely unrelated content about a different topic.' });
    const ranked = rankCandidates(
      [candidate({ sourceUrl: s.url, quote: 'A sentence that was never actually retrieved anywhere' })],
      [s],
      ['VP Finance'],
      'accounts payable',
    );
    expect(ranked).toEqual([]);
  });

  it('rejects a candidate citing a URL that was never retrieved', () => {
    const s = source({ url: 'https://a.com/1' });
    const ranked = rankCandidates(
      [candidate({ sourceUrl: 'https://never-retrieved.com/page' })],
      [s],
      ['VP Finance'],
      'accounts payable',
    );
    expect(ranked).toEqual([]);
  });

  it('matches the same source across trivial URL differences', () => {
    const s = source({ url: 'https://a.com/leadership?utm=1', canonical_url: 'https://a.com/leadership' });
    const ranked = rankCandidates(
      [candidate({ sourceUrl: 'https://a.com/leadership' })],
      [s],
      ['VP Finance'],
      'accounts payable',
    );
    expect(ranked).toHaveLength(1);
  });
});

describe('role gate: the model does not get to assert its own relevance', () => {
  it('rejects a candidate whose role does not match any target role', () => {
    const s = source({ url: 'https://a.com/1', content: 'Sam Lee is Head of Marketing at Acme, driving brand campaigns.' });
    const ranked = rankCandidates(
      [candidate({ name: 'Sam Lee', role: 'Head of Marketing', sourceUrl: s.url, quote: 'Sam Lee is Head of Marketing at Acme' })],
      [s],
      ['VP Finance', 'CFO', 'Controller'],
      'accounts payable',
    );
    expect(ranked).toEqual([]);
  });

  it('accepts a role that is a clear synonym of a target role', () => {
    const s = source({ url: 'https://a.com/1', content: 'Priya Rao is Vice President of Finance at Acme.' });
    const ranked = rankCandidates(
      [candidate({ name: 'Priya Rao', role: 'Vice President of Finance', sourceUrl: s.url, quote: 'Priya Rao is Vice President of Finance at Acme' })],
      [s],
      ['VP Finance'],
      'accounts payable',
    );
    expect(ranked).toHaveLength(1);
  });
});

describe('ranking and shortlisting', () => {
  it('caps the result at MAX_CANDIDATES', () => {
    const sources: NormalizedSource[] = [];
    const proposed: ProposedCandidate[] = [];
    for (let i = 0; i < 8; i++) {
      const s = source({ url: `https://a.com/${i}`, content: `Person${i} is VP Finance at Acme, overseeing operations.` });
      sources.push(s);
      proposed.push(candidate({ name: `Person${i}`, sourceUrl: s.url, quote: `Person${i} is VP Finance at Acme` }));
    }
    expect(rankCandidates(proposed, sources, ['VP Finance'], 'accounts payable')).toHaveLength(MAX_CANDIDATES);
  });

  it('ranks a candidate with a LinkedIn URL above an otherwise identical one without', () => {
    const s1 = source({ url: 'https://a.com/1', content: 'Alex Kim is VP Finance at Acme overseeing all operations.' });
    const s2 = source({ url: 'https://b.com/1', content: 'Robin Park is VP Finance at Acme overseeing all operations.' });
    const ranked = rankCandidates(
      [
        candidate({ name: 'Alex Kim', linkedin_url: null, sourceUrl: s1.url, quote: 'Alex Kim is VP Finance at Acme' }),
        candidate({ name: 'Robin Park', linkedin_url: 'https://www.linkedin.com/in/robin-park', sourceUrl: s2.url, quote: 'Robin Park is VP Finance at Acme' }),
      ],
      [s1, s2],
      ['VP Finance'],
      'accounts payable',
    );
    expect(ranked[0].name).toBe('Robin Park');
  });

  it('ranks a higher-credibility source above a lower one, otherwise equal', () => {
    const strong = source({ url: 'https://a.com/1', credibility: 0.9, content: 'Dana Cho is VP Finance at Acme overseeing all operations.' });
    const weak = source({ url: 'https://b.com/1', credibility: 0.4, content: 'Kim Choi is VP Finance at Acme overseeing all operations.' });
    const ranked = rankCandidates(
      [
        candidate({ name: 'Dana Cho', linkedin_url: null, sourceUrl: strong.url, quote: 'Dana Cho is VP Finance at Acme' }),
        candidate({ name: 'Kim Choi', linkedin_url: null, sourceUrl: weak.url, quote: 'Kim Choi is VP Finance at Acme' }),
      ],
      [strong, weak],
      ['VP Finance'],
      'accounts payable',
    );
    expect(ranked[0].name).toBe('Dana Cho');
  });

  it('deduplicates the same person surfaced by more than one query', () => {
    const s1 = source({ url: 'https://a.com/1', content: 'Jamie Fox is VP Finance at Acme overseeing operations.' });
    const s2 = source({ url: 'https://b.com/1', content: 'Jamie Fox, VP Finance, Acme, leads the finance team.' });
    const ranked = rankCandidates(
      [
        candidate({ name: 'Jamie Fox', sourceUrl: s1.url, quote: 'Jamie Fox is VP Finance at Acme' }),
        candidate({ name: 'jamie fox', sourceUrl: s2.url, quote: 'Jamie Fox, VP Finance, Acme, leads the finance team' }),
      ],
      [s1, s2],
      ['VP Finance'],
      'accounts payable',
    );
    expect(ranked).toHaveLength(1);
  });

  it('produces a stable order across repeated calls with the same input', () => {
    const s = source({ url: 'https://a.com/1' });
    const input: ProposedCandidate[] = [candidate({ sourceUrl: s.url })];
    const a = rankCandidates(input, [s], ['VP Finance'], 'accounts payable');
    const b = rankCandidates(input, [s], ['VP Finance'], 'accounts payable');
    expect(a).toEqual(b);
  });

  it('an empty proposal list yields an empty, honest result', () => {
    expect(rankCandidates([], [source()], ['VP Finance'], 'accounts payable')).toEqual([]);
  });

  it('every returned candidate carries a reason grounded in the qualified workflow', () => {
    const s = source({ url: 'https://a.com/1' });
    const ranked = rankCandidates([candidate({ sourceUrl: s.url })], [s], ['VP Finance'], 'accounts payable and invoice processing');
    expect(ranked[0].reason).toMatch(/accounts payable and invoice processing/);
  });

  it('confidence is bounded 0-100', () => {
    const s = source({ url: 'https://a.com/1', credibility: 1 });
    const ranked = rankCandidates([candidate({ sourceUrl: s.url })], [s], ['VP Finance'], 'x');
    expect(ranked[0].confidence).toBeGreaterThanOrEqual(0);
    expect(ranked[0].confidence).toBeLessThanOrEqual(100);
  });
});

describe('malformed provider/model responses are rejected, never crash ranking', () => {
  it('a candidate missing a quote entirely is dropped, not thrown on', () => {
    const s = source({ url: 'https://a.com/1' });
    const malformed = { ...candidate({ sourceUrl: s.url }), quote: '' };
    expect(() => rankCandidates([malformed], [s], ['VP Finance'], 'x')).not.toThrow();
    expect(rankCandidates([malformed], [s], ['VP Finance'], 'x')).toEqual([]);
  });

  it('a candidate with an empty role is rejected by the role gate, not thrown on', () => {
    const s = source({ url: 'https://a.com/1' });
    const malformed = candidate({ sourceUrl: s.url, role: '' });
    expect(() => rankCandidates([malformed], [s], ['VP Finance'], 'x')).not.toThrow();
    expect(rankCandidates([malformed], [s], ['VP Finance'], 'x')).toEqual([]);
  });

  it('a source list containing an entry with missing optional fields does not crash ranking', () => {
    const bare = {
      url: 'https://a.com/1',
      canonical_url: 'https://a.com/1',
      title: '',
      snippet: '',
      source_type: 'web',
      credibility: null,
      published_date: null,
      providers: [],
      queries: [],
      categories: [],
      duplicate_count: 0,
      retrieved_at: '2026-01-01T00:00:00Z',
      content: null,
      fetch_status: 'snippet_only',
    } as unknown as NormalizedSource;
    expect(() => rankCandidates([candidate({ sourceUrl: bare.url })], [bare], ['VP Finance'], 'x')).not.toThrow();
  });
});

describe('empty candidate result is handled honestly, not padded', () => {
  it('zero proposed candidates yields zero ranked candidates, not an error', () => {
    expect(rankCandidates([], [], [], 'x')).toEqual([]);
  });

  it('candidates that all fail the evidence or role gate yield an empty, not a crash', () => {
    const s = source({ url: 'https://a.com/1', content: 'Nothing relevant here at all.' });
    const c = candidate({ sourceUrl: s.url, quote: 'This text was never retrieved anywhere' });
    expect(rankCandidates([c], [s], ['VP Finance'], 'x')).toEqual([]);
  });
});

describe('no candidate is ever automatically selected', () => {
  it('ranking and verification never set an identity_status or a selection', () => {
    // rankCandidates' output is the PROPOSAL surfaced to a human — it carries
    // no selection or verification state of any kind. Those only exist once
    // a human calls the dedicated /select endpoint for a specific candidate.
    const s = source({ url: 'https://a.com/1' });
    const ranked = rankCandidates([candidate({ sourceUrl: s.url })], [s], ['VP Finance'], 'x');
    for (const c of ranked) {
      expect(c).not.toHaveProperty('identity_status');
      expect(c).not.toHaveProperty('selected_at');
      expect(c).not.toHaveProperty('resulting_run_id');
    }
  });
});

describe('the stage is visible in the UI only when it actually did something', () => {
  it('is hidden when the prospect already qualified — nothing to show', () => {
    expect(contactCandidatesStageIsVisible({ skipped: true, reason: 'PROSPECT_QUALIFIED' })).toBe(false);
  });

  it('is hidden when the company did not qualify either', () => {
    expect(contactCandidatesStageIsVisible({ skipped: true, reason: 'COMPANY_NOT_QUALIFIED' })).toBe(false);
  });

  it('is hidden when no company was resolved to search for', () => {
    expect(contactCandidatesStageIsVisible({ skipped: true, reason: 'NO_COMPANY' })).toBe(false);
  });

  it('is shown when the state applies but no roles could be derived', () => {
    // Still the applicable state — an honest empty result, not an absence.
    expect(contactCandidatesStageIsVisible({ applicable: true, candidates: [], roles: [], reason: 'NO_OBSERVED_WORKFLOW' })).toBe(true);
  });

  it('is shown when candidates were actually found', () => {
    expect(contactCandidatesStageIsVisible({ applicable: true, candidates: [{ name: 'Jane' }], roles: ['VP Finance'] })).toBe(true);
  });

  it('is hidden for a run that has not reached this stage yet', () => {
    expect(contactCandidatesStageIsVisible(null)).toBe(false);
    expect(contactCandidatesStageIsVisible(undefined)).toBe(false);
  });

  it('is hidden for malformed or unexpected output shapes, never shown by default', () => {
    expect(contactCandidatesStageIsVisible('applicable')).toBe(false);
    expect(contactCandidatesStageIsVisible(42)).toBe(false);
    expect(contactCandidatesStageIsVisible({})).toBe(false);
    expect(contactCandidatesStageIsVisible({ applicable: 'true' })).toBe(false);
  });
});
