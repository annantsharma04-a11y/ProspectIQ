import { Workspace } from '@/components/Workspace';
import { RecentRuns } from '@/components/RecentRuns';

export default function Home() {
  return <Workspace initial={null} recentRuns={<RecentRuns />} />;
}
