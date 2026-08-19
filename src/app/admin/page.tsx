import { createClient, requireUser } from "@/lib/supabase/server";

/** Admin-only. Route protection is defence in depth; RLS denies independently. */
export default async function Admin() {
  const actor = await requireUser();
  if (actor?.role !== "admin") {
    return (
      <main>
        <h1>Admin</h1>
        <p className="sub">This screen is for administrators.</p>
      </main>
    );
  }

  const supabase = await createClient();
  const { data: allowed } = await supabase
    .from("allowed_emails")
    .select("email, role, note, created_at")
    .order("created_at");

  return (
    <main>
      <h1>Access</h1>
      <p className="sub">
        Google accounts allowed to sign in, and the role each receives on first sign-in.
      </p>

      {(allowed ?? []).map((row) => (
        <div className="card" key={row.email}>
          <div className="field-head">
            <span>{row.email}</span>
            <span className="row">
              <span className="badge">{row.role}</span>
              {/* One action, three writes. Splitting them is how a removed user keeps
                  working access: the signup hook fires only at signup, so deleting the
                  allowlist row alone does not lock anyone out. */}
              <button type="button" className="ghost">
                Remove access
              </button>
            </span>
          </div>
          {row.note && <p className="muted">{row.note}</p>}
        </div>
      ))}
    </main>
  );
}
