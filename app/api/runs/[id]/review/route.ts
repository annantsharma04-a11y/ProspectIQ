import { NextResponse } from 'next/server';
import { getDraft, updateDraft, updateRun } from '@/lib/supabase/queries';

export const runtime = 'nodejs';

/**
 * The human review gate. Records the reviewer's decision and stops there.
 *
 * Nothing in this route — or anywhere else in the app — sends a message to a
 * prospect. "Approved" means a human accepted the draft, nothing more.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: { action?: string; edited_text?: string };
  try {
    body = (await req.json()) as { action?: string; edited_text?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = body.action;
  if (!action || !['approved', 'edited', 'rejected'].includes(action)) {
    return NextResponse.json(
      { error: 'action must be one of: approved, edited, rejected' },
      { status: 400 },
    );
  }

  const draft = await getDraft(id);
  if (!draft) return NextResponse.json({ error: 'No draft for this run' }, { status: 404 });

  if (action === 'edited' && !body.edited_text?.trim()) {
    return NextResponse.json({ error: 'edited_text is required when action is "edited"' }, { status: 400 });
  }

  await updateDraft(draft.id, {
    reviewer_action: action as 'approved' | 'edited' | 'rejected',
    edited_text: action === 'edited' ? (body.edited_text ?? null) : null,
    reviewed_at: new Date().toISOString(),
  });

  const finalText =
    action === 'edited' ? (body.edited_text ?? '') : (draft.final_text ?? draft.message_text);

  await updateRun(id, {
    status: action === 'rejected' ? 'rejected' : 'approved',
    ...(action === 'rejected' ? {} : { generated_message: finalText }),
  });

  return NextResponse.json({ ok: true, sent: false });
}
