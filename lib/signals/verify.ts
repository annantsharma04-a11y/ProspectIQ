// Deterministic evidence checks. No model involved — this is the mechanical
// gate that stops a hallucinated hook from ever reaching ranking or drafting.

import { isSameSource } from '@/lib/url-identity';
import type { NormalizedSource } from '@/lib/research/normalize';
import type { AnalysisHook } from '@/lib/llm/analyze';
import type { ExtractedSignal } from './types';

export function clampScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Quote matching tolerant of whitespace and punctuation drift, since scraped
 * markdown mangles both. Long quotes fall back to a high word-overlap check.
 */
export function quoteAppearsIn(quote: string, body: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(quote);
  const b = norm(body);
  if (q.length < 12) return false; // too short to verify meaningfully
  if (b.includes(q)) return true;

  const words = q.split(' ').filter((w) => w.length > 3);
  if (words.length === 0) return false;
  return words.filter((w) => b.includes(w)).length / words.length >= 0.85;
}

export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 1990 || year > new Date().getUTCFullYear() + 1) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Keep only hooks that cite a source we actually retrieved AND quote text that
 * genuinely appears in it. Everything else is reported as rejected, with why.
 */
export function verifyHooks(
  hooks: AnalysisHook[],
  sources: NormalizedSource[],
): { kept: ExtractedSignal[]; rejected: { signal: string; reason: string }[] } {
  const kept: ExtractedSignal[] = [];
  const rejected: { signal: string; reason: string }[] = [];

  for (const hook of hooks) {
    // Identity comparison, not string equality: a model may cite
    // sg.linkedin.com/in/x for a profile we stored as www.linkedin.com/in/x.
    const source = sources.find(
      (s) => isSameSource(s.url, hook.source_url) || isSameSource(s.canonical_url, hook.source_url),
    );

    if (!source) {
      rejected.push({
        signal: hook.signal,
        reason: `Cited a URL that was not retrieved: ${hook.source_url}`,
      });
      continue;
    }

    const body = `${source.title}\n${source.snippet}\n${source.content ?? ''}`;
    if (!quoteAppearsIn(hook.supporting_quote, body)) {
      rejected.push({
        signal: hook.signal,
        reason: 'Supporting quote does not appear in the cited source.',
      });
      continue;
    }

    kept.push({
      signal: hook.signal,
      why_it_matters: hook.why_it_matters,
      category: (hook.category ?? 'other') as ExtractedSignal['category'],
      source_title: source.title,
      source_url: hook.source_url,
      // Trust the source's own date over the model's reading of it.
      published_date: source.published_date ?? normalizeDate(hook.published_date),
      supporting_quote: hook.supporting_quote,
      relevance_score: clampScore(hook.relevance_score),
      specificity_score: clampScore(hook.specificity_score),
      confidence_score: clampScore(hook.confidence_score),
      conflicts_with: hook.conflicts_with ?? null,
      signal_level: hook.signal_level === 'COMPANY' ? 'COMPANY' : 'PERSON',
      role_relevance: hook.role_relevance ?? null,
      outreach_rationale: hook.outreach_rationale ?? null,
      related_capability_id: hook.related_capability_id ?? null,
    });
  }

  return { kept, rejected };
}
