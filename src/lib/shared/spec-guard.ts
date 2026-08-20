import { extractNumbers, normalise } from "./normalize";

/**
 * Anti-fabrication: a spec the brief attributes to the source must actually be there.
 *
 * The check used to be `rawText.includes(String(value))`, a plain substring match, and
 * it was wrong in a way that killed working runs. A page writes "1,500 customers"; the
 * brief correctly records 1500; the substring "1500" does not appear; the run is
 * refused for fabricating a number it read properly. Real landers are full of thousands
 * separators — the page that exposed this had both "1,500" and "4,000" — so the failure
 * was not rare, and its symptom is a generation that dies at the brief having already
 * paid for it.
 *
 * Comparing NUMBERS extracted from the normalised text fixes that and, more usefully,
 * makes the guard agree with the spec lint, which has always compared numerically.
 * Number words fold too, so a page saying "two ounces" verifies a spec of 2.
 *
 * The rule itself is unchanged and still absolute: a source-attributed number that is
 * not in the source stops the run.
 */

export interface GuardableSpec {
  label: string;
  value: number;
  origin: string;
}

/** The labels of specs claiming to come from the source that are not in it. */
export function unverifiedSourceSpecs(specs: readonly GuardableSpec[], rawText: string): string[] {
  const sourceValues = new Set(extractNumbers(normalise(rawText)).map((n) => n.value));
  return specs
    .filter((s) => s.origin === "source" && !sourceValues.has(s.value))
    .map((s) => s.label);
}
