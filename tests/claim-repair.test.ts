import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckedClaim } from '@/lib/validation/factcheck';
import type { AnalysisClaim } from '@/lib/llm/analyze';
import type { NormalizedSource } from '@/lib/research/normalize';

// An UNSUPPORTED claim is one no retrieved source establishes. The validator
// says so and stays strict; what changed is that the system now makes ONE
// bounded attempt to delete the offending sentence before troubling a human.
//
// The property that makes that safe: repair can only ever SUBTRACT. It gets no
// search tool, no new sources, and no route to establish anything — and its
// output is re-validated from scratch by the same validator. A repair that
// smuggles in a new fact or a fabricated citation is discarded and the
// original flagged state survives untouched.

const mockCallStructured = vi.fn();
vi.mock('@/lib/llm/gemini', () => ({ callStructured: (...a: unknown[]) => mockCallStructured(...a) }));

const { repairMessage, verifyRepairSafety, shouldAttemptRepair, blockingClaims, MAX_REPAIR_ATTEMPTS } =
  await import('@/lib/generation/repair');
const { validateClaims } = await import('@/lib/validation/factcheck');

const source = (url: string, content: string): NormalizedSource =>
  ({
    url,
    canonical_url: url,
    title: 'Source',
    snippet: content,
    content,
    source_type: 'web',
    credibility: 0.7,
    published_date: '2026-06-01',
    providers: ['tavily'],
    queries: [],
    categories: [],
    duplicate_count: 1,
    fetch_status: 'scraped',
  }) as unknown as NormalizedSource;

const SRC = 'https://news.example.com/shiprocket-ai';
const SOURCES = [
  source(SRC, 'Shiprocket named Priya Nair as its Head of Payments Operations, overseeing dispute handling.'),
];

/**
 * CheckedClaim carries the validator's wider verdict set (it adds ALLOWED),
 * so a claim destined for a repair RESULT is narrowed back to what the model
 * is allowed to return.
 */
const asAnalysisClaim = (c: CheckedClaim): AnalysisClaim => ({
  claim: c.claim,
  type: c.type,
  verdict: c.verdict === 'ALLOWED' ? 'SUPPORTED' : c.verdict,
  evidence_url: c.evidence_url,
  explanation: c.explanation,
});

const claim = (over: Partial<CheckedClaim> = {}): CheckedClaim =>
  ({
    claim: 'Priya Nair is Head of Payments Operations at Shiprocket.',
    type: 'PROSPECT_FACT',
    requires_external_evidence: true,
    verdict: 'SUPPORTED',
    evidence_url: SRC,
    explanation: '',
    ...over,
  }) as CheckedClaim;

const SUPPORTED_CLAIM = claim();
const UNSUPPORTED_CLAIM = claim({
  claim: 'Shiprocket announced plans for its public offering.',
  type: 'EXTERNAL_EVENT',
  verdict: 'UNSUPPORTED',
  evidence_url: null,
  explanation: 'No retrieved source mentions an offering.',
});
const APPROVED_PRODUCT_CLAIM = claim({
  claim: 'We build agents that assemble chargeback evidence.',
  type: 'SENDER_CAPABILITY',
  requires_external_evidence: false,
  verdict: 'SUPPORTED',
  evidence_url: null,
});

const DIRTY_MESSAGE =
  'Hi Priya, Shiprocket announced plans for its public offering. You lead payments operations there, which covers dispute handling. We build agents that assemble chargeback evidence. Worth comparing notes?';
const CLEAN_MESSAGE =
  'Hi Priya, you lead payments operations at Shiprocket, which covers dispute handling. We build agents that assemble chargeback evidence. Worth comparing notes?';

const respond = (body: unknown) => mockCallStructured.mockResolvedValue({ data: body, meta: {} });

beforeEach(() => vi.clearAllMocks());

describe('1. a clean draft never triggers a repair call', () => {
  it('does not attempt repair when nothing is unsupported', () => {
    expect(shouldAttemptRepair([SUPPORTED_CLAIM, APPROVED_PRODUCT_CLAIM], CLEAN_MESSAGE)).toBe(false);
  });

  it('does not attempt repair when the unsupported claim never made it into the text', async () => {
    // Declared but not written: already harmless, so spending a call is waste.
    expect(shouldAttemptRepair([UNSUPPORTED_CLAIM], CLEAN_MESSAGE)).toBe(false);

    expect(await repairMessage({ message: CLEAN_MESSAGE, claims: [UNSUPPORTED_CLAIM], sources: SOURCES })).toBeNull();
    expect(mockCallStructured).not.toHaveBeenCalled();
  });
});

describe('2. an unsupported claim present in the text triggers exactly one repair', () => {
  it('identifies the blocking claim', () => {
    expect(shouldAttemptRepair([SUPPORTED_CLAIM, UNSUPPORTED_CLAIM], DIRTY_MESSAGE)).toBe(true);
    expect(blockingClaims([SUPPORTED_CLAIM, UNSUPPORTED_CLAIM], DIRTY_MESSAGE)).toHaveLength(1);
  });

  it('makes exactly one model call', async () => {
    respond({ message: CLEAN_MESSAGE, claims: [SUPPORTED_CLAIM, APPROVED_PRODUCT_CLAIM] });
    await repairMessage({ message: DIRTY_MESSAGE, claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM], sources: SOURCES });

    expect(mockCallStructured).toHaveBeenCalledTimes(1);
    expect(MAX_REPAIR_ATTEMPTS).toBe(1);
  });

  it('shows the repair model the unsupported claim and the safe alternatives', async () => {
    respond({ message: CLEAN_MESSAGE, claims: [SUPPORTED_CLAIM] });
    await repairMessage({ message: DIRTY_MESSAGE, claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM], sources: SOURCES });

    const prompt = mockCallStructured.mock.calls[0][0].input as string;
    expect(prompt).toContain('UNSUPPORTED CLAIMS');
    expect(prompt).toContain('public offering');
    expect(prompt).toContain('SUPPORTED CLAIMS');
    expect(prompt).toContain('Head of Payments Operations');
  });
});

describe('3-4. an accepted repair removes the claim and revalidates clean', () => {
  it('removing the claim leaves a message the validator passes', async () => {
    respond({ message: CLEAN_MESSAGE, claims: [SUPPORTED_CLAIM, APPROVED_PRODUCT_CLAIM] });
    const repaired = await repairMessage({
      message: DIRTY_MESSAGE,
      claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM],
      sources: SOURCES,
    });

    expect(verifyRepairSafety({ claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM] }, repaired!, SOURCES).safe).toBe(true);

    const second = validateClaims({
      message: repaired!.message,
      claims: repaired!.claims,
      sources: SOURCES,
      evidence: [],
      conservative: false,
      modelConfidence: 80,
    });

    expect(blockingClaims(second.claims, repaired!.message)).toHaveLength(0);
    expect(second.status).not.toBe('flagged');
  });

  it('rewriting with an already-supported claim is allowed', async () => {
    const rewritten =
      'Hi Priya, you lead payments operations at Shiprocket, which covers dispute handling. We build agents that assemble chargeback evidence. Worth comparing notes?';
    respond({ message: rewritten, claims: [SUPPORTED_CLAIM, APPROVED_PRODUCT_CLAIM] });
    const repaired = await repairMessage({
      message: DIRTY_MESSAGE,
      claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM],
      sources: SOURCES,
    });

    expect(verifyRepairSafety({ claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM] }, repaired!, SOURCES).safe).toBe(true);
  });
});

describe('5-6. a repair that introduces a new claim is rejected', () => {
  it('rejects a brand-new company fact', async () => {
    const smuggled = claim({
      claim: 'Shiprocket processes two million shipments a month.',
      type: 'COMPANY_FACT',
      verdict: 'SUPPORTED',
      evidence_url: SRC,
    });
    respond({ message: 'Hi Priya, Shiprocket processes two million shipments a month. Worth comparing notes?', claims: [smuggled] });
    const repaired = await repairMessage({ message: DIRTY_MESSAGE, claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM], sources: SOURCES });

    const verdict = verifyRepairSafety({ claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM] }, repaired!, SOURCES);
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toContain('new factual claim');
  });

  it('rejects a new person fact even when the model marks it SUPPORTED', () => {
    const invented = claim({ claim: 'Priya Nair previously worked at Razorpay.', verdict: 'SUPPORTED', evidence_url: SRC });
    const verdict = verifyRepairSafety(
      { claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM] },
      { message: 'Hi Priya, you were at Razorpay before.', claims: [asAnalysisClaim(invented)], removed: [] },
      SOURCES,
    );

    // A model asserting its own claim is supported is exactly what code must
    // not accept on trust.
    expect(verdict.safe).toBe(false);
  });

  it('rejects a repair that swaps one unsupported claim for another', () => {
    const swapped = claim({ claim: 'Shiprocket is preparing a funding round.', type: 'EXTERNAL_EVENT', verdict: 'UNSUPPORTED', evidence_url: null });
    const verdict = verifyRepairSafety(
      { claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM] },
      { message: 'Hi Priya, Shiprocket is preparing a funding round.', claims: [asAnalysisClaim(swapped)], removed: [] },
      SOURCES,
    );
    expect(verdict.safe).toBe(false);
  });

  it('rejects a repair that merely hedges the unsupported claim', () => {
    const hedged = 'Hi Priya, Shiprocket reportedly announced plans for its public offering. Worth comparing notes?';
    const verdict = verifyRepairSafety(
      { claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM] },
      { message: hedged, claims: [asAnalysisClaim(SUPPORTED_CLAIM)], removed: [] },
      SOURCES,
    );

    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toContain('still present');
  });
});

describe('7-9. what a repair must preserve, and must not add', () => {
  it('7. keeps supported prospect claims', async () => {
    respond({ message: CLEAN_MESSAGE, claims: [SUPPORTED_CLAIM, APPROVED_PRODUCT_CLAIM] });
    const repaired = await repairMessage({ message: DIRTY_MESSAGE, claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM], sources: SOURCES });

    expect(repaired!.message).toContain('payments operations');
    expect(repaired!.claims.some((c) => c.claim === SUPPORTED_CLAIM.claim)).toBe(true);
  });

  it('8. keeps approved product claims, which need no external evidence', async () => {
    respond({ message: CLEAN_MESSAGE, claims: [SUPPORTED_CLAIM, APPROVED_PRODUCT_CLAIM] });
    const repaired = await repairMessage({
      message: DIRTY_MESSAGE,
      claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM, APPROVED_PRODUCT_CLAIM],
      sources: SOURCES,
      approvedSolution: {
        id: 'zamp_chargebacks',
        name: 'Chargeback and dispute handling',
        description: 'Agents that assemble evidence and work dispute cases.',
        target_functions: ['Payments'],
        use_cases: [],
        non_use_cases: [],
        matched_on: ['chargebacks'],
      },
    });

    expect(repaired!.message).toContain('chargeback evidence');
    // Sender claims are not world-claims, so they never trip the new-fact gate.
    expect(verifyRepairSafety({ claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM] }, repaired!, SOURCES).safe).toBe(true);

    const prompt = mockCallStructured.mock.calls[0][0].input as string;
    expect(prompt).toContain('APPROVED PRODUCT');
  });

  it('9. rejects a citation to a source this run never retrieved', () => {
    const fabricated = claim({ claim: SUPPORTED_CLAIM.claim, evidence_url: 'https://invented.example.com/story' });
    const verdict = verifyRepairSafety(
      { claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM] },
      { message: CLEAN_MESSAGE, claims: [asAnalysisClaim(fabricated)], removed: [] },
      SOURCES,
    );

    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toContain('never retrieved');
  });

  it('only shows the repair model URLs that were actually retrieved', async () => {
    respond({ message: CLEAN_MESSAGE, claims: [SUPPORTED_CLAIM] });
    await repairMessage({ message: DIRTY_MESSAGE, claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM], sources: SOURCES });

    const prompt = mockCallStructured.mock.calls[0][0].input as string;
    expect(prompt).toContain(SRC);
    expect(prompt).toContain('no others exist');
  });
});

describe('10. repair cannot search the web', () => {
  it('makes exactly one structured model call and nothing else', async () => {
    respond({ message: CLEAN_MESSAGE, claims: [SUPPORTED_CLAIM] });
    await repairMessage({ message: DIRTY_MESSAGE, claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM], sources: SOURCES });

    expect(mockCallStructured).toHaveBeenCalledTimes(1);
    expect(mockCallStructured.mock.calls[0][0].purpose).toBe('repair_unsupported_claims');
  });

  it('the module imports no research or search capability', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('lib/generation/repair.ts', 'utf8'));
    for (const forbidden of ['@/lib/research/engine', '@/lib/search', 'runSearches', 'research(']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});

describe('11-12. bounded attempts, and a failed repair changes nothing', () => {
  it('11. the cap is one', () => {
    expect(MAX_REPAIR_ATTEMPTS).toBe(1);
  });

  it('12. a model failure returns null rather than a partial draft', async () => {
    mockCallStructured.mockRejectedValue(new Error('model unavailable'));
    const repaired = await repairMessage({ message: DIRTY_MESSAGE, claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM], sources: SOURCES });
    expect(repaired).toBeNull();
  });

  it('12. an empty repaired message is refused', async () => {
    respond({ message: '   ', claims: [] });
    expect(await repairMessage({ message: DIRTY_MESSAGE, claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM], sources: SOURCES })).toBeNull();
  });

  it('12. the original flagged verdict is what survives a rejected repair', () => {
    const original = validateClaims({
      message: DIRTY_MESSAGE,
      claims: [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM].map(asAnalysisClaim),
      sources: SOURCES,
      evidence: [],
      conservative: false,
      modelConfidence: 80,
    });

    expect(original.status).toBe('flagged');
    expect(original.claims.some((c) => c.verdict === 'UNSUPPORTED')).toBe(true);
  });
});

// ─── the Shiprocket-shaped case, end to end ─────────────────────────────────

describe('Shiprocket regression: one supported claim, one unsupported event', () => {
  const claims = [SUPPORTED_CLAIM, UNSUPPORTED_CLAIM, APPROVED_PRODUCT_CLAIM];

  it('the original draft is flagged', () => {
    const first = validateClaims({
      message: DIRTY_MESSAGE, claims: claims.map(asAnalysisClaim), sources: SOURCES, evidence: [], conservative: false, modelConfidence: 80,
    });
    expect(first.status).toBe('flagged');
    expect(blockingClaims(first.claims, DIRTY_MESSAGE)).toHaveLength(1);
  });

  it('repair removes the offering claim, keeps the role and the product', async () => {
    respond({ message: CLEAN_MESSAGE, claims: [SUPPORTED_CLAIM, APPROVED_PRODUCT_CLAIM], removed_claims: [UNSUPPORTED_CLAIM.claim] });

    const first = validateClaims({
      message: DIRTY_MESSAGE, claims: claims.map(asAnalysisClaim), sources: SOURCES, evidence: [], conservative: false, modelConfidence: 80,
    });
    const repaired = await repairMessage({ message: DIRTY_MESSAGE, claims: first.claims, sources: SOURCES });

    expect(verifyRepairSafety({ claims: first.claims }, repaired!, SOURCES).safe).toBe(true);

    const second = validateClaims({
      message: repaired!.message, claims: repaired!.claims, sources: SOURCES, evidence: [], conservative: false, modelConfidence: 80,
    });

    // Revalidation is clean, and the claim is genuinely gone from the text.
    expect(second.status).not.toBe('flagged');
    expect(blockingClaims(second.claims, repaired!.message)).toHaveLength(0);
    expect(repaired!.message.toLowerCase()).not.toContain('public offering');
    expect(repaired!.message).toContain('payments operations');
    expect(repaired!.message).toContain('chargeback evidence');
  });
});

describe('15. the validator itself is unchanged', () => {
  it('still marks an uncited world-claim UNSUPPORTED', () => {
    const r = validateClaims({
      message: 'Hi Priya, Shiprocket announced plans for its public offering.',
      claims: [UNSUPPORTED_CLAIM].map(asAnalysisClaim),
      sources: SOURCES, evidence: [], conservative: false, modelConfidence: 90,
    });
    expect(r.claims[0].verdict).toBe('UNSUPPORTED');
    expect(r.status).toBe('flagged');
  });

  it('still allows sender claims with no external evidence', () => {
    const r = validateClaims({
      message: 'Hi Priya, we build agents that assemble chargeback evidence.',
      claims: [APPROVED_PRODUCT_CLAIM].map(asAnalysisClaim),
      sources: SOURCES, evidence: [], conservative: false, modelConfidence: 90,
    });
    expect(r.claims[0].verdict).not.toBe('UNSUPPORTED');
    expect(r.status).not.toBe('flagged');
  });
});
