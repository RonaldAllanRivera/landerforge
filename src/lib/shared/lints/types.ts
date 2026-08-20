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
  /**
   * Not a copy rule: a lint itself threw. Kept in-band so the section is flagged for a
   * human rather than lost, but excluded from corrective feedback — the model cannot
   * fix a bug in our validator, and quoting one back only burns the retry budget.
   */
  "internal",
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

/** string[][] is a `list` field inside a repeating section: entries per instance. */
export type FieldValue = string | ScaffoldValue | string[] | string[][];

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

/**
 * The literal text a lint reads. Scaffolded fields expose only their copy slots.
 *
 * Flattens one level, because a `list` field inside a REPEATING section arrives as
 * string[][] — one array of entries per instance. Left nested, Array#join stringifies
 * the inner arrays with commas and the word count silently counts the separators as
 * part of a word.
 */
export function plainText(value: FieldValue): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => (Array.isArray(entry) ? entry.join("\n") : entry)).join("\n");
  }
  return value.items.map((i) => i.copy).join("\n");
}
