import { APP_ROLES } from "@/lib/core/access";
import { createClient, requireUser } from "@/lib/supabase/server";
import { grantAccessAction, revokeAccessAction, setRoleAction } from "./actions";

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

      <form action={grantAccessAction} className="card">
        <label htmlFor="email">Grant access</label>
        <input id="email" name="email" type="email" required placeholder="person@gmail.com" />
        <label htmlFor="role">Role</label>
        <select id="role" name="role" defaultValue="editor">
          {APP_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <label htmlFor="note">Note (optional)</label>
        <input id="note" name="note" placeholder="Contractor, through March" />
        <p />
        <button type="submit">Add to allowlist</button>
      </form>

      <h2>Allowed accounts</h2>
      {(allowed ?? []).map((row) => (
        <div className="card" key={row.email}>
          <div className="field-head">
            <span>{row.email}</span>
            <span className="row">
              <form action={setRoleAction} className="row">
                <input type="hidden" name="email" value={row.email} />
                <select name="role" defaultValue={row.role} aria-label={`Role for ${row.email}`}>
                  {APP_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
                <button type="submit" className="ghost">
                  Save
                </button>
              </form>

              {/*
                One action, three writes: allowlist row, role row, and the account
                itself. The signup hook fires only at signup, so removing the
                allowlist row alone leaves an existing user signing in forever.
              */}
              <form action={revokeAccessAction}>
                <input type="hidden" name="email" value={row.email} />
                <button type="submit" className="ghost">
                  Remove access
                </button>
              </form>
            </span>
          </div>
          {row.note && <p className="muted">{row.note}</p>}
        </div>
      ))}
    </main>
  );
}
