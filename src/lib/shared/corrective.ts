import type { Violation } from "./lints";

/**
 * The corrective retry loop — generate, validate, quote the failures back, try again.
 *
 * Extracted so the worker and the tests run the SAME loop. A second copy written for
 * tests would prove only that the copy works, and the behaviour worth pinning here is
 * control flow: when to stop, when not to bother, and what the model is told.
 *
 * Validation is plain code inside the loop, never a thrown error. Throwing inside an
 * Inngest step makes the platform retry the call identically — without the corrective
 * feedback — fighting this loop rather than driving it.
 */

/**
 * A violation the model can act on.
 *
 * `internal` means one of our own checks threw. Quoting a bug in the validator back to
 * the model spends the whole retry budget re-buying the identical failure.
 */
export function isActionable(violation: Violation): boolean {
  return violation.category !== "internal";
}

/**
 * The text appended to the next attempt.
 *
 * Empty when there is nothing actionable, so the first attempt and an attempt following
 * only-internal failures send a byte-identical prompt — which keeps the cached prefix
 * intact and makes the two cases indistinguishable to the model, as they should be.
 */
export function buildCorrectiveFeedback(violations: readonly Violation[]): string {
  const actionable = violations.filter(isActionable);
  if (actionable.length === 0) return "";

  const lines = actionable.map(
    (v) => `- [${v.category}] ${v.address}: ${v.message}${v.excerpt ? ` — "${v.excerpt}"` : ""}`,
  );
  return `\n\nYour previous attempt had these violations. Fix every one:\n${lines.join("\n")}`;
}

export interface CorrectiveResult {
  output: Record<string, unknown>;
  violations: Violation[];
  /** How many model calls this section actually cost. */
  attempts: number;
}

/**
 * Run one section until it validates or the budget runs out.
 *
 * `attempt` receives the previous violations so the caller can build the prompt; it is
 * async because in production it is an API call inside a memoized step.
 */
export async function runCorrectiveLoop(args: {
  maxRetries: number;
  attempt: (
    violations: readonly Violation[],
    attemptIndex: number,
  ) => Promise<Record<string, unknown>>;
  validate: (output: Record<string, unknown>) => Violation[];
}): Promise<CorrectiveResult> {
  let violations: Violation[] = [];
  let output: Record<string, unknown> = {};
  let attempts = 0;

  for (let attemptIndex = 0; attemptIndex <= args.maxRetries; attemptIndex++) {
    attempts++;
    output = await args.attempt(violations, attemptIndex);
    violations = args.validate(output);
    // Stop on "nothing the model can fix", not on "nothing wrong".
    if (!violations.some(isActionable)) break;
  }

  return { output, violations, attempts };
}

/** A section is clean when nothing actionable remains. */
export function sectionStatus(violations: readonly Violation[]): "done" | "flagged" {
  return violations.length === 0 ? "done" : "flagged";
}
