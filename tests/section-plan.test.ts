import { describe, expect, it } from "vitest";
import type { TemplateManifest } from "@/lib/shared/manifest";
import { buildSectionPlan, toWordTarget } from "@/lib/shared/section-plan";
import { block } from "./helpers";

const manifest: TemplateManifest = {
  slug: "advertorial_v1",
  name: "Advertorial V1",
  sections: [
    {
      id: "hero",
      label: "Hero",
      defaultPresent: true,
      fields: [
        {
          key: "page_title",
          label: "Page Title (H1)",
          type: "text",
          generate: true,
          markdownBold: false,
          productNameFormat: "plain",
          linkPolicy: "none",
          voice: "second_person",
        },
      ],
    },
    {
      id: "reviews",
      label: "Reviews",
      repeat: [3, 8],
      defaultPresent: true,
      fields: [
        {
          key: "review_text",
          label: "Review Text",
          type: "textarea",
          generate: true,
          markdownBold: false,
          productNameFormat: "plain",
          linkPolicy: "none",
          voice: "reviewer",
        },
      ],
    },
  ],
};

describe("buildSectionPlan", () => {
  it("bakes the tolerance into the range so both paths run one check", () => {
    expect(toWordTarget(100)).toEqual([90, 110]);
  });

  it("sums mapped blocks per field", () => {
    const blocks = [block("one two three four five")];
    const plan = buildSectionPlan(
      blocks,
      {
        blockMap: { "0": { sectionId: "hero", fieldKey: "page_title" } },
        sections: [{ sectionId: "hero", present: true, formatNotes: "" }],
      },
      manifest,
    );
    expect(plan[0]?.fields.page_title?.wordTarget).toEqual([5, 6]);
  });

  it("counts distinct instance indices, clamped to the repeat range", () => {
    const blocks = [block("a"), block("b"), block("c"), block("d")];
    const plan = buildSectionPlan(
      blocks,
      {
        blockMap: {
          "0": { sectionId: "reviews", fieldKey: "review_text", instanceIndex: 0 },
          "1": { sectionId: "reviews", fieldKey: "review_text", instanceIndex: 1 },
          "2": { sectionId: "reviews", fieldKey: "review_text", instanceIndex: 2 },
          "3": { sectionId: "reviews", fieldKey: "review_text", instanceIndex: 3 },
        },
        sections: [{ sectionId: "reviews", present: true, formatNotes: "" }],
      },
      manifest,
    );
    expect(plan.find((s) => s.sectionId === "reviews")?.instanceCount).toBe(4);
  });

  it("falls back to defaultPresent when the brief says nothing", () => {
    const plan = buildSectionPlan([], { blockMap: {}, sections: [] }, manifest);
    expect(plan[0]?.present).toBe(true);
  });
});
