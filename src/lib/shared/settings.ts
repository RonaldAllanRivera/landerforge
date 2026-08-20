import { z } from "zod";
import type { SectionTier } from "./manifest";
import { EFFORT_LEVELS, type Effort, PRICING, SUPPORTS_EFFORT } from "./pricing";

/**
 * Runtime cost controls — the pure half.
 *
 * These were constants until it became clear the right values are only discoverable by
 * watching real runs. They live in a single-row table so tuning is a form submission.
 *
 * Schema and resolution rules live here rather than in lib/core/settings because they
 * are pure and therefore testable; the Supabase reads and writes stay there. That split
 * has already paid for itself three times in this codebase — every piece of logic that
 * ended up behind `server-only` turned out to be both untested and wrong.
 */

/**
 * A model must have a price entry.
 *
 * Not pedantry: an unpriced model still runs, and every figure on the cost screen then
 * silently falls back to the default model's rates. Wrong numbers presented confidently
 * are worse than an error, and this is the screen those numbers are read from.
 */
const PricedModel = z
  .string()
  .min(1)
  .refine((m) => m in PRICING, {
    error: (issue) =>
      `no published price for "${String(issue.input)}" — add it to lib/shared/pricing ` +
      "before selecting it, or every cost figure will be reported against the wrong rates",
  });

export const SettingsSchema = z.object({
  max_calls_per_run: z.number().int().min(5).max(500),
  standard_model: PricedModel,
  fast_model: PricedModel,
  monthly_budget_usd: z.number().nullable(),
  effort: z.enum(EFFORT_LEVELS),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const UpdateSettingsInput = SettingsSchema.partial();

/** Matches the column defaults, so a missing row degrades rather than crashes a run. */
export const DEFAULT_SETTINGS: Settings = {
  max_calls_per_run: 60,
  standard_model: "claude-sonnet-5",
  fast_model: "claude-haiku-4-5",
  monthly_budget_usd: null,
  effort: "medium",
};

export function modelForTier(settings: Settings, tier: SectionTier | undefined): string {
  return tier === "fast" ? settings.fast_model : settings.standard_model;
}

/**
 * The effort parameter, or nothing at all.
 *
 * Sending it to a model that does not accept it is a 400, and Haiku 4.5 reports every
 * level unsupported — so this returns a spreadable object rather than a value, and the
 * call site cannot forget the check.
 */
export function effortFor(settings: Settings, model: string): { effort: Effort } | undefined {
  return SUPPORTS_EFFORT.has(model) ? { effort: settings.effort } : undefined;
}
