// Identity resolution — deterministic.
//
// When the LinkedIn provider returns a profile, identity is a data-mapping
// problem, not a reasoning problem: the profile states the name, company and
// role outright. No model call is needed or wanted here.
//
// When there is no profile, we carry the user's hints plus a slug-derived name
// guess into research, and the single analysis call resolves identity properly
// from the evidence it reads.

import type { LinkedInProfile } from '@/lib/linkedin/profile';

export interface ResolvedIdentity {
  resolved: boolean;
  full_name: string | null;
  company: string | null;
  company_domain: string | null;
  role: string | null;
  location: string | null;
  /** 0–100. Reflects evidence strength; never rounded up. */
  confidence: number;
  reasoning: string;
  ambiguous: boolean;
  /** 'profile' when it came from direct profile data, else 'provisional'. */
  basis: 'profile' | 'user_hints' | 'slug_guess' | 'unresolved';
}

export interface IdentitySeed {
  slug: string;
  nameHint: string | null;
  userName: string | null;
  userCompany: string | null;
  userTitle: string | null;
}

/**
 * Build the identity we can justify right now, before any analysis.
 * Precedence: profile data > user-supplied hints > slug guess.
 */
export function resolveIdentity(
  profile: LinkedInProfile | null,
  seed: IdentitySeed,
): ResolvedIdentity {
  if (profile && (profile.name || profile.currentCompany?.name)) {
    const company = profile.currentCompany?.name ?? seed.userCompany ?? null;
    const role = profile.currentCompany?.title ?? seed.userTitle ?? profile.headline ?? null;

    return {
      resolved: Boolean(profile.name),
      full_name: profile.name ?? seed.userName,
      company,
      company_domain: domainFromUrl(profile.currentCompany?.url ?? null),
      role,
      location: profile.location,
      // Direct profile data is the strongest evidence available to this app.
      confidence: profile.name && company ? 95 : profile.name ? 80 : 60,
      reasoning: 'Identity taken directly from the retrieved LinkedIn profile.',
      ambiguous: false,
      basis: 'profile',
    };
  }

  if (seed.userName || seed.userCompany) {
    return {
      resolved: Boolean(seed.userName),
      full_name: seed.userName,
      company: seed.userCompany,
      company_domain: null,
      role: seed.userTitle,
      location: null,
      // User-supplied, but uncorroborated until the analysis reads the evidence.
      confidence: seed.userName && seed.userCompany ? 60 : 40,
      reasoning: 'No profile data; using the details you supplied, pending corroboration from public sources.',
      ambiguous: false,
      basis: 'user_hints',
    };
  }

  if (seed.nameHint) {
    return {
      resolved: false,
      full_name: seed.nameHint,
      company: null,
      company_domain: null,
      role: null,
      location: null,
      // A slug is weak evidence of a name and nothing else.
      confidence: 20,
      reasoning: 'No profile data and no hints; name inferred from the profile URL only.',
      ambiguous: false,
      basis: 'slug_guess',
    };
  }

  return {
    resolved: false,
    full_name: null,
    company: null,
    company_domain: null,
    role: null,
    location: null,
    confidence: 0,
    reasoning: 'No profile data, no hints, and no name could be inferred from the URL.',
    ambiguous: false,
    basis: 'unresolved',
  };
}

/**
 * Merge what the analysis concluded on top of the pre-analysis identity.
 * Profile-sourced fields win: the model may not override retrieved facts.
 */
export function mergeAnalysisIdentity(
  base: ResolvedIdentity,
  analysed: {
    name: string | null;
    currentCompany: string | null;
    currentRole: string | null;
    location: string | null;
    identityConfidence: number;
    identityNotes: string | null;
    ambiguous: boolean;
  },
): ResolvedIdentity {
  const fromProfile = base.basis === 'profile';

  return {
    resolved: base.resolved || Boolean(analysed.name),
    full_name: fromProfile ? (base.full_name ?? analysed.name) : (analysed.name ?? base.full_name),
    company: fromProfile ? (base.company ?? analysed.currentCompany) : (analysed.currentCompany ?? base.company),
    company_domain: base.company_domain,
    role: fromProfile ? (base.role ?? analysed.currentRole) : (analysed.currentRole ?? base.role),
    location: base.location ?? analysed.location,
    confidence: fromProfile ? Math.max(base.confidence, analysed.identityConfidence) : analysed.identityConfidence,
    reasoning: analysed.identityNotes ?? base.reasoning,
    ambiguous: fromProfile ? false : analysed.ambiguous,
    basis: base.basis,
  };
}

function domainFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    // A linkedin.com/company/... URL is not the company's own domain.
    return host.endsWith('linkedin.com') ? null : host;
  } catch {
    return null;
  }
}
