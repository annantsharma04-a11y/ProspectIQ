import { NextResponse } from 'next/server';
import { requireOwnedRun } from '@/lib/auth/guard';
import { updateRun } from '@/lib/supabase/queries';
import {
  accountDecisionState,
  continuationPath,
  needsAccountDecision,
  withAccountDecision,
  type AccountDecisionChoice,
} from '@/lib/qualification/account-decision';
import { continueAfterAccountDecision, holdAfterAccountDecision } from '@/lib/pipeline/execute';
import { checkRateLimit } from '@/lib/rate-limit';
import { inngest, OUTREACH_ACCOUNT_DECISION_MADE } from '@/inngest/client';

export const runtime = 'nodejs';

const CHOICES: AccountDecisionChoice[] = ['CONTINUED', 'HELD'];

/**
 * Record a person's decision on a borderline account, and act on it.
 *
 * This route grants no exemptions. It writes one field — who decided what, and
 * when — and then re-enters the ordinary pipeline. The qualification result it
 * is attached to is copied through untouched: a BORDERLINE account is still
 * BORDERLINE after a person continues it, `proceed` is unchanged, and every
 * identity, evidence, candidate-verification, hook, solution and claim gate
 * downstream runs exactly as it would on any other run.
 *
 * It is offered ONLY for the two borderline matrix cells that pause (see
 * lib/qualification/account-decision.ts). A request against a NOT_QUALIFIED
 * company is refused here, not merely hidden in the UI — a human decision must
 * never reach below the evidence floor.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireOwnedRun(id);
  if ('response' in access) return access.response;
  const { user, run } = access;

  if (run.status === 'running' || run.status === 'queued') {
    return NextResponse.json({ error: 'Run is already in progress' }, { status: 409 });
  }

  const qualification = run.qualification;
  if (!needsAccountDecision(qualification)) {
    return NextResponse.json(
      {
        error:
          'This run does not ask for an account decision. The evidence already settled it, and a person cannot override that.',
        state: accountDecisionState(qualification),
      },
      { status: 409 },
    );
  }

  // Already answered. Re-answering would mean a second pipeline dispatch for
  // the same run, so it is refused rather than silently duplicated.
  const current = accountDecisionState(qualification);
  if (current !== 'REQUIRED') {
    return NextResponse.json(
      { error: `This account was already ${current.toLowerCase()}.`, state: current },
      { status: 409 },
    );
  }

  if (!checkRateLimit().ok) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 });
  }

  let body: { decision?: unknown };
  try {
    body = (await req.json()) as { decision?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const decision = body.decision as AccountDecisionChoice;
  if (!CHOICES.includes(decision)) {
    return NextResponse.json(
      { error: 'decision must be CONTINUED or HELD' },
      { status: 400 },
    );
  }

  // qualification is non-null here: needsAccountDecision() already required it.
  const next = withAccountDecision(qualification!, decision, user.id);

  try {
    await updateRun(id, { qualification: next });
  } catch {
    return NextResponse.json({ error: 'Could not save your decision' }, { status: 500 });
  }

  if (decision === 'HELD') {
    // Terminal, and cheap — no stage runs and no model is called, so this is
    // done inline rather than dispatched.
    await holdAfterAccountDecision(id).catch((err) =>
      console.error(`[run ${id}] account hold error:`, err),
    );
    return NextResponse.json({ ok: true, state: 'HELD', continuation_path: null }, { status: 200 });
  }

  // Same durable dispatch as every other pipeline entry point.
  if (process.env.USE_INNGEST === 'true') {
    await inngest.send({ name: OUTREACH_ACCOUNT_DECISION_MADE, data: { runId: id } });
  } else {
    continueAfterAccountDecision(id).catch((err) =>
      console.error(`[run ${id}] account continue error:`, err),
    );
  }

  return NextResponse.json(
    { ok: true, state: 'CONTINUED', continuation_path: continuationPath(next) },
    { status: 202 },
  );
}
