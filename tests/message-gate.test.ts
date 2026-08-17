import { describe, it, expect } from 'vitest';
import { isGenericMessage } from '@/lib/pipeline/stages';
import { validateClaims } from '@/lib/validation/factcheck';
import { source } from './helpers';
import type { AnalysisClaim } from '@/lib/llm/analyze';

const HOOK = 'Zerodha launched a new options analytics platform for retail traders in June 2026';

describe('personalization gate', () => {
  it('accepts a message that engages with the hook specifics', () => {
    const message = `Nithin, the new options analytics platform you launched for retail traders
      caught my attention — surfacing that depth to retail is a hard product call.
      At Acme we build AI agents for finance back-office work. Worth a short conversation?`;

    expect(isGenericMessage(message, HOOK).generic).toBe(false);
  });

  it('rejects a message that never engages with the hook', () => {
    const message = `Hi Nithin, I lead partnerships at Acme. We help finance teams automate
      back-office operations end to end. Would you be open to a quick call next week?`;

    const result = isGenericMessage(message, HOOK);
    expect(result.generic).toBe(true);
    expect(result.reason).toMatch(/barely engages with the selected hook/i);
  });

  it('rejects boilerplate outreach phrasing even when the hook is mentioned', () => {
    const message = `Hi Nithin, I hope this email finds you well. I came across your profile and
      saw Zerodha launched a new options analytics platform for retail traders. Worth a chat?`;

    const result = isGenericMessage(message, HOOK);
    expect(result.generic).toBe(true);
    expect(result.reason).toMatch(/boilerplate/i);
  });

  it('does not judge a message when the hook carries no distinctive terms', () => {
    expect(isGenericMessage('Any message at all.', 'a an the').generic).toBe(false);
  });

  it('is not fooled by merely naming the company', () => {
    const message = `Hi Nithin, Zerodha is a company I admire. Acme automates finance operations
      for teams like yours. Open to a conversation this week about our platform?`;

    expect(isGenericMessage(message, HOOK).generic).toBe(true);
  });
});

describe('sender claim categories', () => {
  const sources = [source({ fetch_status: 'scraped', content: 'Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. Full retrieved page body. ' })];

  const claim = (over: Partial<AnalysisClaim>): AnalysisClaim => ({
    claim: 'Acme builds AI agents for accounts payable',
    type: 'SENDER_OFFERING',
    verdict: 'SUPPORTED',
    evidence_url: null,
    explanation: '',
    ...over,
  });

  const run = (c: AnalysisClaim) =>
    validateClaims({
      message: c.claim,
      claims: [c],
      sources,
      evidence: [],
      conservative: false,
      modelConfidence: 90,
    });

  it('allows SENDER_OFFERING without prospect evidence', () => {
    const r = run(claim({}));
    expect(r.claims[0].verdict).toBe('ALLOWED');
    expect(r.claims[0].requires_external_evidence).toBe(false);
    expect(r.status).toBe('pass');
  });

  it('allows SENDER_CAPABILITY without prospect evidence', () => {
    const r = run(claim({ type: 'SENDER_CAPABILITY', claim: 'It reconciles invoices automatically' }));
    expect(r.claims[0].verdict).toBe('ALLOWED');
    expect(r.status).toBe('pass');
  });

  it('requires evidence for SENDER_OUTCOME_CLAIM rather than allowing it', () => {
    const r = run(claim({ type: 'SENDER_OUTCOME_CLAIM', claim: 'Acme cuts AP processing time by 80%' }));
    expect(r.claims[0].verdict).toBe('UNCERTAIN');
    expect(r.claims[0].requires_external_evidence).toBe(true);
    expect(r.claims[0].explanation).toMatch(/softened|product evidence/i);
  });

  it('catches an outcome claim mislabelled as a capability', () => {
    // The model called it a capability, but it is a performance claim.
    const r = run(claim({ type: 'SENDER_CAPABILITY', claim: 'Acme reduces manual review by 60%' }));
    expect(r.claims[0].verdict).toBe('UNCERTAIN');
    expect(r.claims[0].requires_external_evidence).toBe(true);
  });

  it.each([
    'Used by 200 finance teams',
    'Delivers 3x faster reconciliation',
    'Industry-leading accuracy',
    'Guarantee a 40% ROI',
  ])('flags performance language: %s', (text) => {
    const r = run(claim({ type: 'SENDER_CAPABILITY', claim: text }));
    expect(r.claims[0].verdict).toBe('UNCERTAIN');
  });

  it('still allows a plain capability with no performance language', () => {
    const r = run(claim({ type: 'SENDER_CAPABILITY', claim: 'It handles KYC and KYB checks' }));
    expect(r.claims[0].verdict).toBe('ALLOWED');
  });
});
