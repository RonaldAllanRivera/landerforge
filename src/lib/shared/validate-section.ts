import type { SourceBlock } from "./blocks";
import { type FieldValue, lintField, type Violation } from "./lints";
import type { TemplateManifest } from "./manifest";
import type { SectionPlan } from "./section-plan";

/**
 * Run every lint over one section's output.
 *
 * Shared between the worker and the review screen deliberately. A hand-edited section
 * has to be judged by exactly the same rules as a generated one — a second copy of
 * this logic would drift, and the first symptom would be a section that clears its
 * violations on save and fails again on the next run without anything having changed.
 */
export interface ValidationContext {
  manifest: TemplateManifest;
  allowedSpecs: Array<{
    label: string;
    value: number;
    unit: string | null;
    origin: "source" | "user_notes" | "conversion";
  }>;
  sectionPlan: SectionPlan;
  blocks: readonly SourceBlock[];
  productNameAliases?: readonly string[];
}

export function validateSection(
  ctx: ValidationContext,
  sectionId: string,
  output: Record<string, unknown>,
): Violation[] {
  const section = ctx.manifest.sections.find((s) => s.id === sectionId);
  if (!section) return [];
  const plan = ctx.sectionPlan.find((s) => s.sectionId === sectionId);

  return section.fields.flatMap((field) => {
    const value = output[field.key];
    if (value === undefined) return [];
    return lintField({
      manifest: ctx.manifest,
      field,
      address: `${sectionId}.${field.key}`,
      // Cast, because this is JSON.parse output or a form submission. lintField gates
      // the shape at runtime before any check reads it, which is what makes the cast
      // safe rather than hopeful.
      value: value as FieldValue,
      plan: plan?.fields[field.key],
      blocks: ctx.blocks,
      allowedSpecs: ctx.allowedSpecs,
      productNameAliases: ctx.productNameAliases ?? [],
    });
  });
}
