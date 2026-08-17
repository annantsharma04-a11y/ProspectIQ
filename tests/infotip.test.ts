import { describe, it, expect } from 'vitest';
import { computePosition } from '@/components/InfoTip';
import { OVERVIEW_DEFINITIONS, PANEL_DEFINITIONS, STATIC_DEFINITIONS } from '@/lib/evaluation/definitions';
import { evidenceMetrics, identityMetrics, reliabilityMetrics } from '@/lib/evaluation/metrics';
import { windowFor, type EvaluationInput } from '@/lib/evaluation/types';
import type { RunRow } from '@/lib/types';

// These guard the two ways the tooltip broke before:
//
//   1. Placement. It always opened downward, over the content it explained,
//      and could run past the viewport edge.
//   2. Size. Multi-paragraph definitions produced a panel large enough to
//      cover the headline and the funnel rows beneath it.
//
// The placement maths is pure, so it is tested directly. The size problem is
// prevented by capping the definition length at source.

const VIEWPORT = { width: 1440, height: 900 };
const TIP = { width: 320, height: 60 };
/** An icon roughly mid-page, with plenty of room in every direction. */
const anchor = (over: Partial<{ top: number; bottom: number; left: number; width: number }> = {}) => ({
  top: 400,
  bottom: 416,
  left: 700,
  width: 16,
  ...over,
});

describe('placement prefers above, so the tooltip does not cover the metric', () => {
  it('opens above the icon when there is room', () => {
    const p = computePosition(anchor(), TIP, VIEWPORT);
    expect(p.placement).toBe('above');
    // Sits entirely above the icon, with a gap.
    expect(p.top + TIP.height).toBeLessThanOrEqual(anchor().top);
  });

  it('flips below when the icon is near the top of the viewport', () => {
    const p = computePosition(anchor({ top: 20, bottom: 36 }), TIP, VIEWPORT);
    expect(p.placement).toBe('below');
    expect(p.top).toBeGreaterThanOrEqual(36);
  });

  it('a tall tooltip near the top still flips below rather than off-screen', () => {
    const tall = { width: 320, height: 300 };
    const p = computePosition(anchor({ top: 100, bottom: 116 }), tall, VIEWPORT);
    expect(p.placement).toBe('below');
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.top + tall.height).toBeLessThanOrEqual(VIEWPORT.height);
  });
});

describe('placement never leaves the viewport', () => {
  const cases: [string, ReturnType<typeof anchor>][] = [
    ['far left', anchor({ left: 4 })],
    ['left edge', anchor({ left: 0 })],
    ['far right', anchor({ left: VIEWPORT.width - 20 })],
    ['right edge', anchor({ left: VIEWPORT.width - 1 })],
    ['centre', anchor()],
  ];

  for (const [name, a] of cases) {
    it(`stays inside the viewport when the icon is at the ${name}`, () => {
      const p = computePosition(a, TIP, VIEWPORT);
      expect(p.left).toBeGreaterThanOrEqual(0);
      // The right edge is what would create a horizontal scrollbar.
      expect(p.left + TIP.width).toBeLessThanOrEqual(VIEWPORT.width);
    });
  }

  it('keeps a margin from both edges', () => {
    const left = computePosition(anchor({ left: 0 }), TIP, VIEWPORT);
    expect(left.left).toBe(16);

    const right = computePosition(anchor({ left: VIEWPORT.width - 1 }), TIP, VIEWPORT);
    expect(right.left).toBe(VIEWPORT.width - TIP.width - 16);
  });

  it('centres on the icon when there is room on both sides', () => {
    const a = anchor({ left: 700 });
    const p = computePosition(a, TIP, VIEWPORT);
    expect(p.left).toBe(a.left + a.width / 2 - TIP.width / 2);
  });
});

describe('narrow viewports', () => {
  const MOBILE = { width: 375, height: 667 };
  // On mobile the tooltip is capped by calc(100vw - 32px).
  const MOBILE_TIP = { width: 375 - 32, height: 80 };

  it('fits a phone screen without horizontal overflow', () => {
    for (const left of [0, 100, 200, 300, 374]) {
      const p = computePosition(anchor({ left }), MOBILE_TIP, MOBILE);
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.left + MOBILE_TIP.width).toBeLessThanOrEqual(MOBILE.width);
    }
  });

  it('a tooltip wider than the viewport still starts at the left margin', () => {
    // Degenerate, but must not produce a negative offset.
    const p = computePosition(anchor({ left: 10 }), { width: 500, height: 60 }, MOBILE);
    expect(p.left).toBe(16);
  });
});

describe('definitions stay short enough to be a tooltip', () => {
  /** Beyond this a tooltip becomes a panel that covers what it explains. */
  const MAX_CHARS = 200;

  it('every static definition is one or two sentences', () => {
    for (const [key, text] of Object.entries(STATIC_DEFINITIONS)) {
      expect(text.length, `${key} is ${text.length} chars: "${text}"`).toBeLessThanOrEqual(MAX_CHARS);
      expect(text.trim().length, `${key} is empty`).toBeGreaterThan(20);
    }
  });

  it('every rate definition is one or two sentences', () => {
    const W = windowFor('30d', new Date('2026-08-17T12:00:00Z'));
    const input: EvaluationInput = {
      prospects: [],
      runs: [{ id: 'r', status: 'ready_for_review', created_at: '2026-08-16T00:00:00Z' } as RunRow],
      stages: [], signals: [], drafts: [], proposals: [], hooks: [],
      sourceProviders: {}, sourceFetchStatus: {}, sourcesSampled: false, sourcesCounted: 0, contactCandidates: [],
    };
    for (const def of [
      identityMetrics(input, W).verificationRate.definition,
      evidenceMetrics(input, W).evidenceBackedRate.definition,
      evidenceMetrics(input, W).citationRate.definition,
      reliabilityMetrics(input, W).successRate.definition,
    ]) {
      expect(def.length, `too long for a tooltip: "${def}"`).toBeLessThanOrEqual(MAX_CHARS);
      expect(def).toMatch(/÷/);
    }
  });

  it('definitions are sentence case, never shouted', () => {
    // The old tooltip inherited uppercase from a heading; the copy itself must
    // not be written that way either.
    for (const [key, text] of Object.entries(STATIC_DEFINITIONS)) {
      const letters = text.replace(/[^A-Za-z]/g, '');
      const upper = text.replace(/[^A-Z]/g, '').length;
      expect(upper / letters.length, `${key} looks shouted`).toBeLessThan(0.4);
    }
  });

  it('keeps the meaning that matters in each shortened definition', () => {
    expect(PANEL_DEFINITIONS['Current bottleneck']).toMatch(/10%/);
    expect(PANEL_DEFINITIONS['Pipeline funnel']).toMatch(/monotonic/i);
    expect(PANEL_DEFINITIONS['Pipeline at a glance']).toMatch(/not gates/i);
    expect(OVERVIEW_DEFINITIONS['Active prospects']).toMatch(/counts once/i);
    expect(OVERVIEW_DEFINITIONS['Human review']).toMatch(/no sending capability/i);
  });
});
