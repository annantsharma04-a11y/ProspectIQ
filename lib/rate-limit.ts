// Rate limit + shared-secret gate for the public run-creation endpoint.
// In-memory is sufficient for this single-instance deployment.

export const RUN_RATE_LIMIT_PER_HOUR = Number(process.env.RUN_RATE_LIMIT_PER_HOUR ?? 20);

const hits: number[] = [];

export function checkRateLimit(): { ok: boolean; remaining: number } {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  while (hits.length && hits[0] < windowStart) hits.shift();
  if (hits.length >= RUN_RATE_LIMIT_PER_HOUR) return { ok: false, remaining: 0 };
  hits.push(now);
  return { ok: true, remaining: RUN_RATE_LIMIT_PER_HOUR - hits.length };
}

/** If RUN_SHARED_SECRET is unset (local dev), the gate is open. */
export function checkSharedSecret(req: Request): boolean {
  const secret = process.env.RUN_SHARED_SECRET;
  if (!secret) return true;
  const header = req.headers.get('x-run-secret');
  const query = new URL(req.url).searchParams.get('secret');
  return header === secret || query === secret;
}
