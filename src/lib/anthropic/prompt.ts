import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SourceBlock } from "@/lib/shared/blocks";

/**
 * Message assembly for the section loop.
 *
 * Two cache breakpoints, of the four allowed. The system prefix is stable across the
 * run; the message prefix grows by exactly one section per call, so each call reads
 * the previous call's write at roughly a tenth of input price instead of re-billing
 * the whole page.
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

  content.push({ type: "text", text: `<brief>\n${stableStringify(input.brief)}\n</brief>` });

  if (input.sourceBlocks?.length) {
    /**
     * Scraped and transcribed content is untrusted: a competitor page can carry
     * adversarial text, and the output ends up on public landers. JSON-encoded so an
     * attacker cannot close a delimiter and break into instruction context, and
     * indexed because blockMap keys on block position.
     */
    content.push({
      type: "text",
      text: `<source_material>${JSON.stringify({
        source: "extracted_from_untrusted_page",
        blocks: input.sourceBlocks.map((b, index) => ({ index, type: b.type, text: b.text })),
      })}</source_material>`,
    });
  }

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
