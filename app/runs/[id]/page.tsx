import { notFound } from 'next/navigation';
import { getRun, listStages, listSignals, listSources, getDraft } from '@/lib/supabase/queries';
import { Workspace } from '@/components/Workspace';
import { RecentRuns } from '@/components/RecentRuns';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  const [stages, signals, sources, draft] = await Promise.all([
    listStages(id),
    listSignals(id),
    listSources(id),
    getDraft(id),
  ]);

  return (
    <Workspace initial={{ run, stages, signals, sources, draft }} recentRuns={<RecentRuns />} />
  );
}
