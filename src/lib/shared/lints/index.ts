import { z } from "zod";
import { linkLint } from "./links";
import { complianceLint, specLint } from "./specs";
import { boldLint, itemCountLint, scaffoldLint, wordCountLint } from "./structure";
import { tokenLint } from "./tokens";
import type { Lint, LintContext, Violation } from "./types";
import { violation } from "./types";
import { verbatimLint } from "./verbatim";

/** The nine categories, in the order the plan numbers them. */
export const LINTS: ReadonlyArray<Lint> = [
  wordCountLint,
  itemCountLint,
  boldLint,
  tokenLint,
  linkLint,
  scaffoldLint,
  complianceLint,
  specLint,
  verbatimLint,
];

/**
 * The shape a scaffolded field must arrive in. This is a RUNTIME check, not a type
 * assertion: LintContext.value is typed as FieldValue, but the value behind it is
 * JSON.parse of model output, so the declared type is a promise the caller cannot keep.
 */
const ScaffoldValueSchema = z.object({
  items: z.array(z.object({ variant: z.string(), copy: z.string() })),
});

/**
 * Run every lint over one field.
 *
 * Never throws — and now actually enforces that rather than asserting it. A real run
 * proved the difference: the model returned scaffold items without a `copy` key, the
 * scaffold lint dereferenced it, and the TypeError escaped `validateSection`, which
 * runs OUTSIDE `step.run`. Inngest saw a 500, retried, replayed the memoized steps,
 * and threw again — a generation wedged in `generating` forever, on a page of copy
 * that had already been paid for.
 *
 * Two layers, because they fail differently. The shape gate turns bad model output
 * into feedback the model can act on. The try/catch turns a bug in OUR code into a
 * flagged section instead of an unrecoverable run.
 */
export function lintField(ctx: LintContext): Violation[] {
  if (!ctx.field.generate) return [];
  if (ctx.field.optional && isAbsent(ctx.value)) return [];

  // A value of the wrong shape makes every downstream lint meaningless, so report the
  // shape and stop rather than emitting nine derived complaints about one cause.
  const malformed = checkShape(ctx);
  if (malformed) return [malformed];

  return runLints(ctx);
}

/**
 * The enforcement point for "never throws", separated so it can be tested with a lint
 * that deliberately fails. Closing over the module-level LINTS array would leave the
 * guarantee itself unverifiable — which is how the original crash shipped.
 */
export function runLints(ctx: LintContext, lints: ReadonlyArray<Lint> = LINTS): Violation[] {
  return lints.flatMap((lint) => {
    try {
      return lint(ctx);
    } catch (error) {
      // Loud, because this is a defect and the flagged section is only a fallback.
      console.error(`[lint] ${lint.name || "anonymous"} threw on ${ctx.address}`, error);
      return [
        violation(
          ctx,
          "internal",
          `the ${lint.name || "anonymous"} check failed to run; ` +
            "this field was not fully validated",
        ),
      ];
    }
  });
}

/** Null when the value matches what the field type requires. */
function checkShape(ctx: LintContext): Violation | null {
  if (ctx.field.type === "scaffolded") {
    const parsed = ScaffoldValueSchema.safeParse(ctx.value);
    if (parsed.success) return null;
    const variants = Object.keys(ctx.field.lineTemplates ?? {});
    return violation(
      ctx,
      "scaffold",
      `scaffolded fields must emit {"items":[{"variant":"…","copy":"…"}]} — ` +
        `every item needs both keys, and variant must be one of ${variants.join(" | ")}`,
      preview(ctx.value),
    );
  }

  // Everything else is prose: a string, or a list of them.
  const isProse =
    typeof ctx.value === "string" ||
    (Array.isArray(ctx.value) && ctx.value.every((v) => typeof v === "string"));
  if (isProse) return null;

  return violation(
    ctx,
    "scaffold",
    `${ctx.field.type} fields must emit a string, not ${describe(ctx.value)}`,
    preview(ctx.value),
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array of non-strings";
  return typeof value;
}

/** Enough of the offending value to recognise it, without pasting a whole section back. */
function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? String(value)).slice(0, 200);
}

function isAbsent(value: LintContext["value"]): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  /**
   * A scaffolded value whose item list is explicitly empty. A value that merely fails
   * to look scaffolded is NOT absent — it is malformed, and treating the two alike
   * would let a wrong shape in an optional field skip validation entirely instead of
   * reaching the shape gate.
   */
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) && items.length === 0;
}

export { assembleScaffold } from "./structure";
export * from "./types";
