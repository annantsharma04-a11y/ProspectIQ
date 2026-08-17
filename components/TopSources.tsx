'use client';

import { useState } from 'react';
import type { SignalRow, SourceRow } from '@/lib/types';
import {
  EVIDENCE_LABEL,
  displayDate,
  rankSources,
  topSources,
  type RankedSource,
  type ResearchStage,
} from '@/lib/research/top-sources';

const EVIDENCE_STYLE: Record<string, string> = {
  full: 'bg-emerald-50 text-emerald-700',
  snippet: 'bg-amber-50 text-amber-700',
  unavailable: 'bg-slate-100 text-slate-500',
};

const SHOWN = 4;

/**
 * The sources a research stage actually drew on.
 *
 * Reads rows the run already persisted. It retrieves nothing, so opening this
 * card costs no provider call and no model call.
 *
 * The distinction it has to keep visible: these are RESEARCH sources, which is
 * not the same as evidence. Only the ones the deterministic evidence system
 * kept as verified signals carry the "Used as evidence" mark, and that comes
 * from matching the stored signal URLs — never from a source's position here.
 */
export function TopSources({
  sources,
  signals,
  stage,
}: {
  sources: SourceRow[];
  signals: SignalRow[];
  stage: ResearchStage;
}) {
  const [expanded, setExpanded] = useState(false);

  const ranked = rankSources(sources, stage, signals);
  const shown = expanded ? ranked : topSources(ranked, SHOWN);

  if (ranked.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500">
        No sources retrieved.
      </p>
    );
  }

  return (
    <div>
      <p className="mb-2 text-xs text-slate-500">
        {stage === 'research_prospect'
          ? 'Sources about the person: their role, public activity, interviews and posts.'
          : 'Sources about company developments: funding, launches, hiring, partnerships and strategy.'}
      </p>

      <ul className="space-y-2">
        {shown.map((r) => (
          <SourceCard key={r.source.id} ranked={r} />
        ))}
      </ul>

      {ranked.length > shown.length && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2.5 text-xs font-medium text-indigo-600 hover:underline"
        >
          View all {ranked.length} sources
        </button>
      )}
      {expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-2.5 text-xs font-medium text-slate-500 hover:underline"
        >
          Show fewer
        </button>
      )}
    </div>
  );
}

function SourceCard({ ranked }: { ranked: RankedSource }) {
  const { source, evidence, domain, usedAsEvidence } = ranked;
  const date = displayDate(source.published_date);
  // A missing title is shown as a missing title, never invented from the URL.
  const title = source.title?.trim();

  return (
    <li className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="min-w-0 text-sm font-medium leading-snug text-indigo-700 hover:underline"
        >
          {title || 'Open source'}
        </a>
        {usedAsEvidence && (
          <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
            Used as evidence
          </span>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
        {domain && <span className="truncate">{domain}</span>}
        {date && (
          <>
            <span aria-hidden>·</span>
            <span>{date}</span>
          </>
        )}
        <span aria-hidden>·</span>
        <span className={`rounded px-1.5 py-0.5 font-medium ${EVIDENCE_STYLE[evidence]}`}>
          {EVIDENCE_LABEL[evidence]}
        </span>
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="ml-auto shrink-0 font-medium text-slate-500 hover:text-indigo-600 hover:underline"
        >
          Open ↗
        </a>
      </div>
    </li>
  );
}
