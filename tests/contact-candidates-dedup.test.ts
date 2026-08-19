import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isDuplicateCandidate } from '@/lib/contacts/rank';
import type { ContactCandidateRow } from '@/lib/contacts/types';

// The audit finding: createContactCandidates() was a plain insert with no
// uniqueness constraint of its own, so a retried run (find_contact_candidates
// re-running from scratch — a plain pipeline retry, not a new discovery
// feature) persisted the same discovered person a second time as a
// duplicate row every time the stage re-ran.
//
// The fix adds one check inside createContactCandidates(): before inserting,
// read the run's already-persisted candidates and drop anything that
// already matches one, using the exact same identity logic
// isCurrentProspect() already uses for a different purpose (excluding the
// run's own subject) — LinkedIn URL first, normalized name + company as the
// fallback. Nothing about ranking, pre-verification, identity verification
// or qualification changes; this is purely a persistence-layer guarantee.

const ev = (quote: string, url = 'https://example.com/a') => [{ source_url: url, quote }];

const row = (over: Partial<ContactCandidateRow> = {}): ContactCandidateRow =>
  ({
    id: 'existing-1',
    run_id: 'run-1',
    name: 'Maneesh Arora',
    role: 'CFO',
    company: 'AJIO.com',
    linkedin_url: 'https://www.linkedin.com/in/maneesharora23',
    reason: 'Public role matches the qualified workflow.',
    evidence: ev("Our CFO, Maneesh Arora won the 'Most Impactful CFO' award."),
    confidence: 83,
    rank_score: 99.4,
    identity_status: 'DISCOVERED',
    identity_verification: null,
    selected_at: null,
    resulting_run_id: null,
    created_at: '2026-08-19T00:00:00Z',
    ...over,
  }) as ContactCandidateRow;

const newCandidate = (
  over: Partial<Omit<ContactCandidateRow, 'id' | 'run_id' | 'identity_status' | 'identity_verification' | 'selected_at' | 'resulting_run_id' | 'created_at'>> = {},
) => ({
  name: 'Maneesh Arora',
  role: 'CFO',
  company: 'AJIO.com',
  linkedin_url: 'https://www.linkedin.com/in/maneesharora23',
  reason: 'Public role matches the qualified workflow.',
  evidence: ev("Our CFO, Maneesh Arora won the 'Most Impactful CFO' award."),
  confidence: 83,
  rank_score: 99.4,
  ...over,
});

describe('isDuplicateCandidate — the identity check the fix is built on', () => {
  it('matches on LinkedIn URL, case-insensitively', () => {
    expect(
      isDuplicateCandidate(
        { name: 'M. Arora', linkedin_url: 'https://www.linkedin.com/in/Maneesharora23', company: 'AJIO.com' },
        { name: 'Maneesh Arora', linkedin_url: 'https://www.linkedin.com/in/maneesharora23', company: 'AJIO.com' },
      ),
    ).toBe(true);
  });

  it('falls back to normalized name + company when neither has a URL', () => {
    expect(
      isDuplicateCandidate(
        { name: 'maneesh   arora', linkedin_url: null, company: 'AJIO.com, Inc.' },
        { name: 'Maneesh Arora', linkedin_url: null, company: 'AJIO.com Inc' },
      ),
    ).toBe(true);
  });

  it('a different person at the same company is NOT a duplicate', () => {
    expect(
      isDuplicateCandidate(
        { name: 'Sanjay Mehra', linkedin_url: 'https://www.linkedin.com/in/sanjay-mehra', company: 'AJIO.com' },
        { name: 'Maneesh Arora', linkedin_url: 'https://www.linkedin.com/in/maneesharora23', company: 'AJIO.com' },
      ),
    ).toBe(false);
  });

  it('the same name at a different company is NOT a duplicate', () => {
    expect(
      isDuplicateCandidate(
        { name: 'Maneesh Arora', linkedin_url: null, company: 'Reliance Retail' },
        { name: 'Maneesh Arora', linkedin_url: null, company: 'AJIO.com' },
      ),
    ).toBe(false);
  });

  it('no false match when name or company is missing on either side', () => {
    expect(isDuplicateCandidate({ name: null, linkedin_url: null, company: 'AJIO.com' }, { name: 'X', linkedin_url: null, company: 'AJIO.com' })).toBe(false);
    expect(isDuplicateCandidate({ name: 'X', linkedin_url: null, company: null }, { name: 'X', linkedin_url: null, company: 'AJIO.com' })).toBe(false);
  });
});

// ─── the real createContactCandidates(), against a mocked Supabase client ──

const mockFrom = vi.fn();
const mockInsert = vi.fn();

vi.mock('@/lib/supabase/client', () => ({
  createServiceClient: () => ({ from: (...a: unknown[]) => mockFrom(...a) }),
}));

const { createContactCandidates } = await import('@/lib/supabase/queries');

/** Wires the mocked client so listContactCandidates() sees `existingRows` and any insert() call is captured. */
function wireSupabase(existingRows: ContactCandidateRow[]) {
  mockInsert.mockReset();
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'contact_candidates') throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve({ data: existingRows, error: null }),
        }),
      }),
      insert: (rows: Record<string, unknown>[]) => {
        mockInsert(rows);
        return {
          select: () =>
            Promise.resolve({
              data: rows.map((r, i) => ({ id: `new-${i}`, ...r })),
              error: null,
            }),
        };
      },
    };
  });
}

beforeEach(() => {
  mockFrom.mockReset();
  mockInsert.mockReset();
});

describe('1. the same candidate on a pipeline retry produces one row, not two', () => {
  it('a retry proposing the exact same candidate again inserts nothing', async () => {
    wireSupabase([row()]);

    const result = await createContactCandidates('run-1', [newCandidate()]);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe('2. the same URL with different name formatting still dedupes to one row', () => {
  it('name text differs ("M. Arora" vs "Maneesh Arora"), URL is identical — no insert', async () => {
    wireSupabase([row({ name: 'Maneesh Arora' })]);

    const result = await createContactCandidates('run-1', [
      newCandidate({ name: 'M. Arora', linkedin_url: 'https://www.linkedin.com/in/maneesharora23' }),
    ]);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe('3. the same name/company without a URL dedupes to one row', () => {
  it('neither the existing row nor the new candidate has a LinkedIn URL', async () => {
    wireSupabase([row({ linkedin_url: null })]);

    const result = await createContactCandidates('run-1', [newCandidate({ linkedin_url: null })]);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe('4. a different person at the same company still gets inserted', () => {
  it('Sanjay Mehra (COO) is not blocked by an existing Maneesh Arora (CFO) row', async () => {
    wireSupabase([row()]); // existing: Maneesh Arora, CFO

    const sanjay = newCandidate({
      name: 'Sanjay Mehra',
      role: 'Chief Operating Officer',
      linkedin_url: 'https://www.linkedin.com/in/sanjay-mehra',
      evidence: ev('Sanjay Mehra - Chief Operating Officer (COO)', 'https://www.highperformr.ai/company/ajio'),
    });

    const result = await createContactCandidates('run-1', [sanjay]);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0]).toHaveLength(1);
    expect(mockInsert.mock.calls[0][0][0].name).toBe('Sanjay Mehra');
    expect(result).toHaveLength(1);
  });

  it('a mixed batch inserts only the genuinely new person, and skips the duplicate', async () => {
    wireSupabase([row()]); // existing: Maneesh Arora

    const sanjay = newCandidate({
      name: 'Sanjay Mehra',
      linkedin_url: 'https://www.linkedin.com/in/sanjay-mehra',
    });
    const duplicateManeesh = newCandidate(); // same as the existing row

    await createContactCandidates('run-1', [duplicateManeesh, sanjay]);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const inserted = mockInsert.mock.calls[0][0] as { name: string }[];
    expect(inserted).toHaveLength(1);
    expect(inserted[0].name).toBe('Sanjay Mehra');
  });
});

describe('5. an existing candidate\'s status is never overwritten by a retry', () => {
  it('a candidate already selected/VERIFIED is left completely untouched — no insert, no update call of any kind', async () => {
    wireSupabase([
      row({
        identity_status: 'VERIFIED',
        resulting_run_id: 'run-resulting-1',
        selected_at: '2026-08-19T19:15:39.567Z',
      }),
    ]);

    const result = await createContactCandidates('run-1', [newCandidate()]);

    // The only Supabase table interaction createContactCandidates can make
    // is through mockFrom — confirm it never attempted an insert (its only
    // write path) for the duplicate, so the existing VERIFIED row's status,
    // resulting_run_id and selected_at are never at risk of being clobbered.
    expect(mockInsert).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('a PARTIAL candidate is likewise left alone, not silently re-offered as DISCOVERED', async () => {
    wireSupabase([row({ identity_status: 'PARTIAL' })]);

    await createContactCandidates('run-1', [newCandidate()]);

    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('unchanged behavior: no existing candidates at all', () => {
  it('a run with nothing persisted yet inserts normally', async () => {
    wireSupabase([]);

    const result = await createContactCandidates('run-1', [newCandidate()]);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  it('an empty candidates array never touches Supabase at all', async () => {
    wireSupabase([row()]);

    const result = await createContactCandidates('run-1', []);

    expect(mockFrom).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
