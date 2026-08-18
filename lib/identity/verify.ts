// Verification of ONE selected candidate.
//
// Discovery answers "who could this be?". Selection answers "which one do we
// mean?". This answers the only question that licenses everything downstream:
// does independent public evidence support that this specific person is who the
// input represents?
//
// A user picking a candidate is a preference, not proof — this stage runs
// identically whether the selection was automatic or human, and the
// VERIFIED/PARTIAL/AMBIGUOUS/FAILED call is still made in code.

import { callStructured } from '@/lib/llm/gemini';
import type { JsonSchema } from '@/lib/llm/types';
import { renderSources } from '@/lib/llm/analyze';
import type { NormalizedSource } from '@/lib/research/normalize';
import type { IdentityCandidate, IdentityConflict } from './types';

/** Shape the model returns, before provenance is applied. */
interface RawConflict {
  field: IdentityConflict['field'];
  candidate_value?: string | null;
  public_value?: string | null;
  explanation?: string;
  sources?: string[];
}

const SYSTEM = `You verify a single claimed identity against independent public evidence.

You are given ONE candidate — a specific person with a name, and usually a role,
company and location — plus public sources gathered for them. Decide whether the
evidence supports that this person is who the submitted profile represents.

WHAT TO REPORT
  corroborated_fields — identity fields the sources independently support
    (name, role, company, location). Only list a field when a supplied source
    actually shows it for THIS person.
  conflicts — where a source contradicts the candidate on company or role. Give
    the CANDIDATE's value (candidate_value), the source's value, and cite the
    source. candidate_value is the value you were given above — never describe
    it as coming from the profile provider.
  assessed_confidence — 0-100, how strongly the evidence supports this being the
    right person for the submitted profile.
  missing_fields — material fields (company, role) no source establishes.

RULES
  - Cite only URLs present in the supplied sources.
  - A source about a DIFFERENT person who happens to share the name is a
    conflict, not corroboration. Say so.
  - Absence of evidence is not conflict. If sources simply do not mention this
    person, report low confidence and missing fields — not a contradiction.
  - A documented job change is not a conflict; note the current role.
  - Never invent a person, employer, role or source.
  - Do not decide the outcome, and do not narrate your reasoning. Report evidence.`;

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    corroborated_fields: {
      type: 'array',
      items: { type: 'string', enum: ['name', 'role', 'company', 'location'] },
    },
    supporting_sources: { type: 'array', items: { type: 'string' } },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['company', 'role', 'name', 'location'] },
          candidate_value: { type: 'string', nullable: true },
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
  required: ['assessed_confidence', 'conflicts'],
};

export interface VerifySelectedInput {
  slug: string;
  candidate: IdentityCandidate;
  selectionMethod: 'AUTOMATIC' | 'USER_CONFIRMED';
  sources: NormalizedSource[];
}

export async function verifySelectedCandidate(input: VerifySelectedInput) {
  const retrieved = new Set<string>();
  for (const s of input.sources) {
    retrieved.add(s.url);
    retrieved.add(s.canonical_url);
  }

  const c = input.candidate;
  const prompt = `SUBMITTED PROFILE
linkedin slug: ${input.slug}

CANDIDATE UNDER VERIFICATION
- name: ${c.name ?? '(unknown)'}
- role: ${c.role ?? '(unknown)'}
- company: ${c.company ?? '(unknown)'}
- location: ${c.location ?? '(unknown)'}
- profile URL: ${c.linkedin_url ?? '(none)'}
- how selected: ${input.selectionMethod === 'USER_CONFIRMED' ? 'chosen by a human (a preference, not proof)' : 'the only plausible candidate found'}

PUBLIC SOURCES
${renderSources(input.sources, 2500)}

Does independent evidence support that this candidate is the person the submitted profile represents?`;

  const { data, meta } = await callStructured<{
    corroborated_fields?: string[];
    supporting_sources?: string[];
    conflicts: RawConflict[];
    assessed_confidence: number;
    missing_fields?: string[];
    summary?: string;
  }>({
    purpose: 'verify_selected_identity',
    system: SYSTEM,
    input: prompt,
    schema: SCHEMA,
    timeoutMs: 120_000,
  });

  const conflicts: IdentityConflict[] = (data.conflicts ?? []).map((x) => ({
    field: x.field,
    claimed_value: x.candidate_value ?? null,
    // The verifier compares the CANDIDATE it was handed. Provenance is settled
    // by reconcileProvenance, which knows whether that value originated with
    // the profile provider, the user, or the discovery model.
    claimed_provenance: 'CANDIDATE' as const,
    public_value: x.public_value ?? null,
    explanation: x.explanation ?? '',
    sources: (x.sources ?? []).filter((u) => retrieved.has(u)),
  }));

  return {
    corroboratedFields: data.corroborated_fields ?? [],
    supportingSources: (data.supporting_sources ?? []).filter((u) => retrieved.has(u)),
    conflicts,
    assessedConfidence: Math.max(0, Math.min(100, Math.round(Number(data.assessed_confidence) || 0))),
    missingFields: data.missing_fields ?? [],
    summary: data.summary ?? '',
    meta,
  };
}
