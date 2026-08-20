"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createProject } from "@/lib/core/projects";
import { CreateProjectInput, parseAliases } from "@/lib/shared/project";
import { createClient, requireUser } from "@/lib/supabase/server";

/** Back to the form with the reason AND what they typed. */
function rejectTo(form: Record<string, string>, message: string): never {
  redirect(`/projects/new?${new URLSearchParams({ ...form, error: message })}`);
}

export async function createProjectAction(formData: FormData) {
  const form = {
    name: String(formData.get("name") ?? ""),
    product_name: String(formData.get("product_name") ?? ""),
    product_name_aliases: String(formData.get("product_name_aliases") ?? ""),
    niche: String(formData.get("niche") ?? ""),
  };

  const actor = await requireUser();
  if (actor?.role !== "admin" && actor?.role !== "editor") {
    rejectTo(form, "Only an editor or an admin can create a project.");
  }

  const parsed = CreateProjectInput.safeParse({
    ...form,
    product_name_aliases: parseAliases(form.product_name_aliases),
  });
  if (!parsed.success) {
    rejectTo(form, parsed.error.issues.map((i) => i.message).join(" "));
  }

  // The user's client: the insert policy is what decides, not the check above.
  const result = await createProject(await createClient(), parsed.data, actor.id);
  if (!result.ok) rejectTo(form, result.message);

  revalidatePath("/projects");
  revalidatePath("/new");
  redirect(`/projects?created=${encodeURIComponent(parsed.data.name)}`);
}
