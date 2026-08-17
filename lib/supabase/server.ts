// Request-scoped Supabase clients.
//
// Two clients with deliberately different powers:
//
//   createServerSupabase() — carries the caller's session from cookies. Subject
//     to RLS, so it can only see that user's rows. This is what establishes WHO
//     is calling.
//   createServiceClient() (lib/supabase/client) — bypasses RLS entirely. It is
//     how the pipeline writes results, and it must never be used to answer a
//     request until the caller's right to that data has been checked in code.
//
// The service-role key is not authorization. It is the absence of authorization.

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient, User } from '@supabase/supabase-js';

/** Session-bound client. Reads and writes are constrained by RLS. */
export async function createServerSupabase(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Middleware refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}

/**
 * The authenticated user, or null.
 *
 * Uses getUser() rather than getSession(): getUser() revalidates the token with
 * the auth server, so a forged or expired cookie cannot pass. getSession()
 * trusts whatever the cookie says and must not be used for authorization.
 */
export async function getAuthenticatedUser(): Promise<User | null> {
  try {
    const supabase = await createServerSupabase();
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return data.user ?? null;
  } catch {
    return null;
  }
}
