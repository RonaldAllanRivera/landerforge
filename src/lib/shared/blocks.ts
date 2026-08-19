import { z } from "zod";
import { countWords } from "./normalize";

/**
 * The typed block array — the single density substrate.
 *
 * Every source type produces this shape: the scrape's readability pass, the paste
 * handler, and the screenshot transcription. `raw_text` is always its concatenation.
 * That is what stops density behaving differently depending on where a source came
 * from.
 */

export const BLOCK_TYPES = [
  "heading",
  "paragraph",
  "list_item",
  "quote",
  "testimonial",
  "table_row",
  "cta",
  "disclaimer",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export const SourceBlockSchema = z.object({
  type: z.enum(BLOCK_TYPES),
  /** Headings only. */
  level: z.number().int().min(1).max(6).optional(),
  /** testimonial: inline_quote | review_card | comment — one flat type cannot tell them apart. */
  variant: z.string().optional(),
  /** table_row only. Reconstructing an N-column table from row text is lossy. */
  cells: z.array(z.string()).optional(),
  isHeader: z.boolean().optional(),
  /** Extraction-level nesting only; never a second level of output repetition. */
  parentIndex: z.number().int().nonnegative().optional(),
  /** Same-platform sources: which manifest field this element belongs to. */
  selectorHint: z.object({ sectionId: z.string(), fieldKey: z.string() }).optional(),
  /** Always the flat rendering. raw_text is the concatenation of these. */
  text: z.string(),
});

export type SourceBlock = z.infer<typeof SourceBlockSchema>;

export const RAW_TEXT_CAP_BYTES = 200_000;

/**
 * Truncate BLOCK-wise, never string-wise.
 *
 * Capping the string alone leaves `blocks` holding content `raw_text` does not, so
 * Step 1 reads a spec from past the cut and the guard cannot find it — killing the run
 * over content that was genuinely there. Every writer of blocks uses this.
 */
export function truncateBlocks(blocks: SourceBlock[]): {
  blocks: SourceBlock[];
  rawText: string;
  truncated: boolean;
} {
  const kept: SourceBlock[] = [];
  let size = 0;
  let truncated = false;

  for (const block of blocks) {
    const cost = Buffer.byteLength(block.text, "utf8") + 2;
    if (size + cost > RAW_TEXT_CAP_BYTES) {
      truncated = true;
      break;
    }
    kept.push(block);
    size += cost;
  }
  return { blocks: kept, rawText: concatBlocks(kept), truncated };
}

/** raw_text is defined as this, unconditionally. */
export function concatBlocks(blocks: readonly SourceBlock[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

export function blockWordCount(block: SourceBlock): number {
  return countWords(block.text);
}
