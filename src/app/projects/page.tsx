import Link from "next/link";
import { listProjects } from "@/lib/core/projects";
import { createClient, requireUser } from "@/lib/supabase/server";

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; created?: string; deleted?: string }>;
}) {
  const { q, page, created } = await searchParams;
  const actor = await requireUser();
  const canCreate = actor?.role === "admin" || actor?.role === "editor";
  const result = await listProjects(await createClient(), {
    search: q,
    page: Number(page) || 1,
  });

  // An object href, because typedRoutes rejects an interpolated string.
  const pageHref = (n: number) => ({
    pathname: "/projects" as const,
    query: { ...(q ? { q } : {}), page: String(n) },
  });

  return (
    <main>
      {/* Actions live at the top. A create form below a list is unreachable once the
          list is long, and this one is expected to reach the hundreds. */}
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="sub">
            One per product. Every generation belongs to a project, and its versions are kept there.
          </p>
        </div>
        {canCreate && (
          <Link href="/projects/new">
            <button type="button">New project</button>
          </Link>
        )}
      </div>

      {created && (
        <div className="card">
          <p className="muted">Created “{created}”. It is now selectable on New generation.</p>
        </div>
      )}

      {/* A plain GET form: searching should be linkable and survive a reload. */}
      <form className="row search" action="/projects" method="get">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search by project or product name…"
          aria-label="Search projects"
        />
        <button type="submit" className="ghost">
          Search
        </button>
        {q && (
          <Link href="/projects" className="muted">
            Clear
          </Link>
        )}
      </form>

      <p className="muted">
        {result.total === 0
          ? q
            ? `No project matches “${q}”.`
            : "No projects yet."
          : `${result.total} project${result.total === 1 ? "" : "s"}${q ? ` matching “${q}”` : ""}`}
      </p>

      {result.items.map((p) => (
        <div className="card" key={p.id}>
          <div className="field-head">
            <Link href={`/projects/${p.id}`}>
              <strong>{p.name}</strong>
            </Link>
            <span className="row">
              <span className="badge">
                {p.generations} {p.generations === 1 ? "generation" : "generations"}
              </span>
              {p.totalUsd > 0 && <span className="badge">{usd(p.totalUsd)}</span>}
            </span>
          </div>
          <p className="muted">
            {p.product_name}
            {p.niche && ` · ${p.niche}`}
            {p.lastRunAt && ` · last run ${new Date(p.lastRunAt).toLocaleString()}`}
          </p>
        </div>
      ))}

      {result.pageCount > 1 && (
        <div className="row pager">
          {result.page > 1 && (
            <Link href={pageHref(result.page - 1)} className="ghost-link">
              ← Previous
            </Link>
          )}
          <span className="muted">
            Page {result.page} of {result.pageCount}
          </span>
          {result.page < result.pageCount && (
            <Link href={pageHref(result.page + 1)} className="ghost-link">
              Next →
            </Link>
          )}
        </div>
      )}
    </main>
  );
}
