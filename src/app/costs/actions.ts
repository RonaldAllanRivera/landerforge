"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { updateSettings } from "@/lib/core/settings";
import { UpdateSettingsInput } from "@/lib/shared/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/server";

export async function updateSettingsAction(formData: FormData) {
  const actor = await requireUser();
  if (actor?.role !== "admin") throw new Error("administrators only");

  const budget = formData.get("monthly_budget_usd");
  const parsed = UpdateSettingsInput.safeParse({
    max_calls_per_run: Number(formData.get("max_calls_per_run")),
    standard_model: String(formData.get("standard_model")),
    fast_model: String(formData.get("fast_model")),
    monthly_budget_usd: budget === "" || budget === null ? null : Number(budget),
    effort: String(formData.get("effort")),
  });

  /**
   * Back to the form with the reason, rather than an error page. A thrown server action
   * loses the whole screen — including the cost figures the operator was reading when
   * they decided to change something.
   */
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => i.message).join("; ");
    redirect(`/costs?error=${encodeURIComponent(reason)}`);
  }

  await updateSettings(createAdminClient(), parsed.data);
  revalidatePath("/costs");
  redirect("/costs?saved=1");
}
