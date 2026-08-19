import { linkLint } from "./links";
import { complianceLint, specLint } from "./specs";
import { boldLint, itemCountLint, scaffoldLint, wordCountLint } from "./structure";
import { tokenLint } from "./tokens";
import type { Lint, LintContext, Violation } from "./types";
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
 * Run every lint over one field.
 *
 * Never throws: a validation failure is data, not an exception. Throwing inside an
 * Inngest step would make the platform retry the call identically, without the
 * corrective feedback, fighting the app-level retry loop.
 */
export function lintField(ctx: LintContext): Violation[] {
  if (!ctx.field.generate) return [];
  if (ctx.field.optional && isAbsent(ctx.value)) return [];
  return LINTS.flatMap((lint) => lint(ctx));
}

function isAbsent(value: LintContext["value"]): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return value.items.length === 0;
}

export { assembleScaffold } from "./structure";
export * from "./types";
