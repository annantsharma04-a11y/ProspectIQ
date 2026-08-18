'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { parseLinkedInUrl } from '@/lib/linkedin/url';

const FIELD =
  'mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

interface ExistingProspect {
  found: true;
  /** The slug this answer was fetched for; guards against stale responses. */
  slug: string;
  prospect: { id: string; name: string | null; current_company: string | null; linkedin_slug: string };
  run_count: number;
  days_since_research: number | null;
}

export function ProspectForm() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [senderName, setSenderName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<ExistingProspect | null>(null);

  // Same parser the server uses, so the user sees the problem before submitting.
  const clientError = url.trim() ? (parseLinkedInUrl(url).ok ? null : parseLinkedInUrl(url)) : null;
  const inlineError = clientError && !clientError.ok ? clientError.error : null;

  // Tell the user BEFORE they submit that this person already has history, so a
  // repeat submission is a deliberate re-research rather than a surprise.
  const parsed = parseLinkedInUrl(url);
  const slug = parsed.ok ? parsed.slug : null;

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/prospects/lookup?linkedin_url=${encodeURIComponent(url.trim())}`);
        if (!res.ok) return;
        const body = await res.json();
        // Tag the result with the slug it answered for, so a slow response for
        // a URL the user has already edited away cannot overwrite a newer one.
        if (!cancelled) setExisting(body.found ? { ...(body as ExistingProspect), slug } : null);
      } catch {
        // A failed lookup is not worth interrupting the form for.
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, url]);

  // Derived rather than cleared in an effect: an empty or invalid URL simply
  // has nothing to show, and a stale answer for a previous URL is ignored.
  const existingForUrl = slug && existing?.slug === slug ? existing : null;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const form = new FormData(e.currentTarget);
    const payload = {
      linkedin_url: url.trim(),
      sender_name: String(form.get('sender_name') ?? '').trim() || null,
      prospect_name: String(form.get('prospect_name') ?? '').trim() || null,
      company_name: String(form.get('company_name') ?? '').trim() || null,
      prospect_title: String(form.get('prospect_title') ?? '').trim() || null,
    };

    setSubmitting(true);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not start the run');
      // senderName intentionally kept in state so the next run keeps the signature.
      router.push(`/runs/${data.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-hairline bg-surface p-5">
      <div>
        <label htmlFor="linkedin_url" className="block text-sm font-medium text-ink">
          LinkedIn profile URL <span className="text-red-600">*</span>
        </label>
        <input
          id="linkedin_url"
          name="linkedin_url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.linkedin.com/in/jane-doe"
          autoComplete="off"
          className={FIELD}
        />
        {inlineError && <p className="mt-1 text-xs text-amber-700">{inlineError}</p>}

        {existingForUrl && (
          <div className="mt-2 rounded-lg border border-accent/20 bg-accent/6 px-3 py-2.5">
            <p className="text-xs font-semibold text-accent">Existing prospect found</p>
            <p className="mt-0.5 text-sm text-ink">
              {existingForUrl.prospect.name ?? `/in/${existingForUrl.prospect.linkedin_slug}`}
              {existingForUrl.prospect.current_company && (
                <span className="text-muted"> · {existingForUrl.prospect.current_company}</span>
              )}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {existingForUrl.run_count} {existingForUrl.run_count === 1 ? 'run' : 'runs'} on record ·{' '}
              {existingForUrl.days_since_research == null
                ? 'never completed'
                : existingForUrl.days_since_research === 0
                  ? 'researched today'
                  : `last researched ${existingForUrl.days_since_research} day${existingForUrl.days_since_research === 1 ? '' : 's'} ago`}
            </p>
            <p className="mt-1.5 text-xs text-muted">
              Submitting adds a new run to this prospect — earlier runs are kept.{' '}
              <Link
                href={`/prospects/${existingForUrl.prospect.id}`}
                className="font-medium text-accent underline hover:text-accent-hover"
              >
                View history
              </Link>
            </p>
          </div>
        )}
      </div>

      <div>
        <label htmlFor="sender_name" className="block text-sm font-medium text-ink">
          Your name <span className="text-red-600">*</span>
        </label>
        <input
          id="sender_name"
          name="sender_name"
          required
          value={senderName}
          onChange={(e) => setSenderName(e.target.value)}
          placeholder="Jane Smith"
          autoComplete="name"
          className={FIELD}
        />
        <p className="mt-1 text-xs text-faint">Signed at the end of the drafted message.</p>
      </div>

      <fieldset className="space-y-3 border-t border-hairline pt-3">
        <legend className="text-xs font-medium uppercase tracking-wide text-faint">
          About the prospect — optional, improves identity resolution
        </legend>
        <div>
          <label htmlFor="prospect_name" className="block text-sm font-medium text-ink">Name</label>
          <input id="prospect_name" name="prospect_name" placeholder="Jane Doe" className={FIELD} />
        </div>
        <div>
          <label htmlFor="company_name" className="block text-sm font-medium text-ink">Company</label>
          <input id="company_name" name="company_name" placeholder="Acme Inc" className={FIELD} />
        </div>
        <div>
          <label htmlFor="prospect_title" className="block text-sm font-medium text-ink">Role</label>
          <input id="prospect_title" name="prospect_title" placeholder="VP Finance" className={FIELD} />
        </div>
      </fieldset>

      {error && (
        <p className="rounded-lg bg-red-600/8 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || Boolean(inlineError) || !senderName.trim()}
        className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
      >
        {submitting ? 'Starting research…' : existingForUrl ? 'Research again' : 'Analyze prospect'}
      </button>

      <p className="text-xs leading-relaxed text-faint">
        Public profile data is retrieved through a compliant provider and combined with public web
        and news research. Nothing is accessed behind a login, and outreach is always sent
        manually.
      </p>
    </form>
  );
}
