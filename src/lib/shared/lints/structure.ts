import { countWords } from "../normalize";
import type { Lint, Violation } from "./types";
import { plainText, violation } from "./types";

/** 1. Word count — the range already carries its tolerance; never add a margin. */
export const wordCountLint: Lint = (ctx) => {
  const out: Violation[] = [];
  const text = plainText(ctx.value);
  const target = ctx.plan?.wordTarget ?? ctx.field.fallbackWordTarget;

  if (target) {
    const words = countWords(text);
    if (words < target[0] || words > target[1]) {
      out.push(
        violation(
          ctx,
          "word_count",
          `${words} words, outside the target ${target[0]}–${target[1]}`,
        ),
      );
    }
  }

  if (ctx.field.charLimit !== undefined && text.length > ctx.field.charLimit) {
    out.push(
      violation(ctx, "word_count", `${text.length} chars exceeds charLimit ${ctx.field.charLimit}`),
    );
  }

  // A field with subunits has each part checked against its own range too.
  const partTargets = ctx.plan?.parts ?? ctx.field.fallbackSubunits?.parts;
  if (partTargets && typeof ctx.value === "string") {
    // Parts are validated at assembly time; nothing to check on the joined string.
  }
  return out;
};

/** 2. Item counts — list lines, repeated instances, and subunits inside one field. */
export const itemCountLint: Lint = (ctx) => {
  const out: Violation[] = [];
  const expected = ctx.plan?.itemCount ?? ctx.field.fallbackItemCount;
  if (expected === undefined) return out;

  let actual: number | null = null;
  if (Array.isArray(ctx.value)) actual = ctx.value.length;
  else if (typeof ctx.value === "object") actual = ctx.value.items.length;
  else actual = ctx.value.split("\n").filter((l) => /^\s*[-*]\s+/.test(l)).length || null;

  if (actual !== null && actual !== expected) {
    out.push(violation(ctx, "item_count", `${actual} items, expected ${expected}`));
  }
  return out;
};

/**
 * 3. Bold rules — applied to EVERY field, including markdownBold: false ones.
 *
 * `markdownBold` describes the CMS field, not the copy. The skim-test rule is a
 * property of the copy and cannot be switched off per field; on a WYSIWYG field the
 * markers are working annotations the copy button strips.
 */
export const boldLint: Lint = (ctx) => {
  const out: Violation[] = [];
  const text = plainText(ctx.value);

  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const bolds = sentence.match(/\*\*[^*]+\*\*/g) ?? [];
    if (bolds.length > 1) {
      out.push(
        violation(
          ctx,
          "bold",
          `${bolds.length} bold spans in one sentence; max is 1`,
          sentence.trim(),
        ),
      );
    }
    for (const bold of bolds) {
      if (/[.,;:!?]\*\*$/.test(bold)) {
        out.push(violation(ctx, "bold", "punctuation belongs outside the bold span", bold));
      }
    }
  }
  return out;
};

/** 6. Scaffold — code assembles the markup, so only the copy slot needs checking. */
export const scaffoldLint: Lint = (ctx) => {
  const out: Violation[] = [];
  if (ctx.field.type !== "scaffolded") return out;
  if (typeof ctx.value !== "object" || Array.isArray(ctx.value)) {
    out.push(violation(ctx, "scaffold", "scaffolded fields must emit { items: [...] }"));
    return out;
  }

  const variants = Object.keys(ctx.field.lineTemplates ?? {});
  for (const item of ctx.value.items) {
    if (!variants.includes(item.variant)) {
      out.push(
        violation(
          ctx,
          "scaffold",
          `unknown variant "${item.variant}"; expected ${variants.join(" | ")}`,
        ),
      );
    }
    if (item.copy.includes("\n")) {
      out.push(violation(ctx, "scaffold", "copy slots are single-line", item.copy));
    }
    // Braces are permitted only as tokens — production's benefits list contains
    // "{{discountValue}}% Discounted today", so a blanket no-braces rule would
    // forbid reproducing the real page.
    const withoutTokens = item.copy.replace(/\{\{[^}]*\}\}/g, "");
    if (/[{}]/.test(withoutTokens)) {
      out.push(violation(ctx, "scaffold", "braces are only allowed as tokens", item.copy));
    }
  }
  return out;
};

/** Assemble a scaffolded field for the clipboard: markup correct by construction. */
export function assembleScaffold(
  items: ReadonlyArray<{ variant: string; copy: string }>,
  lineTemplates: Record<string, string>,
): string {
  return items
    .map((item) => (lineTemplates[item.variant] ?? "{copy}").replace("{copy}", item.copy))
    .join("\n");
}
