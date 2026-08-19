import type { SourceBlock } from "@/lib/shared/blocks";
import type { AllowedSpec, FieldValue, LintContext } from "@/lib/shared/lints";
import type { TemplateField, TemplateManifest } from "@/lib/shared/manifest";
import { normalise } from "@/lib/shared/normalize";

export function field(overrides: Partial<TemplateField> = {}): TemplateField {
  return {
    key: "body",
    label: "Body",
    type: "markdown",
    generate: true,
    markdownBold: true,
    productNameFormat: "plain",
    linkPolicy: "none",
    voice: "second_person",
    ...overrides,
  } as TemplateField;
}

export function manifest(): TemplateManifest {
  return {
    slug: "advertorial_v1",
    name: "Advertorial V1",
    sections: [{ id: "content", label: "Content", defaultPresent: true, fields: [field()] }],
  };
}

export function ctx(value: FieldValue, overrides: Partial<LintContext> = {}): LintContext {
  const rawText = overrides.rawTextNormalised;
  return {
    manifest: manifest(),
    field: field(),
    address: "content.body",
    value,
    allowedSpecs: [],
    productNameAliases: [],
    ...overrides,
    rawTextNormalised: rawText === undefined ? undefined : normalise(rawText),
  };
}

export function spec(
  value: number,
  unit: string | null,
  origin: AllowedSpec["origin"] = "source",
): AllowedSpec {
  return { label: "spec", value, unit, origin };
}

export function block(text: string, type: SourceBlock["type"] = "paragraph"): SourceBlock {
  return { type, text };
}
