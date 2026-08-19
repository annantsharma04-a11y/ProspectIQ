// Corporate group membership — the smallest safe representation for "these
// two company names might legitimately be the same employer" that isn't
// plain fuzzy string similarity.
//
// The problem this exists for: a candidate discovered for a brand/subsidiary
// (e.g. a company's e-commerce arm) whose real, current LinkedIn profile
// shows the PARENT or GROUP entity as the current company. That is not
// necessarily a departure — many people's profiles are pinned to the group
// entity while their actual work stays with the subsidiary/brand — but it is
// also not something a plain string comparison (valuesAgree() in
// lib/identity/types.ts) can recognize: "AJIO.com" and "Reliance Retail"
// share no words and no substring relationship at all.
//
// This is deliberately NOT fuzzy matching. valuesAgree() already owns fuzzy
// "close enough to be the same name" comparison, and stays exactly as
// permissive/strict as it already is — broadening it to also absorb
// corporate-family reasoning would risk false negatives on genuinely
// different companies with superficially similar names, everywhere
// valuesAgree() is used (name, role, location — not just company).
//
// A corporate relationship is instead something we either KNOW (it is
// curated, explicit data) or we DON'T (in which case behavior stays exactly
// as conservative as it already was — a mismatch is still a mismatch). This
// keeps the code fully general — sameCorporateGroup() has no company-specific
// logic in it at all — while the DATA below names real, well-documented,
// public parent/subsidiary/brand relationships as illustrative starter
// entries. Extending coverage means adding a row here, in the open, not
// writing a new conditional.

/**
 * Each entry is one corporate family: every name in the array is treated as
 * the same employer for current-employment comparison purposes. Names are
 * matched after normalizeCompanyName() below, so casing, punctuation and
 * common corporate suffixes (.com, Inc, Ltd, Pvt, Limited...) do not need
 * to be enumerated separately.
 *
 * Starter data — real, public, uncontroversial parent/brand relationships.
 * Not exhaustive; extend by adding a row, never by special-casing code.
 */
const CORPORATE_GROUPS: readonly (readonly string[])[] = [
  ['AJIO', 'AJIO.com', 'Reliance Retail', 'Reliance Retail Ventures', 'Reliance Industries'],
  ['Myntra', 'Flipkart', 'Flipkart Group', 'Flipkart Internet'],
  ['Whole Foods', 'Whole Foods Market', 'Amazon', 'Amazon.com'],
  ['Instagram', 'WhatsApp', 'Meta', 'Meta Platforms', 'Facebook'],
];

const SUFFIXES = new Set([
  'inc', 'ltd', 'llc', 'llp', 'plc', 'corp', 'corporation', 'co', 'company',
  'limited', 'pvt', 'private', 'group', 'holdings', 'ventures', 'industries',
  'com', 'the', 'and',
]);

/** Same normalization spirit as lib/contacts/preverify.ts's company matching — lowercase, strip punctuation, drop generic corporate suffixes. */
function normalizeCompanyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !SUFFIXES.has(w))
    .join(' ')
    .trim();
}

/** Which registered corporate group (by index) this name belongs to, if any. */
function groupIndexOf(normalized: string): number | null {
  if (!normalized) return null;
  for (let i = 0; i < CORPORATE_GROUPS.length; i++) {
    if (CORPORATE_GROUPS[i].some((name) => normalizeCompanyName(name) === normalized)) return i;
  }
  return null;
}

/**
 * Do these two company names belong to the same known corporate family
 * (parent, subsidiary, or brand of one another)?
 *
 * An explicit, curated membership check — never a similarity score. Returns
 * false whenever the relationship isn't specifically known, which is the
 * conservative, existing behavior: an unrecognized mismatch is still a
 * mismatch. This never claims two genuinely unrelated companies with
 * similar-sounding names are related, because it never compares the names
 * to each other at all — only to the explicit membership list.
 */
export function sameCorporateGroup(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);
  if (!na || !nb) return false;

  const groupA = groupIndexOf(na);
  if (groupA === null) return false;
  return groupA === groupIndexOf(nb);
}
