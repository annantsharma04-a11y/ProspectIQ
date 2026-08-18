// The single source of truth for "what is this draft's current text" — used
// by both the main run page's Personalized draft card (DraftReviewCard) and
// the generate_message Stage Detail view (StageDetail), so the two can never
// disagree about which version of the message is current.
//
// Before this existed, StageDetail read the generate_message STAGE's own
// `output.message_text` — a snapshot of what generation produced at the
// moment it ran. That snapshot never moves when the draft is later
// regenerated, revised by claim validation, or edited by a reviewer, while
// the main page always reads the live `drafts` row. The two pages could
// therefore show genuinely different text for the same run. Routing both
// through this one function makes that impossible: same input, same output,
// computed once.

/** Precedence: a human's edit wins, then claim-validation's revised text, then the originally generated text. */
export function currentDraftText(draft: {
  edited_text: string | null;
  final_text: string | null;
  message_text: string;
}): string {
  return draft.edited_text ?? draft.final_text ?? draft.message_text;
}
