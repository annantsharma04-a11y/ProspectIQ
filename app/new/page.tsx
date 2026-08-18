import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import { ProspectForm } from '@/components/ProspectForm';

export const dynamic = 'force-dynamic';

export default async function NewRunPage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/login?next=/new');

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="font-display mb-1 text-2xl font-semibold tracking-tight text-ink">
        Research a new prospect
      </h1>
      <p className="mb-5 text-sm text-muted">
        Paste a public LinkedIn profile URL. Research, qualification and a drafted message will be
        ready for your review — nothing is sent automatically.
      </p>
      <ProspectForm />
    </div>
  );
}
