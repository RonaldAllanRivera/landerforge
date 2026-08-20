import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { SectionTier } from "@/lib/shared/manifest";

/**
 * Runtime cost controls.
 *
 * These were constants until it became clear the right values are only discoverable by
 * watching real runs. They live in a single-row table so tuning is a form submission.
 */

export const SettingsSchema = z.object({
  max_calls_per_run: z.number().int().min(5).max(500),
  standard_model: z.string().min(1),
  fast_model: z.string().min(1),
  monthly_budget_usd: z.number().nullable(),
});

export type Settings = z.infer<typeof SettingsSchema>;

/** Matches the column defaults, so a missing row degrades rather than crashes a run. */
export const DEFAULT_SETTINGS: Settings = {
  max_calls_per_run: 60,
  standard_model: "claude-sonnet-4-6",
  fast_model: "claude-haiku-4-5",
  monthly_budget_usd: null,
};

export async function loadSettings(db: SupabaseClient): Promise<Settings> {
  const { data, error } = await db
    .from("settings")
    .select("max_calls_per_run, standard_model, fast_model, monthly_budget_usd")
    .eq("id", 1)
    .maybeSingle();

  // A generation must not fail because a settings row is missing.
  if (error || !data) return DEFAULT_SETTINGS;
  const parsed = SettingsSchema.safeParse(data);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export function modelForTier(settings: Settings, tier: SectionTier | undefined): string {
  return tier === "fast" ? settings.fast_model : settings.standard_model;
}

export const UpdateSettingsInput = SettingsSchema.partial();

export async function updateSettings(
  db: SupabaseClient,
  input: z.infer<typeof UpdateSettingsInput>,
): Promise<void> {
  // RLS denies this independently for anyone who is not an admin.
  const { error } = await db.from("settings").update(input).eq("id", 1);
  if (error) throw new Error(error.message);
}
