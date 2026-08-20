import type Anthropic from "@anthropic-ai/sdk";
import { NonRetriableError } from "inngest";
import {
  anthropic,
  cacheHit,
  cacheInert,
  costUsd,
  DEFAULT_MODEL,
  MIN_CACHEABLE_TOKENS,
} from "@/lib/anthropic/client";
import { COPY_RULES } from "@/lib/core/rules";
import { effortFor, loadSettings, modelForTier, type Settings } from "@/lib/core/settings";
import { scrape } from "@/lib/scrape/browserless";
import { extractBlocks } from "@/lib/scrape/extract";
import { type SourceBlock, SourceBlockSchema } from "@/lib/shared/blocks";
import type { Violation } from "@/lib/shared/lints";
import { parseManifest, type TemplateManifest } from "@/lib/shared/manifest";
import { outputContract } from "@/lib/shared/output-contract";
import { buildMessages, buildSystem, stableStringify } from "@/lib/shared/prompt";
import { buildSectionPlan, type SectionPlan } from "@/lib/shared/section-plan";
import { unverifiedSourceSpecs } from "@/lib/shared/spec-guard";
import { validateSection } from "@/lib/shared/validate-section";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest, SHARED_CONCURRENCY } from "../client";

const MAX_CORRECTIVE_RETRIES = 2;

/**
 * A ceiling, not a reservation: only tokens actually emitted are billed, so headroom is
 * free and truncation is not. It has to cover thinking and response text together, and
 * Claude 4.7 and later emit roughly 30% more tokens for the same prose, which alone
 * would have pushed the previous 8k budget into `stop_reason: "max_tokens"` on the
 * longest sections.
 */
const MAX_OUTPUT_TOKENS = 16_000;

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
    /**
     * Inngest delivers at-least-once and the wizard is double-submittable, so a run is
     * keyed and deduplicated. The window is 24 HOURS, which is why the key includes the
     * attempt number: without it a deliberate retry inside that window is silently
     * swallowed and the button does nothing. Both triggers always carry `attempt`.
     */
    idempotency: 'event.data.generationId + "-" + string(event.data.attempt)',
    concurrency: SHARED_CONCURRENCY,
    onFailure: async ({ error }) => {
      console.error("[generate] run failed after retries", error);
    },
  },
  /**
   * One function, two triggers. A separate retry function would be a second copy of
   * the pipeline, and the copy is what would rot.
   */
  [{ event: "generation.requested" }, { event: "generation.retry.requested" }],
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
        return {
          ...row,
          status: outcome.status,
          blocks: null,
          raw_text: null,
          scrapeReason: outcome.reason,
          via: null,
        };
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
      return {
        ...row,
        status: "ok",
        blocks: extracted.blocks,
        raw_text: extracted.rawText,
        scrapeReason: null,
        via: outcome.via,
      };
    });

    const blocks: SourceBlock[] =
      source?.status === "ok" && Array.isArray(source?.blocks)
        ? SourceBlockSchema.array().parse(source.blocks)
        : [];
    const rawText = typeof source?.raw_text === "string" ? source.raw_text : "";

    /**
     * Record how the source arrived, or why it did not. Which rung of the ladder
     * answered is the difference between "this cost nothing" and "this went through a
     * paid browser", and a blocked scrape without its reason leaves the operator
     * guessing between a bot wall, a dead URL and a missing token.
     */
    if (source?.status !== "ok") {
      await step.run("note-no-source", async () => {
        await appendRunNote(db, generationId, {
          kind: source ? "source_blocked" : "no_source",
          ...(source && "scrapeReason" in source && source.scrapeReason
            ? { reason: source.scrapeReason }
            : {}),
        });
      });
    } else if ("via" in source && source.via && source.via !== "fetch") {
      await step.run("note-scrape-via", async () => {
        await appendRunNote(db, generationId, { kind: "scraped_via_browser", via: source.via });
      });
    }

    // ── Step 1: brief ───────────────────────────────────────────────────────
    await setStatus(step, db, generationId, "briefing");

    const brief = await step.run("brief", async () => {
      if (claimed.brief) return claimed.brief as BriefPayload;
      calls++;
      // Not named `brief`: that is the outer step's own binding, and shadowing it here
      // reads as a self-reference.
      const briefCall = await callBrief(manifest, blocks, claimed.special_notes ?? "", settings);
      const result = briefCall.result;

      /**
       * Logged like any other call. It was not, and it is the most expensive one in the
       * run: it carries the whole source material and writes the cache every later call
       * reads. Its absence meant `total_cost_usd` and every figure on /costs understated
       * a run by the largest single line item, and the cache-hit denominator treated the
       * first SECTION as the run's first call — hiding a real read behind an exclusion
       * meant for the write.
       */
      await logStep(db, generationId, "brief", 0, briefCall.usage, briefCall.model);

      /**
       * The guard runs BEFORE the write, so the brief that gets persisted has already
       * passed it. Post-write, a failure would leave `brief` populated and the resume
       * rule would send a retry straight into Step 2 on a brief that never passed —
       * silently disabling anti-fabrication.
       *
       * Unverified specs are DROPPED rather than used to kill the run. The safety
       * property is that a fabricated number never reaches the copy, and dropping
       * achieves it exactly: the spec lint rejects any number not in allowedSpecs, so
       * the model cannot use what was removed, and the section is flagged if it tries.
       *
       * Refusing the whole run achieved nothing more and cost a great deal. Measured on
       * a real page: the model invented a lower bound for a focus range the page states
       * only in words, the run died at the brief twice, and each attempt was billed. A
       * retry re-runs the same call and invents it again, so the URL was simply
       * unusable — a hard stop with no way past it.
       */
      const unverified = unverifiedSourceSpecs(result.allowedSpecs, rawText);
      const allowedSpecs = result.allowedSpecs.filter(
        (spec) => !(spec.origin === "source" && unverified.includes(spec.label)),
      );
      if (unverified.length > 0) {
        await appendRunNote(db, generationId, {
          kind: "specs_dropped",
          reason: "attributed to the source but not found in it",
          specs: unverified,
        });
      }

      const payload: BriefPayload = {
        ...result,
        allowedSpecs,
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
        violations = validateSection(
          { manifest, allowedSpecs: brief.allowedSpecs, sectionPlan: brief.sectionPlan, blocks },
          section.id,
          output,
        );
        /**
         * Stop on "nothing the model can fix", not on "nothing wrong". An internal
         * violation means one of our own checks threw; quoting it back would spend the
         * whole retry budget re-buying the identical failure.
         */
        if (!violations.some(isActionable)) break;
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

/** A violation the model can actually act on. See the "internal" lint category. */
function isActionable(v: Violation): boolean {
  return v.category !== "internal";
}

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
    max_tokens: MAX_OUTPUT_TOKENS,
    output_config: effortFor(settings, settings.standard_model),
    system: buildSystem(`${COPY_RULES}\n\nManifest:\n${stableStringify(manifest)}`),
    messages: buildMessages({
      systemPrompt: "",
      brief: { notes },
      priorSections: [],
      sourceBlocks: blocks,
      sectionInstructions: BRIEF_INSTRUCTIONS,
    }),
  });
  return {
    result: parseJsonResponse<Omit<BriefPayload, "sectionPlan">>(response),
    usage: response.usage,
    model: settings.standard_model,
  };
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
   * The manifest names a tier; settings name the model. The advertorial template
   * declares no fast sections — measured, the fast model produced an invalid value for
   * its scaffolded field on all three attempts while costing half as much, which is not
   * a saving. See SECTION_TIERS for the cache-isolation caveat that goes with it.
   */
  const model = modelForTier(args.settings, args.section.tier);
  const actionable = args.violations.filter(isActionable);
  const corrective =
    actionable.length > 0
      ? `\n\nYour previous attempt had these violations. Fix every one:\n${actionable
          .map(
            (v) =>
              `- [${v.category}] ${v.address}: ${v.message}${v.excerpt ? ` — "${v.excerpt}"` : ""}`,
          )
          .join("\n")}`
      : "";

  const response = await anthropic.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    /**
     * Explicit, never inherited. The default is not stable — the same section call was
     * measured at 2,414 output tokens on one attempt and 14,820 on the next — and
     * output tokens were 88% of a full run's cost. `high` is the failure case worth
     * knowing: it spent an entire 16,000-token budget reasoning and returned `{}`.
     */
    output_config: effortFor(args.settings, model),
    system: buildSystem(`${COPY_RULES}\n\nManifest:\n${stableStringify(args.manifest)}`),
    messages: buildMessages({
      systemPrompt: "",
      brief: args.brief,
      priorSections: args.priorSections,
      sourceBlocks: args.blocks,
      sectionInstructions:
        `Write section "${args.section.id}".\n` +
        (plan?.formatNotes ? `Format notes: ${plan.formatNotes}\n` : "") +
        `\n${outputContract(args.section, plan)}` +
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
  /**
   * Two different failures wearing the same face, separated because the fixes are
   * opposite. An ordinary miss still WRITES, and means something per-call crept into
   * the prefix. An inert call neither writes nor reads, and means the prefix never
   * reached the model's minimum — the breakpoint was ignored outright, with no error
   * and no usage fields to notice it by.
   */
  if (attempt === 0 && step !== "brief" && !cacheHit(usage)) {
    if (cacheInert(usage)) {
      const min = MIN_CACHEABLE_TOKENS[model];
      console.warn(
        `[cache] INERT on ${step} (${model}) — nothing written or read. The prefix is ` +
          `under this model's ${min ?? "?"}-token minimum, so cache_control did nothing.`,
      );
    } else {
      console.warn(`[cache] miss on ${step} — check the prefix for a per-call value`);
    }
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
