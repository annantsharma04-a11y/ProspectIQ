import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rolesForWorkflows } from '@/lib/contacts/roles';
import { isCurrentProspect } from '@/lib/contacts/rank';
import { preVerifyCandidate } from '@/lib/contacts/preverify';
import { combineQualification, type CompanyFit, type ProspectFit, type TargetQualification } from '@/lib/qualification/types';
import type { RunRow } from '@/lib/types';

// Two fixes from the Shravan Koti / Zerodha case:
//
//   1. lib/contacts/roles.ts's security|compliance|risk|kyc|aml|fraud family
//      listed CISO as an owner of KYC/compliance workflows. A CISO owns
//      cybersecurity, not KYC/AML review — that's the exact mismatch that let
//      candidate discovery suggest Shravan Koti (CISO) for a KYC/AP workflow
//      while direct prospect qualification correctly rejected him as
//      NOT_QUALIFIED for the same reason. The security and compliance/risk
//      keyword families are now split, and CISO no longer appears in the
//      compliance/KYC family's role list.
//
//   2. findContactCandidatesStage never excluded the run's OWN subject from
//      "alternative contact" suggestions, so a company's current, already-
//      submitted prospect could be proposed back to the user as though they
//      were someone else. lib/contacts/rank.ts's isCurrentProspect() closes
//      that, checked before ranking/pre-verification/persistence.

describe('1. KYC/compliance workflows no longer search CISO', () => {
  it('KYC keyword alone does not resolve to CISO', () => {
    const roles = rolesForWorkflows(['Regulated onboarding requires KYC and KYB verification']);
    expect(roles).not.toContain('CISO');
  });

  it('"compliance" and "aml" alone do not resolve to CISO either', () => {
    expect(rolesForWorkflows(['compliance review process'])).not.toContain('CISO');
    expect(rolesForWorkflows(['AML screening for new accounts'])).not.toContain('CISO');
  });
});

describe('2. security workflows still search CISO', () => {
  it('a plain "security" workflow still resolves to CISO', () => {
    const roles = rolesForWorkflows(['Reduces the security incident response burden']);
    expect(roles).toContain('CISO');
    expect(roles).toContain('Head of Security');
  });
});

describe('3. existing compliance/risk roles still work', () => {
  it('KYC/compliance language still resolves to the compliance/risk titles, minus CISO', () => {
    const roles = rolesForWorkflows(['Regulated onboarding requires KYC and KYB verification']);
    expect(roles).toContain('Chief Compliance Officer');
    expect(roles).toContain('Head of Risk');
    expect(roles).toContain('Head of Trust and Safety');
  });

  it('"risk" and "fraud" keywords still match the compliance family', () => {
    for (const term of ['risk', 'fraud']) {
      const roles = rolesForWorkflows([term]);
      expect(roles).toContain('Chief Compliance Officer');
    }
  });
});

describe('4. a Shravan-shaped CISO candidate is not eligible for KYC/compliance discovery', () => {
  it('role_consistent is false, and the candidate is NEEDS_VERIFICATION not ELIGIBLE', () => {
    const targetRoles = rolesForWorkflows(['KYC and AML onboarding review for regulated accounts']);
    expect(targetRoles).not.toContain('CISO'); // sanity: the fix actually changed the search list

    const result = preVerifyCandidate(
      {
        name: 'Shravan Koti',
        role: 'CISO',
        company: 'Zerodha',
        linkedin_url: 'https://www.linkedin.com/in/shravankoti',
        evidence: [{ source_url: 'https://example.com/zerodha-leadership', quote: 'Shravan Koti is CISO at Zerodha.' }],
      },
      { targetRoles },
    );

    expect(result.checks.role_consistent).toBe(false);
    expect(result.eligibility).toBe('NEEDS_VERIFICATION');
    expect(result.blockedReason).toBe('This role does not match an owner of the qualified workflow.');
  });

  it('the same CISO candidate IS eligible for a security workflow — the check is workflow-specific, not a blanket ban', () => {
    const targetRoles = rolesForWorkflows(['security incident response and infrastructure hardening']);
    const result = preVerifyCandidate(
      {
        name: 'Shravan Koti',
        role: 'CISO',
        company: 'Zerodha',
        linkedin_url: 'https://www.linkedin.com/in/shravankoti',
        evidence: [{ source_url: 'https://example.com/zerodha-leadership', quote: 'Shravan Koti is CISO at Zerodha.' }],
      },
      { targetRoles },
    );

    expect(result.checks.role_consistent).toBe(true);
    expect(result.eligibility).toBe('ELIGIBLE');
  });
});

describe('5. current prospect excluded by LinkedIn URL', () => {
  it('matches on normalized URL regardless of case', () => {
    expect(
      isCurrentProspect(
        { name: 'Anyone', linkedin_url: 'https://www.linkedin.com/in/Nithin-Kamath', company: 'Zerodha' },
        { linkedin_url: 'https://www.linkedin.com/in/nithin-kamath', name: 'Nithin Kamath', company: 'Zerodha' },
      ),
    ).toBe(true);
  });

  it('a URL mismatch is not excluded even if names happen to be similar', () => {
    expect(
      isCurrentProspect(
        { name: 'Nithin Kamath', linkedin_url: 'https://www.linkedin.com/in/someone-else', company: 'Zerodha' },
        { linkedin_url: 'https://www.linkedin.com/in/nithin-kamath', name: 'Nithin Kamath', company: 'Zerodha' },
      ),
    ).toBe(false);
  });
});

describe('6. current prospect excluded by normalized name + company when URL is unavailable', () => {
  it('matches on name + company when neither side has a URL', () => {
    expect(
      isCurrentProspect(
        { name: 'Nithin Kamath', linkedin_url: null, company: 'Zerodha' },
        { linkedin_url: null, name: 'Nithin Kamath', company: 'Zerodha' },
      ),
    ).toBe(true);
  });

  it('is case- and punctuation-insensitive', () => {
    expect(
      isCurrentProspect(
        { name: 'nithin KAMATH', linkedin_url: null, company: 'Zerodha Broking Ltd.' },
        { linkedin_url: null, name: 'Nithin Kamath', company: 'Zerodha Broking Ltd' },
      ),
    ).toBe(true);
  });

  it('requires BOTH name and company to match, not just one', () => {
    expect(
      isCurrentProspect(
        { name: 'Nithin Kamath', linkedin_url: null, company: 'A Different Company' },
        { linkedin_url: null, name: 'Nithin Kamath', company: 'Zerodha' },
      ),
    ).toBe(false);
  });
});

describe('7. a different person at the same company remains eligible', () => {
  it('same company, different name — not excluded', () => {
    expect(
      isCurrentProspect(
        { name: 'Shravan Koti', linkedin_url: null, company: 'Zerodha' },
        { linkedin_url: null, name: 'Nithin Kamath', company: 'Zerodha' },
      ),
    ).toBe(false);
  });

  it('same company, different LinkedIn URL — not excluded even though names could coincidentally overlap in tokens', () => {
    expect(
      isCurrentProspect(
        { name: 'Nithin K Rao', linkedin_url: 'https://www.linkedin.com/in/nithin-k-rao', company: 'Zerodha' },
        { linkedin_url: 'https://www.linkedin.com/in/nithin-kamath', name: 'Nithin Kamath', company: 'Zerodha' },
      ),
    ).toBe(false);
  });
});

// ─── 8: full stage wiring — the current prospect never reaches persistence ──

const mockStartStage = vi.fn();
const mockFinishStage = vi.fn();
const mockDiscoverContacts = vi.fn();
const mockCreateContactCandidates = vi.fn();
const mockReplaceSources = vi.fn();

vi.mock('@/lib/supabase/queries', () => ({
  startStage: (...a: unknown[]) => mockStartStage(...a),
  finishStage: (...a: unknown[]) => mockFinishStage(...a),
  createContactCandidates: (...a: unknown[]) => mockCreateContactCandidates(...a),
  replaceSources: (...a: unknown[]) => mockReplaceSources(...a),
  markSignalAsHook: vi.fn(),
  replaceSignals: vi.fn(),
  updateRun: vi.fn(),
  createDraft: vi.fn(),
  deleteDrafts: vi.fn(),
  skipRemainingStages: vi.fn(),
  listSignals: vi.fn().mockResolvedValue([]),
}));

// contacts/rank is deliberately NOT mocked here — this exercises the REAL
// rankCandidates/roleMatches/isCurrentProspect, the actual production wiring.
vi.mock('@/lib/contacts/discover', () => ({ discoverContacts: (...a: unknown[]) => mockDiscoverContacts(...a) }));

const { findContactCandidatesStage } = await import('@/lib/pipeline/stages');
const { newContext } = await import('@/lib/pipeline/context');

const ev = (url: string, quote = 'A verified verbatim excerpt supporting the claim.') => ({ url, quote });

const prospect = (over: Partial<ProspectFit> = {}): ProspectFit => ({
  score: 55,
  classification: 'MEDIUM',
  role: 'CISO',
  seniority: 'C-level',
  relevance_reason: 'Security leadership does not own KYC/AP workflows.',
  decision_authority: 'MEDIUM',
  product_relevance: 'LOW',
  why_this_person: [],
  why_not_this_person: ['CISO does not own the finance/AP/KYC workflows sold.'],
  missing_information: [],
  evidence_basis: 'INFERRED',
  evidence: [],
  ...over,
});

const company = (over: Partial<CompanyFit> = {}): CompanyFit => ({
  score: 78,
  classification: 'HIGH',
  industry: 'Fintech',
  company_size: '1,000+',
  relevant_workflows: ['KYC'],
  capability_matches: [
    {
      capability_id: 'kyc_review',
      capability_name: 'KYC and AML onboarding review',
      company_signal: 'Regulated brokerage onboarding requires KYC and AML verification at scale.',
      fit_strength: 80,
      evidence: [ev('https://example.com/zerodha-report')],
      basis: 'OBSERVED',
      reason: 'Regulated brokerage with high account-opening volume.',
    },
  ],
  fit_reasons: [{ reason: 'Plausible KYC automation use case.', basis: 'OBSERVED', evidence: [ev('https://example.com/zerodha-report')] }],
  missing_information: [],
  evidence_basis: 'OBSERVED',
  evidence_adjustment: null,
  ...over,
});

function qualification(p: ProspectFit, c: CompanyFit): TargetQualification {
  const decision = combineQualification(p, c);
  return { prospect_fit: p, company_fit: c, ...decision };
}

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'run-1',
    linkedin_url: 'https://www.linkedin.com/in/nithin-kamath',
    linkedin_slug: 'nithin-kamath',
    input_name: 'Nithin Kamath',
    input_company: 'Zerodha',
    input_title: 'Founder and CEO',
    user_id: 'user-1',
    prospect_id: null,
    status: 'running',
    ...over,
  }) as RunRow;

beforeEach(() => {
  vi.clearAllMocks();
  mockStartStage.mockResolvedValue('stage-id');
  mockFinishStage.mockResolvedValue(undefined);
  mockReplaceSources.mockResolvedValue([]);
  mockCreateContactCandidates.mockResolvedValue([]);
});

describe('8. the current prospect cannot be persisted as a discovered candidate', () => {
  it('a proposed candidate matching the run\'s own subject (by name+company, no URL) is dropped before ranking/persistence', async () => {
    const ctx = newContext(run());
    // NOT_QUALIFIED prospect (CISO, doesn't own KYC) at a QUALIFIED company —
    // action FIND_BETTER_CONTACT, exactly the real Zerodha case.
    ctx.qualification = qualification(prospect({ score: 20, classification: 'LOW' }), company());
    expect(ctx.qualification.action).toBe('FIND_BETTER_CONTACT');

    mockDiscoverContacts.mockResolvedValue({
      proposed: [
        // The current prospect proposed back — no URL, so must be caught by
        // the name+company fallback.
        {
          name: 'Nithin Kamath',
          role: 'Chief Compliance Officer',
          linkedin_url: null,
          quote: 'Nithin Kamath oversees compliance posture at Zerodha.',
          sourceUrl: 'https://example.com/zerodha-org',
        },
        // A genuinely different person at the same company — must survive.
        {
          name: 'Priya Menon',
          role: 'Chief Compliance Officer',
          linkedin_url: 'https://www.linkedin.com/in/priya-menon-compliance',
          quote: 'Priya Menon is Zerodha\'s Chief Compliance Officer overseeing KYC operations.',
          sourceUrl: 'https://example.com/zerodha-compliance-lead',
        },
      ],
      // Priya's candidacy still has to clear rankCandidates()'s own,
      // pre-existing evidence gate (lib/contacts/rank.ts: the quote must
      // appear verbatim in a source that was actually retrieved) — that gate
      // is untouched by this fix, so the fixture backs her quote with a real
      // retrieved source, the same way discoverContacts() would in
      // production. Nithin's candidate needs no such source: it is dropped
      // by isCurrentProspect() before it ever reaches ranking.
      sources: [
        {
          url: 'https://example.com/zerodha-compliance-lead',
          canonical_url: 'https://example.com/zerodha-compliance-lead',
          title: "Zerodha names Priya Menon Chief Compliance Officer",
          snippet: '',
          source_type: 'web',
          credibility: 0.6,
          published_date: null,
          providers: ['tavily'],
          queries: [],
          categories: ['contact_discovery'],
          duplicate_count: 0,
          retrieved_at: '2026-01-01T00:00:00Z',
          content: 'Priya Menon is Zerodha\'s Chief Compliance Officer overseeing KYC operations.',
          fetch_status: 'snippet_only',
        },
      ],
      roles: ['Chief Compliance Officer', 'Head of Risk', 'Head of Trust and Safety'],
      queriesRun: 1,
      queriesOk: 1,
    });

    await findContactCandidatesStage(ctx);

    expect(ctx.contactCandidates).not.toBeNull();
    const names = (ctx.contactCandidates ?? []).map((c) => c.name);
    expect(names).not.toContain('Nithin Kamath');
    expect(names).toContain('Priya Menon');

    // Never even reaches the persistence call for the excluded person.
    expect(mockCreateContactCandidates).toHaveBeenCalledTimes(1);
    const persistedNames = (mockCreateContactCandidates.mock.calls[0][1] as { name: string }[]).map((c) => c.name);
    expect(persistedNames).not.toContain('Nithin Kamath');
    expect(persistedNames).toContain('Priya Menon');
  });

  it('a proposed candidate matching the run\'s own subject BY URL is dropped even if the name text differs slightly', async () => {
    const ctx = newContext(run());
    ctx.qualification = qualification(prospect({ score: 20, classification: 'LOW' }), company());

    mockDiscoverContacts.mockResolvedValue({
      proposed: [
        {
          // Slightly different name text, but the SAME LinkedIn URL as the run's own subject.
          name: 'N. Kamath',
          role: 'Chief Compliance Officer',
          linkedin_url: 'https://www.linkedin.com/in/nithin-kamath',
          quote: 'N. Kamath is involved in compliance oversight at Zerodha.',
          sourceUrl: 'https://example.com/zerodha-org-chart',
        },
      ],
      sources: [],
      roles: ['Chief Compliance Officer'],
      queriesRun: 1,
      queriesOk: 1,
    });

    await findContactCandidatesStage(ctx);

    expect(ctx.contactCandidates).toEqual([]);
    expect(mockCreateContactCandidates).not.toHaveBeenCalled();
  });
});

describe('9. existing pre-verification behavior is unchanged for unrelated families', () => {
  it('an accounts-payable-family candidate with a matching role is still ELIGIBLE', () => {
    const targetRoles = rolesForWorkflows(['accounts payable invoice automation']);
    const result = preVerifyCandidate(
      {
        name: 'Jordan Lee',
        role: 'VP Finance',
        company: 'Acme Corp',
        linkedin_url: 'https://www.linkedin.com/in/jordan-lee-finance',
        evidence: [{ source_url: 'https://example.com/acme-finance', quote: 'Jordan Lee leads Finance at Acme Corp.' }],
      },
      { targetRoles },
    );
    expect(result.eligibility).toBe('ELIGIBLE');
    expect(result.checks.role_consistent).toBe(true);
  });

  it('the EXCLUDED/NEEDS_VERIFICATION ordering and reasons for missing name/URL/evidence are untouched', () => {
    const noName = preVerifyCandidate(
      { name: null, role: 'CFO', company: 'Acme', linkedin_url: 'https://www.linkedin.com/in/x', evidence: [] },
      {},
    );
    expect(noName.eligibility).toBe('EXCLUDED');
    expect(noName.blockedReason).toBe('No name was established for this candidate.');
  });
});
