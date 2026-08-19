import { notFound } from "next/navigation";
import { parseManifest } from "@/lib/shared/manifest";
import { createClient } from "@/lib/supabase/server";
import { ReviewScreen } from "./review-client";

/** RSC fetches the initial state; the client component subscribes for deltas. */
export default async function GenerationPage({ params }: { params: Promise<{ id: string }> }) {
  // params is async in Next 15.
  const { id } = await params;
  const generationId = Number(id);
  const supabase = await createClient();

  const { data: generation } = await supabase
    .from("generations")
    .select("id, status, error_message, run_notes, total_cost_usd, manifest_snapshot")
    .eq("id", generationId)
    .maybeSingle();
  if (!generation) notFound();

  const { data: sections } = await supabase
    .from("generation_sections")
    .select("section_id, output, status, violations")
    .eq("generation_id", generationId);

  return (
    <ReviewScreen
      generationId={generationId}
      initialStatus={generation.status}
      errorMessage={generation.error_message}
      runNotes={(generation.run_notes as unknown[]) ?? []}
      costUsd={generation.total_cost_usd}
      manifest={parseManifest(generation.manifest_snapshot)}
      initialSections={sections ?? []}
    />
  );
}
