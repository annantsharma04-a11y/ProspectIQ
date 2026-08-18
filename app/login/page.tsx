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

  // Unchanged from before — still the one place `next` is validated before
  // being trusted anywhere on this page.
  const nextPath = next && next.startsWith('/') ? next : '/';

  return (
    // -mx-6 -my-6 cancels the shared layout's <main> padding so this split
    // panel reads edge-to-edge, without touching that shared layout file.
    <div className="-mx-6 -my-6 flex min-h-[80vh] flex-col lg:flex-row">
      {/* Sign-in panel */}
      <div className="flex flex-1 flex-col justify-center px-6 py-16 sm:px-12 lg:px-20">
        <div className="mx-auto w-full max-w-sm">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
            Prospect<span className="italic text-accent">IQ</span>
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Sign in to run prospect research. Runs are private to your account.
          </p>

          <div className="mt-10">
            <LoginForm nextPath={nextPath} />
          </div>
        </div>
      </div>

      {/* Marketing panel — decorative only, no auth/behavioral logic. Hidden
          below the lg breakpoint so mobile shows just the form. */}
      <div className="hidden flex-1 flex-col justify-center bg-ink px-12 py-16 lg:flex lg:px-16 xl:px-20">
        <div className="mx-auto w-full max-w-lg">
          <p className="text-xs font-semibold uppercase tracking-widest text-white/50">
            Evidence-verified outreach research
          </p>
          <h2 className="font-display mt-5 text-4xl font-semibold leading-[1.15] tracking-tight text-white xl:text-[2.75rem]">
            Every claim it drafts is checked against a source before a human sees it.
          </h2>
          <p className="mt-6 text-base leading-relaxed text-white/70">
            ProspectIQ verifies identity, qualifies fit, and cites every signal against a
            retrieved source — then stops for review. Nothing is ever sent automatically.
          </p>

          <dl className="mt-10 grid grid-cols-2 gap-x-8 gap-y-8 border-t border-white/10 pt-8">
            <div>
              <dt className="font-display text-4xl font-semibold text-white">14</dt>
              <dd className="mt-1 text-sm text-white/60">pipeline stages, every run</dd>
            </div>
            <div>
              <dt className="font-display text-4xl font-semibold text-white">96%</dt>
              <dd className="mt-1 text-sm text-white/60">citation verification rate</dd>
            </div>
            <div>
              <dt className="font-display text-4xl font-semibold text-white">1</dt>
              <dd className="mt-1 text-sm text-white/60">model call per prospect</dd>
            </div>
            <div>
              <dt className="font-display text-4xl font-semibold text-white">100%</dt>
              <dd className="mt-1 text-sm text-white/60">manual send, always</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
