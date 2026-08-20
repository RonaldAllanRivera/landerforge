import type Anthropic from "@anthropic-ai/sdk";
import type { SourceBlock } from "./blocks";

/**
 * Message assembly for the section loop.
 *
 * In shared/ because it is a pure function from data to a request body — no I/O, no
 * framework. It sat behind `server-only`, which made the one thing worth asserting
 * about it untestable: that everything varying per call comes after the last cache
 * breakpoint. A prefix bug is invisible in review and shows up only as a bill.
 *
 * Three cache breakpoints, of the four allowed, ordered most stable first:
 *   1. system      — rules plus manifest, identical for every call in the run
 *   2. source      — the extracted blocks, identical for every call including the brief
 *   3. last prior  — moves forward one section per call, so each call reads the
 *                    previous call's write at roughly a tenth of input price
 *
 * The fourth slot is deliberately left free for automatic caching.
 *
 * Anything that varies per call MUST sit after the last breakpoint, or the cache
 * silently dies. `tools` stays empty: a per-section tool definition would change the
 * very front of the prefix and make every call a full miss.
 */

type Block = Anthropic.Messages.ContentBlockParam;

export interface SectionCallInput {
  /** Rules + manifest. Identical for every call in the run. */
  systemPrompt: string;
  /** Deterministically serialised: sorted keys, no timestamps, no per-run ids. */
  brief: unknown;
  /** Completed sections, in generation order. Append-only. */
  priorSections: Array<{ sectionId: string; body: string }>;
  /** Varies per call — must come last. */
  sectionInstructions: string;
  /** Untrusted source material, delivered as a tool result. */
  sourceBlocks?: readonly SourceBlock[];
}

export function buildSystem(systemPrompt: string): Anthropic.Messages.TextBlockParam[] {
  return [
    {
      type: "text",
      text: systemPrompt,
      // On the last system block so tools + system cache together.
      cache_control: { type: "ephemeral" },
    },
  ];
}

export function buildMessages(input: SectionCallInput): Anthropic.Messages.MessageParam[] {
  const content: Block[] = [];

  if (input.sourceBlocks?.length) {
    /**
     * Scraped and transcribed content is untrusted: a competitor page can carry
     * adversarial text, and the output ends up on public landers. JSON-encoded so an
     * attacker cannot close a delimiter and break into instruction context, and
     * indexed because blockMap keys on block position.
     *
     * selectorHint is carried through deliberately. On same-platform sources the
     * extractor recovers an exact {sectionId, fieldKey} for most blocks from the CMS's
     * own class names, and the brief is explicitly told to adopt it — but it was being
     * computed, stored, and then dropped here, leaving the model to re-derive by eye
     * the one thing already known for certain. Every word target in the run is built
     * from the resulting blockMap, so a guess costs density on every field.
     *
     * It is safe to trust structurally: a hint only survives extraction when it matches
     * a field this manifest declares, so its value space is ours, not the page's.
     */
    content.push({
      type: "text",
      text: `<source_material>${JSON.stringify({
        source: "extracted_from_untrusted_page",
        blocks: input.sourceBlocks.map((b, index) => ({
          index,
          type: b.type,
          // Omitted when absent rather than emitted as null: these are sparse, and the
          // whole array sits inside the cached prefix of every call in the run.
          ...(b.level === undefined ? {} : { level: b.level }),
          ...(b.variant === undefined ? {} : { variant: b.variant }),
          ...(b.cells === undefined ? {} : { cells: b.cells }),
          ...(b.selectorHint === undefined ? {} : { selectorHint: b.selectorHint }),
          text: b.text,
        })),
      })}</source_material>`,
      /**
       * Breakpoint 2 of 4. Source material is byte-identical on every call in the run,
       * including the brief, so it belongs in the shared prefix.
       *
       * It used to sit AFTER <brief>, whose content differs between the brief call
       * ({notes}) and the section calls (the whole payload). Caching matches on exact
       * prefix, so that one difference at position 0 made the source material
       * uncacheable across the boundary: the first section call was measured re-buying
       * 11,696 input tokens it had already paid for once.
       */
      cache_control: { type: "ephemeral" },
    });
  }

  // After the source material, because <brief> is what varies between the brief call
  // and the section calls, and everything that varies must come later than everything
  // that does not.
  content.push({ type: "text", text: `<brief>\n${stableStringify(input.brief)}\n</brief>` });

  input.priorSections.forEach((section, i) => {
    const isLast = i === input.priorSections.length - 1;
    content.push({
      type: "text",
      text: `<completed_section id="${section.sectionId}">\n${section.body}\n</completed_section>`,
      // Moving breakpoint on the last completed section: each call reads the
      // previous call's write.
      ...(isLast ? { cache_control: { type: "ephemeral" as const } } : {}),
    });
  });

  content.push({ type: "text", text: input.sectionInstructions });

  return [{ role: "user", content }];
}

/** Byte-stability is the whole game: one interpolated timestamp kills every hit. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return val;
  });
}
