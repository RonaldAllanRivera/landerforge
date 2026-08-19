import type { Lint, Violation } from "./types";
import { plainText, violation } from "./types";

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)]*)\)/g;
const BARE_URL = /(?<!\()\bhttps?:\/\/[^\s)]+/g;

/**
 * 5. Link lint. The field's linkPolicy is the whole rule — there is no global
 * permitted-target set. This doubles as the prompt-injection guard, since a scraped
 * page can carry adversarial links straight into generated copy.
 */
export const linkLint: Lint = (ctx) => {
  const out: Violation[] = [];
  const text = plainText(ctx.value);

  for (const bare of text.matchAll(BARE_URL)) {
    out.push(violation(ctx, "link", "bare URL — every link target is {{clickURL}}", bare[0]));
  }

  const links = [...text.matchAll(MARKDOWN_LINK)];
  if (ctx.field.linkPolicy === "none" && links.length > 0) {
    out.push(violation(ctx, "link", "this field permits no links", links[0]?.[0]));
    return out;
  }

  for (const link of links) {
    const anchor = link[1] ?? "";
    const target = (link[2] ?? "").trim();

    if (target !== "{{clickURL}}") {
      out.push(
        violation(ctx, "link", `link target must be {{clickURL}}, got "${target}"`, link[0]),
      );
    }
    if (ctx.field.linkPolicy === "product_name") {
      const expected =
        ctx.field.productNameFormat === "bold" ? "**{{productName}}**" : "{{productName}}";
      if (anchor.trim() !== expected) {
        out.push(violation(ctx, "link", `anchor must be ${expected} in this field`, link[0]));
      }
    }
  }
  return out;
};
