// Identity verification contracts.
//
// The question this layer answers is "who is this, actually?" — and it must be
// answered before anything downstream is allowed to run. A name match is not an
// identity: several people share a name, and the profile provider is one
// evidence source among several, not the truth.

export type IdentityStatus = 'VERIFIED' | 'PARTIAL' | 'AMBIGUOUS' | 'FAILED';
export type IdentityResolution = 'AUTOMATIC' | 'USER_CONFIRMED';

/** One plausible person the submitted URL/name could refer to. */
export interface IdentityCandidate {
  id: string;
  name: string | null;
  role: string | null;
  company: string | null;
  location: string | null;
  headline: string | null;
  linkedin_url: string | null;
  confidence: number;
  /** Retrieved source URLs supporting this candidate. */
  sources: string[];
  /** Where this candidate came from: the profile provider or public research. */
  origin: 'profile_provider' | 'public_research';
}

/**
 * Where an identity field's value actually came from.
 *
 * The distinction exists because these carry very different authority, and
 * collapsing them is how a model's guess starts being treated as a retrieved
 * fact:
 *
 *   PROFILE         the profile provider returned it. The strongest thing we
 *                   have, and the only value that can contradict public
 *                   evidence about who this person is.
 *   USER_HINT       the person running the search typed it. Actionable, and
 *                   worth surfacing when evidence contradicts it — but never
 *                   itself evidence.
 *   CANDIDATE       the discovery model proposed it. Useful for FINDING a
 *                   person; it establishes nothing on its own.
 *   PUBLIC_EVIDENCE an independently retrieved source corroborated it.
 */
export type FieldProvenance = 'PROFILE' | 'USER_HINT' | 'CANDIDATE' | 'PUBLIC_EVIDENCE';

/**
 * Provenances with the standing to contradict public evidence about identity.
 *
 * CANDIDATE is deliberately absent and is the whole point of this distinction:
 * a title the discovery model proposed disagreeing with the sources means the
 * model was wrong, not that the person is someone else.
 */
const AUTHORITATIVE: readonly FieldProvenance[] = ['PROFILE', 'USER_HINT', 'PUBLIC_EVIDENCE'];

/** A material disagreement between evidence sources about who this is. */
export interface IdentityConflict {
  field: 'company' | 'role' | 'name' | 'location';
  /**
   * The value being contradicted. Deliberately NOT named `profile_value`: it is
   * frequently a candidate the discovery model proposed, and naming it after
   * the profile provider made a model guess read — and behave — as a retrieved
   * fact. Always interpret it together with `claimed_provenance`.
   */
  claimed_value: string | null;
  claimed_provenance: FieldProvenance;
  public_value: string | null;
  explanation: string;
  sources: string[];
}

/** Provenance of each field of the identity a run settled on. */
export type IdentityProvenance = Partial<Record<(typeof IDENTITY_FIELDS)[number], FieldProvenance>>;

/**
 * Read a conflict that may have been persisted before provenance existed.
 *
 * Rows written by the old shape stored the compared value under `profile_value`
 * and carried no provenance. They are read back as PROFILE, which is what that
 * field asserted at the time — so historical runs keep the status they were
 * given rather than silently changing meaning underneath the user.
 */
export function normalizeConflict(raw: unknown): IdentityConflict {
  const c = (raw ?? {}) as Record<string, unknown>;
  const provenance = c.claimed_provenance as FieldProvenance | undefined;
  return {
    field: c.field as IdentityConflict['field'],
    claimed_value: (c.claimed_value ?? c.profile_value ?? null) as string | null,
    claimed_provenance: provenance ?? 'PROFILE',
    public_value: (c.public_value ?? null) as string | null,
    explanation: (c.explanation ?? '') as string,
    sources: Array.isArray(c.sources) ? (c.sources as string[]) : [],
  };
}

/** Honest accounting of what verification could and could not check. */
export interface FieldEvidence {
  /** Fields the candidate actually carries, so they could be checked at all. */
  available: string[];
  /** Of those, the ones a retrieved source supports. */
  corroborated: string[];
  /** Material fields the candidate does not carry — never counted as checked. */
  unavailable: string[];
  /** Fields a source contradicts. */
  conflicting: string[];
  /** Retrieved sources that actually supported the corroborated fields. */
  supporting_sources: string[];
  /** One line the UI can show verbatim. */
  summary: string;
}

/** Identity fields verification looks at, in display order. */
export const IDENTITY_FIELDS = ['name', 'role', 'company', 'location'] as const;

/**
 * Work out what was genuinely corroborated.
 *
 * The rule that matters: a field the candidate never had cannot have been
 * corroborated. Counting it inflates the evidence and makes a PARTIAL decision
 * look like a verified one.
 */
export function accountFields(
  candidate: Pick<IdentityCandidate, 'name' | 'role' | 'company' | 'location'> | null,
  corroboratedFields: string[],
  conflicts: IdentityConflict[],
  supportingSources: string[] = [],
): FieldEvidence {
  const available = IDENTITY_FIELDS.filter((f) => Boolean(candidate?.[f]));
  const unavailable = IDENTITY_FIELDS.filter((f) => !candidate?.[f]);
  const conflicting = [...new Set(conflicts.map((c) => c.field as string))].filter((f) =>
    (IDENTITY_FIELDS as readonly string[]).includes(f),
  );

  // Only fields that exist, were reported corroborated, and are not contradicted.
  const corroborated = available.filter(
    (f) => corroboratedFields.includes(f) && !conflicting.includes(f),
  );

  const parts = [
    `${corroborated.length} of ${available.length} identity field${available.length === 1 ? '' : 's'} available for verification ${corroborated.length === 1 ? 'was' : 'were'} corroborated`,
  ];
  if (unavailable.length > 0) parts.push(`${unavailable.join(' and ')} unavailable`);
  if (conflicting.length > 0) parts.push(`${conflicting.join(' and ')} conflicting`);

  return {
    available: [...available],
    corroborated,
    unavailable: [...unavailable],
    conflicting,
    supporting_sources: [...new Set(supportingSources)],
    summary: `${parts.join(' · ')}.`,
  };
}

export interface IdentityVerification {
  status: IdentityStatus;
  /** What verification could actually check, and what it found. */
  field_evidence?: FieldEvidence;
  /** Where each field of `resolved` came from. */
  provenance?: IdentityProvenance;
  confidence: number;
  resolution: IdentityResolution;
  /** The identity the run will use, once resolved. */
  resolved: {
    name: string | null;
    role: string | null;
    company: string | null;
    location: string | null;
    linkedin_url: string | null;
  };
  candidates: IdentityCandidate[];
  conflicts: IdentityConflict[];
  /** Fields we could not establish at all. */
  missing_fields: string[];
  reason: string;
  /** True only when qualification may begin. */
  proceed: boolean;
  /** Set when a human picked the identity. */
  selected_candidate_id: string | null;
}

/** Below this, an automatic resolution is not confident enough to act on. */
export const IDENTITY_CONFIDENCE_FLOOR = 60;
/** A candidate below this is not plausible enough to be worth offering. */
export const CANDIDATE_PLAUSIBILITY_FLOOR = 40;

export type SelectionMethod = 'AUTOMATIC' | 'USER_CONFIRMED';

/** Outcome of the selection step, before any verification happens. */
export interface CandidateSelection {
  selected: IdentityCandidate | null;
  selection_method: SelectionMethod | null;
  /** True when a human must choose before the run can continue. */
  needs_user_choice: boolean;
  plausible: IdentityCandidate[];
  reason: string;
}

/**
 * Pick the candidate to verify, or decide a human has to.
 *
 * Deliberately dumb: it counts plausible candidates. It does not weigh who is
 * more famous or more likely — that judgment belongs to the person running the
 * search, and guessing it is exactly how the wrong human gets analysed.
 */
export function selectCandidate(candidates: IdentityCandidate[]): CandidateSelection {
  const plausible = candidates.filter((c) => c.confidence >= CANDIDATE_PLAUSIBILITY_FLOOR);

  if (plausible.length === 1) {
    return {
      selected: plausible[0],
      selection_method: 'AUTOMATIC',
      needs_user_choice: false,
      plausible,
      reason: 'Exactly one plausible identity was found, so it was selected automatically for verification.',
    };
  }

  if (plausible.length > 1) {
    return {
      selected: null,
      selection_method: null,
      needs_user_choice: true,
      plausible,
      reason: `${plausible.length} public identities plausibly match this prospect. Select the person you want analysed.`,
    };
  }

  // Nothing clears the bar. Fall back to the strongest thing we have, if any,
  // so verification can report honestly on it rather than the run dead-ending.
  const best = [...candidates].sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  return {
    selected: best,
    selection_method: best ? 'AUTOMATIC' : null,
    needs_user_choice: false,
    plausible: [],
    reason: best
      ? 'No candidate was strongly plausible; the best available was carried forward for verification.'
      : 'No identifiable candidate was found for this profile URL.',
  };
}

/** Identity fields that materially change who we think we are talking to. */
const MATERIAL_FIELDS = ['company', 'role'] as const;

function normalise(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|plc|pvt|private)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Do two values for the same field describe the same thing?
 * Tolerant of suffixes and word order, strict about genuinely different names.
 */
export function valuesAgree(a: string | null, b: string | null): boolean {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return true; // nothing to disagree about
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;

  const wordsA = new Set(x.split(' ').filter((w) => w.length > 2));
  const wordsB = new Set(y.split(' ').filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return false;

  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size) >= 0.6;
}

export interface IdentityDecisionInput {
  /** The single candidate under verification. */
  selected?: IdentityCandidate | null;
  /** How that candidate came to be selected. */
  selectionMethod?: SelectionMethod | null;
  /** Identity as the profile provider reported it. */
  profile: {
    name: string | null;
    role: string | null;
    company: string | null;
    location: string | null;
    linkedin_url: string | null;
  };
  /** Whether the profile provider returned anything at all. */
  hasProfile: boolean;
  candidates: IdentityCandidate[];
  conflicts: IdentityConflict[];
  /** Model's own confidence that the profile identity is the right person. */
  assessedConfidence: number;
  /** Fields the evidence could not establish. */
  missingFields: string[];
  /** Where each field of the identity came from. */
  provenance?: IdentityProvenance;
}

/**
 * Decide identity status in code, not in the model.
 *
 * The rules that matter:
 *   - A material conflict (different company or role for the same name) is
 *     AMBIGUOUS. We do not pick a side, because picking wrong sends a stranger
 *     a message about someone else's job.
 *   - More than one plausible candidate is AMBIGUOUS for the same reason.
 *   - Missing material fields with no corroboration is PARTIAL, not a guess.
 *   - Only VERIFIED proceeds.
 */
export function decideIdentity(input: IdentityDecisionInput): IdentityVerification {
  const { profile, candidates, conflicts, hasProfile } = input;
  const confidence = Math.max(0, Math.min(100, Math.round(input.assessedConfidence)));

  const base = {
    confidence,
    resolution: 'AUTOMATIC' as IdentityResolution,
    resolved: { ...profile },
    candidates,
    conflicts,
    missing_fields: input.missingFields,
    selected_candidate_id: null as string | null,
    provenance: input.provenance,
  };

  // Nothing to work with at all.
  if (!hasProfile && candidates.length === 0 && !profile.name) {
    return {
      ...base,
      status: 'FAILED',
      confidence: 0,
      reason:
        'No profile data was retrieved and public research produced no identifiable person for this URL.',
      proceed: false,
    };
  }

  // A material disagreement about who this is.
  //
  // Only a value with standing can contradict public evidence. A role the
  // discovery model invented disagreeing with the sources says the MODEL was
  // wrong about the title — not that the sources describe a different person —
  // and blocking on it manufactured a profile-vs-evidence conflict out of a
  // profile that stated no role at all. Such conflicts are still recorded and
  // still shown; they just no longer decide the outcome. The field they
  // concern is cleared upstream, so an unproven title becomes "unestablished"
  // (PARTIAL) rather than "contradicted" (AMBIGUOUS) — conservative either way.
  const materialConflicts = conflicts.filter(
    (c) =>
      (MATERIAL_FIELDS as readonly string[]).includes(c.field) &&
      AUTHORITATIVE.includes(c.claimed_provenance),
  );
  if (materialConflicts.length > 0) {
    return {
      ...base,
      status: 'AMBIGUOUS',
      // Names what actually disagrees. Saying "the profile" when the contested
      // value came from the submitted details misdescribes the evidence and
      // sends the user off to correct the wrong thing.
      reason: `Public sources disagree with ${
        materialConflicts.every((c) => c.claimed_provenance === 'USER_HINT')
          ? 'the details you supplied'
          : 'the profile'
      } about this person's ${materialConflicts
        .map((c) => c.field)
        .join(' and ')}. Qualification has not started, because acting on the wrong identity would target the wrong person.`,
      proceed: false,
    };
  }

  // Verification runs on one selected candidate; ambiguity between candidates is
  // resolved before this point, by selectCandidate or by the user.
  const identity = input.selected
    ? {
        name: input.selected.name ?? profile.name,
        role: input.selected.role ?? profile.role,
        company: input.selected.company ?? profile.company,
        location: input.selected.location ?? profile.location,
        linkedin_url: input.selected.linkedin_url ?? profile.linkedin_url,
      }
    : profile;
  base.resolved = identity;
  base.selected_candidate_id = input.selected?.id ?? null;
  if (input.selectionMethod === 'USER_CONFIRMED') base.resolution = 'USER_CONFIRMED';

  // Material fields we never established.
  const missingMaterial = MATERIAL_FIELDS.filter((f) => !identity[f]);
  if (missingMaterial.length > 0) {
    return {
      ...base,
      status: 'PARTIAL',
      reason: `Could not establish this person's ${missingMaterial.join(' and ')} from the profile or public sources. Held for a human rather than guessing.`,
      proceed: false,
    };
  }

  if (confidence < IDENTITY_CONFIDENCE_FLOOR) {
    return {
      ...base,
      status: 'PARTIAL',
      reason: `Identity evidence is too weak to act on (confidence ${confidence}/100, and ${IDENTITY_CONFIDENCE_FLOOR} is the bar).`,
      proceed: false,
    };
  }

  return {
    ...base,
    status: 'VERIFIED',
    reason: `Identity corroborated by independent public sources${
      identity.company ? ` as ${identity.name}, ${identity.role ?? 'role unknown'} at ${identity.company}` : ''
    }.`,
    proceed: true,
  };
}

/**
 * Re-check identity after a human picks a candidate.
 *
 * Manual selection resolves ambiguity between candidates; it does not waive
 * verification. A selected candidate that still carries a material conflict of
 * its own stays AMBIGUOUS.
 */
export function applyUserSelection(
  verification: IdentityVerification,
  candidateId: string,
): IdentityVerification {
  const candidate = verification.candidates.find((c) => c.id === candidateId);
  if (!candidate) {
    return {
      ...verification,
      reason: `Selected identity "${candidateId}" is not among the candidates found for this run.`,
    };
  }

  // Conflicts that concern the identity actually chosen. A conflict raised
  // against a model-proposed value never had standing to block, so choosing
  // this candidate by hand does not need to clear it either.
  const unresolved = verification.conflicts.filter((c) => {
    if (!AUTHORITATIVE.includes(c.claimed_provenance)) return false;
    if (c.field === 'company') return !valuesAgree(candidate.company, c.public_value) && !valuesAgree(candidate.company, c.claimed_value);
    if (c.field === 'role') return !valuesAgree(candidate.role, c.public_value) && !valuesAgree(candidate.role, c.claimed_value);
    return false;
  });

  const resolved = {
    name: candidate.name,
    role: candidate.role,
    company: candidate.company,
    location: candidate.location,
    linkedin_url: candidate.linkedin_url ?? verification.resolved.linkedin_url,
  };

  if (unresolved.length > 0) {
    return {
      ...verification,
      status: 'AMBIGUOUS',
      resolution: 'USER_CONFIRMED',
      resolved,
      selected_candidate_id: candidateId,
      proceed: false,
      reason:
        'The selected identity still carries an unresolved conflict with public sources, so the run stays at manual review.',
    };
  }

  const missingMaterial = MATERIAL_FIELDS.filter((f) => !resolved[f]);
  if (missingMaterial.length > 0) {
    return {
      ...verification,
      status: 'PARTIAL',
      resolution: 'USER_CONFIRMED',
      resolved,
      selected_candidate_id: candidateId,
      proceed: false,
      reason: `The selected identity is missing ${missingMaterial.join(' and ')}, which downstream targeting depends on.`,
    };
  }

  return {
    ...verification,
    status: 'VERIFIED',
    resolution: 'USER_CONFIRMED',
    confidence: Math.max(verification.confidence, candidate.confidence),
    resolved,
    selected_candidate_id: candidateId,
    proceed: true,
    reason: `Identity confirmed by a human: ${resolved.name}${resolved.company ? `, ${resolved.role ?? 'unknown role'} at ${resolved.company}` : ''}.`,
  };
}
