import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getRun, getStage, listStages } from '@/lib/supabase/queries';
import { StageDetail } from '@/components/StageDetail';
import { STAGE_ORDER, STAGE_LABELS, type StageName } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function StagePage({
  params,
}: {
  params: Promise<{ id: string; stage: string }>;
}) {
  const { id, stage } = await params;
  if (!STAGE_ORDER.includes(stage as StageName)) notFound();

  const run = await getRun(id);
  if (!run) notFound();

  const row = await getStage(id, stage as StageName);
  if (!row) notFound();

  const all = await listStages(id);
  const index = STAGE_ORDER.indexOf(stage as StageName);
  const prev = index > 0 ? STAGE_ORDER[index - 1] : null;
  const next = index < STAGE_ORDER.length - 1 ? STAGE_ORDER[index + 1] : null;
  const ran = new Set(all.filter((s) => s.status !== 'pending').map((s) => s.stage_name));

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link href={`/runs/${id}`} className="text-sm font-medium text-indigo-600 hover:underline">
          ← Back to run
        </Link>
        <p className="truncate text-sm text-slate-500">
          {run.prospect_name ?? run.input_name ?? `/in/${run.linkedin_slug}`}
          {run.company_name ? ` · ${run.company_name}` : ''}
        </p>
      </div>

      <StageDetail run={run} stage={row} />

      <nav className="mt-4 flex items-center justify-between gap-3">
        {prev && ran.has(prev) ? (
          <Link
            href={`/runs/${id}/stages/${prev}`}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            ← {STAGE_LABELS[prev]}
          </Link>
        ) : (
          <span />
        )}
        {next && ran.has(next) ? (
          <Link
            href={`/runs/${id}/stages/${next}`}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {STAGE_LABELS[next]} →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </div>
  );
}
