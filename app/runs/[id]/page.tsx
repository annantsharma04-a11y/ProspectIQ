import { notFound, redirect } from 'next/navigation';
import { getRun, listStages, listSignals, listSources, getDraft, listContactCandidates } from '@/lib/supabase/queries';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import { Workspace } from '@/components/Workspace';
import { RecentRuns } from '@/components/RecentRuns';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getAuthenticatedUser();
  if (!user) redirect(`/login?next=/runs/${id}`);

  const run = await getRun(id);
  // Same response whether it is missing or someone else's — no enumeration.
  if (!run || run.user_id !== user.id) notFound();

  const [stages, signals, sources, draft, contactCandidates] = await Promise.all([
    listStages(id),
    listSignals(id),
    listSources(id),
    getDraft(id),
    // Supplementary: until migration 011 is applied the table does not
    // exist yet, and that must never take down the run page itself.
    listContactCandidates(id).catch(() => []),
  ]);

  return (
    <Workspace
      initial={{ run, stages, signals, sources, draft, contactCandidates }}
      recentRuns={<RecentRuns />}
    />
  );
}
