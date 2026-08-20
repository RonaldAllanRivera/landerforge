import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/supabase/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "LanderForge",
  description: "Constraint-driven advertorial copy generation.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireUser();
  return (
    <html lang="en">
      <body>
        {actor && (
          <nav className="nav">
            <Link href="/">LanderForge</Link>
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
