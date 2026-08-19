import type { SourceBlock } from "../blocks";
import type { TemplateField, TemplateManifest } from "../manifest";
import type { FieldPlan } from "../section-plan";

export const LINT_CATEGORIES = [
  "word_count",
  "item_count",
  "bold",
  "token",
  "link",
  "scaffold",
  "compliance",
  "spec",
  "verbatim",
] as const;

export type LintCategory = (typeof LINT_CATEGORIES)[number];

export interface Violation {
  category: LintCategory;
  /** sectionId.fieldKey, or sectionId[i].fieldKey inside a repeating section. */
  address: string;
  message: string;
  /** The offending text, so the corrective retry can quote it back. */
  excerpt?: string;
}

/** A scaffolded field's value: the model writes copy, code assembles the markup. */
export interface ScaffoldValue {
  items: Array<{ variant: string; copy: string }>;
}

export type FieldValue = string | ScaffoldValue | string[];

export interface LintContext {
  manifest: TemplateManifest;
  field: TemplateField;
  address: string;
  value: FieldValue;
  plan?: FieldPlan;
  /** Normalised ground truth. Absent on the notes-only path. */
  rawTextNormalised?: string;
  blocks?: readonly SourceBlock[];
  allowedSpecs: AllowedSpec[];
  /** product_name plus every alias — one real page uses two spellings of its own name. */
  productNameAliases: readonly string[];
}

export interface AllowedSpec {
  label: string;
  value: number;
  unit: string | null;
  origin: "source" | "user_notes" | "conversion";
}

export type Lint = (ctx: LintContext) => Violation[];

export function violation(
  ctx: LintContext,
  category: LintCategory,
  message: string,
  excerpt?: string,
): Violation {
  return excerpt === undefined
    ? { category, address: ctx.address, message }
    : { category, address: ctx.address, message, excerpt };
}

/** The literal text a lint reads. Scaffolded fields expose only their copy slots. */
export function plainText(value: FieldValue): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join("\n");
  return value.items.map((i) => i.copy).join("\n");
}
