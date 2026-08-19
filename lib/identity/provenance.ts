// Field-level provenance for the identity under verification.
//
// Discovery, resolution and verification each contribute values, and until now
// they all arrived at `decideIdentity` flattened into one object called
// `profile`. That flattening caused a real defect: a role the discovery model
// proposed was compared against public sources as though the profile provider
// had returned it, producing "public sources disagree with the profile about
// this person's role" for a profile that contained no role at all — and
// blocking the run on a disagreement between two things neither of which was
// evidence.
//
// This module keeps the sources apart. It answers two questions:
//   1. where did each field of the working identity actually come from?
//   2. which recorded conflicts have the standing to block?
//
// It is deliberately pure and model-free. Nothing here decides identity status
// — that stays in decideIdentity — and nothing here can promote a value: the
// only outcomes are "keep", "relabel" and "clear".

import {
  valuesAgree,
  type FieldProvenance,
  type IdentityCandidate,
  type IdentityConflict,
  type IdentityProvenance,
} from './types';
import { sameCorporateGroup } from './corporate-groups';

/** The identity fields provenance is tracked for. */
type TrackedField = 'name' | 'role' | 'company' | 'location';

export interface IdentityFields {
  name: string | null;
  role: string | null;
  company: string | null;
  location: string | null;
}

export interface ReconcileInput {
  /** Values the PROFILE PROVIDER actually returned. Absent fields must be null. */
  profileFields: IdentityFields;
  /** Values the user typed when submitting or editing the run. */
  hints: Pick<IdentityFields, 'name' | 'role' | 'company'>;
  /** The candidate carried into verification. */
  candidate: IdentityFields;
  /** Conflicts as reported by the verifier, before provenance is applied. */
  conflicts: IdentityConflict[];
  /** Fields independent sources corroborated. */
  corroboratedFields: string[];
}

export interface ReconcileResult {
  /** Conflicts, each tagged with the standing of the value it contests. */
  conflicts: IdentityConflict[];
  provenance: IdentityProvenance;
  /** The identity to verify, with unproven model-derived fields cleared. */
  fields: IdentityFields;
  /** Fields whose corroboration no longer holds once a value was cleared. */
  corroboratedFields: string[];
  /** Human-readable record of every demotion, for the stage output. */
  notes: string[];
}

/**
 * Where a single field's value came from.
 *
 * Order mirrors the authority order the app already applies in
 * `resolveIdentity`: provider data first, then what the user told us, then
 * whatever the model proposed. A value is only attributed to the user when the
 * user actually supplied something matching it — otherwise a candidate that
 * happens to agree with nothing would be laundered into a hint.
 */
export function fieldProvenance(
  profileValue: string | null,
  hintValue: string | null,
  candidateValue: string | null,
  corroborated: boolean,
): FieldProvenance | undefined {
  if (profileValue && valuesAgree(profileValue, candidateValue ?? profileValue)) return 'PROFILE';
  if (profileValue) return 'PROFILE';
  if (!candidateValue) return hintValue ? 'USER_HINT' : undefined;
  if (hintValue && valuesAgree(hintValue, candidateValue)) return 'USER_HINT';
  // A model-proposed value that independent sources went on to confirm has
  // earned a stronger label than the guess it started as.
  if (corroborated) return 'PUBLIC_EVIDENCE';
  return 'CANDIDATE';
}

/** Material fields — the ones that change WHO we think we are talking to. */
const MATERIAL: TrackedField[] = ['company', 'role'];

/**
 * Tag every conflict with the provenance of the value it contests, and clear
 * model-derived values that public evidence contradicts.
 *
 * The clearing is the conservative half and matters as much as the tagging.
 * Once a candidate-derived role is known to be contradicted, continuing to
 * carry it would let an unproven title flow downstream into targeting. Setting
 * it to null instead makes the run PARTIAL — "could not establish the role" —
 * which is both truthful and still blocking.
 *
 * The one exception: if independent sources back a value the USER supplied,
 * the field is established on the evidence's authority, not the model's. That
 * is the case this fix exists to stop failing — a correct human answer thrown
 * away because the model preferred a different title.
 */
export function reconcileProvenance(input: ReconcileInput): ReconcileResult {
  const { profileFields, hints, candidate } = input;
  const notes: string[] = [];
  const fields: IdentityFields = { ...candidate };
  let corroboratedFields = [...input.corroboratedFields];

  const conflicts = input.conflicts.map((c) => {
    const field = c.field as TrackedField;
    // corroborated is forced false here: this field is in conflict by
    // definition, and letting it read as corroborated would relabel a
    // contradicted model guess as PUBLIC_EVIDENCE — which would restore
    // exactly the blocking behaviour this fix removes.
    const provenance =
      fieldProvenance(
        profileFields[field] ?? null,
        (hints as Partial<IdentityFields>)[field] ?? null,
        candidate[field] ?? null,
        false,
      ) ?? 'CANDIDATE';

    return { ...c, claimed_provenance: provenance };
  });

  for (const c of conflicts) {
    const field = c.field as TrackedField;
    if (!MATERIAL.includes(field)) continue;
    if (c.claimed_provenance !== 'CANDIDATE') continue;

    const hint = (hints as Partial<IdentityFields>)[field] ?? null;

    if (hint && valuesAgree(hint, c.public_value)) {
      // Sources corroborate what the user said. The model's competing value
      // was never evidence, so it loses to the corroborated one.
      fields[field] = c.public_value ?? hint;
      if (!corroboratedFields.includes(field)) corroboratedFields = [...corroboratedFields, field];
      notes.push(
        `${field}: the discovery model proposed "${c.claimed_value ?? 'unknown'}", but public sources support the ${field} you supplied ("${hint}"). Used the corroborated value.`,
      );
      continue;
    }

    // Contradicted, and nothing with standing backs it. Do not carry it.
    fields[field] = null;
    corroboratedFields = corroboratedFields.filter((f) => f !== field);
    notes.push(
      `${field}: "${c.claimed_value ?? 'unknown'}" came from the discovery model, not from the profile provider, and public sources do not support it. Treated as unestablished rather than as a profile conflict.`,
    );
  }

  const provenance: IdentityProvenance = {};
  for (const field of ['name', 'role', 'company', 'location'] as TrackedField[]) {
    if (!fields[field]) continue;
    const p = fieldProvenance(
      profileFields[field] ?? null,
      (hints as Partial<IdentityFields>)[field] ?? null,
      fields[field],
      corroboratedFields.includes(field),
    );
    if (p) provenance[field] = p;
  }

  return { conflicts, provenance, fields, corroboratedFields, notes };
}

/** The identity fields the profile PROVIDER genuinely returned, and no others. */
export function providerFields(
  profile: {
    name?: string | null;
    headline?: string | null;
    location?: string | null;
    currentCompany?: { name?: string | null; title?: string | null } | null;
  } | null,
): IdentityFields {
  if (!profile) return { name: null, role: null, company: null, location: null };
  return {
    name: profile.name ?? null,
    // headline is provider-returned text, so it counts as profile data — but
    // only when the provider actually supplied one.
    role: profile.currentCompany?.title ?? profile.headline ?? null,
    company: profile.currentCompany?.name ?? null,
    location: profile.location ?? null,
  };
}

/** Candidate view of an IdentityCandidate, for callers holding the full record. */
export function candidateFields(candidate: IdentityCandidate | null): IdentityFields {
  return {
    name: candidate?.name ?? null,
    role: candidate?.role ?? null,
    company: candidate?.company ?? null,
    location: candidate?.location ?? null,
  };
}

/**
 * A deterministic current-employer check, independent of whatever the
 * verification model happened to report.
 *
 * reconcileProvenance() above only RELABELS conflicts it is given — it does
 * not generate new ones — so a candidate whose only available evidence is
 * old enough that a search-based summary never surfaces the discrepancy
 * (the exact "historical evidence, no current-role signal" case) sailed
 * through untouched even once the real profile was being fetched, because
 * nothing ever compared the fetched profile's current company against the
 * candidate's claimed one when the model itself reported nothing.
 *
 * This closes that gap with the cheapest possible check: a single, direct
 * field comparison against data already fetched for this exact candidate —
 * no new provider call, no model call, no qualification pass. It never
 * invents a person, a role or a company; it only ever compares two values
 * already in hand. When the model already reported its own company
 * conflict (including a genuine concurrent-role read), this defers to that
 * richer explanation entirely rather than duplicating or overriding it.
 *
 * A mismatch is also not raised when the two names are a known parent/
 * subsidiary/brand pair (sameCorporateGroup(), lib/identity/corporate-
 * groups.ts) — a profile pinned to the group entity is not evidence the
 * person left the brand they were discovered for. This is a curated
 * membership check, never a similarity heuristic: an unrecognized mismatch
 * stays exactly as conservative as before.
 */
export function currentEmploymentConflict(
  claimedCompany: string | null,
  profileCompany: string | null,
): IdentityConflict | null {
  if (!claimedCompany || !profileCompany) return null;
  if (valuesAgree(claimedCompany, profileCompany)) return null;
  if (sameCorporateGroup(claimedCompany, profileCompany)) return null;
  return {
    field: 'company',
    claimed_value: claimedCompany,
    claimed_provenance: 'CANDIDATE',
    public_value: profileCompany,
    explanation: `This person's own current profile lists "${profileCompany}" as their current company, not "${claimedCompany}".`,
    sources: [],
  };
}
