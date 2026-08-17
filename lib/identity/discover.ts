// Candidate discovery — "who could this input represent?"
//
// Deliberately lightweight. It runs on the profile provider's answer plus a
// small identity-focused search, and its only job is to enumerate the people
// this URL could plausibly refer to. It does not prove anything: proving is the
// verification stage's job, and it runs on ONE selected candidate.

import { callStructured } from '@/lib/llm/gemini';
import type { JsonSchema } from '@/lib/llm/types';
import { renderProfile, type LinkedInProfile } from '@/lib/linkedin/profile';
import { renderSources } from '@/lib/llm/analyze';
import type { NormalizedSource } from '@/lib/research/normalize';
import type { IdentityCandidate, IdentityConflict } from './types';

const SYSTEM = `You enumerate WHO a prospect could be, before anyone tries to sell to them.

You are given a LinkedIn profile slug, whatever a profile provider returned for
it, and public web sources gathered for that name. Your job is to report what the
evidence says about identity — not to decide whether it is good enough.

THE CORE RISK
  Several people share a name. A profile provider can return one person while
  the public web is dominated by a different, often more prominent, person with
  the same name. Treating them as one person means analysing the wrong human.

WHAT TO PRODUCT
  candidates — every distinct person the evidence plausibly describes for this
    name/URL. Distinguish them by ROLE, COMPANY and LOCATION, never by name
    alone. Include the profile provider's version as its own candidate when it
    differs from what public sources describe. Cite the source URLs supporting
    each candidate, and give each a confidence.
  conflicts — material disagreements about the SAME person between the profile
    and public sources: a different current company, a different current role.
    Say which value came from which side, and cite sources.
  assessed_confidence — how confident you are that the profile provider's
    identity is the person this URL actually belongs to, 0-100.
  missing_fields — material identity fields (company, role, location) that no
    source establishes.

RULES
  - Only cite source URLs that appear in the supplied sources.
  - If public sources describe a person with the same name but a clearly
    different job, that is a SEPARATE CANDIDATE and usually also a CONFLICT.
    Do not merge them into one description.
  - Job changes are not conflicts when a source shows the move; describe the
    current role and note the change. A conflict is unexplained disagreement.
  - ALWAYS return at least one candidate when any evidence names a person: the
    profile's version when there is one, and every distinct person the sources
    describe for this name. Returning an empty list strands the run.
  - When the profile provider returned nothing, build candidates from the public
    sources alone. A slug-derived name plus a source describing that person is
    enough to propose a candidate — proving it is the verification stage's job,
    not yours.
  - If the sources genuinely describe nobody, return a single low-confidence
    candidate carrying whatever name the slug or hints suggest, with no role or
    company, rather than an empty list.
  - Silence is not disagreement: absent evidence means low confidence, not conflict.
  - Never invent a person, employer, role or source.
  - Do not decide the outcome. Report evidence; the caller decides.`;

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', nullable: true },
          role: { type: 'string', nullable: true },
          company: { type: 'string', nullable: true },
          location: { type: 'string', nullable: true },
          headline: { type: 'string', nullable: true },
          linkedin_url: { type: 'string', nullable: true },
          confidence: { type: 'integer' },
          sources: { type: 'array', items: { type: 'string' } },
          origin: { type: 'string', enum: ['profile_provider', 'public_research'] },
        },
        required: ['confidence', 'origin'],
      },
    },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['company', 'role', 'name', 'location'] },
          profile_value: { type: 'string', nullable: true },
          public_value: { type: 'string', nullable: true },
          explanation: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
        },
        required: ['field', 'explanation'],
      },
    },
    assessed_confidence: { type: 'integer' },
    missing_fields: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['candidates', 'conflicts', 'assessed_confidence'],
};

export interface DiscoverInput {
  slug: string;
  profile: LinkedInProfile | null;
  profileAccessNote: string;
  provisional: {
    name: string | null;
    role: string | null;
    company: string | null;
    location: string | null;
  };
  userHints: { name: string | null; company: string | null; title: string | null };
  sources: NormalizedSource[];
}

export async function discoverCandidates(input: DiscoverInput) {
  const retrieved = new Set<string>();
  for (const s of input.sources) {
    retrieved.add(s.url);
    retrieved.add(s.canonical_url);
  }

  const prompt = `LinkedIn slug: ${input.slug}

PROFILE PROVIDER RESULT
${input.profile ? renderProfile(input.profile) : `No profile data (${input.profileAccessNote})`}

Provisional identity currently in use:
- name: ${input.provisional.name ?? '(unknown)'}
- role: ${input.provisional.role ?? '(unknown)'}
- company: ${input.provisional.company ?? '(unknown)'}
- location: ${input.provisional.location ?? '(unknown)'}

User-supplied hints:
- name: ${input.userHints.name ?? '(none)'}
- company: ${input.userHints.company ?? '(none)'}
- title: ${input.userHints.title ?? '(none)'}

PUBLIC SOURCES
${renderSources(input.sources, 2000)}

List every person this URL could plausibly refer to, and any conflicts already visible.`;

  const { data, meta } = await callStructured<{
    candidates: Omit<IdentityCandidate, 'id'>[];
    conflicts: IdentityConflict[];
    assessed_confidence: number;
    missing_fields?: string[];
    summary?: string;
  }>({
    purpose: 'discover_identity_candidates',
    system: SYSTEM,
    input: prompt,
    schema: SCHEMA,
    timeoutMs: 120_000,
  });

  const candidates: IdentityCandidate[] = (data.candidates ?? []).map((c, i) => ({
    id: `candidate_${i + 1}`,
    name: c.name ?? null,
    role: c.role ?? null,
    company: c.company ?? null,
    location: c.location ?? null,
    headline: c.headline ?? null,
    linkedin_url: c.linkedin_url ?? null,
    confidence: Math.max(0, Math.min(100, Math.round(Number(c.confidence) || 0))),
    // Only citations we actually retrieved count as support.
    sources: (c.sources ?? []).filter((u) => retrieved.has(u)),
    origin: c.origin === 'profile_provider' ? 'profile_provider' : 'public_research',
  }));

  const conflicts: IdentityConflict[] = (data.conflicts ?? []).map((c) => ({
    field: c.field,
    profile_value: c.profile_value ?? null,
    public_value: c.public_value ?? null,
    explanation: c.explanation ?? '',
    sources: (c.sources ?? []).filter((u) => retrieved.has(u)),
  }));

  return {
    candidates,
    conflicts,
    assessedConfidence: Math.max(0, Math.min(100, Math.round(Number(data.assessed_confidence) || 0))),
    missingFields: data.missing_fields ?? [],
    summary: data.summary ?? '',
    meta,
  };
}
