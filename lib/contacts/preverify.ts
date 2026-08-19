// Lightweight, deterministic pre-verification of a discovered contact candidate.
//
// The problem this closes: a candidate used to be shown with an enabled Select
// button and the label "Not yet verified", and only AFTER the human clicked did
// the full identity pipeline discover that the quote was about a different
// person, or that the LinkedIn URL pointed somewhere else entirely. The human
// was, in effect, asked to spend a verification pass to find out whether the
// suggestion was worth showing at all.
//
// So the cheap, deterministic half of that judgment moves here, in front of the
// Select button. Everything below is plain code over data the run ALREADY has —
// no model call, no network, no research round. It is explicitly NOT a
// replacement for identity verification: a candidate that passes here still
// goes through the full verifySelectedCandidate/decideIdentity pass on
// selection, unchanged. This only decides whether it was honest to offer the
// button in the first place.
//
// Reuses, rather than reinvents:
//   - parseLinkedInUrl()      the same profile-URL parser the pipeline uses
//   - roleMatches()           the same role gate rankCandidates() applies
// and reads the same evidence shape the discovery stage already persisted.

import { parseLinkedInUrl } from '@/lib/linkedin/url';
import { roleMatches } from './rank';
import type { ContactCandidateEvidence } from './types';

/**
 * What may be offered to a human, and how.
 *
 *   ELIGIBLE            every check passed — Select enabled, shown as verified
 *   NEEDS_VERIFICATION  a real consistency conflict — shown, Select DISABLED
 *   EXCLUDED            unusable as a research target — never offered at all
 */
export type CandidateEligibility = 'ELIGIBLE' | 'NEEDS_VERIFICATION' | 'EXCLUDED';

/** Each check's own verdict. `null` means the check could not be run (see notes per check). */
export interface PreVerificationChecks {
  /** A name exists to verify against at all. */
  name_present: boolean;
  /** At least one evidence item with a real source URL and a real quote. */
  evidence_present: boolean;
  /** linkedin_url parses as a genuine, normalizable /in/ profile URL. */
  linkedin_url_valid: boolean;
  /** The candidate's surname actually appears in the cited evidence. */
  name_in_evidence: boolean;
  /** The company appears in the cited evidence, tying this person to THIS employer. */
  company_in_evidence: boolean;
  /** The profile slug's implied name is consistent with the candidate's name. Null when the slug carries no usable name. */
  name_matches_profile: boolean | null;
  /** Role matches a functional owner of the qualified workflow. Null when no target roles were supplied. */
  role_consistent: boolean | null;
}

export interface PreVerificationResult {
  eligibility: CandidateEligibility;
  checks: PreVerificationChecks;
  /** One plain sentence naming the first failed check, for the UI and the API. Null when ELIGIBLE. */
  blockedReason: string | null;
  /** The canonical profile URL, when the URL parsed. Saves the caller re-parsing. */
  normalizedUrl: string | null;
}

export interface PreVerifyInput {
  name: string | null;
  role: string | null;
  company: string | null;
  linkedin_url: string | null;
  evidence: ContactCandidateEvidence[];
}

export interface PreVerifyContext {
  /**
   * The functional-owner titles this workflow implies (lib/contacts/roles.ts).
   * Optional because the persisted row does not carry them: at discovery time
   * they are known and the check runs; at Select time they are not, and
   * rankCandidates() has already enforced the same gate upstream, so skipping
   * it there re-checks nothing that was never checked.
   */
  targetRoles?: string[];
}

/** Words that carry no identifying power when matching a company name. */
const COMPANY_STOPWORDS = new Set([
  'inc', 'ltd', 'llc', 'llp', 'plc', 'corp', 'corporation', 'co', 'company',
  'limited', 'pvt', 'private', 'group', 'holdings', 'technologies', 'technology',
  'solutions', 'services', 'systems', 'labs', 'the', 'and',
]);

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/** Everything a candidate's evidence can be matched against: its quotes and its source URLs. */
function evidenceHaystack(evidence: ContactCandidateEvidence[]): string {
  return evidence.map((e) => `${e.quote ?? ''} ${e.source_url ?? ''}`).join(' ').toLowerCase();
}

/**
 * Is this evidence actually about this person?
 *
 * Keys on the SURNAME (the last usable name token), which is the strongest
 * single identifier in a quote — a forename alone is far too common to prove
 * anything. A one-token name is matched on that token. This is the check that
 * catches the reported failure mode: a real, retrieved quote that genuinely
 * exists in a real source, but describes somebody else.
 */
export function nameAppearsIn(name: string, haystack: string): boolean {
  const parts = tokens(name);
  if (parts.length === 0) return false;
  const surname = parts[parts.length - 1];
  return haystack.includes(surname);
}

/**
 * Is this evidence actually about this company?
 *
 * Generic corporate suffixes are dropped first, so "Acme Technologies Pvt Ltd"
 * is matched on "acme" and never on "ltd" — which would otherwise match almost
 * any corporate source and make the check meaningless.
 */
export function companyAppearsIn(company: string, haystack: string): boolean {
  const distinctive = tokens(company).filter((t) => !COMPANY_STOPWORDS.has(t));
  if (distinctive.length === 0) return false;
  return distinctive.some((t) => haystack.includes(t));
}

/**
 * Does the profile URL plausibly belong to the named person?
 *
 * Compares the candidate's name against the name the slug itself implies
 * (parseLinkedInUrl's `name_hint`). Returns null — "could not check", never a
 * failure — when the slug carries no usable name, which is common and is not
 * evidence of anything either way.
 */
export function nameMatchesProfileSlug(name: string, nameHint: string | null): boolean | null {
  if (!nameHint) return null;
  const nameTokens = tokens(name);
  if (nameTokens.length === 0) return null;

  // Only NAME-LIKE hint tokens can evidence a conflict. An opaque vanity slug
  // ("/in/xk8f2p") still yields a hint string, but one that carries no claim
  // about who the person is — treating that as a mismatch would block a
  // perfectly good candidate over noise. Alphabetic-only tokens are the ones
  // that genuinely assert a name, and "/in/rahul-mehta" against "Jane Kapoor"
  // is still caught.
  const hintTokens = tokens(nameHint).filter((t) => /^[a-z]+$/.test(t));
  if (hintTokens.length === 0) return null;

  // The separated form: "/in/pramod-adiddam", "/in/rahul-mehta". One shared
  // name token is enough, because a slug that names a DIFFERENT person shares
  // none.
  const nameSet = new Set(nameTokens);
  if (hintTokens.some((t) => nameSet.has(t))) return true;

  // The RUN-TOGETHER forms, which the token comparison above cannot see
  // because LinkedIn emits them as a single word:
  //
  //   /in/pramodadiddam   full name, no separator
  //   /in/padiddam        first initial + surname  ← the live false negative
  //   /in/pramoda         first name + surname initial
  //
  // Checked by composing the candidate's own name tokens and comparing whole
  // strings, so this can only ever RECOGNISE a slug the person's real name
  // could have produced. It never matches a slug built from a different name:
  // "rahul-mehta" tokenizes to two words and composes to "rahulmehta" /
  // "rmehta", none of which any composition of "Pramod Adiddam" yields.
  const compact = hintTokens.join('');
  if (compositionsOf(nameTokens).has(compact)) return true;

  return false;
}

/**
 * Every run-together slug the parts of a real name could legitimately produce.
 *
 * Deliberately built FROM the candidate's name rather than by parsing the
 * slug: the question is "could this person's name have produced this slug?",
 * and generating the small set of legitimate answers is verifiable in a way
 * that guessing where a surname starts inside an opaque string is not.
 *
 * Initials are only ever taken from a token the name actually contains, so no
 * composition here can match a slug naming somebody else.
 */
function compositionsOf(nameTokens: string[]): Set<string> {
  const out = new Set<string>();
  if (nameTokens.length === 0) return out;

  const first = nameTokens[0];
  const last = nameTokens[nameTokens.length - 1];

  // Whole name, in order and — for two-part names — reversed, since both
  // "pramodadiddam" and "adiddampramod" are slugs people genuinely use.
  out.add(nameTokens.join(''));
  if (nameTokens.length === 2) out.add(`${last}${first}`);

  // Initial + surname, and forename + surname initial.
  out.add(`${first[0]}${last}`);
  out.add(`${first}${last[0]}`);
  // Both initials, for a middle-name-bearing name: "p" + "a".
  if (nameTokens.length >= 2) out.add(nameTokens.map((t) => t[0]).join(''));

  // First and last only, skipping any middle names.
  if (nameTokens.length > 2) {
    out.add(`${first}${last}`);
    out.add(`${first[0]}${last}`);
  }

  return out;
}

/**
 * Decide whether a discovered candidate may be offered for selection.
 *
 * Ordering matters: the three EXCLUDED checks come first because each one
 * means there is nothing to verify against at all, which is a different
 * statement from "verified and found wanting".
 */
export function preVerifyCandidate(
  candidate: PreVerifyInput,
  context: PreVerifyContext = {},
): PreVerificationResult {
  const name = candidate.name?.trim() ?? '';
  const company = candidate.company?.trim() ?? '';
  const evidence = (candidate.evidence ?? []).filter(
    (e) => Boolean(e?.source_url?.trim()) && Boolean(e?.quote?.trim()),
  );

  // Destructured at parse time: `name_hint` exists only on the success
  // variant, and the invalid-URL early return below narrows a boolean copy
  // rather than `parsed` itself.
  const parsed = parseLinkedInUrl(candidate.linkedin_url);
  const urlValid = parsed.ok;
  const normalizedUrl = parsed.ok ? parsed.normalized_url : null;
  const nameHint = parsed.ok ? parsed.name_hint : null;

  const checks: PreVerificationChecks = {
    name_present: name.length > 0,
    evidence_present: evidence.length > 0,
    linkedin_url_valid: urlValid,
    name_in_evidence: false,
    company_in_evidence: false,
    name_matches_profile: null,
    role_consistent: null,
  };

  // ── EXCLUDED: nothing to verify against ────────────────────────────────
  if (!checks.name_present) {
    return excluded(checks, normalizedUrl, 'No name was established for this candidate.');
  }
  if (!checks.linkedin_url_valid) {
    return excluded(
      checks,
      normalizedUrl,
      candidate.linkedin_url?.trim()
        ? 'The stored profile link is not a valid public LinkedIn profile URL.'
        : 'No public LinkedIn profile URL, so identity cannot be verified.',
    );
  }
  if (!checks.evidence_present) {
    return excluded(checks, normalizedUrl, 'No supporting evidence was retrieved for this candidate.');
  }

  // ── Consistency checks: real conflicts, not missing inputs ─────────────
  const haystack = evidenceHaystack(evidence);
  checks.name_in_evidence = nameAppearsIn(name, haystack);
  checks.company_in_evidence = company.length > 0 ? companyAppearsIn(company, haystack) : false;
  checks.name_matches_profile = nameMatchesProfileSlug(name, nameHint);
  checks.role_consistent =
    context.targetRoles && context.targetRoles.length > 0
      ? roleMatches(candidate.role ?? '', context.targetRoles)
      : null;

  if (!checks.name_in_evidence) {
    return needsVerification(checks, normalizedUrl, 'The cited evidence does not name this person.');
  }
  if (!checks.company_in_evidence) {
    return needsVerification(checks, normalizedUrl, 'The cited evidence does not tie this person to this company.');
  }
  if (checks.name_matches_profile === false) {
    return needsVerification(checks, normalizedUrl, 'The LinkedIn profile link does not match this person’s name.');
  }
  if (checks.role_consistent === false) {
    return needsVerification(checks, normalizedUrl, 'This role does not match an owner of the qualified workflow.');
  }

  return { eligibility: 'ELIGIBLE', checks, blockedReason: null, normalizedUrl };
}

function excluded(
  checks: PreVerificationChecks,
  normalizedUrl: string | null,
  blockedReason: string,
): PreVerificationResult {
  return { eligibility: 'EXCLUDED', checks, blockedReason, normalizedUrl };
}

function needsVerification(
  checks: PreVerificationChecks,
  normalizedUrl: string | null,
  blockedReason: string,
): PreVerificationResult {
  return { eligibility: 'NEEDS_VERIFICATION', checks, blockedReason, normalizedUrl };
}

/** Convenience predicate — the one question the Select button asks. */
export function isSelectable(candidate: PreVerifyInput, context: PreVerifyContext = {}): boolean {
  return preVerifyCandidate(candidate, context).eligibility === 'ELIGIBLE';
}
