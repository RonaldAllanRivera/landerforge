import { z } from "zod";
import { blockWordCount, type SourceBlock } from "./blocks";
import type { TemplateManifest } from "./manifest";

/**
 * sectionPlan is a CODE-BUILT object, never a model output.
 *
 * Division of labour, fixed: the extractor emits blocks; code counts words; Step 1
 * emits a blockMap (pure judgment, no numbers); code builds this. Language models
 * cannot count reliably, and density is the one place where a slightly wrong number
 * quietly degrades every output.
 */

export const BlockMapEntrySchema = z.object({
  sectionId: z.string(),
  /** An identifier the model assigns, not a count it computes. */
  instanceIndex: z.number().int().nonnegative().optional(),
  fieldKey: z.string(),
  subunitIndex: z.number().int().nonnegative().optional(),
  /** e.g. heading | body | quote, for a rich-text field with internal rhythm. */
  part: z.string().optional(),
});

export const BriefBlockMapSchema = z.object({
  blockMap: z.record(z.string(), BlockMapEntrySchema),
  sections: z.array(
    z.object({ sectionId: z.string(), present: z.boolean(), formatNotes: z.string().default("") }),
  ),
});

export type BlockMap = z.infer<typeof BriefBlockMapSchema>;

export type WordTarget = readonly [number, number];

export interface FieldPlan {
  /** Range with tolerance already baked in. Do NOT apply a further margin. */
  wordTarget: WordTarget;
  itemCount?: number;
  subunitCount?: number;
  parts?: Record<string, WordTarget>;
}

export interface SectionPlanEntry {
  sectionId: string;
  present: boolean;
  instanceCount: number | null;
  formatNotes: string;
  fields: Record<string, FieldPlan>;
}

export type SectionPlan = SectionPlanEntry[];

const TOLERANCE = 0.1;

/** Bake the ±10% in here so brief and manifest fallbacks are the identical check. */
export function toWordTarget(sum: number): WordTarget {
  return [Math.max(1, Math.round(sum * (1 - TOLERANCE))), Math.round(sum * (1 + TOLERANCE))];
}

/**
 * Build the plan the validator consumes from the blocks plus the model's mapping.
 * Every number here is computed, never received.
 */
export function buildSectionPlan(
  blocks: readonly SourceBlock[],
  map: BlockMap,
  manifest: TemplateManifest,
): SectionPlan {
  interface Acc {
    words: number;
    listItems: number;
    subunits: Set<number>;
    parts: Map<string, number>;
  }
  const acc = new Map<string, Map<string, Acc>>();
  const instances = new Map<string, Set<number>>();

  for (const [rawIndex, entry] of Object.entries(map.blockMap)) {
    const block = blocks[Number(rawIndex)];
    if (!block) continue;

    if (entry.instanceIndex !== undefined) {
      const set = instances.get(entry.sectionId) ?? new Set<number>();
      set.add(entry.instanceIndex);
      instances.set(entry.sectionId, set);
    }

    const bySection = acc.get(entry.sectionId) ?? new Map<string, Acc>();
    const current: Acc = bySection.get(entry.fieldKey) ?? {
      words: 0,
      listItems: 0,
      subunits: new Set(),
      parts: new Map(),
    };

    current.words += blockWordCount(block);
    if (block.type === "list_item") current.listItems += 1;
    if (entry.subunitIndex !== undefined) current.subunits.add(entry.subunitIndex);
    if (entry.part) {
      current.parts.set(entry.part, (current.parts.get(entry.part) ?? 0) + blockWordCount(block));
    }

    bySection.set(entry.fieldKey, current);
    acc.set(entry.sectionId, bySection);
  }

  return manifest.sections.map((section) => {
    const declared = map.sections.find((s) => s.sectionId === section.id);
    const bySection = acc.get(section.id);
    const fields: Record<string, FieldPlan> = {};

    if (bySection) {
      for (const [fieldKey, a] of bySection) {
        const plan: FieldPlan = { wordTarget: toWordTarget(a.words) };
        if (a.listItems > 0) plan.itemCount = a.listItems;
        if (a.subunits.size > 0) plan.subunitCount = a.subunits.size;
        if (a.parts.size > 0) {
          const parts: Record<string, WordTarget> = {};
          // A part's target is its per-subunit average, not its total across the field.
          const divisor = Math.max(1, a.subunits.size);
          for (const [part, words] of a.parts) parts[part] = toWordTarget(words / divisor);
          plan.parts = parts;
        }
        fields[fieldKey] = plan;
      }
    }

    const seen = instances.get(section.id);
    const instanceCount = section.repeat
      ? clamp(seen?.size ?? section.repeat[0], section.repeat[0], section.repeat[1])
      : null;

    return {
      sectionId: section.id,
      present: declared?.present ?? section.defaultPresent,
      instanceCount,
      formatNotes: declared?.formatNotes ?? "",
      fields,
    };
  });
}

/** Precedence is absolute and per field: brief wins, manifest is the fallback. */
export function resolveWordTarget(
  plan: FieldPlan | undefined,
  fallback: WordTarget | undefined,
): WordTarget | null {
  if (plan?.wordTarget) return plan.wordTarget;
  return fallback ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
