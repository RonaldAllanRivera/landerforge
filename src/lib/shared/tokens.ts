/**
 * The authoritative token list, mirrored from docs/tokens.txt.
 *
 * Matching is EXACT and CASE-SENSITIVE. Note the deliberate inconsistency in the
 * source system: content tokens are camelCase while the four legal URLs are
 * snake_case. A model will try to normalise that; the lint must not let it.
 */

export const TOKEN_CATEGORIES = [
  "tracking",
  "content",
  "date",
  "visitor",
  "legal",
  "conditional",
] as const;

export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

export const TOKENS_BY_CATEGORY: Record<TokenCategory, readonly string[]> = {
  tracking: ["{{clickURL}}"],
  content: [
    "{{productName}}",
    "{{discountValue}}",
    "{{priceRegular}}",
    "{{priceDiscounted}}",
    "{{guaranteeDays}}",
  ],
  date: ["{{currentDate}}", "{{currentYear}}"],
  visitor: ["{{visitorCountryCode}}"],
  legal: ["{{terms_url}}", "{{privacy_url}}", "{{contact_url}}", "{{impressum_url}}"],
  // The conditional rows are PATTERNS, not literals. Treating the table as an exact
  // set would flag every real conditional ({{if:country=DE}} is not in the set) while
  // passing the placeholder. See CONDITIONAL_PATTERNS.
  conditional: ["{{if:country=XX}}", "{{elif:country=XX}}", "{{else}}", "{{endif}}"],
};

export const LITERAL_TOKENS: readonly string[] = Object.entries(TOKENS_BY_CATEGORY)
  .filter(([category]) => category !== "conditional")
  .flatMap(([, tokens]) => tokens)
  .concat(["{{else}}", "{{endif}}"]);

export const CONDITIONAL_PATTERNS = {
  if: /\{\{if:country=([A-Za-z]{2})\}\}/g,
  elif: /\{\{elif:country=([A-Za-z]{2})\}\}/g,
  else: /\{\{else\}\}/g,
  endif: /\{\{endif\}\}/g,
} as const;

/** Any `{{...}}` occurrence, so unknown tokens can be detected rather than ignored. */
export const ANY_TOKEN = /\{\{[^}]*\}\}/g;

/**
 * Default token scope for a field: every category except `legal`.
 *
 * No manifest field opts into legal — the four legal URLs live in the CMS's attached
 * Disclaimers resource, which this tool never writes.
 */
export const DEFAULT_TOKEN_CATEGORIES: readonly TokenCategory[] = [
  "tracking",
  "content",
  "date",
  "visitor",
  "conditional",
];

export function tokensForCategories(categories: readonly TokenCategory[]): Set<string> {
  const out = new Set<string>();
  for (const category of categories) {
    for (const token of TOKENS_BY_CATEGORY[category]) out.add(token);
  }
  return out;
}

export function isKnownToken(raw: string): boolean {
  if (LITERAL_TOKENS.includes(raw)) return true;
  return /^\{\{(if|elif):country=[A-Za-z]{2}\}\}$/.test(raw);
}

/** ISO 3166-1 alpha-2 shape check. The literal placeholder `XX` is itself a violation. */
export function isValidCountryCode(code: string): boolean {
  return /^[A-Z]{2}$/.test(code) && code !== "XX";
}
