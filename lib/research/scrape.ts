// Page fetching via Firecrawl.
//
// Scraping is best-effort enrichment: when a page can't be fetched we keep the
// search snippet and mark the source as snippet-only. A signal is never
// upgraded to "verified from the page" unless the page actually came back.

const ENDPOINT = 'https://api.firecrawl.dev/v2/scrape';
const TIMEOUT_MS = 45_000;

export interface ScrapeResult {
  url: string;
  ok: boolean;
  markdown: string;
  error: string | null;
  /** True when the site itself refuses automated access (e.g. LinkedIn). */
  blocked: boolean;
  duration_ms: number;
}

export function hasFirecrawlKey(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

/** Firecrawl refuses linkedin.com; LinkedIn is routed to Bright Data instead. */
function isLinkedIn(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('linkedin.com');
  } catch {
    return false;
  }
}

export async function scrapeUrl(url: string): Promise<ScrapeResult> {
  const startedAt = Date.now();

  // Skip the request entirely rather than spending a call to collect a 403.
  if (isLinkedIn(url)) {
    return {
      url,
      ok: false,
      markdown: '',
      error: 'LinkedIn is not fetched via Firecrawl; profile data comes from the LinkedIn provider.',
      blocked: true,
      duration_ms: 0,
    };
  }

  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    return {
      url,
      ok: false,
      markdown: '',
      error: 'FIRECRAWL_API_KEY is not configured',
      blocked: false,
      duration_ms: 0,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
    });

    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
      data?: { markdown?: string };
    };

    if (!res.ok || json.success === false) {
      const message = json.error ?? `HTTP ${res.status}`;
      // 403 + "do not support this site" is a policy refusal, not a transient error.
      const blocked = res.status === 403 || /do not support this site|not supported/i.test(message);
      return {
        url,
        ok: false,
        markdown: '',
        error: message.slice(0, 300),
        blocked,
        duration_ms: Date.now() - startedAt,
      };
    }

    const markdown = String(json.data?.markdown ?? '');
    return {
      url,
      ok: markdown.trim().length > 0,
      markdown,
      error: markdown.trim().length > 0 ? null : 'Page returned no readable content',
      blocked: false,
      duration_ms: Date.now() - startedAt,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      url,
      ok: false,
      markdown: '',
      error: isAbort ? `Scrape timed out after ${TIMEOUT_MS}ms` : `Scrape failed: ${String(err)}`,
      blocked: false,
      duration_ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Scrape a batch concurrently. Individual failures do not affect the others. */
export async function scrapeMany(urls: string[]): Promise<ScrapeResult[]> {
  return Promise.all(urls.map(scrapeUrl));
}
