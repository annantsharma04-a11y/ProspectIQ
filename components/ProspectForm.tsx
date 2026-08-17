'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseLinkedInUrl } from '@/lib/linkedin/url';

const FIELD =
  'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';

export function ProspectForm() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [senderName, setSenderName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same parser the server uses, so the user sees the problem before submitting.
  const clientError = url.trim() ? (parseLinkedInUrl(url).ok ? null : parseLinkedInUrl(url)) : null;
  const inlineError = clientError && !clientError.ok ? clientError.error : null;

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
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div>
        <label htmlFor="linkedin_url" className="block text-sm font-medium text-slate-700">
          LinkedIn profile URL <span className="text-red-500">*</span>
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
        {inlineError && <p className="mt-1 text-xs text-amber-600">{inlineError}</p>}
      </div>

      <div>
        <label htmlFor="sender_name" className="block text-sm font-medium text-slate-700">
          Your name <span className="text-red-500">*</span>
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
        <p className="mt-1 text-xs text-slate-500">Signed at the end of the drafted message.</p>
      </div>

      <fieldset className="space-y-3 border-t border-slate-100 pt-3">
        <legend className="text-xs font-medium uppercase tracking-wide text-slate-400">
          About the prospect — optional, improves identity resolution
        </legend>
        <div>
          <label htmlFor="prospect_name" className="block text-sm font-medium text-slate-700">Name</label>
          <input id="prospect_name" name="prospect_name" placeholder="Jane Doe" className={FIELD} />
        </div>
        <div>
          <label htmlFor="company_name" className="block text-sm font-medium text-slate-700">Company</label>
          <input id="company_name" name="company_name" placeholder="Acme Inc" className={FIELD} />
        </div>
        <div>
          <label htmlFor="prospect_title" className="block text-sm font-medium text-slate-700">Role</label>
          <input id="prospect_title" name="prospect_title" placeholder="VP Finance" className={FIELD} />
        </div>
      </fieldset>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || Boolean(inlineError) || !senderName.trim()}
        className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {submitting ? 'Starting research…' : 'Analyze prospect'}
      </button>

      <p className="text-xs leading-relaxed text-slate-500">
        Public profile data is retrieved through a compliant provider and combined with public web
        and news research. Nothing is accessed behind a login, and nothing is ever sent to the
        prospect.
      </p>
    </form>
  );
}
