import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { startGeneration } from "./actions";

export default async function NewGeneration() {
  const supabase = await createClient();
  const [{ data: projects }, { data: templates }] = await Promise.all([
    supabase.from("projects").select("id, name").order("name"),
    supabase.from("templates").select("id, name, slug").order("name"),
  ]);

  const hasProjects = (projects ?? []).length > 0;

  return (
    <main>
      <h1>New generation</h1>
      <p className="sub">
        Give it a URL to match, or paste the source text. With neither, it generates from your notes
        alone.
      </p>

      <form action={startGeneration}>
        <label htmlFor="templateId">Template</label>
        <select id="templateId" name="templateId" required>
          {(templates ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>

        <label htmlFor="projectId">Project</label>
        <select id="projectId" name="projectId" required disabled={!hasProjects}>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className="muted">
          {hasProjects ? (
            <>
              Versions are kept per project. <Link href="/projects">Manage projects</Link> to add
              another.
            </>
          ) : (
            <>
              You have no projects yet — <Link href="/projects">create one first</Link>. A
              generation has to belong to somewhere its versions can live.
            </>
          )}
        </p>

        <label htmlFor="sourceUrl">Source URL (optional)</label>
        <input id="sourceUrl" name="sourceUrl" type="url" placeholder="https://…" />

        <label className="row" htmlFor="rescrape">
          <input id="rescrape" name="rescrape" type="checkbox" style={{ width: "auto" }} />
          Re-scrape now (ignore a cached source under 24h old)
        </label>

        <label htmlFor="pastedSource">…or paste the source text</label>
        <textarea
          id="pastedSource"
          name="pastedSource"
          placeholder="For a page behind a login, or one that blocks scraping."
        />

        <label htmlFor="specialNotes">Special notes</label>
        <textarea id="specialNotes" name="specialNotes" placeholder="Angle, claims, constraints…" />

        <p />
        <button type="submit" disabled={!hasProjects}>
          Generate
        </button>
      </form>
    </main>
  );
}
