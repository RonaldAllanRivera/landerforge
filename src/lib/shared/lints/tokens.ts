import {
  ANY_TOKEN,
  CONDITIONAL_PATTERNS,
  DEFAULT_TOKEN_CATEGORIES,
  isKnownToken,
  isValidCountryCode,
  TOKENS_BY_CATEGORY,
  tokensForCategories,
} from "../tokens";
import type { Lint, Violation } from "./types";
import { plainText, violation } from "./types";

/** 4. Token lint. Exact, case-sensitive matching throughout. */
export const tokenLint: Lint = (ctx) => {
  const out: Violation[] = [];
  const text = plainText(ctx.value);

  const permitted = ctx.field.allowedTokens
    ? new Set([
        ...tokensForCategories(ctx.field.allowedTokens.categories ?? DEFAULT_TOKEN_CATEGORIES),
        ...(ctx.field.allowedTokens.tokens ?? []),
      ])
    : tokensForCategories(DEFAULT_TOKEN_CATEGORIES);

  for (const match of text.matchAll(ANY_TOKEN)) {
    const raw = match[0];
    if (!isKnownToken(raw)) {
      out.push(violation(ctx, "token", `unknown token ${raw}`, raw));
      continue;
    }
    const conditional = /^\{\{(if|elif):country=([A-Za-z]{2})\}\}$/.exec(raw);
    if (conditional) {
      const code = conditional[2] as string;
      if (!isValidCountryCode(code)) {
        out.push(
          violation(ctx, "token", `"${code}" is not a real uppercase ISO 3166-1 alpha-2 code`, raw),
        );
      }
      continue;
    }
    if (raw !== "{{else}}" && raw !== "{{endif}}" && !permitted.has(raw)) {
      out.push(violation(ctx, "token", `${raw} is not permitted in this field`, raw));
    }
  }

  // Legal-URL tokens are out of scope for every generated field.
  for (const legal of TOKENS_BY_CATEGORY.legal) {
    if (text.includes(legal)) {
      out.push(
        violation(ctx, "token", `${legal} belongs to the attached Disclaimers resource`, legal),
      );
    }
  }

  // The product name is ALWAYS the token — never a literal, in any field.
  for (const alias of ctx.productNameAliases) {
    if (alias.trim() === "") continue;
    const pattern = new RegExp(`(?<!\\{\\{)\\b${escapeAlias(alias)}\\b`, "gi");
    const hit = pattern.exec(text);
    if (hit) {
      out.push(
        violation(ctx, "token", `literal product name "${hit[0]}" — use {{productName}}`, hit[0]),
      );
    }
  }

  // productNameFormat governs how the token renders, never whether a literal is allowed.
  const occurrences = [...text.matchAll(/(\*\*)?\{\{productName\}\}(\*\*)?/g)];
  if (ctx.field.productNameFormat === "none" && occurrences.length > 0) {
    out.push(violation(ctx, "token", "this field must not name the product"));
  }
  for (const occurrence of occurrences) {
    const bolded = Boolean(occurrence[1] && occurrence[2]);
    if (ctx.field.productNameFormat === "bold" && !bolded) {
      out.push(violation(ctx, "token", "{{productName}} must be bold in this field"));
    }
    if (ctx.field.productNameFormat === "plain" && bolded) {
      out.push(violation(ctx, "token", "{{productName}} must be bare in this field"));
    }
  }

  if (text.includes("{{discountValue}}") && !/\{\{discountValue\}\}\s*%/.test(text)) {
    out.push(violation(ctx, "token", "{{discountValue}} must be followed by a literal %"));
  }

  if (/\{\{guaranteeDays\}\}/.test(text)) {
    // Production renders "90-Day Money Back Guarantee": Title Case, unhyphenated.
    if (!/\{\{guaranteeDays\}\}[\s-]*day\s+money[\s-]?back\s+guarantee/i.test(text)) {
      out.push(
        violation(ctx, "token", "guarantee reads {{guaranteeDays}}-day money-back guarantee"),
      );
    }
  }

  // No hardcoded prices, discounts or guarantee durations.
  if (/(?<!\{\{)[$€£]\s?\d/.test(text)) {
    out.push(violation(ctx, "token", "hardcoded price — use {{priceRegular}}/{{priceDiscounted}}"));
  }

  // Years must be {{currentYear}}; dates are unconditionally banned.
  for (const year of text.matchAll(/(?<![\d.,])(19|20)\d{2}(?![\d.,])/g)) {
    const value = Number(year[0]);
    if (!ctx.allowedSpecs.some((s) => s.value === value)) {
      out.push(violation(ctx, "token", `hardcoded year ${year[0]} — use {{currentYear}}`, year[0]));
    }
  }
  const MONTHS =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
  if (MONTHS.test(text) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(text)) {
    out.push(violation(ctx, "token", "hardcoded date — use {{currentDate}}"));
  }

  // {{visitorCountryCode}} renders a bare code; it is for logic, not prose.
  if (/\{\{visitorCountryCode\}\}/.test(text)) {
    out.push(violation(ctx, "token", "{{visitorCountryCode}} is for conditionals, not prose"));
  }

  out.push(...conditionalBalance(ctx, text));
  return out;
};

/** Blocks must be balanced, ordered, and contained within a single field value. */
function conditionalBalance(ctx: Parameters<Lint>[0], text: string): Violation[] {
  const out: Violation[] = [];
  const opens = [...text.matchAll(CONDITIONAL_PATTERNS.if)].length;
  const closes = [...text.matchAll(CONDITIONAL_PATTERNS.endif)].length;
  const elses = [...text.matchAll(CONDITIONAL_PATTERNS.else)].length;
  const elifs = [...text.matchAll(CONDITIONAL_PATTERNS.elif)].length;

  if (opens !== closes) {
    out.push(
      violation(ctx, "token", `${opens} {{if:...}} vs ${closes} {{endif}} — blocks must balance`),
    );
  }
  if (opens === 0 && (elses > 0 || elifs > 0)) {
    out.push(violation(ctx, "token", "{{else}}/{{elif}} outside an {{if:...}} block"));
  }
  if (opens > 1) {
    out.push(violation(ctx, "token", "conditional blocks do not nest"));
  }
  if (elses > 1) {
    out.push(violation(ctx, "token", "{{else}} appears at most once per block"));
  }
  return out;
}

function escapeAlias(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
