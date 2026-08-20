import { assembleScaffold } from "./lints";
import type { TemplateField, TemplateSection } from "./manifest";

/**
 * Reading and editing one section's stored output.
 *
 * A repeating section stores PARALLEL ARRAYS — `{reviewer_name: [...], review_text:
 * [...]}` — one entry per instance, rather than an array of objects. That shape comes
 * from the model returning a JSON object keyed by field key, and it means adding or
 * removing a review has to touch every generated field at once or the arrays fall out
 * of step and instance 2's name pairs with instance 3's text.
 *
 * Every function here is pure and total: the input is model output, so "the shape is
 * wrong" is an ordinary case, not an exception.
 */

export type SectionOutput = Record<string, unknown>;

export function isRepeating(section: TemplateSection): boolean {
  return Array.isArray(section.repeat);
}

export function generatedFields(section: TemplateSection): TemplateField[] {
  return section.fields.filter((f) => f.generate);
}

/**
 * Does THIS field vary per instance?
 *
 * A repeating section can hold a field that occurs once — a heading above the cards —
 * and treating it as an array would repeat it per card and make add/remove edit it.
 */
export function fieldRepeats(section: TemplateSection, field: TemplateField): boolean {
  return isRepeating(section) && field.repeats !== false;
}

/** The generated fields that actually vary per instance. */
export function repeatingFields(section: TemplateSection): TemplateField[] {
  return generatedFields(section).filter((f) => fieldRepeats(section, f));
}

function fieldByKey(section: TemplateSection, key: string): TemplateField | undefined {
  return section.fields.find((f) => f.key === key);
}

/**
 * How many instances the stored output actually holds.
 *
 * The longest array across the generated fields, not the shortest: a field the model
 * skipped should show as an empty box to fill in, not silently drop the instance.
 */
export function instanceCount(section: TemplateSection, output: SectionOutput | null): number {
  if (!isRepeating(section)) return 1;
  let longest = 0;
  for (const field of repeatingFields(section)) {
    const value = output?.[field.key];
    if (Array.isArray(value)) longest = Math.max(longest, value.length);
  }
  // Never fewer than the manifest's minimum: an empty section still needs its boxes.
  return Math.max(longest, section.repeat?.[0] ?? 1);
}

/** The value of one field, for one instance of a repeating section. */
export function readField(
  section: TemplateSection,
  output: SectionOutput | null,
  fieldKey: string,
  instance: number,
): unknown {
  const value = output?.[fieldKey];
  const field = fieldByKey(section, fieldKey);
  if (!field || !fieldRepeats(section, field)) return value;
  return Array.isArray(value) ? value[instance] : instance === 0 ? value : undefined;
}

/** A copy of `output` with one field updated. Never mutates the input. */
export function writeField(
  section: TemplateSection,
  output: SectionOutput | null,
  fieldKey: string,
  instance: number,
  value: unknown,
): SectionOutput {
  const next: SectionOutput = { ...(output ?? {}) };
  const field = fieldByKey(section, fieldKey);
  if (!field || !fieldRepeats(section, field)) {
    next[fieldKey] = value;
    return next;
  }
  const current = next[fieldKey];
  const list = Array.isArray(current) ? [...current] : [];
  // Pad rather than leave holes: a sparse array serialises to nulls that read as
  // "the model produced nothing here" when in fact nobody has typed there yet.
  while (list.length < instance) list.push("");
  list[instance] = value;
  next[fieldKey] = list;
  return next;
}

export function canAddInstance(section: TemplateSection, count: number): boolean {
  return isRepeating(section) && count < (section.repeat?.[1] ?? count);
}

export function canRemoveInstance(section: TemplateSection, count: number): boolean {
  return isRepeating(section) && count > (section.repeat?.[0] ?? 1);
}

/** Append an empty instance across every generated field, keeping the arrays in step. */
export function addInstance(section: TemplateSection, output: SectionOutput | null): SectionOutput {
  const count = instanceCount(section, output);
  const next: SectionOutput = { ...(output ?? {}) };
  // Only the fields that vary: a once-per-section heading must not gain an entry.
  for (const field of repeatingFields(section)) {
    const current = next[field.key];
    const list = Array.isArray(current) ? [...current] : [];
    while (list.length < count) list.push("");
    list.push("");
    next[field.key] = list;
  }
  return next;
}

/** Drop one instance from every generated field at once. */
export function removeInstance(
  section: TemplateSection,
  output: SectionOutput | null,
  instance: number,
): SectionOutput {
  const count = instanceCount(section, output);
  const next: SectionOutput = { ...(output ?? {}) };
  for (const field of repeatingFields(section)) {
    const current = next[field.key];
    const list = Array.isArray(current) ? [...current] : [];
    while (list.length < count) list.push("");
    list.splice(instance, 1);
    next[field.key] = list;
  }
  return next;
}

/**
 * The text an operator sees and copies.
 *
 * Scaffolded fields are stored as copy slots and assembled here, because code owns the
 * markup — which is also why the CMS shows the assembled markdown in a plain textarea.
 */
export function renderFieldValue(field: TemplateField, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  /**
   * A list is edited as one line per entry, which is how it reads and how it pastes.
   * The CMS draws a separate input per entry, but a textarea of lines is the same
   * information and far less to operate for copy that arrives all at once.
   */
  if (field.type === "list" && Array.isArray(value)) {
    return value.filter((v) => typeof v === "string").join("\n");
  }
  if (field.type === "scaffolded" && typeof value === "object" && "items" in value) {
    const items = (value as { items?: unknown }).items;
    if (Array.isArray(items)) {
      const usable = items.filter(
        (i): i is { variant: string; copy: string } =>
          typeof i === "object" && i !== null && typeof (i as { copy?: unknown }).copy === "string",
      );
      return assembleScaffold(usable, field.lineTemplates ?? {});
    }
  }
  return JSON.stringify(value, null, 2);
}

/**
 * Parse an edited scaffolded field back into copy slots.
 *
 * The operator edits the assembled markdown, because that is what the CMS shows. Each
 * line is matched against the variant templates to recover which variant it was and
 * what the copy slot held; a line matching nothing keeps the first variant, since
 * losing the operator's text would be worse than guessing its style.
 */
export function parseScaffold(
  field: TemplateField,
  text: string,
): { items: Array<{ variant: string; copy: string }> } {
  const templates = Object.entries(field.lineTemplates ?? {});
  const fallbackVariant = templates[0]?.[0] ?? "default";

  const items = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      for (const [variant, template] of templates) {
        const parts = template.split("{copy}");
        const before = parts[0] ?? "";
        const after = parts[1] ?? "";
        if (line.startsWith(before) && line.endsWith(after)) {
          const copy = line.slice(before.length, after.length ? -after.length : undefined);
          return { variant, copy: copy.trim() };
        }
      }
      return { variant: fallbackVariant, copy: line };
    });

  return { items };
}

/** Split an edited list field back into entries. Blank lines are not entries. */
export function parseList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
