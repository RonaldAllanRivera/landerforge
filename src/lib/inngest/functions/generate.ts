import type Anthropic from "@anthropic-ai/sdk";
import { NonRetriableError } from "inngest";
import { anthropic, cacheHit, costUsd, DEFAULT_MODEL } from "@/lib/anthropic/client";
import { buildMessages, buildSystem, stableStringify } from "@/lib/anthropic/prompt";
import { COPY_RULES } from "@/lib/core/rules";
import { loadSettings, modelForTier, type Settings } from "@/lib/core/settings";
import { scrape } from "@/lib/scrape/browserless";
import { extractBlocks } from "@/lib/scrape/extract";
import { type SourceBlock, SourceBlockSchema } from "@/lib/shared/blocks";
import { lintField, type Violation } from "@/lib/shared/lints";
import { parseManifest, type TemplateManifest } from "@/lib/shared/manifest";
import { buildSectionPlan, type SectionPlan } from "@/lib/shared/section-plan";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest, SHARED_CONCURRENCY } from "../client";

const MAX_CORRECTIVE_RETRIES = 2;

type Db = ReturnType<typeof createAdminClient>;

export interface AllowedSpecPayload {
  label: string;
  value: number;
  unit: string | null;
  origin: "source" | "user_notes" | "conversion";
}

export interface BriefPayload {
  angle: string;
  allowedSpecs: AllowedSpecPayload[];
  map: {
    blockMap: Record<string, { sectionId: string; fieldKey: string; instanceIndex?: number }>;
    sections: Array<{ sectionId: string; present: boolean; formatNotes: string }>;
  };
  sectionPlan: SectionPlan;
}

export const generate = inngest.createFunction(
  {
    id: "generate-lander",
    // Inngest delivers at-least-once and the wizard is double-submittable. The window
    // is 24 HOURS, which is exactly why retry is a separate event.
    idempotency: "event.data.generationId",
    concurrency: SHARED_CONCURRENCY,
    onFailure: async ({ error }) => {
      console.error("[generate] run failed after retries", error);
    },
  },
  { event: "generation.requested" },
  async ({ event, step }) => {
    const db = createAdminClient();
    const generationId = event.data.generationId as number;
    let calls = 0;

    // Read once per run, not per call: a mid-run change would make the cache prefix
    // and the call ceiling inconsistent with what the run started under.
    const settings = await step.run("settings", () => loadSettings(db));

    // Conditional claim. 'failed' is accepted so a retry can re-enter; restricting it
    // to 'queued' would make the Retry button unreachable.
    const claimed = await step.run("claim", async () => {
      const { data } = await db
        .from("generations")
        .update({ status: "scraping" })
        .eq("id", generationId)
        .in("status", ["queued", "failed"])
        .select("id, source_id, manifest_snapshot, special_notes, brief")
        .maybeSingle();
      return data;
    });
    if (!claimed) throw new NonRetriableError("generation already in flight or missing");

    const manifest = parseManifest(claimed.manifest_snapshot);

    // ── Step 0: scrape ──────────────────────────────────────────────────────
    // The sources row already exists — the wizard created it — so this reads its url
    // and writes back blocks/raw_text/status. It skips a non-url source entirely.
    const source = await step.run("scrape", async () => {
      if (!claimed.source_id) return null;
      const { data: row } = await db
        .from("sources")
        .select("id, source_type, url, status, blocks, raw_text")
        .eq("id", claimed.source_id)
        .single();
      if (!row) return null;
      if (row.source_type !== "url" || row.status === "ok") return row;

      const outcome = await scrape(row.url ?? "");
      if (outcome.status !== "ok") {
        await db.from("sources").update({ status: outcome.status }).eq("id", row.id);
        return { ...row, status: outcome.status, blocks: null, raw_text: null };
      }
      const extracted = extractBlocks(outcome.html, manifest);
      await db
        .from("sources")
        .update({
          status: "ok",
          blocks: extracted.blocks,
          raw_text: extracted.rawText,
          raw_text_truncated: extracted.truncated,
          scraped_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      return { ...row, status: "ok", blocks: extracted.blocks, raw_text: extracted.rawText };
    });

    const blocks: SourceBlock[] =
      source?.status === "ok" && Array.isArray(source?.blocks)
        ? SourceBlockSchema.array().parse(source.blocks)
        : [];
    const rawText = typeof source?.raw_text === "string" ? source.raw_text : "";

    if (source?.status !== "ok") {
      await step.run("note-no-source", async () => {
        await appendRunNote(db, generationId, { kind: source ? "source_blocked" : "no_source" });
      });
    }

    // ── Step 1: brief ───────────────────────────────────────────────────────
    await setStatus(step, db, generationId, "briefing");

    const brief = await step.run("brief", async () => {
      if (claimed.brief) return claimed.brief as BriefPayload;
      calls++;
      const result = await callBrief(manifest, blocks, claimed.special_notes ?? "", settings);

      /**
       * The guard runs BEFORE the write. Post-write, a failure would leave `brief`
       * populated and the resume rule would send a retry straight into Step 2 on a
       * brief that never passed it — silently disabling anti-fabrication.
       */
      const unverified = result.allowedSpecs.filter(
        (s) => s.origin === "source" && !rawText.includes(String(s.value)),
      );
      if (unverified.length > 0) {
        await appendRunNote(db, generationId, {
          kind: "spec_guard_failed",
          specs: unverified.map((s) => s.label),
        });
        throw new NonRetriableError("allowedSpecs failed the raw_text guard");
      }

      const payload: BriefPayload = {
        ...result,
        sectionPlan: buildSectionPlan(blocks, result.map, manifest),
      };
      await db.from("generations").update({ brief: payload }).eq("id", generationId);
      return payload;
    });

    // ── Steps 2 + 3: generation with in-band validation ─────────────────────
    await setStatus(step, db, generationId, "generating");
    const priorSections: Array<{ sectionId: string; body: string }> = [];

    for (const section of manifest.sections) {
      const plan = brief.sectionPlan.find((s) => s.sectionId === section.id);
      if (plan && !plan.present) continue;
      if (section.fields.every((f) => !f.generate)) continue;

      let violations: Violation[] = [];
      let output: Record<string, unknown> = {};

      for (let attempt = 0; attempt <= MAX_CORRECTIVE_RETRIES; attempt++) {
        if (calls >= settings.max_calls_per_run) {
          await appendRunNote(db, generationId, { kind: "budget_exceeded", calls });
          throw new NonRetriableError("budget exceeded");
        }
        calls++;

        // Each attempt is its own step with a deterministic id, so replay is stable.
        const attemptViolations = violations;
        output = await step.run(`generate-${section.id}-attempt-${attempt}`, async () => {
          const generated = await callSection({
            manifest,
            section,
            brief,
            priorSections,
            blocks,
            violations: attemptViolations,
            settings,
          });
          await logStep(
            db,
            generationId,
            `generate:${section.id}`,
            attempt,
            generated.usage,
            generated.model,
          );
          return generated.output;
        });

        /**
         * Validation is plain code INSIDE the loop, never a thrown error. Throwing
         * would make Inngest retry the call identically, without the corrective
         * feedback, fighting this loop.
         */
        violations = validateSection(manifest, section.id, output, brief, blocks);
        if (violations.length === 0) break;
      }

      const sectionViolations = violations;
      const sectionOutput = output;
      await step.run(`persist-${section.id}`, async () => {
        await db.from("generation_sections").upsert(
          {
            generation_id: generationId,
            section_id: section.id,
            output: sectionOutput,
            status: sectionViolations.length === 0 ? "done" : "flagged",
            violations: sectionViolations,
          },
          { onConflict: "generation_id,section_id" },
        );
      });

      priorSections.push({ sectionId: section.id, body: stableStringify(output) });
    }

    // ── Step 4: finalize ────────────────────────────────────────────────────
    await step.run("finalize", async () => {
      const { data: steps } = await db
        .from("generation_steps")
        .select("cost_usd")
        .eq("generation_id", generationId);
      const total = (steps ?? []).reduce((sum, s) => sum + Number(s.cost_usd ?? 0), 0);
      await db
        .from("generations")
        .update({ status: "done", total_cost_usd: total })
        .eq("id", generationId);
    });

    return { generationId, sections: priorSections.length };
  },
);

// ── helpers ────────────────────────────────────────────────────────────────

async function setStatus(
  step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> },
  db: Db,
  id: number,
  status: string,
) {
  await step.run(`status-${status}`, async () => {
    await db.from("generations").update({ status }).eq("id", id);
  });
}

async function callBrief(
  manifest: TemplateManifest,
  blocks: SourceBlock[],
  notes: string,
  settings: Settings,
) {
  const response = await anthropic.messages.create({
    // The brief is the planning-heavy call and always runs on the standard model,
    // whatever tier the sections use.
    model: settings.standard_model,
    max_tokens: 8000,
    system: buildSystem(`${COPY_RULES}\n\nManifest:\n${stableStringify(manifest)}`),
    messages: buildMessages({
      systemPrompt: "",
      brief: { notes },
      priorSections: [],
      sourceBlocks: blocks,
      sectionInstructions: BRIEF_INSTRUCTIONS,
    }),
  });
  return parseJsonResponse<Omit<BriefPayload, "sectionPlan">>(response);
}

async function callSection(args: {
  manifest: TemplateManifest;
  section: TemplateManifest["sections"][number];
  brief: BriefPayload;
  priorSections: Array<{ sectionId: string; body: string }>;
  blocks: SourceBlock[];
  violations: Violation[];
  settings: Settings;
}) {
  const plan = args.brief.sectionPlan.find((s) => s.sectionId === args.section.id);
  /**
   * The manifest names a tier; settings name the model. Note that the prompt cache is
   * keyed per model, so mixing tiers within a run means each model keeps its own
   * cached prefix and each pays one cache write for the system prompt — the saving is
   * smaller than the raw price difference suggests. Confirm it on /costs.
   */
  const model = modelForTier(args.settings, args.section.tier);
  const corrective =
    args.violations.length > 0
      ? `\n\nYour previous attempt had these violations. Fix every one:\n${args.violations
          .map(
            (v) =>
              `- [${v.category}] ${v.address}: ${v.message}${v.excerpt ? ` — "${v.excerpt}"` : ""}`,
          )
          .join("\n")}`
      : "";

  const response = await anthropic.messages.create({
    model,
    /**
     * Density ceiling + JSON overhead + explicit thinking headroom. max_tokens caps
     * thinking and response text together, so a budget derived from word count alone
     * yields a response that is almost entirely thinking plus truncated JSON.
     */
    max_tokens: 8000,
    system: buildSystem(`${COPY_RULES}\n\nManifest:\n${stableStringify(args.manifest)}`),
    messages: buildMessages({
      systemPrompt: "",
      brief: args.brief,
      priorSections: args.priorSections,
      sourceBlocks: args.blocks,
      sectionInstructions:
        `Write section "${args.section.id}".\n` +
        `Constraints: ${stableStringify(plan ?? {})}\n` +
        "Return a JSON object keyed by field key." +
        corrective,
    }),
  });

  return {
    output: parseJsonResponse<Record<string, unknown>>(response),
    usage: response.usage,
    model,
  };
}

/** A refusal or truncation is not a copy violation and must not spend the retry budget. */
function parseJsonResponse<T>(response: Anthropic.Messages.Message): T {
  if (response.stop_reason === "refusal") throw new NonRetriableError("model refused");
  if (response.stop_reason === "max_tokens") throw new Error("truncated; raise max_tokens");
  const textBlock = response.content.find((c): c is Anthropic.TextBlock => c.type === "text");
  const json = /\{[\s\S]*\}/.exec(textBlock?.text ?? "{}")?.[0] ?? "{}";
  return JSON.parse(json) as T;
}

function validateSection(
  manifest: TemplateManifest,
  sectionId: string,
  output: Record<string, unknown>,
  brief: BriefPayload,
  blocks: SourceBlock[],
): Violation[] {
  const section = manifest.sections.find((s) => s.id === sectionId);
  if (!section) return [];
  const plan = brief.sectionPlan.find((s) => s.sectionId === sectionId);

  return section.fields.flatMap((field) => {
    const value = output[field.key];
    if (value === undefined) return [];
    return lintField({
      manifest,
      field,
      address: `${sectionId}.${field.key}`,
      value: value as string,
      plan: plan?.fields[field.key],
      blocks,
      allowedSpecs: brief.allowedSpecs,
      productNameAliases: [],
    });
  });
}

async function appendRunNote(db: Db, generationId: number, note: Record<string, unknown>) {
  const { data } = await db.from("generations").select("run_notes").eq("id", generationId).single();
  const notes = Array.isArray(data?.run_notes) ? data.run_notes : [];
  await db
    .from("generations")
    .update({ run_notes: [...notes, note] })
    .eq("id", generationId);
}

async function logStep(
  db: Db,
  generationId: number,
  step: string,
  attempt: number,
  usage: Anthropic.Messages.Usage,
  model: string = DEFAULT_MODEL,
) {
  await db.from("generation_steps").insert({
    generation_id: generationId,
    step,
    attempt,
    model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cost_usd: costUsd(usage, model),
  });
  // A zero read on call 2+ means a silent invalidator crept into the prefix.
  if (attempt === 0 && step !== "brief" && !cacheHit(usage)) {
    console.warn(`[cache] miss on ${step} — check the prefix for a per-call value`);
  }
}

const BRIEF_INSTRUCTIONS = `Analyse the source material and return JSON:
{
  "angle": string,
  "allowedSpecs": [{ "label": string, "value": number, "unit": string|null,
                     "origin": "source"|"user_notes"|"conversion" }],
  "map": {
    "blockMap": { "<blockIndex>": { "sectionId": string, "fieldKey": string,
                                    "instanceIndex"?: number } },
    "sections": [{ "sectionId": string, "present": boolean, "formatNotes": string }]
  }
}
Emit NO word counts or other totals — code computes every number from the blocks.
Where a block carries a selectorHint, adopt it unless it is plainly wrong.
For every unit-bearing spec also emit its metric or imperial counterpart with
origin "conversion", so the dual-unit rule is satisfiable.`;
