import * as cheerio from "cheerio";
import type { SourceBlock } from "@/lib/shared/blocks";
import { truncateBlocks } from "@/lib/shared/blocks";
import type { TemplateManifest } from "@/lib/shared/manifest";

/**
 * HTML → the typed block array.
 *
 * No semantic structuring here: no testimonial pairing, no spec extraction, no price
 * parsing. Landers are page-builder output with specs written in prose or baked into
 * images, so heuristics miss enough to break the anti-fabrication guard downstream.
 * Step 1 is already an LLM structured-output pass over this content.
 */

const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,tr,button,a[href]";
/**
 * The footer is deliberately NOT stripped: its disclaimers become `disclaimer` blocks,
 * which the verbatim lint excludes from its corpus and Step 1 never maps to a field.
 * Stripping instead would also discard any real content a lander puts down there.
 */
const STRIP = "script,style,noscript,template,nav,svg,[hidden],[aria-hidden=true]";

/**
 * Page-builder output does not use semantic elements. The measured landers contain no
 * <footer> tag at all — the disclaimers live in `<div class="adv-disclaimers">`. A
 * tag-only check therefore matched nothing, and 278 words of legal boilerplate were
 * silently entering the density counts and the verbatim-overlap corpus as ordinary
 * paragraphs.
 */
const FOOTER_SELECTOR = "footer,[class*='footer'],[class*='disclaim'],[class*='legal']";

export interface ExtractResult {
  blocks: SourceBlock[];
  rawText: string;
  truncated: boolean;
  /** Present when the page carries a known tpl-{slug} marker. */
  platformSlug: string | null;
}

export function extractBlocks(html: string, manifest?: TemplateManifest): ExtractResult {
  const $ = cheerio.load(html);

  /**
   * Strip <script> BEFORE extracting, not after. On a Next.js page the RSC flight
   * payload embeds a second, JSON-escaped copy of every heading, paragraph and
   * testimonial — tens of KB. Miss it and every word count doubles, instanceCount
   * doubles, and the verbatim lint compares against a duplicated corpus.
   */
  $(STRIP).remove();

  const platformSlug = detectPlatformSlug($);
  const blocks: SourceBlock[] = [];

  // Head fields are real fields with real targets: one measured page has an 8-word
  // SEO title quite distinct from its 17-word H1.
  const title = $("head title").text().trim();
  if (title) blocks.push({ type: "heading", level: 1, text: title });
  const description = $('meta[name="description"]').attr("content")?.trim();
  if (description) blocks.push({ type: "paragraph", text: description });

  $(BLOCK_SELECTOR).each((_, element) => {
    const node = $(element);
    // Inline elements are flattened into the parent's text by .text(); an extractor
    // that emitted <a> as its own block would produce "The current version of is
    // nothing like traditional glasses".
    const text = node.text().replace(/\s+/g, " ").trim();
    if (text === "") return;
    if (node.parents(BLOCK_SELECTOR).length > 0 && element.tagName !== "li") return;

    const className = node.attr("class") ?? "";
    const inFooter = node.closest(FOOTER_SELECTOR).length > 0;
    const block: SourceBlock = {
      type: blockType(element.tagName, className, inFooter),
      text,
    };

    if (/^h[1-6]$/.test(element.tagName)) block.level = Number(element.tagName[1]);
    if (element.tagName === "tr") {
      block.cells = node
        .find("th,td")
        .map((_i, cell) => $(cell).text().trim())
        .get();
      block.isHeader = node.find("th").length > 0;
    }
    if (manifest?.selectors) {
      const hint = matchSelector(node, manifest.selectors);
      if (hint) block.selectorHint = hint;
    }
    blocks.push(block);
  });

  const { blocks: kept, rawText, truncated } = truncateBlocks(blocks);
  return { blocks: kept, rawText, truncated, platformSlug };
}

function blockType(tag: string, className: string, inFooter: boolean): SourceBlock["type"] {
  // Interactive elements win over position: the footer CTA ("Apply 50% Discount &
  // Check Availability") is a real cta_button_text field, not boilerplate.
  if (tag === "button" || tag === "a") return "cta";
  if (inFooter) return "disclaimer";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "li") return "list_item";
  if (tag === "blockquote") return "quote";
  if (tag === "tr") return "table_row";
  if (/disclaim|legal/i.test(className)) return "disclaimer";
  if (/review|testimonial|comment/i.test(className)) return "testimonial";
  return "paragraph";
}

/** LogicHub renders each page inside <div class="tpl-{slug}">. */
function detectPlatformSlug($: cheerio.CheerioAPI): string | null {
  const match = /\btpl-([a-z0-9_]+)\b/.exec($("[class*='tpl-']").first().attr("class") ?? "");
  return match?.[1] ?? null;
}

function matchSelector(
  node: { is(selector: string): boolean; closest(selector: string): { length: number } },
  selectors: Record<string, string>,
): { sectionId: string; fieldKey: string } | undefined {
  for (const [selector, address] of Object.entries(selectors)) {
    // `closest` covers both the element itself and any matched container it sits in.
    // Rich-text fields are a single container holding dozens of blocks, so matching
    // only the element would leave the largest field on the page unhinted.
    if (node.closest(selector).length === 0) continue;
    const [sectionId, fieldKey] = address.split(".");
    if (sectionId && fieldKey) return { sectionId, fieldKey };
  }
  return undefined;
}

/** Pasted text has no reliable structure; density from it is coarser, and that is fine. */
export function blocksFromPaste(text: string): ExtractResult {
  const blocks: SourceBlock[] = text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => ({
      type:
        chunk.length < 80 && !chunk.endsWith(".") ? ("heading" as const) : ("paragraph" as const),
      text: chunk,
    }));
  const { blocks: kept, rawText, truncated } = truncateBlocks(blocks);
  return { blocks: kept, rawText, truncated, platformSlug: null };
}
