"use server";

import { revalidatePath } from "next/cache";
import {
  APP_ROLES,
  type AppRole,
  GrantAccessInput,
  grantAccess,
  revokeAccess,
  setRole,
} from "@/lib/core/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/server";

/** Thin wrappers: resolve the session, call the core, revalidate. */

export async function grantAccessAction(formData: FormData) {
  const actor = await requireUser();
  if (!actor) throw new Error("not signed in");
  const input = GrantAccessInput.parse({
    email: formData.get("email"),
    role: formData.get("role"),
    note: (formData.get("note") as string) || undefined,
  });
  await grantAccess(createAdminClient(), actor, input);
  revalidatePath("/admin");
}

export async function setRoleAction(formData: FormData) {
  const actor = await requireUser();
  if (!actor) throw new Error("not signed in");
  const role = formData.get("role") as AppRole;
  if (!APP_ROLES.includes(role)) throw new Error("unknown role");
  await setRole(createAdminClient(), actor, formData.get("email") as string, role);
  revalidatePath("/admin");
}

export async function revokeAccessAction(formData: FormData) {
  const actor = await requireUser();
  if (!actor) throw new Error("not signed in");
  await revokeAccess(createAdminClient(), actor, formData.get("email") as string);
  revalidatePath("/admin");
}
