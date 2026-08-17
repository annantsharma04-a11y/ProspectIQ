import { vi } from 'vitest';
import type { SearchHit } from '@/lib/search/types';
import type { NormalizedSource } from '@/lib/research/normalize';
import type { ExtractedSignal } from '@/lib/signals/types';

export function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    title: 'Acme raises $40M Series B',
    url: 'https://techcrunch.com/2026/05/01/acme-series-b',
    snippet: 'Acme announced a $40M Series B led by Sequoia.',
    provider: 'tavily',
    published_date: '2026-05-01',
    provider_score: 0.9,
    query: '"Acme" funding',
    category: 'company_funding',
    ...over,
  };
}

export function source(over: Partial<NormalizedSource> = {}): NormalizedSource {
  return {
    url: 'https://techcrunch.com/2026/05/01/acme-series-b',
    canonical_url: 'https://techcrunch.com/2026/05/01/acme-series-b',
    title: 'Acme raises $40M Series B',
    snippet: 'Acme announced a $40M Series B led by Sequoia to scale finance operations.',
    source_type: 'news_major',
    credibility: 0.9,
    published_date: '2026-05-01',
    providers: ['tavily'],
    queries: ['"Acme" funding'],
    categories: ['company_funding'],
    duplicate_count: 0,
    retrieved_at: '2026-08-15T00:00:00.000Z',
    content: null,
    fetch_status: 'snippet_only',
    ...over,
  };
}

export function signal(over: Partial<ExtractedSignal> = {}): ExtractedSignal {
  return {
    signal: 'Acme raised a $40M Series B',
    why_it_matters: 'Fresh capital usually precedes finance-ops hiring.',
    category: 'funding',
    source_title: 'Acme raises $40M Series B',
    source_url: 'https://techcrunch.com/2026/05/01/acme-series-b',
    published_date: '2026-05-01',
    supporting_quote: 'Acme announced a $40M Series B led by Sequoia',
    relevance_score: 80,
    specificity_score: 90,
    confidence_score: 85,
    conflicts_with: null,
    signal_level: 'PERSON',
    role_relevance: null,
    outreach_rationale: null,
    related_capability_id: null,
    ...over,
  };
}

/** Mock a Gemini Interactions API response carrying `payload` as its JSON output. */
export function mockGeminiOnce(payload: unknown, status = 200) {
  const body = {
    id: 'int_test',
    status: 'completed',
    usage: { total_tokens: 100 },
    steps: [
      { type: 'thought', signature: 'x' },
      { type: 'model_output', content: [{ type: 'text', text: JSON.stringify(payload) }] },
    ],
  };
  return vi.fn().mockResolvedValue({
    ok: status === 200,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

/** Mock any fetch failure (HTTP error status). */
export function mockHttpError(status: number, message = 'boom') {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: message }),
    text: async () => message,
  });
}
