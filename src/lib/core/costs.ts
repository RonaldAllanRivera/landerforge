import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type CostReport, type SectionRow, type StepRow, summarise } from "@/lib/shared/costs";

/** The I/O half. All the arithmetic lives in lib/shared/costs, where it is tested. */
export async function buildCostReport(
  db: SupabaseClient,
  budgetUsd: number | null,
): Promise<CostReport> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const { data: steps } = await db
    .from("generation_steps")
    .select(
      "generation_id, step, attempt, model, cost_usd, output_tokens, cache_read_input_tokens, created_at",
    )
    .gte("created_at", monthStart.toISOString())
    .order("created_at", { ascending: false })
    .limit(5000);

  const rows = (steps ?? []) as StepRow[];

  /**
   * Section outcomes for exactly the runs above, so "which model produced usable copy"
   * can be answered. Scoped by generation id rather than by date: a run that starts in
   * the last minute of a month finishes in the next one, and a date filter here would
   * silently drop its sections and skew every quality rate.
   */
  const generationIds = [...new Set(rows.map((r) => r.generation_id))];
  const sections = generationIds.length
    ? ((
        await db
          .from("generation_sections")
          .select("generation_id, section_id, status")
          .in("generation_id", generationIds)
      ).data ?? [])
    : [];

  return summarise(rows, sections as SectionRow[], budgetUsd);
}

export type { CostReport } from "@/lib/shared/costs";
