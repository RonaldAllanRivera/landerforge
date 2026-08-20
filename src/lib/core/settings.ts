import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import {
  DEFAULT_SETTINGS,
  type Settings,
  SettingsSchema,
  type UpdateSettingsInput,
} from "@/lib/shared/settings";

/** The I/O half. Schema, defaults and resolution rules live in lib/shared/settings. */

export async function loadSettings(db: SupabaseClient): Promise<Settings> {
  const { data, error } = await db
    .from("settings")
    .select("max_calls_per_run, standard_model, fast_model, monthly_budget_usd, effort")
    .eq("id", 1)
    .maybeSingle();

  // A generation must not fail because a settings row is missing.
  if (error || !data) return DEFAULT_SETTINGS;

  const parsed = SettingsSchema.safeParse(data);
  if (parsed.success) return parsed.data;

  /**
   * Falling back is correct; doing it silently is not. A stored model that has since
   * lost its price entry would otherwise mean every run quietly ignores the settings
   * an operator believes are in force.
   */
  console.warn("[settings] stored row failed validation, using defaults:", parsed.error.message);
  return DEFAULT_SETTINGS;
}

export async function updateSettings(
  db: SupabaseClient,
  input: z.infer<typeof UpdateSettingsInput>,
): Promise<void> {
  // RLS denies this independently for anyone who is not an admin.
  const { error } = await db.from("settings").update(input).eq("id", 1);
  if (error) throw new Error(error.message);
}

export {
  DEFAULT_SETTINGS,
  effortFor,
  modelForTier,
  type Settings,
  SettingsSchema,
  UpdateSettingsInput,
} from "@/lib/shared/settings";
