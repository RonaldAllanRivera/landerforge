import { describe, expect, it } from "vitest";
import { blocksFromPaste, extractBlocks } from "@/lib/scrape/extract";
import type { TemplateManifest } from "@/lib/shared/manifest";

/**
 * A compact fixture reproducing the structures that actually broke the extractor when
 * it first met a real lander. Each one is a real observation, not a hypothetical.
 */
const FIXTURE = `<!doctype html><html><head>
<title>Widget | Stop The Noise</title>
<meta name="description" content="A short SEO description.">
</head><body>
<div class="tpl-advertorial_v1">
  <nav><a href="/x">Nav link that must not become a block</a></nav>
  <h1 class="adv-title">Goodbye Barking In My Home</h1>
  <div class="adv-content">
    <p>The current version of <a href="{{clickURL}}"><strong>Widget</strong></a> is nothing like the old one.</p>
    <p>Second paragraph of the body.</p>
    <ul><li>A bullet</li><li>Another bullet</li></ul>
  </div>
  <div class="adv-review-item">
    <p class="adv-review-name">Olivia Martinez</p>
    <p class="adv-review-text">It worked in a week.</p>
  </div>
  <a class="adv-footercta" href="{{clickURL}}">Apply 50% Discount</a>
  <div class="adv-footer">
    <div class="adv-disclaimers"><p>AUTHORIZED RESELLER. Legal boilerplate here.</p></div>
  </div>
</div>
<script>self.__next_f.push([1,"Goodbye Barking In My Home duplicated by the framework"])</script>
</body></html>`;

const manifest: TemplateManifest = {
  slug: "advertorial_v1",
  name: "Advertorial V1",
  selectors: {
    ".adv-title": "hero.page_title",
    ".adv-content": "content.body",
    ".adv-review-item .adv-review-text": "reviews.review_text",
  },
  sections: [{ id: "hero", label: "Hero", defaultPresent: true, fields: [] as never }] as never,
};

const run = () => extractBlocks(FIXTURE, manifest);
const texts = () => run().blocks.map((b) => b.text);
const typed = (t: string) => run().blocks.filter((b) => b.type === t);

describe("extraction against real lander structure", () => {
  it("raw_text is exactly the concatenation of blocks", () => {
    const r = run();
    expect(r.rawText).toBe(r.blocks.map((b) => b.text).join("\n\n"));
  });

  it("detects the platform slug from the tpl- root class", () => {
    expect(run().platformSlug).toBe("advertorial_v1");
  });

  it("strips scripts BEFORE extracting, so the framework payload is not counted twice", () => {
    // Next.js embeds a second copy of every word in its hydration payload. Missing
    // this doubles every word count and every instance count.
    const hits = texts().filter((t) => t.includes("Goodbye Barking In My Home"));
    expect(hits).toHaveLength(1);
    expect(run().rawText).not.toContain("duplicated by the framework");
  });

  it("flattens an inline anchor into its parent paragraph", () => {
    // A block-per-anchor extractor produces "The current version of  is nothing like".
    expect(texts()).toContain("The current version of Widget is nothing like the old one.");
  });

  it("does not emit nav links as blocks", () => {
    expect(texts().some((t) => t.includes("Nav link"))).toBe(false);
  });

  it("captures head fields, which body-only extraction would miss entirely", () => {
    expect(texts()).toContain("Widget | Stop The Noise");
    expect(texts()).toContain("A short SEO description.");
  });

  it("types footer boilerplate as disclaimer even with no <footer> element", () => {
    // The real landers have no <footer> tag at all — it is div.adv-disclaimers. A
    // tag-only check let 278 words of legal text into the density and overlap corpus.
    expect(typed("disclaimer").map((b) => b.text)).toContain(
      "AUTHORIZED RESELLER. Legal boilerplate here.",
    );
  });

  it("keeps a footer CTA as a cta — position does not outrank being interactive", () => {
    expect(typed("cta").map((b) => b.text)).toContain("Apply 50% Discount");
  });

  it("hints descendants of a matched container, not just the container itself", () => {
    // The body is one container holding dozens of blocks; element-only matching left
    // the largest field on the page unhinted.
    const hinted = run().blocks.filter((b) => b.selectorHint?.fieldKey === "body");
    expect(hinted.length).toBeGreaterThanOrEqual(3);
  });

  it("hints a repeated field through its container", () => {
    const hints = run().blocks.map((b) => b.selectorHint?.fieldKey);
    expect(hints).toContain("review_text");
  });
});

describe("paste extraction", () => {
  it("splits on blank lines and still satisfies the concat invariant", () => {
    const r = blocksFromPaste("A heading\n\nA longer paragraph of body copy goes here.");
    expect(r.blocks).toHaveLength(2);
    expect(r.rawText).toBe(r.blocks.map((b) => b.text).join("\n\n"));
  });
});
