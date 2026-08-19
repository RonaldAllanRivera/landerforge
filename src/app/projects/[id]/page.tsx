import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function ProjectHistory({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, product_name")
    .eq("id", Number(id))
    .maybeSingle();
  if (!project) notFound();

  const { data: generations } = await supabase
    .from("generations")
    .select("id, version_num, status, parent_id, created_at, total_cost_usd")
    .eq("project_id", project.id)
    .order("version_num", { ascending: false });

  return (
    <main>
      <h1>{project.name}</h1>
      <p className="sub">{project.product_name}</p>

      {(generations ?? []).map((g) => (
        <div className="card" key={g.id}>
          <div className="field-head">
            <Link href={`/generations/${g.id}`}>v{g.version_num}</Link>
            <span className="row">
              {g.parent_id && <span className="badge">from v-parent #{g.parent_id}</span>}
              <span className={`badge ${g.status === "done" ? "ok" : ""}`}>{g.status}</span>
            </span>
          </div>
          <p className="muted">
            {new Date(g.created_at).toLocaleString()}
            {g.total_cost_usd !== null && ` · $${Number(g.total_cost_usd).toFixed(3)}`}
          </p>
        </div>
      ))}
    </main>
  );
}
