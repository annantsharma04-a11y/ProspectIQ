// Deterministic verification and ranking of proposed contact candidates.
//
// The model in discover.ts only proposes. Everything that decides whether a
// candidate is real, and in what order it is shown, happens here in plain
// code — the same "model proposes, code decides" split as hook verification.
//
// Two gates a candidate must clear before it is even ranked:
//   1. Its quote must appear verbatim in a source that was actually retrieved
//      (reuses the same check a hook's supporting_quote goes through).
//   2. Its role must match one of the roles the qualified workflow implies —
//      never trust the model's own labelling of relevance.
//
// Ranking itself is additive and inspectable, the same shape as signal scoring
// in lib/ranking/rank.ts: no single factor can dominate silently.

import { isSameSource } from '@/lib/url-identity';
import { quoteAppearsIn } from '@/lib/signals/verify';
import type { NormalizedSource } from '@/lib/research/normalize';
import { roleTier } from './roles';

export interface ProposedCandidate {
  name: string;
  role: string;
  linkedin_url: string | null;
  quote: string;
  sourceUrl: string;
}

export interface VerifiedCandidate {
  name: string;
  role: string;
  linkedin_url: string | null;
  /** Evidence backing the suggestion: the source and the verbatim quote. */
  evidence: { source_url: string; quote: string };
  /** Plain statement of why this role was targeted. */
  reason: string;
  /** 0–100, exposed on the persisted row. */
  confidence: number;
  /** The additive ranking score behind the ordering — kept for the UI/tests. */
  rankScore: number;
}

/** Cap on how many candidates are ever shown, per the product requirement. */
export const MAX_CANDIDATES = 5;
/** Below this many, an empty result is more honest than padding the list. */
export const MIN_CANDIDATES = 0;

const W_ROLE_MATCH = 35;
/**
 * Seniority, applied only AFTER functional relevance has already been proven.
 *
 * roleMatches() is a hard gate above this: a candidate whose role does not own
 * the qualified workflow is never scored at all. So this weight can only ever
 * order people who are ALL relevant — it cannot lift an unrelated senior
 * person above a relevant junior one, because the unrelated person is not in
 * the list to be lifted.
 *
 * Sized below W_ROLE_MATCH deliberately: authority breaks ties among relevant
 * owners, it does not substitute for owning the workflow.
 */
const W_SENIORITY = 20;
const W_HAS_LINKEDIN = 25;
const W_SOURCE_CREDIBILITY = 25;
const W_QUOTE_LENGTH = 10; // a longer verified quote is harder to have faked context for
const W_RECENCY = 5;

/**
 * Loose match: "VP Finance" should match a source's "Vice President of Finance".
 *
 * Exported so lib/contacts/preverify.ts applies the SAME role gate rather than
 * writing a second, subtly different one — the two must never disagree about
 * whether a role owns the qualified workflow.
 */
export function roleMatches(proposedRole: string, targetRoles: string[]): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/vice president/g, 'vp').replace(/chief financial officer/g, 'cfo').replace(/[^a-z ]/g, ' ').trim();
  const p = norm(proposedRole);
  const pWords = new Set(p.split(/\s+/).filter((w) => w.length > 2));
  return targetRoles.some((t) => {
    const tWords = norm(t).split(/\s+/).filter((w) => w.length > 2);
    if (tWords.length === 0) return false;
    const hits = tWords.filter((w) => pWords.has(w)).length;
    return hits / tWords.length >= 0.5;
  });
}

/** Who the current run is already about — the identity a proposed candidate must never turn out to be. */
export interface CurrentProspectIdentity {
  linkedin_url: string | null;
  name: string | null;
  company: string | null;
}

function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Is this proposed candidate actually the prospect this run is already
 * about? Contact discovery must never suggest a run's own subject back as
 * an "alternative contact" at their own company.
 *
 * Prefers the LinkedIn URL: both sides are already canonicalized through
 * parseLinkedInUrl() before this is called, so an exact match is unambiguous
 * identity. Falls back to normalized name + company only when a URL
 * comparison is not possible — a weaker signal, and why BOTH must match:
 * matching on name alone would wrongly exclude a different person who
 * happens to share a name at the same company.
 */
export function isCurrentProspect(
  candidate: { name: string; linkedin_url: string | null; company: string | null },
  current: CurrentProspectIdentity,
): boolean {
  if (candidate.linkedin_url && current.linkedin_url) {
    return candidate.linkedin_url.toLowerCase() === current.linkedin_url.toLowerCase();
  }
  if (!current.name || !current.company || !candidate.company) return false;
  return (
    normalizeForComparison(candidate.name) === normalizeForComparison(current.name) &&
    normalizeForComparison(candidate.company) === normalizeForComparison(current.company)
  );
}

/** The identity fields a persisted or proposed candidate is deduplicated on. */
export interface CandidateIdentityKey {
  linkedin_url: string | null;
  name: string | null;
  company: string | null;
}

/**
 * Is `a` the same real person as `b`? Used to keep a pipeline retry from
 * persisting the same discovered candidate a second time — createContactCandidates()
 * is a plain insert with no uniqueness constraint of its own, so this is the
 * check that gives it one.
 *
 * Same shape as isCurrentProspect() above, for the same reason: prefer the
 * LinkedIn URL (both sides are already canonicalized through
 * parseLinkedInUrl() before either function ever sees them, so an exact
 * match is unambiguous identity), and fall back to normalized name + company
 * only when a URL comparison is not possible. Requiring BOTH name and
 * company in the fallback is what keeps a different person at the same
 * company from being wrongly collapsed into one row.
 */
export function isDuplicateCandidate(a: CandidateIdentityKey, b: CandidateIdentityKey): boolean {
  if (a.linkedin_url && b.linkedin_url) {
    return a.linkedin_url.toLowerCase() === b.linkedin_url.toLowerCase();
  }
  if (!a.name || !b.name || !a.company || !b.company) return false;
  return (
    normalizeForComparison(a.name) === normalizeForComparison(b.name) &&
    normalizeForComparison(a.company) === normalizeForComparison(b.company)
  );
}

/** Tier 1 keeps the full seniority weight, Tier 2 two-thirds, Tier 3 one-third. */
const TIER_WEIGHT: Record<number, number> = { 1: 1, 2: 2 / 3, 3: 1 / 3 };

function scoreOf(c: ProposedCandidate, source: NormalizedSource): number {
  const roleScore = W_ROLE_MATCH; // only scored candidates already passed the role gate
  const seniorityScore = W_SENIORITY * (TIER_WEIGHT[roleTier(c.role)] ?? TIER_WEIGHT[3]);
  const linkedinScore = c.linkedin_url ? W_HAS_LINKEDIN : 0;
  const credibilityScore = (source.credibility ?? 0.45) * W_SOURCE_CREDIBILITY;
  const quoteScore = Math.min(c.quote.length / 20, W_QUOTE_LENGTH);
  const recencyScore = source.published_date ? W_RECENCY : 0;
  return roleScore + seniorityScore + linkedinScore + credibilityScore + quoteScore + recencyScore;
}

/**
 * Verify and rank a discovery result.
 *
 * `targetRoles` is the deterministic role list discovery already searched for
 * (see lib/contacts/roles.ts). `workflowSignal` is folded into the stored
 * `reason` so the UI can say WHY the role was targeted, not just that it was.
 */
export function rankCandidates(
  proposed: ProposedCandidate[],
  sources: NormalizedSource[],
  targetRoles: string[],
  workflowSignal: string,
): VerifiedCandidate[] {
  const dedupedByName = new Map<string, ProposedCandidate>();

  for (const c of proposed) {
    // Role gate: the model does not get to decide relevance by asserting it.
    if (!roleMatches(c.role, targetRoles)) continue;

    // Evidence gate: the quote must be real, in a source we actually have.
    const source = sources.find((s) => isSameSource(s.url, c.sourceUrl) || isSameSource(s.canonical_url, c.sourceUrl));
    if (!source) continue;
    const body = `${source.title}\n${source.snippet}\n${source.content ?? ''}`;
    if (!quoteAppearsIn(c.quote, body)) continue;

    const key = c.name.trim().toLowerCase();
    const existing = dedupedByName.get(key);
    // The same person can surface from more than one query; keep the
    // strongest-scored appearance rather than the first.
    if (!existing || scoreOf(c, source) > scoreOf({ ...existing }, source)) {
      dedupedByName.set(key, c);
    }
  }

  const ranked = [...dedupedByName.values()]
    .map((c) => {
      const source = sources.find((s) => isSameSource(s.url, c.sourceUrl) || isSameSource(s.canonical_url, c.sourceUrl))!;
      const score = scoreOf(c, source);
      return {
        name: c.name,
        role: c.role,
        linkedin_url: c.linkedin_url,
        evidence: { source_url: c.sourceUrl, quote: c.quote },
        reason: `Public role matches the qualified workflow (${workflowSignal}).`,
        confidence: Math.round(
          Math.min(
            100,
            (score /
              (W_ROLE_MATCH + W_SENIORITY + W_HAS_LINKEDIN + W_SOURCE_CREDIBILITY + W_QUOTE_LENGTH + W_RECENCY)) *
              100,
          ),
        ),
        rankScore: Math.round(score * 100) / 100,
      };
    })
    // Ties broken on name so the order is stable across runs.
    .sort((a, b) => (b.rankScore !== a.rankScore ? b.rankScore - a.rankScore : a.name.localeCompare(b.name)));

  return ranked.slice(0, MAX_CANDIDATES);
}
