import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import { LoginForm } from '@/components/LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const user = await getAuthenticatedUser();
  if (user) redirect(next && next.startsWith('/') ? next : '/');

  return (
    <div className="mx-auto max-w-sm py-16">
      <h1 className="text-2xl font-bold tracking-tight">
        Prospect<span className="text-indigo-600">IQ</span>
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Sign in to run prospect research. Runs are private to your account.
      </p>
      <div className="mt-6">
        {/* `next` is validated server-side above and passed through as a relative path only. */}
        <LoginForm nextPath={next && next.startsWith('/') ? next : '/'} />
      </div>
    </div>
  );
}
