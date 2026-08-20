import {
  MULTI_WORD_UNITS,
  NUMBER_WORDS,
  UNIT_ALIASES,
  VAGUE_QUANTIFIERS,
  WORD_AMBIGUOUS_UNITS,
} from "./units";

/**
 * The normalisation pass.
 *
 * Produces a PARALLEL COMPARISON VIEW; it never replaces a field value. Only the
 * dual-unit, spec and verbatim lints (plus the Step 1 allowedSpecs guard) read it.
 * Word count and charLimit read the literal text the copy button will emit —
 * otherwise "twenty-five percent" collapsing to "25%" lets a field pass a limit the
 * clipboard text blows past.
 *
 * Applied identically to generated output, raw_text and allowedSpecs. Applying it to
 * one side only is what makes a spec check flag copy that faithfully reproduces its
 * source.
 */

export interface NumericMention {
  value: number;
  unit: string | null;
  /** Source text of the match, for violation excerpts. */
  raw: string;
  /** Digits printed after the decimal point, used by the conversion tolerance rule. */
  precision: number;
  approximate: boolean;
  index: number;
}

const MINUS_SIGNS = /[−–‐]/g;

/** Fold unicode minus/en-dash variants and collapse whitespace. */
export function foldPunctuation(input: string): string {
  return input.replace(MINUS_SIGNS, "-").replace(/ /g, " ");
}

/**
 * Convert spelled-out numbers to digits, including hyphenated compounds.
 * "twenty-five" -> 25. Ordinals and vague quantifiers are left alone.
 */
export function normaliseNumberWords(input: string): string {
  return input.replace(/\b([a-z]+)(?:-([a-z]+))?\b/gi, (match, aRaw: string, bRaw?: string) => {
    const a = aRaw.toLowerCase();
    const b = bRaw?.toLowerCase();
    if (VAGUE_QUANTIFIERS.has(a)) return match;
    const aVal = NUMBER_WORDS[a];
    if (aVal === undefined) return match;
    if (b !== undefined) {
      const bVal = NUMBER_WORDS[b];
      // "twenty-five" = 25; "twenty-something" is left alone.
      if (bVal !== undefined && aVal >= 20 && aVal % 10 === 0 && bVal < 10) {
        return String(aVal + bVal);
      }
      return match;
    }
    return String(aVal);
  });
}

/** Fold unit spellings to canonical form, longest alias first so "square feet" wins. */
export function normaliseUnitWords(input: string): string {
  const aliases = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length);
  let out = input;
  for (const alias of aliases) {
    const pattern = new RegExp(`(?<![\\w])${escapeRegex(alias)}(?![\\w])`, "gi");
    out = out.replace(pattern, UNIT_ALIASES[alias] as string);
  }
  return out;
}

/** Full pass: punctuation, number words, unit words. */
export function normalise(input: string): string {
  return normaliseUnitWords(normaliseNumberWords(foldPunctuation(input)));
}

const UNIT_PATTERN = [
  ...MULTI_WORD_UNITS.map(escapeRegex),
  "mAh",
  "Wh",
  "diopter",
  "kg",
  "mg",
  "cm",
  "mm",
  "ft",
  "hr",
  "oz",
  "lb",
  "ml",
  "cl",
  "sec",
  "min",
  "days",
  "day",
  "in",
  "m",
  "l",
  "g",
  "W",
  "h",
  "%",
  "\\$",
  "€",
  "£",
].join("|");

/**
 * Extract numeric mentions from normalised text.
 *
 * Handles the formats real pages actually use: thousands separators (1,284),
 * trailing plus (50,000+), leading tilde (~400), currency prefixes ($49.99), and
 * units abutting the digit with no space (18W, 6000mAh).
 */
export function extractNumbers(normalisedText: string): NumericMention[] {
  const out: NumericMention[] = [];
  /**
   * Two guards learned from a real run, where "In 1, when we..." was reported as the
   * spec `1 Wh` and "3 weeks" as `3 W`, both quoted back to the model as truncated
   * nonsense it could not act on.
   *
   * Digits: a comma is a thousands separator only when three digits follow it. The old
   * `\d[\d,]*` accepted a TRAILING comma, which let the next word's first letters be
   * read as a unit.
   *
   * Units: an alphabetic unit must not be glued to more letters. Nearly every short
   * unit here is also the start of a common word — w/week, h/hour, g/good, m/my — so
   * without the boundary the alternation matches inside ordinary prose.
   */
  const pattern = new RegExp(
    `(~)?\\s*([$€£])?\\s*(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(\\+)?\\s*((?:${UNIT_PATTERN})(?![a-z]))?`,
    "gi",
  );

  for (const match of normalisedText.matchAll(pattern)) {
    const [raw, tilde, currency, digitsRaw, plus, unitRaw] = match;
    if (digitsRaw === undefined) continue;

    const digits = digitsRaw.replace(/,/g, "");
    const value = Number.parseFloat(digits);
    if (Number.isNaN(value)) continue;

    let unit: string | null = currency ?? unitRaw ?? null;
    const index = match.index ?? 0;

    // A word-ambiguous abbreviation is a unit only when what follows is not another
    // word or digit: "2 in," is a measurement, "1 in 3" is not.
    if (unit && WORD_AMBIGUOUS_UNITS.has(unit.toLowerCase())) {
      const after = normalisedText.slice(index + raw.length);
      if (/^\s*[\w\d]/.test(after)) unit = null;
    }

    const decimals = digits.split(".")[1];
    out.push({
      value,
      unit,
      raw: raw.trim(),
      precision: decimals ? decimals.length : 0,
      approximate: Boolean(tilde) || Boolean(plus),
      index,
    });
  }
  return out;
}

/** Words as the reader sees them — literal text, not the normalised view. */
export function countWords(text: string): number {
  const stripped = text
    .replace(/\{\{[^}]*\}\}/g, "TOKEN")
    .replace(/[#*_>`]/g, " ")
    .trim();
  if (stripped === "") return 0;
  return stripped.split(/\s+/).length;
}

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sentence split good enough for the dual-unit proximity rule. */
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== "");
}
