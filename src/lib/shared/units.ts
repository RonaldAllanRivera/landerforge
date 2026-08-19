/**
 * Unit vocabulary, conversions and the numeric normalisation the spec check depends on.
 *
 * Every rule here exists because a real page broke a simpler version of it. The
 * comments name the case rather than the principle.
 */

/** Multi-word units tokenize as one unit despite containing a space. */
export const MULTI_WORD_UNITS = ["fl oz", "sq ft", "sq m"] as const;

/** Single-token canonical units, post-normalisation. */
export const SINGLE_UNITS = [
  "g",
  "kg",
  "mg",
  "oz",
  "lb",
  "ml",
  "l",
  "cl",
  "cm",
  "mm",
  "m",
  "in",
  "ft",
  "mAh",
  "Wh",
  "W",
  "diopter",
  "h",
  "hr",
  "min",
  "sec",
  "day",
  "days",
  "%",
  "$",
  "€",
  "£",
] as const;

/**
 * Units that are also ordinary English words. "1 in 3 customers" is stock advertorial
 * phrasing; a naive matcher reads the 1 as bearing the imperial unit `in`, which trips
 * the dual-unit lint AND voids the rhetorical exemption. A word-ambiguous abbreviation
 * counts as a unit only when what follows it is not another word or digit.
 */
export const WORD_AMBIGUOUS_UNITS = new Set(["in", "m", "l"]);

/** Imperial units requiring a metric counterpart in the same sentence. Area included. */
export const IMPERIAL_UNITS = new Set(["oz", "fl oz", "lb", "in", "ft", "sq ft"]);

/**
 * Fixed conversion factors so the validator's recomputation is reproducible.
 * US fluid ounces, stated explicitly: the imperial fl oz would make 130 ml / 4.4 fl oz
 * wrong (it computes to 4.575).
 */
export const CONVERSIONS: ReadonlyArray<{ from: string; to: string; factor: number }> = [
  { from: "oz", to: "g", factor: 28.349523125 },
  { from: "lb", to: "kg", factor: 0.45359237 },
  { from: "in", to: "cm", factor: 2.54 },
  { from: "ft", to: "m", factor: 0.3048 },
  { from: "fl oz", to: "ml", factor: 29.5735295625 },
  { from: "sq ft", to: "sq m", factor: 0.09290304 },
];

export function metricCounterpart(imperial: string): string | null {
  return CONVERSIONS.find((c) => c.from === imperial)?.to ?? null;
}

/** Unit spellings folded to canonical form. Area has several input spellings. */
export const UNIT_ALIASES: Record<string, string> = {
  ounce: "oz",
  ounces: "oz",
  gram: "g",
  grams: "g",
  gramme: "g",
  grammes: "g",
  kilogram: "kg",
  kilograms: "kg",
  kilo: "kg",
  kilos: "kg",
  pound: "lb",
  pounds: "lb",
  lbs: "lb",
  millilitre: "ml",
  millilitres: "ml",
  milliliter: "ml",
  milliliters: "ml",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  centimetre: "cm",
  centimetres: "cm",
  centimeter: "cm",
  centimeters: "cm",
  metre: "m",
  metres: "m",
  meter: "m",
  meters: "m",
  inch: "in",
  inches: "in",
  foot: "ft",
  feet: "ft",
  second: "sec",
  seconds: "sec",
  minute: "min",
  minutes: "min",
  hour: "h",
  hours: "h",
  hrs: "hr",
  day: "day",
  days: "days",
  percent: "%",
  pct: "%",
  dollar: "$",
  dollars: "$",
  euro: "€",
  euros: "€",
  // Area: copy RENDERS m², but everything normalises to `sq m` so both sides of a
  // comparison land on the same token and 372 m² (4,000 sq ft) matches its own pair.
  "m²": "sq m",
  sqm: "sq m",
  "square metre": "sq m",
  "square metres": "sq m",
  "square meter": "sq m",
  "square meters": "sq m",
  "ft²": "sq ft",
  sqft: "sq ft",
  "square foot": "sq ft",
  "square feet": "sq ft",
  "fluid ounce": "fl oz",
  "fluid ounces": "fl oz",
};

/** Digit-words in scope. Ordinals and vague quantifiers are deliberately excluded. */
export const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  thousand: 1000,
};

/** Out of scope on purpose — the real pages lean on these heavily. */
export const VAGUE_QUANTIFIERS = new Set([
  "dozen",
  "couple",
  "half",
  "few",
  "several",
  "many",
  "hundreds",
  "thousands",
  "millions",
]);
