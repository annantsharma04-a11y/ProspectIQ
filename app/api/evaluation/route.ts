import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/guard';
import { loadEvaluationInput } from '@/lib/evaluation/query';
import { PERIODS, previousWindow, windowFor, type Period } from '@/lib/evaluation/types';
import {
  claimMetrics,
  evidenceMetrics,
  failureAnalysis,
  funnel,
  hookMetrics,
  identityMetrics,
  messageMetrics,
  providerMetrics,
  qualificationMetrics,
  reliabilityMetrics,
  trends,
  unavailableMetrics,
  volumeMetrics,
} from '@/lib/evaluation/metrics';
import { contactDiscoveryMetrics } from '@/lib/evaluation/contacts';

export const runtime = 'nodejs';

/**
 * Evaluation metrics for the caller's own data.
 *
 * The aggregation is scoped to the authenticated user before any arithmetic
 * happens — an aggregate over another user's runs would still be a disclosure.
 */
export async function GET(req: Request) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;

  const raw = new URL(req.url).searchParams.get('period');
  const period: Period = (PERIODS as readonly string[]).includes(raw ?? '')
    ? (raw as Period)
    : '30d';

  try {
    const input = await loadEvaluationInput(auth.user.id);
    const w = windowFor(period);
    const prev = previousWindow(period);

    return NextResponse.json({
      period,
      window: { from: w.from?.toISOString() ?? null, to: w.to.toISOString() },
      volume: volumeMetrics(input, w),
      identity: identityMetrics(input, w),
      qualification: qualificationMetrics(input, w),
      evidence: evidenceMetrics(input, w),
      hooks: hookMetrics(input, w),
      messages: messageMetrics(input, w),
      claims: claimMetrics(input, w),
      funnel: funnel(input, w),
      failures: failureAnalysis(input, w),
      reliability: reliabilityMetrics(input, w),
      providers: providerMetrics(input, w),
      trends: trends(input, w, prev),
      contactDiscovery: contactDiscoveryMetrics(input.runs, input.contactCandidates, w),
      unavailable: unavailableMetrics(),
    });
  } catch {
    return NextResponse.json({ error: 'Could not load evaluation metrics' }, { status: 500 });
  }
}
