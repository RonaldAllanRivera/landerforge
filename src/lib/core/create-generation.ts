import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { blocksFromPaste } from "@/lib/scrape/extract";
import type { Actor } from "@/lib/supabase/server";

/**
 * Transport-agnostic core.
 *
 * It RECEIVES a Supabase client rather than constructing one, and contains no
 * cookies(), redirect() or revalidatePath(). That parameter is the seam between the
 * web app and any future non-browser client: adding it later would mean touching
 * every core function and call site at once.
 */

export const CreateGenerationInput = z.object({
  projectId: z.number().int().positive(),
  templateId: z.number().int().positive(),
  sourceUrl: z.string().url().optional(),
  pastedSource: z.string().optional(),
  specialNotes: z.string().optional(),
  rescrape: z.boolean().default(false),
});

export type CreateGenerationInput = z.infer<typeof CreateGenerationInput>;

const REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRACKING_PARAMS = /^(utm_|gclid|fbclid|msclkid)/i;

/** Strip tracking params so the same page does not create duplicate source rows. */
export function normaliseUrl(raw: string): string {
  const url = new URL(raw);
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

/**
 * The server action owns the insert; the worker never creates a source row.
 * version_num and manifest_snapshot are assigned by a database trigger, so a future
 * direct-from-client insert cannot reintroduce either hole.
 */
export async function createGeneration(
  db: SupabaseClient,
  actor: Actor,
  input: CreateGenerationInput,
): Promise<{ generationId: number }> {
  const sourceId = await resolveSource(db, input);

  const { data, error } = await db
    .from("generations")
    .insert({
      owner_id: actor.id,
      project_id: input.projectId,
      template_id: input.templateId,
      source_id: sourceId,
      special_notes: input.specialNotes ?? null,
      status: "queued",
    })
    .select("id")
    .single();

  // Two editors generating into one shared project can race on version_num.
  if (error?.code === "23505") return createGeneration(db, actor, input);
  if (error) throw new Error(error.message);

  return { generationId: data.id as number };
}

async function resolveSource(
  db: SupabaseClient,
  input: CreateGenerationInput,
): Promise<number | null> {
  if (input.pastedSource?.trim()) {
    // A user-scoped insert would be denied, so this runs through the admin client.
    const extracted = blocksFromPaste(input.pastedSource);
    const { data, error } = await db
      .from("sources")
      .insert({
        project_id: input.projectId,
        source_type: "paste",
        status: "manual",
        blocks: extracted.blocks,
        raw_text: extracted.rawText,
        raw_text_truncated: extracted.truncated,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as number;
  }

  if (!input.sourceUrl) return null;
  const normalized = normaliseUrl(input.sourceUrl);

  if (!input.rescrape) {
    const fresh = new Date(Date.now() - REUSE_WINDOW_MS).toISOString();
    const { data } = await db
      .from("sources")
      .select("id")
      .eq("project_id", input.projectId)
      .eq("url_normalized", normalized)
      .eq("status", "ok")
      .gte("scraped_at", fresh)
      .maybeSingle();
    if (data) return data.id as number;
  }

  // Never overwrite: old generations must keep pointing at the snapshot they were
  // built from.
  const { data, error } = await db
    .from("sources")
    .insert({
      project_id: input.projectId,
      source_type: "url",
      url: input.sourceUrl,
      url_normalized: normalized,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as number;
}
