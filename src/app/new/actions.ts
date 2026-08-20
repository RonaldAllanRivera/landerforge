"use server";

import { redirect } from "next/navigation";
import { CreateGenerationInput, createGeneration } from "@/lib/core/create-generation";
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { canGenerate, requireUser } from "@/lib/supabase/server";

/**
 * A thin wrapper over the transport-agnostic core: resolve the session, call the
 * core, then handle redirection. Everything reusable lives in lib/core.
 */
export async function startGeneration(formData: FormData) {
  const actor = await requireUser();
  if (!canGenerate(actor)) throw new Error("not authorized to generate");

  const input = CreateGenerationInput.parse({
    projectId: Number(formData.get("projectId")),
    templateId: Number(formData.get("templateId")),
    sourceUrl: (formData.get("sourceUrl") as string) || undefined,
    pastedSource: (formData.get("pastedSource") as string) || undefined,
    specialNotes: (formData.get("specialNotes") as string) || undefined,
    rescrape: formData.get("rescrape") === "on",
  });

  // Source rows need the admin client: a user-scoped insert is denied by RLS.
  const { generationId } = await createGeneration(createAdminClient(), actor, input);

  // The row must exist before the event fires — the event carries only the id.
  await inngest.send({ name: "generation.requested", data: { generationId, attempt: 0 } });
  redirect(`/generations/${generationId}`);
}
