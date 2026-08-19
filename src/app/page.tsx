import Link from "next/link";
import { requireUser } from "@/lib/supabase/server";

export default async function Home() {
  const actor = await requireUser();
  return (
    <main>
      <h1>LanderForge</h1>
      <p className="sub">
        Signed in as {actor?.email ?? "unknown"} ({actor?.role ?? "no role"}).
      </p>
      <Link href="/new">
        <button type="button">New generation</button>
      </Link>
    </main>
  );
}
