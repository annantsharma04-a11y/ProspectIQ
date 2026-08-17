import { describe, it, expect } from 'vitest';
import { qualifyHook, gateHook, scoreSignals } from '@/lib/ranking/rank';
import { checkPersonalization } from '@/lib/pipeline/stages';
import { signal, source } from './helpers';

const NOW = new Date('2026-08-16T00:00:00Z');
const strongSource = () =>
  source({ fetch_status: 'scraped', content: 'Full retrieved page body. '.repeat(12) });

const scored = (over = {}) => scoreSignals([signal(over)], [strongSource()], NOW)[0];

describe('qualifyHook — person vs company signals', () => {
  it('accepts a verified person-level signal without needing a role', () => {
    const s = scored({ signal_level: 'PERSON' });
    expect(qualifyHook(s, null).qualified).toBe(true);
  });

  it('accepts a company-level signal when the role is known and relevance is stated', () => {
    const s = scored({
      signal_level: 'COMPANY',
      role_relevance: 'She owns finance operations, which this AP automation partnership directly affects.',
    });
    expect(qualifyHook(s, 'VP Finance Operations').qualified).toBe(true);
  });

  it('rejects a company-level signal when the prospect’s role is unknown', () => {
    const s = scored({
      signal_level: 'COMPANY',
      role_relevance: 'Relevant to whoever runs finance there.',
    });
    const verdict = qualifyHook(s, null);
    expect(verdict.qualified).toBe(false);
    expect(verdict.reason).toMatch(/role is unknown/i);
  });

  it('rejects a company-level signal with no stated role connection', () => {
    const s = scored({ signal_level: 'COMPANY', role_relevance: null });
    const verdict = qualifyHook(s, 'Facilities Manager');
    expect(verdict.qualified).toBe(false);
    expect(verdict.reason).toMatch(/no stated connection/i);
  });

  it('rejects a disputed signal regardless of level', () => {
    expect(qualifyHook(scored({ conflicts_with: 'contested' }), 'VP Finance').qualified).toBe(false);
  });

  it('rejects a signal below the quality threshold', () => {
    const weak = scoreSignals(
      [signal({ published_date: null, relevance_score: 5, specificity_score: 5, confidence_score: 10 })],
      [source({ credibility: 0.3 })],
      NOW,
    )[0];
    expect(qualifyHook(weak, 'VP Finance').reason).toMatch(/threshold/i);
  });
});

describe('gateHook passes the role through', () => {
  const proposal = {
    index: 0,
    reason: 'best candidate',
    confidence: 80,
    alternatives: [],
    insufficient: false,
    insufficientReason: null as string | null,
  };

  it('rejects an unconnected company hook and reports why', () => {
    const ranked = scoreSignals(
      [signal({ signal_level: 'COMPANY', role_relevance: null })],
      [strongSource()],
      NOW,
    );
    const selection = gateHook(ranked, proposal, 'Facilities Manager');

    expect(selection.selected_index).toBeNull();
    expect(selection.rejected_candidates).toHaveLength(1);
    expect(selection.rejected_candidates[0].reason).toMatch(/role or function/i);
  });

  it('prefers a qualifying person signal over an unconnected company signal', () => {
    const ranked = scoreSignals(
      [
        signal({ signal_level: 'COMPANY', role_relevance: null }),
        signal({ signal: 'She was appointed VP', signal_level: 'PERSON', source_url: 'https://reuters.com/c' }),
      ],
      [strongSource(), source({ url: 'https://reuters.com/c', canonical_url: 'https://reuters.com/c', fetch_status: 'scraped', content: 'Full retrieved page body. '.repeat(12) })],
      NOW,
    );
    const companyIndex = ranked.findIndex((s) => s.signal_level === 'COMPANY');
    const selection = gateHook(ranked, { ...proposal, index: companyIndex }, 'VP Finance');

    expect(selection.selected_index).not.toBeNull();
    expect(ranked[selection.selected_index!].signal_level).toBe('PERSON');
  });
});

describe('checkPersonalization — beyond vocabulary overlap', () => {
  const hook = {
    signal: 'Zerodha launched an options analytics platform for retail traders in June 2026',
    signal_level: 'COMPANY' as const,
    role_relevance: 'He runs the company and sets product direction.',
  };
  const ctx = { prospectName: 'Nithin Kamath', company: 'Zerodha', role: 'Founder & CEO' };

  it('passes a message that genuinely rests on the hook', () => {
    const message = `Nithin, the options analytics platform Zerodha launched for retail traders is a
      real bet on giving retail the same depth institutions get. At Acme we build finance
      back-office agents. Worth comparing notes?`;
    const result = checkPersonalization(message, hook, ctx);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
  });

  it('fails a message that shares hook words but reads as sales copy', () => {
    // Contains "platform", "traders", "analytics" — but assumes pain and is boilerplate.
    const message = `Hi Nithin, I hope this email finds you well. I'm sure your team is struggling
      with manual processes. Our analytics platform helps traders. Quick call?`;
    const result = checkPersonalization(message, hook, ctx);
    expect(result.passed).toBe(false);
    expect(result.failures.join(' ')).toMatch(/boilerplate/i);
    expect(result.failures.join(' ')).toMatch(/pain point/i);
  });

  it('fails a message that asserts unestablished pain', () => {
    const message = `Nithin, the options analytics platform for retail traders Zerodha launched is
      impressive. Manual reconciliation must be a bottleneck for your finance team. Chat?`;
    const result = checkPersonalization(message, hook, ctx);
    expect(result.passed).toBe(false);
    expect(result.failures.join(' ')).toMatch(/pain point/i);
  });

  it('fails a message that never names the prospect or company', () => {
    const message = `The options analytics platform launched for retail traders in June 2026 is
      notable. We build finance agents. Open to a chat?`;
    const result = checkPersonalization(message, hook, { role: 'CEO' });
    expect(result.detail.names_specifics).toBe(true); // no specifics supplied to check against
    const withCtx = checkPersonalization(message, hook, ctx);
    expect(withCtx.detail.names_specifics).toBe(false);
    expect(withCtx.passed).toBe(false);
  });

  it('reports a partial score rather than a bare pass/fail', () => {
    const message = `Hi Nithin, I wanted to reach out about Zerodha's options analytics platform
      for retail traders. Worth a chat?`;
    const result = checkPersonalization(message, hook, ctx);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
    expect(result.detail.no_boilerplate).toBe(false);
  });
});
