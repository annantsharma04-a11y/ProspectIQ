// Which sources to surface on a research stage card.
//
// Purely presentational selection over ALREADY PERSISTED rows. It performs no
// retrieval, adds no provider call and adds no model call: everything here is
// arithmetic over `sources` rows the run already stored.
//
// Two jobs:
//
//   1. Attribute a source to the person stage or the company stage. The
//      pipeline builds its queries by category prefix — prospect* for
//      research_prospect, company* for research_company — and each source
//      records the categories that found it in `found_via`. Reusing that is
//      what keeps the two lists honestly separate, rather than guessing from
//      the URL or splitting a shared list in half.
//
//   2. Rank within a stage, deterministically. "Top" here means best evidence,
//      not first retrieved.

import { hostOf, isSameSource } from '@/lib/url-identity';
import { titleTokens } from '@/lib/research/normalize';
import type { SignalRow, SourceRow } from '@/lib/types';

export type ResearchStage = 'research_prospect' | 'research_company' | 'collect_signals';

/**
 * Which pipeline stages need `sources`/`signals` rows fetched to render their
 * detail page at all.
 *
 * A stage detail page that forgets this reads `sources: []` no matter how
 * many rows the run actually has — TopSources then reports "No sources
 * retrieved" for a genuinely populated evidence set, which looks like a data
 * bug but is really a page never having asked for the data. Named and
 * exported so that decision has exactly one place to be right, and can be
 * tested directly rather than only discovered by loading a page.
 */
export function stageNeedsSources(stage: string): stage is ResearchStage {
  return stage === 'research_prospect' || stage === 'research_company' || stage === 'collect_signals';
}

export type EvidenceKind = 'full' | 'snippet' | 'unavailable';

export interface RankedSource {
  source: SourceRow;
  /** Where the page body was retrieved, or only a search snippet was. */
  evidence: EvidenceKind;
  /** Registrable host, for display. */
  domain: string;
  /**
   * True only when the deterministic evidence system kept this source as a
   * verified signal. Never inferred from rank, recency or position.
   */
  usedAsEvidence: boolean;
  /** Ranking score, exposed so the ordering can be asserted in tests. */
  score: number;
}

/** Does this source belong to the person stage or the company stage? */
export function belongsToStage(source: SourceRow, stage: ResearchStage): boolean {
  // collect_signals consolidates BOTH prospect and company research into one
  // deduplicated evidence set — nothing to filter by prefix, everything found
  // so far belongs to it.
  if (stage === 'collect_signals') return true;
  const prefix = stage === 'research_prospect' ? 'prospect' : 'company';
  return (source.found_via ?? []).some((c) => c.toLowerCase().startsWith(prefix));
}

export function evidenceKindOf(source: SourceRow): EvidenceKind {
  switch (source.fetch_status) {
    case 'scraped':
      return 'full';
    case 'scrape_failed':
      return 'unavailable';
    default:
      return 'snippet';
  }
}

export const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  full: 'Full text',
  snippet: 'Snippet',
  unavailable: 'Unavailable',
};

// ─── scoring ─────────────────────────────────────────────────────────────────
//
// Weights are deliberately blunt and additive so the ordering is explainable
// from the row itself. Nothing here is tuned against a particular run.

/** Credibility already scored during normalization, 0–1. */
const W_CREDIBILITY = 40;
/** A page we actually read beats one we only have a snippet of. */
const W_FULL_TEXT = 25;
/** Verified evidence is the strongest signal a source mattered. */
const W_EVIDENCE = 20;
/** Recency, when a date exists at all. */
const W_RECENCY = 10;
/** Independent retrievals of the same source: corroboration. */
const W_DUPLICATE = 3;
const MAX_DUPLICATE_BONUS = 3;

/** Days after which a dated source earns no recency credit. */
const RECENCY_WINDOW_DAYS = 365;

function recencyPoints(published: string | null, now: Date): number {
  if (!published) return 0;
  const t = new Date(published).getTime();
  if (Number.isNaN(t)) return 0;
  const days = (now.getTime() - t) / 86_400_000;
  if (days < 0) return 0; // a future date is bad data, not freshness
  if (days >= RECENCY_WINDOW_DAYS) return 0;
  return W_RECENCY * (1 - days / RECENCY_WINDOW_DAYS);
}

function scoreOf(s: SourceRow, usedAsEvidence: boolean, now: Date): number {
  const evidence = evidenceKindOf(s);
  return (
    (s.credibility ?? 0.45) * W_CREDIBILITY +
    (evidence === 'full' ? W_FULL_TEXT : 0) +
    (usedAsEvidence ? W_EVIDENCE : 0) +
    recencyPoints(s.published_date, now) +
    Math.min(s.duplicate_count ?? 0, MAX_DUPLICATE_BONUS) * W_DUPLICATE
  );
}

/** The prospect a research_prospect list is being ranked for. */
export interface ProspectContext {
  name: string | null;
  /** LinkedIn slug — the profile itself, and any post URL embedding it, is relevant by construction. */
  slug: string | null;
}

/**
 * Is this source actually about the prospect — not just found by a query
 * scoped to them?
 *
 * A source's `found_via` category proves it was FOUND BY a prospect-scoped
 * search query, never that its content is about this person. Search
 * providers sometimes pad a thin result set with generic, highly-credible,
 * currently-trending stories that have nothing to do with the prospect at
 * all (a royal interview, a phone launch date) — those still carry high
 * credibility and would otherwise rank above genuinely relevant coverage.
 * This is the deterministic gate that keeps them out: every distinctive
 * token of the prospect's name must appear in the source's own title,
 * snippet or content, or the source's URL must be their own LinkedIn slug.
 */
export function mentionsProspect(source: SourceRow, prospect: ProspectContext): boolean {
  const nameTokens = prospect.name ? titleTokens(prospect.name) : new Set<string>();
  if (nameTokens.size === 0) return true; // nothing to check the source against — do not exclude blindly

  if (prospect.slug) {
    const url = (source.canonical_url || source.url).toLowerCase();
    if (url.includes(`/in/${prospect.slug.toLowerCase()}`)) return true;
  }

  const body = `${source.title ?? ''} ${source.snippet ?? ''} ${source.content ?? ''}`;
  const bodyTokens = titleTokens(body);
  return [...nameTokens].every((t) => bodyTokens.has(t));
}

/**
 * Rank a stage's sources, best first.
 *
 * For `research_prospect`, sources are also gated by `mentionsProspect()`
 * when a prospect is supplied — credibility and freshness alone are not
 * relevance, and ranking by those alone is exactly what let a generic
 * high-authority story about someone else outrank real coverage of the
 * actual person (see mentionsProspect's doc comment).
 *
 * Ties break on canonical_url so the order is stable across renders — a list
 * that reshuffles between page loads is not a ranking.
 */
export function rankSources(
  sources: SourceRow[],
  stage: ResearchStage,
  signals: SignalRow[] = [],
  now: Date = new Date(),
  prospect?: ProspectContext,
): RankedSource[] {
  const evidenceUrls = signals.map((sig) => sig.source_url).filter(Boolean);

  return sources
    .filter((s) => belongsToStage(s, stage))
    .filter((s) => stage !== 'research_prospect' || !prospect || mentionsProspect(s, prospect))
    .map((s): RankedSource => {
      const usedAsEvidence = evidenceUrls.some((u) => isSameSource(u, s.canonical_url || s.url));
      return {
        source: s,
        evidence: evidenceKindOf(s),
        domain: hostOf(s.canonical_url || s.url),
        usedAsEvidence,
        score: scoreOf(s, usedAsEvidence, now),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.source.canonical_url || a.source.url).localeCompare(
        b.source.canonical_url || b.source.url,
      );
    });
}

/**
 * The few sources to show on the card.
 *
 * Takes the best source from each distinct domain first, then fills any
 * remaining slots from what is left. Without that pass a single prolific
 * publisher takes every slot and the list stops being informative about where
 * the research actually came from.
 */
export function topSources(ranked: RankedSource[], limit = 4): RankedSource[] {
  const picked: RankedSource[] = [];
  const seen = new Set<string>();

  for (const r of ranked) {
    if (picked.length >= limit) break;
    if (r.domain && seen.has(r.domain)) continue;
    seen.add(r.domain);
    picked.push(r);
  }

  if (picked.length < limit) {
    const chosen = new Set(picked.map((p) => p.source.id));
    for (const r of ranked) {
      if (picked.length >= limit) break;
      if (chosen.has(r.source.id)) continue;
      picked.push(r);
    }
  }

  return picked;
}

/**
 * Human date for display. Returns null rather than inventing one.
 *
 * Locale is pinned explicitly rather than left as `undefined` — an ambient
 * locale is read from wherever the code happens to run, which is the
 * server's locale during SSR and the browser's during hydration. Those
 * disagreeing ("Apr 3, 2026" vs "3 Apr 2026") is a real hydration mismatch,
 * not a cosmetic one: React discards and re-renders the whole subtree when
 * server and client text disagree.
 */
export function displayDate(published: string | null): string | null {
  if (!published) return null;
  const d = new Date(published);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Look up the persisted source a citation URL refers to, by identity (not
 * string equality — the same source can be cited via different LinkedIn
 * locale subdomains or tracking params).
 *
 * Returns null when the URL is not among this run's persisted sources —
 * callers must treat that as "nothing to show", never fall back to
 * displaying the bare cited string as if it were a verified source.
 */
export function findSourceByUrl(sources: SourceRow[], url: string | null | undefined): SourceRow | null {
  if (!url) return null;
  return sources.find((s) => isSameSource(s.url, url) || isSameSource(s.canonical_url, url)) ?? null;
}
