import type { TemplateField, TemplateSection } from "./manifest";
import { fieldRepeats } from "./section-io";
import { resolveWordTarget, type SectionPlanEntry } from "./section-plan";

/**
 * The exact shape a section must return, spelled out.
 *
 * Three of five sections failed their whole retry budget on a first real run, and every
 * one was an ambiguity rather than a copy fault:
 *
 *   - a scaffolded field came back as assembled HTML, because the manifest shows the
 *     markup in `lineTemplates` and nothing said code applies it;
 *   - a repeating section came back at three times its word target, because
 *     `wordTarget` is a TOTAL across instances and the model read it per instance —
 *     the plan states both numbers and never says how they relate;
 *   - the instruction was literally "Return a JSON object keyed by field key".
 *
 * None of that is the model guessing badly. It is a contract that was never written
 * down. This writes it down.
 *
 * It goes in the per-section instructions, which sit AFTER the last cache breakpoint,
 * so being verbose here costs nothing in cache terms.
 */

export function outputContract(
  section: TemplateSection,
  plan: SectionPlanEntry | undefined,
): string {
  const fields = section.fields.filter((f) => f.generate);
  if (fields.length === 0) return "";

  const instances = section.repeat ? (plan?.instanceCount ?? section.repeat[0]) : null;
  // A field that occurs once inside a repeating section is a plain value, not an array.
  const spread = (f: TemplateField) => (fieldRepeats(section, f) ? instances : null);
  const shape = fields.map((f) => `  ${JSON.stringify(f.key)}: ${shapeFor(f, spread(f))}`);
  const rules = fields.map((f) => `- ${ruleFor(f, plan, spread(f))}`);

  const preamble =
    instances === null
      ? "Return exactly this JSON object, with no other keys and no text around it:"
      : `This section repeats ${instances} times. Return exactly this JSON object, with ` +
        "no other keys and no text around it. Fields shown as an array have one entry " +
        "per instance, in display order; fields shown as a single value occur once for " +
        "the whole section:";

  return `${preamble}\n{\n${shape.join(",\n")}\n}\n\nField rules:\n${rules.join("\n")}`;
}

function shapeFor(field: TemplateField, instances: number | null): string {
  if (field.type === "scaffolded") {
    const variants = Object.keys(field.lineTemplates ?? {})
      .map((v) => JSON.stringify(v))
      .join(" | ");
    const one = `{ "items": [ { "variant": ${variants || '"…"'}, "copy": "<one line>" } ] }`;
    return instances === null ? one : `[ ${one}, … ]`;
  }
  if (field.type === "list") {
    // Already an array in its own right. No CMS field here nests one inside a
    // repeating section, so the instance spread does not apply to it.
    const one = '[ "<one line>", … ]';
    return instances === null ? one : `[ ${one} x${instances} ]`;
  }
  const one = `"<${field.type}>"`;
  // The count goes inside the array rather than in a trailing comment: a comment
  // followed by the object's comma made the illustration look like invalid JSON.
  return instances === null ? one : `[ ${one} x${instances} ]`;
}

function ruleFor(
  field: TemplateField,
  plan: SectionPlanEntry | undefined,
  instances: number | null,
): string {
  const parts: string[] = [];
  const fieldPlan = plan?.fields[field.key];
  const target = resolveWordTarget(fieldPlan, field.fallbackWordTarget);

  if (target) {
    const [min, max] = target;
    /**
     * The disambiguation that cost a section its whole retry budget. The target is a
     * sum over every instance, so it is stated as a total AND divided out, because a
     * writer works per item and will otherwise apply the total to each one.
     */
    const spread = instances && instances > 1 ? instances : 1;
    const single = min === max ? `exactly ${min} words` : `${min}–${max} words`;
    const per = Math.round((min + max) / 2 / spread);
    parts.push(
      spread > 1
        ? `${min}–${max} words in TOTAL across all ${spread} entries ` +
            `(about ${per} ${per === 1 ? "word" : "words"} each)`
        : single,
    );
  }

  const itemCount = fieldPlan?.itemCount ?? field.fallbackItemCount;
  if (itemCount) parts.push(`${itemCount} items`);

  // Repetition INSIDE one rich-text field — distinct from section-level repeat.
  if (fieldPlan?.subunitCount) parts.push(`${fieldPlan.subunitCount} sub-blocks`);
  if (fieldPlan?.parts) {
    const shape = Object.entries(fieldPlan.parts)
      .map(([name, [lo, hi]]) => `${name} ${lo}–${hi} words`)
      .join(", ");
    parts.push(`each sub-block is ${shape}`);
  }

  if (field.type === "scaffolded") {
    parts.push(
      "write ONLY the copy text — the surrounding markup is added by code, so any " +
        "HTML tag in your output is a defect",
    );
  }
  if (field.type === "list") {
    parts.push("a JSON array of short single-line strings, with no bullet characters");
  }
  if (field.charLimit) parts.push(`at most ${field.charLimit} characters`);

  return `${field.key}: ${parts.length > 0 ? parts.join("; ") : "no length constraint"}.`;
}
