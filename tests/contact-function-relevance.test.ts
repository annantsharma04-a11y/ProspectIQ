import { describe, it, expect } from 'vitest';
import { rolesForWorkflows } from '@/lib/contacts/roles';
import { roleMatches } from '@/lib/contacts/rank';
import { preVerifyCandidate } from '@/lib/contacts/preverify';

// The Sanjay Mehra / AJIO case: candidate discovery searched for
// ['CFO', 'Head of Payments', 'VP Engineering', 'COO', 'VP Finance'] for a
// company whose ONLY qualified capabilities were accounts-payable automation
// and chargeback/dispute handling — neither an engineering nor a physical-
// operations workflow. "VP Engineering" and "COO" entered that list purely
// because the free-form company_signal text used the generic business words
// "platform" ("an online retail platform...") and "operations" ("large-scale
// e-commerce operations...") — words that describe the COMPANY in ordinary
// business English, not the FUNCTION that owns the qualified workflow.
// Sanjay Mehra (COO) was then proposed, passed role_consistent trivially
// (his exact title was already sitting in the search list), and only failed
// at the much more expensive full identity-verification step — producing
// the contradictory PARTIAL card this fix's predecessor (the UI-consistency
// fix) made honest, but did not address the root cause: the candidate
// should never have been searched for in the first place.
//
// The fix — narrowing the "engineering" and "operations" role families in
// lib/contacts/roles.ts to drop their two overly-generic bare-word triggers
// ("platform", "operations") — is the same principle as the earlier
// CISO/KYC fix: a role family must trigger on words that are actually
// specific to the FUNCTION it names, not words that merely co-occur with a
// free-form description of the company or its qualified workflow.

const AP_SIGNALS = ['Large-scale e-commerce operations involving extensive vendor and brand partnerships across India.', 'Accounts payable automation'];
const CHARGEBACK_SIGNALS = ['Consumer-facing online retail platform processing nationwide online transactions and deliveries.', 'Chargeback and dispute handling'];
const KYC_SIGNALS = ['Regulated onboarding requires KYC and KYB verification'];
const SECURITY_SIGNALS = ['Reduces the security incident response burden'];

const ev = (quote: string, url = 'https://example.com/a') => ({ source_url: url, quote });

describe('1. a relevant Finance/AP leader remains eligible', () => {
  it('a CFO with matching evidence passes role_consistent and is ELIGIBLE', () => {
    const targetRoles = rolesForWorkflows(AP_SIGNALS);
    expect(targetRoles).toContain('CFO');

    const result = preVerifyCandidate(
      {
        name: 'Meera Nair',
        role: 'Chief Financial Officer',
        company: 'AJIO.com',
        linkedin_url: 'https://www.linkedin.com/in/meera-nair-cfo',
        evidence: [ev('Meera Nair is Chief Financial Officer at AJIO.com.')],
      },
      { targetRoles },
    );
    expect(result.checks.role_consistent).toBe(true);
    expect(result.eligibility).toBe('ELIGIBLE');
  });
});

describe('2. a relevant Payments/Risk leader remains eligible', () => {
  it('a Head of Payments with matching evidence passes role_consistent and is ELIGIBLE', () => {
    const targetRoles = rolesForWorkflows(CHARGEBACK_SIGNALS);
    expect(targetRoles).toContain('Head of Payments');

    const result = preVerifyCandidate(
      {
        name: 'Arjun Verma',
        role: 'Head of Payments',
        company: 'AJIO.com',
        linkedin_url: 'https://www.linkedin.com/in/arjun-verma-payments',
        evidence: [ev('Arjun Verma leads Payments at AJIO.com.')],
      },
      { targetRoles },
    );
    expect(result.checks.role_consistent).toBe(true);
    expect(result.eligibility).toBe('ELIGIBLE');
  });
});

describe('3. an unrelated senior executive is not surfaced merely for seniority or company', () => {
  it('COO is no longer in the search list for the exact real AJIO AP+chargebacks workflow signals', () => {
    const targetRoles = rolesForWorkflows([...AP_SIGNALS, ...CHARGEBACK_SIGNALS]);
    expect(targetRoles).not.toContain('COO');
    expect(targetRoles).not.toContain('VP Engineering');
    expect(targetRoles).not.toContain('VP Operations');
    expect(targetRoles).not.toContain('Head of Operations');
  });

  it('the real Sanjay Mehra shape (COO) fails role_consistent against the corrected search list', () => {
    const targetRoles = rolesForWorkflows([...AP_SIGNALS, ...CHARGEBACK_SIGNALS]);
    const result = preVerifyCandidate(
      {
        name: 'Sanjay Mehra',
        role: 'Chief Operating Officer',
        company: 'AJIO.com',
        linkedin_url: 'https://www.linkedin.com/in/sanjay-mehra',
        evidence: [ev('Sanjay Mehra - Chief Operating Officer (COO)', 'https://www.highperformr.ai/company/ajio')],
      },
      { targetRoles },
    );
    expect(result.checks.role_consistent).toBe(false);
    expect(result.eligibility).toBe('NEEDS_VERIFICATION');
    expect(result.blockedReason).toBe('This role does not match an owner of the qualified workflow.');
  });

  it('seniority alone does not satisfy roleMatches — a senior title with no functional overlap fails', () => {
    const targetRoles = rolesForWorkflows(AP_SIGNALS);
    expect(roleMatches('Chief Operating Officer', targetRoles)).toBe(false);
    expect(roleMatches('Chief Marketing Officer', targetRoles)).toBe(false);
  });
});

describe('4. CISO/KYC behavior remains fixed', () => {
  it('KYC workflows still do not search CISO', () => {
    expect(rolesForWorkflows(KYC_SIGNALS)).not.toContain('CISO');
  });

  it('security workflows still search CISO', () => {
    expect(rolesForWorkflows(SECURITY_SIGNALS)).toContain('CISO');
  });

  it('this fix did not touch the compliance/risk family\'s own roles', () => {
    const targetRoles = rolesForWorkflows(KYC_SIGNALS);
    expect(targetRoles).toContain('Chief Compliance Officer');
    expect(targetRoles).toContain('Head of Risk');
    expect(targetRoles).toContain('Head of Trust and Safety');
  });
});

describe('5. a candidate already known to be PARTIAL is not selectable, regardless of role', () => {
  it('PARTIAL status blocks selection even for a genuinely on-target Finance role', async () => {
    const { canSelectCandidate } = await import('@/lib/contacts/select-ui');
    expect(
      canSelectCandidate({
        identity_status: 'PARTIAL',
        linkedin_url: 'https://www.linkedin.com/in/meera-nair-cfo',
        name: 'Meera Nair',
        role: 'Chief Financial Officer',
        company: 'AJIO.com',
        evidence: [ev('Meera Nair is Chief Financial Officer at AJIO.com.')],
      }),
    ).toBe(false);
  });
});

describe('6. different people at the same company are still considered normally', () => {
  it('a Finance leader at AJIO is eligible while a COO at the SAME company is not — this is a function gate, not a company-wide block', () => {
    const targetRoles = rolesForWorkflows([...AP_SIGNALS, ...CHARGEBACK_SIGNALS]);

    const financeLeader = preVerifyCandidate(
      {
        name: 'Meera Nair',
        role: 'Chief Financial Officer',
        company: 'AJIO.com',
        linkedin_url: 'https://www.linkedin.com/in/meera-nair-cfo',
        evidence: [ev('Meera Nair is Chief Financial Officer at AJIO.com.')],
      },
      { targetRoles },
    );
    const coo = preVerifyCandidate(
      {
        name: 'Sanjay Mehra',
        role: 'Chief Operating Officer',
        company: 'AJIO.com',
        linkedin_url: 'https://www.linkedin.com/in/sanjay-mehra',
        evidence: [ev('Sanjay Mehra - Chief Operating Officer (COO)', 'https://www.highperformr.ai/company/ajio')],
      },
      { targetRoles },
    );

    expect(financeLeader.eligibility).toBe('ELIGIBLE');
    expect(coo.eligibility).toBe('NEEDS_VERIFICATION');
  });

  it('a different, genuinely on-target person is unaffected by another candidate at the same company failing', () => {
    const targetRoles = rolesForWorkflows(CHARGEBACK_SIGNALS);
    const paymentsLead = preVerifyCandidate(
      {
        name: 'Arjun Verma',
        role: 'VP Payments',
        company: 'AJIO.com',
        linkedin_url: 'https://www.linkedin.com/in/arjun-verma-payments',
        evidence: [ev('Arjun Verma is VP Payments at AJIO.com.')],
      },
      { targetRoles },
    );
    expect(paymentsLead.eligibility).toBe('ELIGIBLE');
  });
});
