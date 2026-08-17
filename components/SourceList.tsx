import type { SourceRow } from '@/lib/types';

const FETCH_LABEL: Record<string, string> = {
  scraped: 'full page read',
  snippet_only: 'search snippet only',
  scrape_failed: 'page unavailable — snippet only',
};

export function SourceList({ sources }: { sources: SourceRow[] }) {
  if (sources.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500">
        No sources were retrieved.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {sources.map((s) => (
        <li key={s.id} className="rounded-lg border border-slate-200 bg-white p-2.5">
          <a
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-indigo-700 hover:underline"
          >
            {s.title || s.url}
          </a>
          <p className="mt-0.5 truncate text-[11px] text-slate-400" title={s.url}>{s.url}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
            <span className="rounded bg-slate-100 px-1.5 py-0.5">{s.source_type}</span>
            <span>credibility {Math.round((s.credibility ?? 0) * 100)}</span>
            <span>{s.published_date ?? 'undated'}</span>
            <span>{FETCH_LABEL[s.fetch_status ?? ''] ?? s.fetch_status}</span>
            {s.duplicate_count > 0 && <span>{s.duplicate_count} duplicate(s) merged</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
