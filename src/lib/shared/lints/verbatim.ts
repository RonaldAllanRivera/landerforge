import { countWords } from "../normalize";
import type { Lint, Violation } from "./types";
import { plainText, violation } from "./types";

const MIN_RUN = 12;

/**
 * 9. Verbatim overlap.
 *
 * Output is transformative rewriting, never lifted copy. `disclaimer` blocks are
 * excluded from the comparison corpus: the tool never generates footer content, and
 * roughly 15–19% of a scraped page is platform-global boilerplate that would
 * otherwise dominate the signal.
 */
export const verbatimLint: Lint = (ctx) => {
  const out: Violation[] = [];
  if (!ctx.blocks || ctx.blocks.length === 0) return out;

  const corpus = ctx.blocks
    .filter((b) => b.type !== "disclaimer")
    .map((b) => b.text)
    .join("\n");
  if (corpus.trim() === "") return out;

  const text = plainText(ctx.value);
  if (countWords(text) < MIN_RUN) return out;

  const haystack = new Set(shingles(corpus, MIN_RUN));
  for (const run of shingles(text, MIN_RUN)) {
    if (haystack.has(run)) {
      out.push(
        violation(ctx, "verbatim", `${MIN_RUN}+ words lifted verbatim from the source`, run),
      );
      break;
    }
  }
  return out;
};

function shingles(text: string, size: number): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i++) out.push(words.slice(i, i + size).join(" "));
  return out;
}
