import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/** Ends the session and returns to the login page. */
export async function POST(req: Request) {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/login', req.url), { status: 303 });
}
