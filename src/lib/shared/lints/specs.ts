import { extractNumbers, normalise, splitSentences } from "../normalize";
import { CONVERSIONS, IMPERIAL_UNITS, metricCounterpart } from "../units";
import type { AllowedSpec, Lint, Violation } from "./types";
import { plainText, violation } from "./types";

const BANNED_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\beliminates?\b/i, label: "absolute efficacy claim" },
  { pattern: /\bguaranteed to (stop|cure|prevent|end)\b/i, label: "absolute efficacy claim" },
  { pattern: /\b100%\s*(effective|guaranteed|safe)\b/i, label: "absolute efficacy claim" },
  { pattern: /\bonly \d+ left\b/i, label: "fabricated scarcity" },
  { pattern: /\b(hurry|act now),? only \d+/i, label: "fabricated scarcity" },
];

const US_STATES =
  /\b(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|Ohio|Oklahoma|Oregon|Pennsylvania|Tennessee|Texas|Utah|Vermont|Virginia|Washington|Wisconsin|Wyoming)\b/;

/** 7. Compliance. Every sub-rule here is mechanically checkable — this lint is code. */
export const complianceLint: Lint = (ctx) => {
  const out: Violation[] = [];
  const text = plainText(ctx.value);
  const normalised = normalise(text);

  for (const { pattern, label } of BANNED_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit) out.push(violation(ctx, "compliance", label, hit[0]));
  }

  if (US_STATES.test(text)) {
    out.push(
      violation(ctx, "compliance", "testimonial locations are country-level, not US states"),
    );
  }

  // "clinically proven" is flagged unless the phrase occurs verbatim in the source.
  // The original rule said "without source support", which asks code to make a
  // judgment it cannot make.
  if (/\bclinically proven\b/i.test(text)) {
    const supported = ctx.rawTextNormalised?.toLowerCase().includes("clinically proven") ?? false;
    if (!supported)
      out.push(violation(ctx, "compliance", '"clinically proven" is not in the source'));
  }

  // Dual units, INCLUDING area. These products sell well outside the US, so an
  // imperial-only figure is unreadable to most of the audience.
  for (const sentence of splitSentences(normalised)) {
    const numbers = extractNumbers(sentence);
    for (const n of numbers) {
      if (!n.unit || !IMPERIAL_UNITS.has(n.unit)) continue;
      const metric = metricCounterpart(n.unit);
      if (!metric) continue;
      const hasMetric = numbers.some((other) => other.unit === metric && other.index < n.index);
      if (!hasMetric) {
        out.push(
          violation(
            ctx,
            "compliance",
            `${n.raw} needs a metric counterpart in ${metric} earlier in the sentence`,
            sentence.trim(),
          ),
        );
      }
    }
  }
  return out;
};

/**
 * 8. Spec check.
 *
 * Every number must resolve against allowedSpecs unless an exemption applies.
 * Exemptions are evaluated FIRST — the old "counts under 10 in rhetorical use"
 * wording could not express that ordering.
 */
export const specLint: Lint = (ctx) => {
  const out: Violation[] = [];
  if (ctx.field.specPolicy === "exempt") return out;

  const text = plainText(ctx.value);
  const normalised = normalise(text);

  for (const n of extractNumbers(normalised)) {
    if (isExempt(n.value, n.unit, normalised, n.index)) continue;
    if (matchesSpec(n.value, n.unit, ctx.allowedSpecs)) continue;
    if (isCorrectConversion(n.value, n.unit, n.precision, ctx.allowedSpecs)) continue;

    out.push(violation(ctx, "spec", `${n.raw} is not in allowedSpecs`, n.raw));
  }
  return out;
};

function isExempt(value: number, unit: string | null, text: string, index: number): boolean {
  // A bare integer 1–9 not adjacent to a unit: "3 simple steps".
  if (!unit && Number.isInteger(value) && value >= 1 && value <= 9) return true;
  // A 4-digit integer in 1900–2100 with no unit is a year. Exempt HERE; the token
  // lint is where hardcoded years are actually policed.
  if (!unit && Number.isInteger(value) && value >= 1900 && value <= 2100) return true;
  // A percentage bound to the discount token.
  if (unit === "%" && text.slice(Math.max(0, index - 24), index).includes("{{discountValue}}")) {
    return true;
  }
  // Times are not specs.
  if (/^\s*(am|pm|:)/i.test(text.slice(index + String(value).length))) return true;
  return false;
}

function matchesSpec(value: number, unit: string | null, specs: readonly AllowedSpec[]): boolean {
  return specs.some((s) => s.value === value && (s.unit ?? null) === unit);
}

/**
 * A number also matches if it is a correct unit conversion of a matched entry.
 * Tolerance: recompute and round to the PRINTED precision. That is what makes both
 * mandated examples pass — 2 oz → 56.699 g rounds to 57 at zero decimals, and
 * 130 ml → 4.396 fl oz rounds to 4.4 at one — where a naive relative tolerance
 * under ~1% would fail the first.
 */
function isCorrectConversion(
  value: number,
  unit: string | null,
  precision: number,
  specs: readonly AllowedSpec[],
): boolean {
  if (!unit) return false;
  for (const spec of specs) {
    if (spec.unit === null) continue;
    for (const c of CONVERSIONS) {
      if (spec.unit === c.from && unit === c.to) {
        if (round(spec.value * c.factor, precision) === value) return true;
      }
      if (spec.unit === c.to && unit === c.from) {
        if (round(spec.value / c.factor, precision) === value) return true;
      }
    }
  }
  return false;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
