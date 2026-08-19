import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Actor } from "@/lib/supabase/server";

/**
 * Access management. Transport-agnostic: receives a client rather than building one.
 *
 * Every operation here is admin-only, and every one of them is ALSO denied by RLS
 * independently — the checks in this file are for a clear error message, not for
 * security.
 */

export const APP_ROLES = ["admin", "editor", "viewer"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const GrantAccessInput = z.object({
  email: z
    .string()
    .email()
    .transform((e) => e.toLowerCase()),
  role: z.enum(APP_ROLES),
  note: z.string().max(200).optional(),
});

export function assertAdmin(actor: Actor | null): asserts actor is Actor {
  if (actor?.role !== "admin") throw new Error("administrators only");
}

export async function grantAccess(
  db: SupabaseClient,
  actor: Actor,
  input: z.infer<typeof GrantAccessInput>,
): Promise<void> {
  assertAdmin(actor);
  const { error } = await db
    .from("allowed_emails")
    .upsert(
      { email: input.email, role: input.role, note: input.note ?? null, invited_by: actor.id },
      { onConflict: "email" },
    );
  if (error) throw new Error(error.message);
}

/**
 * Change someone's role.
 *
 * Writes BOTH the allowlist row (which seeds the role at first sign-in) and the
 * user_roles row (which the access-token hook reads). Updating only the allowlist
 * would silently do nothing for anyone who has already signed in.
 *
 * The change is not instant for claim-based policies: the JWT carries the old role
 * until it refreshes, which is why destructive policies use a live lookup instead.
 */
export async function setRole(
  db: SupabaseClient,
  actor: Actor,
  email: string,
  role: AppRole,
): Promise<void> {
  assertAdmin(actor);
  const normalised = email.toLowerCase();

  const { error: allowError } = await db
    .from("allowed_emails")
    .update({ role })
    .eq("email", normalised);
  if (allowError) throw new Error(allowError.message);

  const userId = await findUserId(db, normalised);
  if (!userId) return; // Never signed in; the allowlist row is the whole story.

  const { error: roleError } = await db
    .from("user_roles")
    .upsert({ user_id: userId, role }, { onConflict: "user_id" });
  if (roleError) throw new Error(roleError.message);
}

/**
 * Off-board someone. THREE writes, deliberately in one operation.
 *
 * The before-user-created hook fires only at signup, so deleting the allowlist row
 * does NOT lock out an existing user — they keep signing in forever. Splitting these
 * into separate buttons is exactly how someone ends up with two of the three done and
 * a working account they should not have.
 */
export async function revokeAccess(
  db: SupabaseClient,
  actor: Actor,
  email: string,
): Promise<{ removedAccount: boolean }> {
  assertAdmin(actor);
  const normalised = email.toLowerCase();

  if (normalised === actor.email?.toLowerCase()) {
    throw new Error("you cannot revoke your own access");
  }

  // 1. The allowlist row, so they cannot sign up again.
  const { error: allowError } = await db.from("allowed_emails").delete().eq("email", normalised);
  if (allowError) throw new Error(allowError.message);

  const userId = await findUserId(db, normalised);
  if (!userId) return { removedAccount: false };

  // 2. The role, so any surviving session authorises nothing.
  const { error: roleError } = await db.from("user_roles").delete().eq("user_id", userId);
  if (roleError) throw new Error(roleError.message);

  // 3. The account itself. This is the step that actually ends existing sessions —
  // an already-issued JWT stays cryptographically valid until it expires, so nothing
  // short of removing the user reliably stops the next request.
  const { error: deleteError } = await db.auth.admin.deleteUser(userId);
  if (deleteError) throw new Error(deleteError.message);

  return { removedAccount: true };
}

async function findUserId(db: SupabaseClient, email: string): Promise<string | null> {
  const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(error.message);
  const match = data.users.find((u) => u.email?.toLowerCase() === email);
  return match?.id ?? null;
}
