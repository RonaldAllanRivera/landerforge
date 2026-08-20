import type { TemplateField, TemplateSection } from "./manifest";
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
  const shape = fields.map((f) => `  ${JSON.stringify(f.key)}: ${shapeFor(f, instances)}`);
  const rules = fields.map((f) => `- ${ruleFor(f, plan, instances)}`);

  const preamble =
    instances === null
      ? "Return exactly this JSON object, with no other keys and no text around it:"
      : `This section repeats ${instances} times. Return exactly this JSON object, with ` +
        `no other keys and no text around it — every field is an array of ${instances}, ` +
        "one per instance, in display order:";

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
    parts.push(
      spread > 1
        ? `${min}–${max} words in TOTAL across all ${spread} entries ` +
            `(about ${Math.round((min + max) / 2 / spread)} words each)`
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
  if (field.charLimit) parts.push(`at most ${field.charLimit} characters`);

  return `${field.key}: ${parts.length > 0 ? parts.join("; ") : "no length constraint"}.`;
}
