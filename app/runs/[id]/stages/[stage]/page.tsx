import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  getRun,
  getStage,
  listSignals,
  listSources,
  listStages,
  listContactCandidates,
} from '@/lib/supabase/queries';
import { StageDetail } from '@/components/StageDetail';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import { STAGE_ORDER, STAGE_LABELS, type StageName } from '@/lib/types';
import { contactCandidatesStageIsVisible } from '@/lib/contacts/types';
import { stageNeedsSources } from '@/lib/research/top-sources';

export const dynamic = 'force-dynamic';

export default async function StagePage({
  params,
}: {
  params: Promise<{ id: string; stage: string }>;
}) {
  const { id, stage } = await params;
  if (!STAGE_ORDER.includes(stage as StageName)) notFound();

  const user = await getAuthenticatedUser();
  if (!user) redirect(`/login?next=/runs/${id}/stages/${stage}`);

  const run = await getRun(id);
  if (!run || run.user_id !== user.id) notFound();

  const row = await getStage(id, stage as StageName);
  if (!row) notFound();

  // Stages that show sources/signals: the two research stages (their own
  // findings) and collect_signals (the consolidated evidence set built from
  // both of them). Every other stage's detail is fully derived from its own
  // recorded `output`, so it reads nothing else needs. Both reads are already
  // scoped to this run, which ownership has been checked for above, and
  // neither contacts a provider or a model.
  const needsSources = stageNeedsSources(stage);
  const isContactDiscovery = stage === 'find_contact_candidates';
  const [all, sources, signals, contactCandidates] = await Promise.all([
    listStages(id),
    needsSources ? listSources(id) : Promise.resolve([]),
    needsSources ? listSignals(id) : Promise.resolve([]),
    isContactDiscovery ? listContactCandidates(id) : Promise.resolve([]),
  ]);
  // find_contact_candidates is a real stage but a no-op on every run except
  // the one specific state (company qualified, contact not) — prev/next
  // navigation skips over it like it was never there, unless it actually did
  // something, so ordinary runs step straight from qualification to signals.
  const contactCandidatesRow = all.find((s) => s.stage_name === 'find_contact_candidates');
  const contactCandidatesApplicable = contactCandidatesStageIsVisible(contactCandidatesRow?.output);
  const navigable = STAGE_ORDER.filter(
    (name) => name !== 'find_contact_candidates' || contactCandidatesApplicable || name === stage,
  );
  const index = navigable.indexOf(stage as StageName);
  const prev = index > 0 ? navigable[index - 1] : null;
  const next = index < navigable.length - 1 ? navigable[index + 1] : null;
  const ran = new Set(all.filter((s) => s.status !== 'pending').map((s) => s.stage_name));

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link href={`/runs/${id}`} className="text-sm font-medium text-accent hover:underline">
          ← Back to run
        </Link>
        <p className="truncate text-sm text-faint">
          {run.prospect_name ?? run.input_name ?? `/in/${run.linkedin_slug}`}
          {run.company_name ? ` · ${run.company_name}` : ''}
        </p>
      </div>

      <StageDetail
        run={run}
        stage={row}
        sources={sources}
        signals={signals}
        contactCandidates={contactCandidates}
      />

      <nav className="mt-4 flex items-center justify-between gap-3">
        {prev && ran.has(prev) ? (
          <Link
            href={`/runs/${id}/stages/${prev}`}
            className="rounded-lg border border-hairline px-3 py-2 text-sm font-medium text-muted hover:bg-app"
          >
            ← {STAGE_LABELS[prev]}
          </Link>
        ) : (
          <span />
        )}
        {next && ran.has(next) ? (
          <Link
            href={`/runs/${id}/stages/${next}`}
            className="rounded-lg border border-hairline px-3 py-2 text-sm font-medium text-muted hover:bg-app"
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
