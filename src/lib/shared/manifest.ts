import { z } from "zod";
import { TOKEN_CATEGORIES } from "./tokens";

/**
 * Template manifests: data, not code.
 *
 * The manifest is exactly the CMS's editable fields — nothing more. A piece of text
 * that appears on a rendered lander but has no CMS field is platform chrome, and the
 * tool never writes it. That is why there is no disclaimer field and no `legal` link
 * policy anywhere in this schema.
 */

export const FIELD_TYPES = [
  "text",
  "textarea",
  "markdown",
  /** Repeated lines wrapping copy in fixed markup — the model never writes the markup. */
  "scaffolded",
  "number",
  /** NOT generated: a position marker so the review screen mirrors the CMS. */
  "display",
] as const;

export const VOICES = ["second_person", "brand_we", "reviewer", "expert"] as const;

/** How {{productName}} renders. It never permits a literal — a literal never is. */
export const PRODUCT_NAME_FORMATS = ["bold", "plain", "none"] as const;

/** The complete set of permitted links in a field. There is no global link rule. */
export const LINK_POLICIES = ["none", "product_name", "free_anchor"] as const;

/** How a non-generated CMS field is presented. See TemplateField.displayKind. */
export const DISPLAY_KINDS = ["toggle", "image", "relation"] as const;
export type DisplayKind = (typeof DISPLAY_KINDS)[number];

export const TemplateFieldSchema = z
  .object({
    /** SECTION-LOCAL, e.g. "page_title" — never "hero.page_title". */
    key: z.string().regex(/^[a-z0-9_]+$/, "field keys are snake_case and section-local"),
    label: z.string(),
    type: z.enum(FIELD_TYPES),
    generate: z.boolean(),
    /** May be absent on a given instance; skipped by every lint when absent. */
    optional: z.boolean().optional(),

    /** Fallbacks — used ONLY when the brief has no entry for this field. */
    fallbackWordTarget: z.tuple([z.number().int(), z.number().int()]).optional(),
    fallbackItemCount: z.number().int().positive().optional(),
    charLimit: z.number().int().positive().optional(),

    markdownBold: z.boolean(),
    productNameFormat: z.enum(PRODUCT_NAME_FORMATS),
    linkPolicy: z.enum(LINK_POLICIES),

    allowedTokens: z
      .object({
        categories: z.array(z.enum(TOKEN_CATEGORIES)).optional(),
        tokens: z.array(z.string()).optional(),
      })
      .optional(),

    /** Required when type === "scaffolded". Keyed by variant name. */
    lineTemplates: z.record(z.string(), z.string()).optional(),

    /**
     * What a `display` field actually looks like in the CMS.
     *
     * These are position markers so the review screen mirrors the CMS panel order, but
     * "marker" is not enough to render one: a toggle, an image slot and a relation
     * picker look nothing alike, and showing all three as an identical "not generated"
     * row is what made the screen unreadable. Declared rather than inferred from the
     * key, because guessing from a name is wrong the first time a field is called
     * something else.
     */
    displayKind: z.enum(DISPLAY_KINDS).optional(),

    /** Skip the spec check — relative timestamps ("11 hours ago") are not specs. */
    specPolicy: z.literal("exempt").optional(),

    /** Repetition INSIDE one rich-text field. Not the same thing as section `repeat`. */
    fallbackSubunits: z
      .object({
        count: z.tuple([z.number().int(), z.number().int()]),
        parts: z.record(z.string(), z.tuple([z.number().int(), z.number().int()])),
        join: z.string().default("\n\n"),
      })
      .optional(),

    voice: z.enum(VOICES),
    notes: z.string().optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === "scaffolded" && !field.lineTemplates) {
      ctx.addIssue({
        code: "custom",
        message: `${field.key}: scaffolded fields need lineTemplates`,
      });
    }
    if (field.type === "display" && field.generate) {
      ctx.addIssue({ code: "custom", message: `${field.key}: display fields are never generated` });
    }
    if (field.linkPolicy === "product_name" && field.productNameFormat === "none") {
      ctx.addIssue({
        code: "custom",
        message: `${field.key}: cannot link a product name the field must not contain`,
      });
    }
  });

export type TemplateField = z.infer<typeof TemplateFieldSchema>;

/**
 * Which class of model writes this section.
 *
 * A manifest says "this section is cheap to write"; settings say which model is
 * currently the cheap one. That indirection keeps manifests descriptions of the
 * content rather than of the vendor's model line-up.
 *
 * Tier is per SECTION because a model is chosen per API call and a call generates a
 * whole section. In practice that lines up: the CTA section is entirely short strings,
 * the Content section is a thousand words of prose.
 */
/**
 * The tier a section runs at. `fast` is a real lever but a sharp one, and it is off by
 * default on the advertorial template for a QUALITY reason with a cost caveat attached
 * — not, as first supposed, because it is straightforwardly cheaper to avoid.
 *
 * What the numbers actually said, on the same section across two runs:
 *
 *   Haiku 4.5   $0.0207 over three attempts — and FLAGGED. It returned assembled HTML
 *               for the scaffolded field every time and never produced a valid value.
 *   Sonnet 5    $0.0442 over two attempts — and clean.
 *
 * So the fast tier was about twice as cheap and worth nothing, which is the only
 * comparison that matters. Output tokens dominate a call's cost, and Haiku is both
 * cheaper per token and much terser; the cache effects below are real but second-order.
 *
 * The cache caveat, since it is easy to reason about backwards: the prompt cache is
 * keyed per model, so an interleaved fast section cannot read the standard model's
 * prefix. It pays a full cache write where a standard section pays a read — measured at
 * $0.0146 against $0.0030 for the same prefix, roughly 5x on that component alone — and
 * it then breaks the standard model's chain for the following call. Haiku also needs
 * 4,096 tokens before a breakpoint does anything, four times Sonnet's minimum, so the
 * system block silently fails to cache on it at all. It additionally rejects
 * `output_config.effort`, which is the largest cost lever in the pipeline.
 *
 * The lever remains available. It suits many consecutive short sections on a template
 * where the fast model can actually satisfy the field contract.
 */
export const SECTION_TIERS = ["standard", "fast"] as const;
export type SectionTier = (typeof SECTION_TIERS)[number];

export const TemplateSectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string(),
  /** Omitted means "standard" — see modelForTier. */
  tier: z.enum(SECTION_TIERS).optional(),
  /** The CMS renders this as a toggle in the section HEADER, not in the field stack. */
  presenceToggleLabel: z.string().optional(),
  /** Genuinely repeated CMS field groups — the ones with an "Add X" button. */
  repeat: z.tuple([z.number().int(), z.number().int()]).optional(),
  defaultPresent: z.boolean(),
  fields: z.array(TemplateFieldSchema).min(1),
});

export type TemplateSection = z.infer<typeof TemplateSectionSchema>;

export const TEMPLATE_SLUGS = [
  "advertorial_v1",
  "comparison_v1",
  "interstitial_v1",
  "reasons_v1",
] as const;

export const TemplateManifestSchema = z.object({
  slug: z.enum(TEMPLATE_SLUGS),
  name: z.string(),
  /** Section order follows the CMS's RENDERED PANEL order, not its nav order. */
  sections: z.array(TemplateSectionSchema).min(1),
  /** CSS selector -> "sectionId.fieldKey", for same-platform sources. Data, not code. */
  selectors: z.record(z.string(), z.string()).optional(),
});

export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;

/** Manifests are Zod-validated on read, so a bad DB edit fails loudly. */
export function parseManifest(input: unknown): TemplateManifest {
  return TemplateManifestSchema.parse(input);
}

export function findField(
  manifest: TemplateManifest,
  sectionId: string,
  fieldKey: string,
): TemplateField | undefined {
  return manifest.sections.find((s) => s.id === sectionId)?.fields.find((f) => f.key === fieldKey);
}

/** One convention everywhere: sectionId.fieldKey, or sectionId[i].fieldKey when repeating. */
export function fieldAddress(sectionId: string, fieldKey: string, instanceIndex?: number): string {
  return instanceIndex === undefined
    ? `${sectionId}.${fieldKey}`
    : `${sectionId}[${instanceIndex}].${fieldKey}`;
}
