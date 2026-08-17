import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getAuthenticatedUser } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "ProspectIQ",
  description:
    "Research a public LinkedIn prospect from real public sources, rank the signals, draft outreach, and hold it for human review.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthenticatedUser();
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-slate-50 text-slate-900">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-[110rem] items-center justify-between px-6 py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Prospect<span className="text-indigo-600">IQ</span>
            </Link>
            <nav className="flex items-center gap-5 text-sm font-medium text-slate-600">
              <Link href="/" className="hover:text-indigo-600">New run</Link>
              <Link href="/history" className="hover:text-indigo-600">History</Link>
              <Link href="/evaluation" className="hover:text-indigo-600">Evaluation</Link>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
                Nothing is ever sent
              </span>
              {user ? (
                <form action="/auth/signout" method="post" className="flex items-center gap-2">
                  <span className="max-w-[16ch] truncate text-xs text-slate-500" title={user.email ?? ''}>
                    {user.email}
                  </span>
                  <button type="submit" className="text-xs font-medium text-slate-600 hover:text-indigo-600">
                    Sign out
                  </button>
                </form>
              ) : (
                <Link href="/login" className="hover:text-indigo-600">Sign in</Link>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[110rem] flex-1 px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
