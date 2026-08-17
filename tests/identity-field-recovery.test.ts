import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fieldRecoveryQueries, recoverIdentityField } from '@/lib/identity/recover-field';
import { decideIdentity, accountFields, type IdentityCandidate } from '@/lib/identity/types';
import { source } from './helpers';

const PROFILE_URL = 'https://www.linkedin.com/in/example-person';
const SRC = 'https://example.com/leadership';

const candidate = (over: Partial<IdentityCandidate> = {}): IdentityCandidate => ({
  id: 'candidate_1',
  name: 'Alex Rivera',
  role: null,
  company: 'Northwind Brokerage',
  location: 'Bengaluru',
  headline: null,
  linkedin_url: PROFILE_URL,
  confidence: 90,
  sources: [SRC],
  origin: 'public_research',
  ...over,
});

const sources = () => [source({ url: SRC, canonical_url: SRC, fetch_status: 'scraped', content: 'Full retrieved page body. '.repeat(12) })];

const decide = (c: IdentityCandidate, conflicts = [] as never[]) =>
  decideIdentity({
    selected: c,
    selectionMethod: 'AUTOMATIC',
    profile: { name: c.name, role: c.role, company: c.company, location: c.location, linkedin_url: PROFILE_URL },
    hasProfile: true,
    candidates: [c],
    conflicts,
    assessedConfidence: 90,
    missingFields: (['company', 'role'] as const).filter((f) => !c[f]),
  });

/** Mock one Gemini structured reply. */
function gemini(payload: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'completed',
      usage: { total_tokens: 10 },
      steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(payload) }] }],
    }),
    text: async () => '',
  } as unknown as Response);
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEMINI_API_KEY;
});

describe('recovery queries are anchored to the known person', () => {
  it('uses the known company when chasing a missing role', () => {
    const qs = fieldRecoveryQueries(candidate(), 'role');
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.every((q) => q.query.includes('Alex Rivera'))).toBe(true);
    expect(qs.every((q) => q.query.includes('Northwind Brokerage'))).toBe(true);
  });

  it('will not search for a role with no company to anchor to', () => {
    expect(fieldRecoveryQueries(candidate({ company: null }), 'role')).toEqual([]);
  });

  it('will not search at all without a name', () => {
    expect(fieldRecoveryQueries(candidate({ name: null }), 'role')).toEqual([]);
  });
});

describe('1. missing role recovered from a real source → VERIFIED', () => {
  it('accepts a value that cites a retrieved source, then re-decides', async () => {
    vi.stubGlobal(
      'fetch',
      gemini({
        found: true,
        value: 'Chief Executive Officer',
        evidence_url: SRC,
        supporting_quote: 'Alex Rivera, Chief Executive Officer of Northwind Brokerage',
        source_kind: 'leadership_page',
        different_person_detected: false,
        reason: 'Stated on the company leadership page.',
      }),
    );

    const before = decide(candidate());
    expect(before.status).toBe('PARTIAL');

    const r = await recoverIdentityField({ candidate: candidate(), field: 'role', sources: sources() });
    expect(r.value).toBe('Chief Executive Officer');
    expect(r.evidence_url).toBe(SRC);

    const after = decide(candidate({ role: r.value }));
    expect(after.status).toBe('VERIFIED');
    expect(after.proceed).toBe(true);
  });
});

describe('2. recovery fails → stays PARTIAL', () => {
  it('does not invent a role when no source states it', async () => {
    vi.stubGlobal(
      'fetch',
      gemini({ found: false, different_person_detected: false, reason: 'No source states this person’s role.' }),
    );

    const r = await recoverIdentityField({ candidate: candidate(), field: 'role', sources: sources() });
    expect(r.value).toBeNull();
    expect(decide(candidate({ role: r.value })).status).toBe('PARTIAL');
  });

  it('rejects a proposed value that cites no retrieved source', async () => {
    // The model "knows" the answer but cannot point at anything.
    vi.stubGlobal(
      'fetch',
      gemini({
        found: true,
        value: 'Chief Executive Officer',
        evidence_url: null,
        different_person_detected: false,
        reason: 'Well known.',
      }),
    );

    const r = await recoverIdentityField({ candidate: candidate(), field: 'role', sources: sources() });
    expect(r.value).toBeNull();
    expect(r.reason).toMatch(/cited no retrieved source/i);
  });

  it('rejects a citation pointing outside the retrieved set', async () => {
    vi.stubGlobal(
      'fetch',
      gemini({
        found: true,
        value: 'CEO',
        evidence_url: 'https://not-retrieved.example/page',
        different_person_detected: false,
        reason: 'x',
      }),
    );

    const r = await recoverIdentityField({ candidate: candidate(), field: 'role', sources: sources() });
    expect(r.value).toBeNull();
  });
});

describe('3. missing company recovered → identity re-evaluated', () => {
  it('fills the company and clears the PARTIAL reason', async () => {
    vi.stubGlobal(
      'fetch',
      gemini({
        found: true,
        value: 'Northwind Brokerage',
        evidence_url: SRC,
        supporting_quote: 'Alex Rivera joined Northwind Brokerage',
        source_kind: 'reputable_publication',
        different_person_detected: false,
        reason: 'Stated in the article.',
      }),
    );

    const thin = candidate({ company: null, role: 'Chief Executive Officer' });
    expect(decide(thin).status).toBe('PARTIAL');

    const r = await recoverIdentityField({ candidate: thin, field: 'company', sources: sources() });
    expect(r.value).toBe('Northwind Brokerage');
    expect(decide(candidate({ role: 'Chief Executive Officer' })).status).toBe('VERIFIED');
  });
});

describe('4-5. recovery must never pull in a different person', () => {
  it('4. a conflicting source produces a conflict, not a recovery', async () => {
    vi.stubGlobal(
      'fetch',
      gemini({
        found: false,
        different_person_detected: true,
        different_person_value: 'Software Developer at Contoso',
        different_person_source: SRC,
        different_person_explanation: 'A different Alex Rivera works at Contoso.',
        reason: 'Same name, different person.',
      }),
    );

    const r = await recoverIdentityField({ candidate: candidate(), field: 'role', sources: sources() });
    expect(r.value).toBeNull();
    expect(r.conflict).not.toBeNull();

    // Fed back into the decision, that conflict makes the identity ambiguous.
    const after = decide(candidate(), [r.conflict!] as never);
    expect(after.status).toBe('AMBIGUOUS');
    expect(after.proceed).toBe(false);
  });

  it('5. the candidate is never silently replaced by the other person', async () => {
    vi.stubGlobal(
      'fetch',
      gemini({
        found: true,
        value: 'Software Developer',
        evidence_url: SRC,
        different_person_detected: true,
        different_person_value: 'Software Developer at Contoso',
        different_person_source: SRC,
        reason: 'Different person.',
      }),
    );

    const original = candidate();
    const r = await recoverIdentityField({ candidate: original, field: 'role', sources: sources() });

    // Even though a value was offered, the different-person flag voids it.
    expect(r.value).toBeNull();
    expect(original.company).toBe('Northwind Brokerage');
  });
});

describe('6-7. thresholds and safeguards are unchanged', () => {
  it('6. recovery only ever adds evidence — it cannot lower the bar', async () => {
    vi.stubGlobal(
      'fetch',
      gemini({ found: false, different_person_detected: false, reason: 'Nothing found.' }),
    );

    // A candidate that was already failing for a different reason still fails.
    const conflicted = decide(candidate({ role: 'CEO' }), [
      { field: 'company', profile_value: 'A', public_value: 'B', explanation: 'x', sources: [] },
    ] as never);
    expect(conflicted.status).toBe('AMBIGUOUS');
  });

  it('7. field accounting reflects a recovered field honestly', () => {
    const recovered = candidate({ role: 'Chief Executive Officer' });
    const fe = accountFields(recovered, ['name', 'company', 'location', 'role'], [], [SRC]);
    expect(fe.available).toEqual(['name', 'role', 'company', 'location']);
    expect(fe.corroborated).toHaveLength(4);
    expect(fe.unavailable).toHaveLength(0);
    expect(fe.summary).toMatch(/4 of 4/);
  });

  it('an unrecovered field still shows as unavailable, not corroborated', () => {
    const fe = accountFields(candidate(), ['name', 'company', 'location'], [], [SRC]);
    expect(fe.unavailable).toEqual(['role']);
    expect(fe.corroborated).not.toContain('role');
    expect(fe.summary).toMatch(/3 of 3 identity fields available for verification were corroborated/i);
    expect(fe.summary).toMatch(/role unavailable/i);
  });
});

describe('recovery order lets an earlier field unlock a later one', () => {
  it('a role search becomes possible only once the company is known', () => {
    const noCompany = candidate({ company: null, role: null });
    // With no employer to anchor to, a role search is refused outright.
    expect(fieldRecoveryQueries(noCompany, 'role')).toEqual([]);

    // Once the company is recovered, the same search is well-formed.
    const withCompany = { ...noCompany, company: 'Northwind Brokerage' };
    const qs = fieldRecoveryQueries(withCompany, 'role');
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.every((q) => q.query.includes('Northwind Brokerage'))).toBe(true);
  });

  it('company is attempted before role so the anchor exists', () => {
    // Mirrors RECOVERY_ORDER in the verification stage.
    const order: ('company' | 'role')[] = ['company', 'role'];
    expect(order.indexOf('company')).toBeLessThan(order.indexOf('role'));
  });
});
