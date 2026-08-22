import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
import { requireUser } from "@/lib/supabase/server";
import "./globals.css";

/**
 * Two faces, one family, doing two different jobs.
 *
 * The copy under review is prose that becomes a landing page, so it is set in the sans
 * at a readable size. Everything the tool adds around it — word counts, character
 * limits, tokens, violations — is set in the mono, because those are machine facts
 * about the copy rather than part of it. The distinction is the design: ink in the
 * measure, marks in the margin.
 *
 * Self-hosted by next/font at build time; no runtime request and no layout shift.
 */
const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "LanderForge",
  description: "Constraint-driven advertorial copy generation.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireUser();
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        {actor && (
          <nav className="nav">
            <Link href="/" className="wordmark">
              LanderForge
            </Link>
            <span className="nav-links">
              <Link href="/new">New</Link>
              <Link href="/projects">Projects</Link>
              <Link href="/costs">Costs</Link>
              {actor.role === "admin" && <Link href="/admin">Access</Link>}
              <span className="badge">{actor.role ?? "no role"}</span>
            </span>
          </nav>
        )}
        {children}
      </body>
    </html>
  );
}
