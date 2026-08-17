import { redirect } from 'next/navigation';
import { Workspace } from '@/components/Workspace';
import { RecentRuns } from '@/components/RecentRuns';
import { getAuthenticatedUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/login');

  return <Workspace initial={null} recentRuns={<RecentRuns />} />;
}
