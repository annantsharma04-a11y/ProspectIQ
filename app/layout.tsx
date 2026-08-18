import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Serif } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { getAuthenticatedUser } from "@/lib/supabase/server";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const plexSerif = IBM_Plex_Serif({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ProspectIQ",
  description:
    "Research a public LinkedIn prospect from real public sources, rank the signals, draft outreach, and hold it for human review.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthenticatedUser();
  return (
    <html lang="en" className={`${plexSans.variable} ${plexSerif.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-app text-ink">
        <header className="border-b border-hairline bg-surface">
          <div className="mx-auto flex max-w-[110rem] items-center justify-between px-6 py-4">
            <Link href="/" className="font-display text-lg font-semibold tracking-tight text-ink">
              Prospect<span className="text-accent">IQ</span>
            </Link>
            <nav className="flex items-center gap-5 text-sm font-medium text-muted">
              <Link href="/new" className="hover:text-accent">New run</Link>
              <Link href="/history" className="hover:text-accent">History</Link>
              <Link href="/evaluation" className="hover:text-accent">Evaluation</Link>
              <span className="flex items-center gap-1.5 rounded-full bg-accent/8 px-2.5 py-1 text-xs font-medium text-accent">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                Human review only
              </span>
              {user ? (
                <form action="/auth/signout" method="post" className="flex items-center gap-2">
                  <span className="max-w-[16ch] truncate text-xs text-faint" title={user.email ?? ''}>
                    {user.email}
                  </span>
                  <button type="submit" className="text-xs font-medium text-muted hover:text-accent">
                    Sign out
                  </button>
                </form>
              ) : (
                <Link href="/login" className="hover:text-accent">Sign in</Link>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[110rem] flex-1 px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
