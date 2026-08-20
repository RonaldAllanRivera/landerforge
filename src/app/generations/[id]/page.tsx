import { notFound } from "next/navigation";
import { sectionIdOf } from "@/lib/shared/costs";
import { parseManifest } from "@/lib/shared/manifest";
import { createClient, requireUser } from "@/lib/supabase/server";
import { ReviewScreen } from "./review-client";

/** RSC fetches the initial state; the client component subscribes for deltas. */
export default async function GenerationPage({ params }: { params: Promise<{ id: string }> }) {
  // params is async in Next 15.
  const { id } = await params;
  const generationId = Number(id);
  const supabase = await createClient();
  const actor = await requireUser();

  const { data: generation } = await supabase
    .from("generations")
    .select("id, status, error_message, run_notes, total_cost_usd, manifest_snapshot")
    .eq("id", generationId)
    .maybeSingle();
  if (!generation) notFound();

  const { data: sections } = await supabase
    .from("generation_sections")
    .select("section_id, output, status, violations, edited_at")
    .eq("generation_id", generationId);

  /**
   * Per-section spend, shown beside the copy rather than only as a run total. A
   * flagged section and what it cost to fail are the same decision — whether to change
   * the manifest, the effort, or the model — and splitting them across two screens
   * means the expensive ones are never the ones you look at.
   */
  const { data: steps } = await supabase
    .from("generation_steps")
    .select("step, cost_usd, model")
    .eq("generation_id", generationId);

  const spend: Record<string, { usd: number; attempts: number; model: string | null }> = {};
  for (const row of steps ?? []) {
    const sectionId = sectionIdOf(row.step);
    if (sectionId === null) continue;
    const entry = spend[sectionId] ?? { usd: 0, attempts: 0, model: row.model };
    entry.usd += Number(row.cost_usd ?? 0);
    entry.attempts += 1;
    spend[sectionId] = entry;
  }

  return (
    <ReviewScreen
      generationId={generationId}
      initialStatus={generation.status}
      errorMessage={generation.error_message}
      runNotes={(generation.run_notes as unknown[]) ?? []}
      costUsd={generation.total_cost_usd}
      spend={spend}
      // The policy decides for real; this only avoids offering a control that would
      // be refused, which reads as a broken screen rather than a permission.
      canEdit={actor?.role === "admin" || actor?.role === "editor"}
      manifest={parseManifest(generation.manifest_snapshot)}
      initialSections={sections ?? []}
    />
  );
}
