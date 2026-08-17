// Authentication and authorization guards for API routes.
//
// Two separate questions, answered in order and never conflated:
//
//   requireUser()      — who is calling? No session, no data.
//   requireOwnedRun()  — may this caller touch THIS run?
//
// A run id is an identifier, not a capability. Being a UUID makes it hard to
// guess; it does not make it authorization. Every route that takes an id from
// the client resolves ownership through requireOwnedRun before doing anything.

import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import { getProspect, getRun, getContactCandidate } from '@/lib/supabase/queries';
import type { RunRow } from '@/lib/types';
import type { ProspectRow } from '@/lib/prospects/types';
import type { ContactCandidateRow } from '@/lib/contacts/types';

/** Generic 401. Says nothing about what exists behind it. */
export function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
}

/**
 * Generic 404 for a run the caller may not have.
 *
 * Deliberately identical whether the run does not exist or belongs to someone
 * else — a distinguishable 403 would confirm the existence of other people's
 * runs and let an attacker enumerate them.
 */
export function notFound(): NextResponse {
  return NextResponse.json({ error: 'Run not found' }, { status: 404 });
}

export type AuthResult = { user: User } | { response: NextResponse };

/** Resolve the caller, or produce the 401 the route should return. */
export async function requireUser(): Promise<AuthResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { response: unauthorized() };
  return { user };
}

export type RunAccessResult = { user: User; run: RunRow } | { response: NextResponse };

/**
 * Authenticate, then confirm the run belongs to the caller.
 *
 * Ownership is read with the service-role client (so the check itself cannot be
 * defeated by RLS quirks) and compared in code. Legacy runs with a null owner
 * belong to nobody and are refused — they are preserved in the database and can
 * be adopted deliberately via claim_orphan_runs().
 */
export async function requireOwnedRun(runId: string): Promise<RunAccessResult> {
  const auth = await requireUser();
  if ('response' in auth) return auth;

  let run: RunRow | null;
  try {
    run = await getRun(runId);
  } catch {
    // Never surface a database error to the caller.
    return { response: notFound() };
  }

  if (!run || run.user_id !== auth.user.id) return { response: notFound() };

  return { user: auth.user, run };
}

/** Generic 404 for a prospect the caller may not have. Same reasoning as notFound(). */
export function prospectNotFound(): NextResponse {
  return NextResponse.json({ error: 'Prospect not found' }, { status: 404 });
}

export type ProspectAccessResult =
  | { user: User; prospect: ProspectRow }
  | { response: NextResponse };

/**
 * Authenticate, then confirm the prospect belongs to the caller.
 *
 * Identical shape and identical reasoning to requireOwnedRun: a prospect id is
 * an identifier, not a capability, and a foreign prospect is indistinguishable
 * from a missing one.
 */
export async function requireOwnedProspect(prospectId: string): Promise<ProspectAccessResult> {
  const auth = await requireUser();
  if ('response' in auth) return auth;

  let prospect: ProspectRow | null;
  try {
    prospect = await getProspect(prospectId);
  } catch {
    return { response: prospectNotFound() };
  }

  if (!prospect || prospect.user_id !== auth.user.id) return { response: prospectNotFound() };

  return { user: auth.user, prospect };
}

/** Generic 404 for a contact candidate the caller may not have. Same reasoning as notFound(). */
export function contactCandidateNotFound(): NextResponse {
  return NextResponse.json({ error: 'Contact candidate not found' }, { status: 404 });
}

export type ContactCandidateAccessResult =
  | { user: User; run: RunRow; candidate: ContactCandidateRow }
  | { response: NextResponse };

/**
 * Authenticate, confirm the run belongs to the caller, THEN confirm the
 * candidate belongs to that specific run.
 *
 * A candidate has no user_id of its own — ownership is derived through its
 * run, exactly like signals, sources and drafts. Checking both matters: it
 * refuses a candidate id paired with someone else's run id just as firmly as
 * it refuses a candidate that does not exist.
 */
export async function requireOwnedContactCandidate(
  runId: string,
  candidateId: string,
): Promise<ContactCandidateAccessResult> {
  const runAccess = await requireOwnedRun(runId);
  if ('response' in runAccess) return runAccess;

  let candidate: ContactCandidateRow | null;
  try {
    candidate = await getContactCandidate(candidateId);
  } catch {
    return { response: contactCandidateNotFound() };
  }

  if (!candidate || candidate.run_id !== runAccess.run.id) {
    return { response: contactCandidateNotFound() };
  }

  return { user: runAccess.user, run: runAccess.run, candidate };
}
