/**
 * Local development account.
 *
 * Creates an allowlist entry and a usable admin account so the app runs on your own
 * machine without setting up a Google Cloud project first.
 *
 * Refuses to run against anything but a local Supabase, because it creates an account
 * with a known password.
 */
import { createClient } from "@supabase/supabase-js";

const EMAIL = process.env.DEV_EMAIL ?? "dev@localhost.test";
const PASSWORD = process.env.DEV_PASSWORD ?? "devpassword123";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  }
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal)/.test(url)) {
    throw new Error(`refusing to seed a dev account against a non-local project: ${url}`);
  }

  const db = createClient(url, key, { auth: { persistSession: false } });

  // The allowlist row must exist first: the before-user-created hook rejects anyone
  // not on it, and it fires for every provider — so this exercises the real path
  // rather than bypassing it.
  const { error: allowError } = await db
    .from("allowed_emails")
    .upsert({ email: EMAIL, role: "admin", note: "Local development" }, { onConflict: "email" });
  if (allowError) throw new Error(allowError.message);

  const { data: before } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (before.users.some((u) => u.email === EMAIL)) {
    console.log(`dev user already exists: ${EMAIL}`);
  } else {
    const { error } = await db.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    console.log(`created dev user: ${EMAIL} / ${PASSWORD}`);
  }

  // The role row is created by an after-insert trigger on auth.users. Verify rather
  // than assume — a null role is the failure mode that looks like an app bug.
  const { data: after } = await db.auth.admin.listUsers({ perPage: 1000 });
  const user = after.users.find((u) => u.email === EMAIL);
  if (!user) throw new Error("user was not created");

  const { data: role } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!role) throw new Error("no role row — the provisioning trigger in 0002 did not fire");
  console.log(`role: ${role.role}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
