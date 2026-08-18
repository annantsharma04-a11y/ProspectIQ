import { describe, it, expect } from 'vitest';
import { currentDraftText } from '@/lib/drafts/current-text';

// The one function both the main run page's Personalized draft card
// (DraftReviewCard) and the generate_message Stage Detail view (StageDetail)
// call to decide "what text is this draft right now" — these tests exist to
// prove the precedence is exactly what a reviewer would expect, and that
// it's the same regardless of which page asks.

describe('currentDraftText', () => {
  it('an edit wins over everything else', () => {
    expect(
      currentDraftText({ edited_text: 'Edited version', final_text: 'Validated version', message_text: 'Original version' }),
    ).toBe('Edited version');
  });

  it("claim validation's revised text wins when there is no edit", () => {
    expect(
      currentDraftText({ edited_text: null, final_text: 'Validated version', message_text: 'Original version' }),
    ).toBe('Validated version');
  });

  it('falls back to the originally generated text when nothing revised it', () => {
    expect(currentDraftText({ edited_text: null, final_text: null, message_text: 'Original version' })).toBe(
      'Original version',
    );
  });

  it('an empty-string edit is a real edit, not "no edit"', () => {
    // Nullish coalescing, not `||` — an intentional empty edit must not fall
    // through to the validated or original text.
    expect(currentDraftText({ edited_text: '', final_text: 'Validated version', message_text: 'Original' })).toBe('');
  });
});
