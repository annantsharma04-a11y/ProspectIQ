// Targeted recovery of a missing identity field.
//
// Verification often lands on PARTIAL for a thin but honest reason: name,
// company and location all check out, and the role simply never appeared. That
// is worth one focused attempt to resolve before stopping — but the attempt
// must not become a way to guess.
//
// The rules that keep it safe:
//   * The search is anchored to the KNOWN fields of the selected candidate.
//   * A value counts only when a RETRIEVED source establishes it. The model's
//     own belief is never evidence.
//   * A source describing a different person with the same name is a CONFLICT,
//     not a recovery. The candidate is never silently replaced.

import { callStructured } from '@/lib/llm/gemini';
import type { JsonSchema } from '@/lib/llm/types';
import { renderSources } from '@/lib/llm/analyze';
import type { NormalizedSource } from '@/lib/research/normalize';
import type { SearchQuery } from '@/lib/search/types';
import type { IdentityCandidate, IdentityConflict } from './types';

/** Fields worth chasing: without them, targeting cannot proceed. */
export type RecoverableField = 'role' | 'company';

/**
 * Searches anchored to what we already know about THIS person.
 * Never a bare name search — that is how a different person gets pulled in.
 */
export function fieldRecoveryQueries(
  candidate: IdentityCandidate,
  field: RecoverableField,
): SearchQuery[] {
  const name = (candidate.name ?? '').trim();
  if (!name) return [];
  const quoted = `"${name.replace(/"/g, '')}"`;
  const queries: SearchQuery[] = [];

  if (field === 'role') {
    const company = (candidate.company ?? '').trim();
    if (!company) return [];
    const qc = `"${company.replace(/"/g, '')}"`;
    queries.push(
      { query: `${quoted} ${qc} founder OR CEO OR head OR director OR president`, category: 'prospect_identity' },
      { query: `${quoted} ${qc} role OR title OR designation`, category: 'prospect_company' },
      { query: `${qc} leadership team ${quoted}`, category: 'prospect_company' },
    );
  } else {
    const role = (candidate.role ?? '').trim();
    queries.push(
      { query: role ? `${quoted} ${role} company OR employer` : `${quoted} company OR employer`, category: 'prospect_company' },
      { query: `${quoted} "works at" OR "joined" OR "appointed"`, category: 'prospect_identity' },
    );
  }

  return queries;
}

const SYSTEM = `You establish ONE missing identity field for ONE specific person,
using only the supplied sources.

You are given a person whose other identity details are already known, and the
field that is missing. Find whether any supplied source states that field FOR
THIS EXACT PERSON.

RULES — these decide whether the answer is usable at all:
  - The value must come from a supplied source. Your own knowledge of who this
    person is does NOT count and must never be used.
  - Cite the source URL that states it, exactly as given.
  - Quote the sentence or phrase from that source which states it.
  - The source must clearly be about THIS person: the known fields must line up.
    A source about someone who merely shares the name is NOT corroboration —
    report it as a conflict instead, with what it says.
  - If no supplied source establishes the field for this person, say so. Absence
    is a perfectly good answer; inventing a plausible value is not.
  - Prefer official company or leadership pages, then reputable publications and
    interviews. Note which kind of source you used.`;

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    value: { type: 'string', nullable: true },
    evidence_url: { type: 'string', nullable: true },
    supporting_quote: { type: 'string', nullable: true },
    source_kind: {
      type: 'string',
      enum: ['official_company', 'leadership_page', 'reputable_publication', 'interview', 'other', 'none'],
    },
    /** A source about a different person with the same name. */
    different_person_detected: { type: 'boolean' },
    different_person_explanation: { type: 'string', nullable: true },
    different_person_value: { type: 'string', nullable: true },
    different_person_source: { type: 'string', nullable: true },
    reason: { type: 'string' },
  },
  required: ['found', 'different_person_detected', 'reason'],
};

export interface FieldRecoveryResult {
  field: RecoverableField;
  /** Only set when a retrieved source genuinely established it. */
  value: string | null;
  evidence_url: string | null;
  supporting_quote: string | null;
  source_kind: string;
  /** Raised when a same-name different person turned up. */
  conflict: IdentityConflict | null;
  reason: string;
  attempted: boolean;
}

export async function recoverIdentityField(input: {
  candidate: IdentityCandidate;
  field: RecoverableField;
  sources: NormalizedSource[];
}): Promise<FieldRecoveryResult> {
  const { candidate, field } = input;
  const retrieved = new Set<string>();
  for (const s of input.sources) {
    retrieved.add(s.url);
    retrieved.add(s.canonical_url);
  }

  const prompt = `PERSON (already established)
- name: ${candidate.name ?? '(unknown)'}
- role: ${candidate.role ?? '(MISSING)'}
- company: ${candidate.company ?? '(MISSING)'}
- location: ${candidate.location ?? '(unknown)'}

MISSING FIELD TO ESTABLISH: ${field}

SOURCES
${renderSources(input.sources, 2500)}

Does any supplied source state this person's ${field}?`;

  const { data } = await callStructured<{
    found: boolean;
    value?: string | null;
    evidence_url?: string | null;
    supporting_quote?: string | null;
    source_kind?: string;
    different_person_detected: boolean;
    different_person_explanation?: string | null;
    different_person_value?: string | null;
    different_person_source?: string | null;
    reason: string;
  }>({
    purpose: `recover_identity_${field}`,
    system: SYSTEM,
    input: prompt,
    schema: SCHEMA,
    timeoutMs: 90_000,
  });

  // A same-name different person is a conflict, never a recovery.
  const conflict: IdentityConflict | null = data.different_person_detected
    ? {
        field,
        claimed_value: field === 'role' ? candidate.role : candidate.company,
        // Not a model guess: a retrieved source was found describing a
        // DIFFERENT person with this name. That is grounded evidence about who
        // this is, and it must keep blocking the run.
        claimed_provenance: 'PUBLIC_EVIDENCE' as const,
        public_value: data.different_person_value ?? null,
        explanation:
          data.different_person_explanation ??
          'A source describes a different person with the same name.',
        sources: [data.different_person_source].filter(
          (u): u is string => typeof u === 'string' && retrieved.has(u),
        ),
      }
    : null;

  // The citation must point at something we actually retrieved.
  const citation = data.evidence_url && retrieved.has(data.evidence_url) ? data.evidence_url : null;
  const usable = Boolean(data.found && data.value?.trim() && citation && !data.different_person_detected);

  return {
    field,
    value: usable ? (data.value as string).trim() : null,
    evidence_url: usable ? citation : null,
    supporting_quote: usable ? (data.supporting_quote ?? null) : null,
    source_kind: data.source_kind ?? 'none',
    conflict,
    reason: usable
      ? data.reason
      : data.different_person_detected
        ? 'A source described a different person with the same name, so the field was not recovered.'
        : data.found && !citation
          ? 'A value was proposed but cited no retrieved source, so it was not accepted.'
          : (data.reason ?? 'No supplied source established this field.'),
    attempted: true,
  };
}
