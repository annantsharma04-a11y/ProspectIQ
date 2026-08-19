import { describe, it, expect, vi } from 'vitest';
import type { IdentityCandidate } from '@/lib/identity/types';

// The Kailash Nadh / Zerodha / Samagata Foundation case: verify_selected_identity
// (lib/identity/verify.ts) previously had only two categories for a company
// mismatch — "conflict" (different person) or "documented job change" (silently
// adopt the newer company). Real, recently-dated sources explicitly stated he
// is CTO of Zerodha AND (concurrently) founder of Samagata Foundation, with no
// source ever saying the Zerodha role ended — yet the run resolved to Samagata
// Foundation alone, VERIFIED 100/100, because the model had no instruction for
// "this may be a concurrent role, not a supersession."
//
// The fix is entirely in verify.ts's SYSTEM prompt — no schema, no
// decideIdentity() change. These tests exercise the REAL, unmocked
// reconcileProvenance() + decideIdentity() wiring exactly as
// verifyIdentityStage (lib/pipeline/stages.ts) composes them, with only
// callStructured mocked — so they prove the actual downstream behavior, not
// just that a string was added to a prompt.

const mockCallStructured = vi.fn();
vi.mock('@/lib/llm/gemini', () => ({ callStructured: (...a: unknown[]) => mockCallStructured(...a) }));

const { verifySelectedCandidate } = await import('@/lib/identity/verify');
const { decideIdentity } = await import('@/lib/identity/types');
const { reconcileProvenance, providerFields, candidateFields } = await import('@/lib/identity/provenance');
import type { NormalizedSource } from '@/lib/research/normalize';

const source = (url: string): NormalizedSource => {
  return {
    url,
    canonical_url: url,
    title: 'Untitled',
    snippet: '',
    source_type: 'web',
    credibility: 0.6,
    published_date: null,
    providers: ['tavily'],
    queries: [],
    categories: ['prospect_identity'],
    duplicate_count: 0,
    retrieved_at: '2026-08-20T00:00:00Z',
    content: null,
    fetch_status: 'snippet_only',
  } as NormalizedSource;
};

/** Bright Data's real profile fetch for Kailash Nadh: single pinned company, no experience history. */
const kailashProfile = {
  name: 'Kailash Nadh',
  headline: 'Hobbyist software developer and FOSS hacker',
  location: 'Bengaluru',
  currentCompany: { name: 'Samagata Foundation', title: null },
};

const kailashCandidate: IdentityCandidate = {
  id: 'candidate_1',
  name: 'Kailash Nadh',
  role: 'Founder',
  company: 'Samagata Foundation',
  location: 'Bengaluru',
  headline: 'Hobbyist software developer and FOSS hacker',
  linkedin_url: 'https://www.linkedin.com/in/kailashnadh',
  confidence: 90,
  sources: [],
  origin: 'profile_provider',
};

const ZERODHA_SOURCE = 'https://zerodha.com/about';
const WIKIPEDIA_SOURCE = 'https://en.wikipedia.org/wiki/Kailash_Nadh';
const PUCAR_SOURCE = 'https://pucar.org/contributors/kailash-nadh';

/**
 * Runs the exact same three-function composition verifyIdentityStage uses:
 * verifySelectedCandidate (model call, mocked) -> reconcileProvenance (real)
 * -> decideIdentity (real, untouched).
 */
async function runFullVerification(opts: {
  candidate: IdentityCandidate;
  profile: typeof kailashProfile | null;
  sources: NormalizedSource[];
  modelResponse: {
    corroborated_fields?: string[];
    conflicts: { field: 'company' | 'role' | 'name' | 'location'; candidate_value?: string | null; public_value?: string | null; explanation?: string; sources?: string[] }[];
    assessed_confidence: number;
    missing_fields?: string[];
  };
}) {
  mockCallStructured.mockResolvedValueOnce({
    data: opts.modelResponse,
    meta: { model: 'test', used_fallback_model: false, purpose: 'verify_selected_identity', duration_ms: 1, attempts: 1, total_tokens: null },
  });

  const evidence = await verifySelectedCandidate({
    slug: 'kailashnadh',
    candidate: opts.candidate,
    selectionMethod: 'AUTOMATIC',
    sources: opts.sources,
  });

  const reconciled = reconcileProvenance({
    profileFields: providerFields(opts.profile),
    hints: { name: null, role: null, company: null },
    candidate: candidateFields(opts.candidate),
    conflicts: evidence.conflicts,
    corroboratedFields: evidence.corroboratedFields,
  });

  const working = { ...opts.candidate, ...reconciled.fields };

  return decideIdentity({
    selected: working,
    selectionMethod: 'AUTOMATIC',
    provenance: reconciled.provenance,
    profile: {
      name: working.name,
      role: working.role,
      company: working.company,
      location: working.location,
      linkedin_url: working.linkedin_url,
    },
    hasProfile: Boolean(opts.profile),
    candidates: [opts.candidate],
    conflicts: reconciled.conflicts,
    assessedConfidence: evidence.assessedConfidence,
    missingFields: reconciled.corroboratedFields.length >= 0 ? (opts.modelResponse.missing_fields ?? []) : [],
  } as Parameters<typeof decideIdentity>[0]);
}

describe('1. concurrent Zerodha + Samagata Foundation resolves to AMBIGUOUS, not silently Samagata', () => {
  it('a conflict explicitly flagged as a possible concurrent role blocks automatic VERIFIED', async () => {
    const v = await runFullVerification({
      candidate: kailashCandidate,
      profile: kailashProfile,
      sources: [source(ZERODHA_SOURCE), source(WIKIPEDIA_SOURCE), source(PUCAR_SOURCE)],
      modelResponse: {
        corroborated_fields: ['name', 'location'],
        conflicts: [
          {
            field: 'company',
            candidate_value: 'Samagata Foundation',
            public_value: 'Zerodha (CTO)',
            explanation:
              'Multiple recent sources state, in the present tense with no departure or end date, that Kailash Nadh is CTO of Zerodha; this may be a concurrent role rather than a job change.',
            sources: [ZERODHA_SOURCE, WIKIPEDIA_SOURCE, PUCAR_SOURCE],
          },
        ],
        assessed_confidence: 85,
        missing_fields: [],
      },
    });

    expect(v.status).toBe('AMBIGUOUS');
    expect(v.proceed).toBe(false);
    // Never silently resolved to Samagata alone.
    expect(v.status).not.toBe('VERIFIED');
  });
});

describe('2. an explicit former-role source still resolves automatically', () => {
  it('a source stating the earlier role ended is a job change, not a conflict — VERIFIED as before', async () => {
    const v = await runFullVerification({
      candidate: kailashCandidate,
      profile: kailashProfile,
      sources: [source(WIKIPEDIA_SOURCE)],
      modelResponse: {
        corroborated_fields: ['name', 'company', 'location'],
        // The model correctly treats this as a documented job change: no conflict reported.
        conflicts: [],
        assessed_confidence: 90,
        missing_fields: [],
      },
    });

    expect(v.status).toBe('VERIFIED');
    expect(v.proceed).toBe(true);
    expect(v.resolved.company).toBe('Samagata Foundation');
  });
});

describe('3. an explicit end date / stepped-down source still resolves automatically', () => {
  it('"CTO of Zerodha until 2024, now leads Samagata Foundation" — VERIFIED, current company adopted', async () => {
    const v = await runFullVerification({
      candidate: kailashCandidate,
      profile: kailashProfile,
      sources: [source(WIKIPEDIA_SOURCE)],
      modelResponse: {
        corroborated_fields: ['name', 'company'],
        conflicts: [], // a stated end date is a job change per the SYSTEM prompt, not a conflict
        assessed_confidence: 88,
        missing_fields: [],
      },
    });

    expect(v.status).toBe('VERIFIED');
    expect(v.proceed).toBe(true);
  });

  it('the SYSTEM prompt explicitly instructs this case is a job change, not a conflict', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.join(process.cwd(), 'lib/identity/verify.ts'), 'utf-8');
    expect(src).toMatch(/former[\s\S]*stepped down[\s\S]*left[\s\S]*until \[date\]/i);
    expect(src).toMatch(/a stated end date/i);
  });
});

describe('4. no timing evidence either way resolves to AMBIGUOUS, not an automatic job change', () => {
  it('a differing company with no departure language and no dates is reported as a possible concurrent role', async () => {
    const v = await runFullVerification({
      candidate: kailashCandidate,
      profile: kailashProfile,
      sources: [source(ZERODHA_SOURCE)],
      modelResponse: {
        corroborated_fields: ['name'],
        conflicts: [
          {
            field: 'company',
            candidate_value: 'Samagata Foundation',
            public_value: 'Zerodha',
            explanation:
              'A source names a different company with no indication the earlier role ended; this may be a concurrent role.',
            sources: [ZERODHA_SOURCE],
          },
        ],
        assessed_confidence: 70,
        missing_fields: [],
      },
    });

    expect(v.status).toBe('AMBIGUOUS');
    expect(v.proceed).toBe(false);
  });
});

describe('5. a genuine identity conflict (different person) is unaffected by the concurrent-role wording', () => {
  it('a same-name-different-person company conflict (not a concurrent-role case) still blocks exactly as before', async () => {
    const v = await runFullVerification({
      candidate: kailashCandidate,
      profile: kailashProfile,
      sources: [source('https://example.com/different-person')],
      modelResponse: {
        corroborated_fields: ['name'],
        conflicts: [
          {
            field: 'company',
            candidate_value: 'Samagata Foundation',
            public_value: 'Meridian Logistics (unrelated industry)',
            explanation:
              'A retrieved source describes a different Kailash Nadh — a logistics manager in an unrelated field — not the FOSS developer and Zerodha/Samagata figure this profile represents.',
            sources: ['https://example.com/different-person'],
          },
        ],
        assessed_confidence: 60,
        missing_fields: [],
      },
    });

    expect(v.status).toBe('AMBIGUOUS');
    expect(v.proceed).toBe(false);
  });
});

describe('prompt content — the exact instructions this fix depends on', () => {
  it('the SYSTEM prompt names the concurrent-role case explicitly', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.join(process.cwd(), 'lib/identity/verify.ts'), 'utf-8');

    expect(src).toMatch(/CONCURRENT role/);
    expect(src).toMatch(/also[\s\S]*and[\s\S]*in addition to[\s\S]*as well as/i);
    expect(src).toMatch(/may be a concurrent role\s+rather than a job change/i);
    expect(src).toMatch(/do not silently drop either side/i);
  });
});
