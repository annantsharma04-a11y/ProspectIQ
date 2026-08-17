import type { SignalRow } from '@/lib/types';

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  const v = value ?? 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[11px] text-slate-500">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        <span className="block h-full rounded-full bg-indigo-400" style={{ width: `${v}%` }} />
      </span>
      <span className="w-7 text-right text-[11px] tabular-nums text-slate-500">{v}</span>
    </div>
  );
}

export function SignalList({ signals }: { signals: SignalRow[] }) {
  if (signals.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500">
        No signals were extracted from the sources that were found.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {signals.map((s, i) => (
        <li
          key={s.id}
          className={`rounded-lg border p-3 ${
            s.selected_as_hook ? 'border-indigo-300 bg-indigo-50/50' : 'border-slate-200 bg-white'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium text-slate-800">
              <span className="mr-1.5 text-xs text-slate-400">#{i + 1}</span>
              {s.signal}
            </p>
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-600">
              {s.composite_score ?? 0}
            </span>
          </div>

          {s.selected_as_hook && (
            <span className="mt-1 inline-block rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
              Selected hook
            </span>
          )}

          {s.why_it_matters && <p className="mt-1.5 text-xs text-slate-600">{s.why_it_matters}</p>}

          {s.conflicts_with && (
            <p className="mt-1.5 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
              Conflicting evidence: {s.conflicts_with}
            </p>
          )}

          {s.supporting_quote && (
            <blockquote className="mt-2 border-l-2 border-slate-200 pl-2 text-xs italic text-slate-500">
              “{s.supporting_quote}”
            </blockquote>
          )}

          <div className="mt-2 space-y-1">
            <ScoreBar label="recency" value={s.recency_score} />
            <ScoreBar label="relevance" value={s.relevance_score} />
            <ScoreBar label="specificity" value={s.specificity_score} />
            <ScoreBar label="confidence" value={s.confidence_score} />
            <ScoreBar label="credibility" value={s.credibility_score} />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
            <span>{s.category?.replace(/_/g, ' ')}</span>
            <span>{s.published_date ?? 'undated'}</span>
            <span>{s.source_type}</span>
            {s.corroboration_count > 0 && <span>{s.corroboration_count} corroborating</span>}
            <a
              href={s.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-indigo-600 hover:underline"
            >
              source ↗
            </a>
          </div>
        </li>
      ))}
    </ul>
  );
}
