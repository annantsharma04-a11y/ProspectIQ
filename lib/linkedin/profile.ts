// ProspectIQ's internal LinkedIn profile schema.
//
// Provider-neutral: Bright Data is the current source, but nothing downstream
// knows that. Every field is nullable because profile completeness varies
// enormously between profiles — missing data is represented, never invented.

export interface LinkedInExperience {
  company: string | null;
  title: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  description: string | null;
}

export interface LinkedInEducation {
  institution: string | null;
  degree: string | null;
  fieldOfStudy: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface LinkedInProfile {
  url: string;
  name: string | null;
  headline: string | null;
  about: string | null;
  location: string | null;
  currentCompany: {
    name: string | null;
    url: string | null;
    title: string | null;
  } | null;
  experience: LinkedInExperience[];
  education: LinkedInEducation[];
  skills: string[];
  posts: unknown[];
  followers: number | null;
  connections: number | null;
}

/** Where the profile data came from, and how complete it is. */
export type PrimarySource = 'brightdata' | 'public_web';
export type ProfileCompleteness = 'full' | 'partial' | 'none';

export interface ProfileAccess {
  directLinkedIn: boolean;
  primarySource: PrimarySource;
  profileCompleteness: ProfileCompleteness;
  /** Present when direct retrieval failed or returned partial data. */
  reason: string | null;
}

/** Attribution recorded alongside any profile-derived evidence. */
export interface ProfileSourceMeta {
  source: 'brightdata';
  source_type: 'linkedin_profile';
  direct_linkedin_access: boolean;
  retrieved_at: string;
}

/**
 * A profile is "full" when the fields that actually drive research are present:
 * a name plus either a current company or some work history.
 */
export function assessCompleteness(profile: LinkedInProfile): ProfileCompleteness {
  const hasName = Boolean(profile.name);
  const hasEmployer = Boolean(profile.currentCompany?.name) || profile.experience.length > 0;
  const hasContext = Boolean(profile.headline || profile.about) || profile.experience.length > 0;

  if (hasName && hasEmployer && hasContext) return 'full';
  if (hasName || hasEmployer) return 'partial';
  return 'none';
}

/** Compact profile rendering for LLM prompts. Omits empty sections entirely. */
export function renderProfile(profile: LinkedInProfile): string {
  const lines: string[] = [`LinkedIn profile (retrieved directly): ${profile.url}`];

  if (profile.name) lines.push(`name: ${profile.name}`);
  if (profile.headline) lines.push(`headline: ${profile.headline}`);
  if (profile.location) lines.push(`location: ${profile.location}`);
  if (profile.currentCompany) {
    const c = profile.currentCompany;
    lines.push(
      `current company: ${c.name ?? 'unknown'}${c.title ? ` (title: ${c.title})` : ''}${c.url ? ` [${c.url}]` : ''}`,
    );
  }
  if (profile.followers !== null) lines.push(`followers: ${profile.followers}`);
  if (profile.connections !== null) lines.push(`connections: ${profile.connections}`);
  if (profile.about) lines.push(`about: ${profile.about.slice(0, 1500)}`);

  if (profile.experience.length > 0) {
    lines.push('experience:');
    for (const e of profile.experience.slice(0, 8)) {
      const range = [e.startDate, e.endDate ?? 'present'].filter(Boolean).join(' – ');
      lines.push(
        `  - ${e.title ?? 'unknown role'} at ${e.company ?? 'unknown company'}${range ? ` (${range})` : ''}` +
          (e.description ? `: ${e.description.slice(0, 300)}` : ''),
      );
    }
  }

  if (profile.education.length > 0) {
    lines.push('education:');
    for (const e of profile.education.slice(0, 5)) {
      lines.push(
        `  - ${e.institution ?? 'unknown'}${e.degree ? `, ${e.degree}` : ''}${e.fieldOfStudy ? ` (${e.fieldOfStudy})` : ''}`,
      );
    }
  }

  if (profile.skills.length > 0) lines.push(`skills: ${profile.skills.slice(0, 20).join(', ')}`);
  if (profile.posts.length > 0) lines.push(`recent posts on profile: ${profile.posts.length}`);

  return lines.join('\n');
}
