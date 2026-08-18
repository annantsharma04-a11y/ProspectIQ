'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserSupabase } from '@/lib/supabase/client';
import { safeNextPath } from '@/lib/auth/safe-next-path';

// Underline-only field: no box, no fill — a hairline bottom border that turns
// accent-colored on focus. Presentation only; every prop below is unchanged.
const FIELD =
  'mt-3 block w-full border-0 border-b border-hairline bg-transparent px-0 pb-2.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-0';

/**
 * Email + password sign-in against Supabase Auth.
 *
 * Uses the anon key only, which is safe: it is public by design and, with RLS
 * enabled, grants nothing on its own. The session cookie it establishes is what
 * every server-side check reads.
 */
export function LoginForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    const supabase = createBrowserSupabase();
    const { error: authError, data } =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    setBusy(false);

    if (authError) {
      // Supabase messages here are user-facing and carry no internal detail.
      setError(authError.message);
      return;
    }

    if (mode === 'signup' && !data.session) {
      setNotice('Check your email to confirm the account, then sign in.');
      return;
    }

    // Re-validated here too: nextPath already came sanitized from the server
    // page, but router.push() is a second place a malicious/unsanitized value
    // could otherwise reach the browser's location, so this component never
    // trusts its prop alone.
    router.push(safeNextPath(nextPath));
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-ink">Email</label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={FIELD}
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-ink">Password</label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={FIELD}
        />
      </div>

      {error && <p className="rounded-lg bg-red-600/8 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
      {notice && <p className="rounded-lg bg-emerald-600/8 px-3 py-2 text-sm text-emerald-800">{notice}</p>}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-ink px-4 py-3 text-sm font-semibold text-white transition hover:bg-ink/90 disabled:opacity-50"
      >
        {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
      </button>

      <button
        type="button"
        onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setNotice(null); }}
        className="w-full text-center text-sm text-muted hover:text-accent"
      >
        {mode === 'signin' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
      </button>

      <p className="pt-4 text-xs leading-relaxed text-faint">
        Public profile data is retrieved through a compliant provider. Nothing is accessed behind
        a login, and outreach is always sent manually.
      </p>
    </form>
  );
}
