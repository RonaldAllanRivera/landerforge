"use server";

import { revalidatePath } from "next/cache";
import { inngest } from "@/lib/inngest/client";
import { type SourceBlock, SourceBlockSchema } from "@/lib/shared/blocks";
import { parseManifest } from "@/lib/shared/manifest";
import type { SectionPlan } from "@/lib/shared/section-plan";
import { validateSection } from "@/lib/shared/validate-section";
import { createClient, requireUser } from "@/lib/supabase/server";

export interface SaveResult {
  ok: boolean;
  message?: string;
}

/**
 * Persist a hand-edited section, then re-judge it.
 *
 * Written through the USER's client, not the admin one, so the row-level policy is
 * what actually decides — the role check below is a better error message, not the
 * security boundary.
 *
 * status and violations are recomputed here rather than accepted from the browser.
 * Letting the client send them would mean an operator could clear a flag by editing
 * the badge instead of the copy, and the column grant deliberately allows all three
 * so that this recomputation is possible at all.
 */
export async function saveSectionAction(
  generationId: number,
  sectionId: string,
  output: Record<string, unknown>,
): Promise<SaveResult> {
  const actor = await requireUser();
  if (actor?.role !== "admin" && actor?.role !== "editor") {
    return { ok: false, message: "Only an editor or an admin can change generated copy." };
  }

  const db = await createClient();

  const { data: generation } = await db
    .from("generations")
    .select("id, manifest_snapshot, brief, source_id")
    .eq("id", generationId)
    .maybeSingle();
  if (!generation) return { ok: false, message: "That generation no longer exists." };

  const manifest = parseManifest(generation.manifest_snapshot);
  if (!manifest.sections.some((s) => s.id === sectionId)) {
    return { ok: false, message: `This template has no "${sectionId}" section.` };
  }

  /**
   * Validate against the brief the section was WRITTEN for, not against today's. The
   * word targets and the allowed specs are properties of that run; re-deriving them
   * would judge the edit by numbers it never had.
   */
  const brief = (generation.brief ?? {}) as {
    allowedSpecs?: Array<{
      label: string;
      value: number;
      unit: string | null;
      origin: "source" | "user_notes" | "conversion";
    }>;
    sectionPlan?: SectionPlan;
  };

  let blocks: SourceBlock[] = [];
  if (generation.source_id) {
    const { data: source } = await db
      .from("sources")
      .select("blocks")
      .eq("id", generation.source_id)
      .maybeSingle();
    const parsed = SourceBlockSchema.array().safeParse(source?.blocks ?? []);
    if (parsed.success) blocks = parsed.data;
  }

  const violations = validateSection(
    {
      manifest,
      allowedSpecs: brief.allowedSpecs ?? [],
      sectionPlan: brief.sectionPlan ?? [],
      blocks,
    },
    sectionId,
    output,
  );

  const { error } = await db
    .from("generation_sections")
    .update({
      output,
      violations,
      status: violations.length === 0 ? "done" : "flagged",
    })
    .eq("generation_id", generationId)
    .eq("section_id", sectionId);

  // A denial here is the policy talking, and it is the answer that matters.
  if (error) return { ok: false, message: error.message };

  revalidatePath(`/generations/${generationId}`);
  return { ok: true };
}

/**
 * Re-run a generation that stopped short.
 *
 * The Retry control used to POST to /api/v1/generations/[id]/retry, a route that was
 * never written, and `generation.retry.requested` had no handler — so the only visible
 * recovery path in the app was a 404. A run can also stall at `queued` if its event is
 * lost, which is not `failed` and so offered no button at all.
 *
 * retry_count is the attempt number, and it is part of the function's idempotency key:
 * re-sending the original event inside its 24-hour window is deduplicated, which is
 * precisely what made this look broken rather than absent.
 */
export async function retryGenerationAction(generationId: number): Promise<SaveResult> {
  const actor = await requireUser();
  if (actor?.role !== "admin" && actor?.role !== "editor") {
    return { ok: false, message: "Only an editor or an admin can re-run a generation." };
  }

  const db = await createClient();
  const { data: generation } = await db
    .from("generations")
    .select("id, status, retry_count")
    .eq("id", generationId)
    .maybeSingle();
  if (!generation) return { ok: false, message: "That generation no longer exists." };
  if (generation.status === "done") {
    return { ok: false, message: "This run finished. Start a new generation instead." };
  }

  const attempt = Number(generation.retry_count ?? 0) + 1;
  const { error } = await db
    .from("generations")
    .update({ retry_count: attempt, status: "failed" })
    .eq("id", generationId);
  if (error) return { ok: false, message: error.message };

  /**
   * status is set to `failed` first on purpose: the worker claims a row only when it
   * is `queued` or `failed`, so a run wedged in `generating` would otherwise refuse
   * its own retry.
   */
  await inngest.send({
    name: "generation.retry.requested",
    data: { generationId, attempt },
  });

  revalidatePath(`/generations/${generationId}`);
  return { ok: true };
}
