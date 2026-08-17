'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserSupabase } from '@/lib/supabase/client';

const FIELD =
  'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';

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

    router.push(nextPath);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-slate-700">Email</label>
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
        <label htmlFor="password" className="block text-sm font-medium text-slate-700">Password</label>
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

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
      {notice && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
      </button>

      <button
        type="button"
        onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setNotice(null); }}
        className="w-full text-xs text-slate-500 hover:text-indigo-600"
      >
        {mode === 'signin' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
      </button>
    </form>
  );
}
