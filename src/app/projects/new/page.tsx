import Link from "next/link";
import { PROJECT_NAME_MAX } from "@/lib/shared/project";
import { requireUser } from "@/lib/supabase/server";
import { createProjectAction } from "../actions";

export default async function NewProject({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    name?: string;
    product_name?: string;
    product_name_aliases?: string;
    niche?: string;
  }>;
}) {
  const submitted = await searchParams;
  const actor = await requireUser();
  const canCreate = actor?.role === "admin" || actor?.role === "editor";

  if (!canCreate) {
    return (
      <main>
        <h1>New project</h1>
        <div className="card">
          <p className="muted">Only an editor or an admin can create a project.</p>
          <Link href="/projects">Back to projects</Link>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>New project</h1>
          <p className="sub">
            One project per product. Its generations and versions live inside it.
          </p>
        </div>
        <Link href="/projects" className="ghost-link">
          Cancel
        </Link>
      </div>

      {submitted.error && (
        <div className="card">
          <div className="field-head">
            <span className="field-label">Not created</span>
            <span className="badge flag">rejected</span>
          </div>
          <p className="muted">{submitted.error}</p>
        </div>
      )}

      {/* Values come back through the query string on rejection. Losing what somebody
          typed because a name collided is a worse failure than the collision. */}
      <form action={createProjectAction} className="card">
        <label htmlFor="name">Project name</label>
        <input
          id="name"
          name="name"
          required
          maxLength={PROJECT_NAME_MAX}
          autoComplete="off"
          defaultValue={submitted.name ?? ""}
        />
        <p className="muted">
          Must be unique. Case and extra spaces are ignored, so “Breezebox” and “breezebox ” are the
          same name.
        </p>

        <label htmlFor="product_name">Product name</label>
        <input
          id="product_name"
          name="product_name"
          required
          autoComplete="off"
          defaultValue={submitted.product_name ?? ""}
        />
        <p className="muted">
          What the copy is about. It never appears literally in generated copy — the{" "}
          <code>{"{{productName}}"}</code> token does — but the validator needs it to catch a
          literal that slipped through.
        </p>

        <label htmlFor="product_name_aliases">Other spellings (optional)</label>
        <input
          id="product_name_aliases"
          name="product_name_aliases"
          placeholder="PestPulsePro Solar, Pest Pulse Pro"
          autoComplete="off"
          defaultValue={submitted.product_name_aliases ?? ""}
        />
        <p className="muted">
          Comma separated. Real pages use more than one spelling of their own product name, and each
          one has to be caught.
        </p>

        <label htmlFor="niche">Niche (optional)</label>
        <input
          id="niche"
          name="niche"
          placeholder="pet, home, wellness…"
          autoComplete="off"
          defaultValue={submitted.niche ?? ""}
        />

        <p />
        <button type="submit">Create project</button>
      </form>
    </main>
  );
}
