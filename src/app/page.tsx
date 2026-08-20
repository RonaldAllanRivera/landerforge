import Link from "next/link";
import { createClient, requireUser } from "@/lib/supabase/server";

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/**
 * The landing page is a work list.
 *
 * It used to be a greeting and one button, which meant the only way to reach an
 * existing generation was to remember its id — the project history screen existed and
 * nothing linked to it.
 */
export default async function Home() {
  const actor = await requireUser();
  const supabase = await createClient();

  const { data: generations } = await supabase
    .from("generations")
    .select("id, version_num, status, created_at, total_cost_usd, project_id, projects(name)")
    .order("created_at", { ascending: false })
    .limit(20);

  /**
   * PostgREST types an embedded relation as an array even when the foreign key makes it
   * at most one row, so the name is unwrapped rather than cast past.
   */
  const rows = (generations ?? []).map((g) => {
    const related = g.projects as { name: string } | Array<{ name: string }> | null;
    return {
      ...g,
      projectName: (Array.isArray(related) ? related[0]?.name : related?.name) ?? null,
    };
  });

  return (
    <main>
      <h1>LanderForge</h1>
      <p className="sub">
        Signed in as {actor?.email ?? "unknown"} ({actor?.role ?? "no role"}).
      </p>

      <div className="row">
        <Link href="/new">
          <button type="button">New generation</button>
        </Link>
        <Link href="/projects">
          <button type="button" className="ghost">
            All projects
          </button>
        </Link>
      </div>

      <h2>Recent generations</h2>
      {rows.length === 0 ? (
        <div className="card">
          <p className="muted">
            Nothing generated yet. <Link href="/projects">Create a project</Link>, then start a
            generation against it.
          </p>
        </div>
      ) : (
        rows.map((g) => (
          <div className="card" key={g.id}>
            <div className="field-head">
              <Link href={`/generations/${g.id}`}>
                <strong>{g.projectName ?? `Project #${g.project_id}`}</strong> v{g.version_num}
              </Link>
              <span className="row">
                <span
                  className={`badge ${g.status === "done" ? "ok" : g.status === "failed" ? "flag" : ""}`}
                >
                  {g.status}
                </span>
                {g.total_cost_usd !== null && (
                  <span className="badge">{usd(Number(g.total_cost_usd))}</span>
                )}
              </span>
            </div>
            <p className="muted">
              {new Date(g.created_at).toLocaleString()} ·{" "}
              <Link href={`/projects/${g.project_id}`}>all versions</Link>
            </p>
          </div>
        ))
      )}
    </main>
  );
}
