import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type CostReport, type StepRow, summarise } from "@/lib/shared/costs";

/** The I/O half. All the arithmetic lives in lib/shared/costs, where it is tested. */
export async function buildCostReport(
  db: SupabaseClient,
  budgetUsd: number | null,
): Promise<CostReport> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const { data } = await db
    .from("generation_steps")
    .select("generation_id, step, attempt, model, cost_usd, cache_read_input_tokens, created_at")
    .gte("created_at", monthStart.toISOString())
    .order("created_at", { ascending: false })
    .limit(5000);

  return summarise((data ?? []) as StepRow[], budgetUsd);
}

export type { CostReport } from "@/lib/shared/costs";
