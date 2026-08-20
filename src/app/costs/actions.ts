"use server";

import { revalidatePath } from "next/cache";
import { UpdateSettingsInput, updateSettings } from "@/lib/core/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/server";

export async function updateSettingsAction(formData: FormData) {
  const actor = await requireUser();
  if (actor?.role !== "admin") throw new Error("administrators only");

  const budget = formData.get("monthly_budget_usd");
  const input = UpdateSettingsInput.parse({
    max_calls_per_run: Number(formData.get("max_calls_per_run")),
    standard_model: String(formData.get("standard_model")),
    fast_model: String(formData.get("fast_model")),
    monthly_budget_usd: budget === "" || budget === null ? null : Number(budget),
  });

  await updateSettings(createAdminClient(), input);
  revalidatePath("/costs");
}
