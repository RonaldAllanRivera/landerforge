import { describe, expect, it } from "vitest";
import type { TemplateSection } from "@/lib/shared/manifest";
import { outputContract } from "@/lib/shared/output-contract";
import type { SectionPlanEntry } from "@/lib/shared/section-plan";
import { field } from "./helpers";

/**
 * Regressions from the first complete run, where three of five sections burned their
 * entire retry budget on ambiguity rather than on bad writing.
 */

const section = (over: Partial<TemplateSection> = {}): TemplateSection =>
  ({
    id: "reviews",
    label: "Reviews",
    defaultPresent: true,
    fields: [field({ key: "review_text", type: "textarea" })],
    ...over,
  }) as TemplateSection;

const plan = (over: Partial<SectionPlanEntry> = {}): SectionPlanEntry => ({
  sectionId: "reviews",
  present: true,
  instanceCount: null,
  formatNotes: "",
  fields: {},
  ...over,
});

describe("repeating sections", () => {
  const repeating = section({ repeat: [3, 8] });
  const withPlan = plan({
    instanceCount: 3,
    fields: { review_text: { wordTarget: [222, 272] } },
  });

  it("states the instance count and asks for an array", () => {
    const out = outputContract(repeating, withPlan);
    expect(out).toContain("repeats 3 times");
    expect(out).toContain("x3");
  });

  it("says the word target is a TOTAL, which is what the validator checks", () => {
    // The failure: the model read 222-272 as per review and wrote 789 words.
    expect(outputContract(repeating, withPlan)).toContain("in TOTAL across all 3 entries");
  });

  it("also divides the target out, because a writer works per item", () => {
    expect(outputContract(repeating, withPlan)).toContain("about 82 words each");
  });

  it("does not claim a total for a non-repeating section", () => {
    const single = outputContract(
      section({ repeat: undefined }),
      plan({ fields: { review_text: { wordTarget: [40, 50] } } }),
    );
    expect(single).toContain("40–50 words");
    expect(single).not.toContain("TOTAL");
  });
});

describe("scaffolded fields", () => {
  const scaffolded = section({
    id: "sidebar",
    repeat: undefined,
    fields: [
      field({
        key: "benefits_list",
        type: "scaffolded",
        lineTemplates: {
          positive: '- <span class="positive"></span> {copy}',
          negative: '- <span class="negative"></span> {copy}',
        },
      }),
    ],
  });

  it("names the exact object shape and the permitted variants", () => {
    const out = outputContract(scaffolded, plan({ sectionId: "sidebar" }));
    expect(out).toContain('"items"');
    expect(out).toContain('"variant"');
    expect(out).toContain('"positive" | "negative"');
  });

  it("says the markup is applied by code — the model returned assembled HTML", () => {
    const out = outputContract(scaffolded, plan({ sectionId: "sidebar" }));
    expect(out).toContain("write ONLY the copy text");
    expect(out).toContain("HTML tag in your output is a defect");
  });

  it("never leaks a lineTemplate into the instructions", () => {
    expect(outputContract(scaffolded, plan({ sectionId: "sidebar" }))).not.toContain("<span");
  });
});

describe("general shape", () => {
  it("falls back to the manifest target when the brief has no entry", () => {
    const out = outputContract(
      section({
        repeat: undefined,
        fields: [field({ key: "page_title", fallbackWordTarget: [12, 14] })],
      }),
      plan({ fields: {} }),
    );
    expect(out).toContain("12–14 words");
  });

  it("lists only generated fields", () => {
    const out = outputContract(
      section({
        repeat: undefined,
        fields: [field({ key: "written" }), field({ key: "display_only", generate: false })],
      }),
      plan(),
    );
    expect(out).toContain("written");
    expect(out).not.toContain("display_only");
  });

  it("says 'exactly N' rather than 'N-N' for a fixed-length field", () => {
    const out = outputContract(
      section({ repeat: undefined, fields: [field({ key: "cta", fallbackWordTarget: [2, 2] })] }),
      plan(),
    );
    expect(out).toContain("exactly 2 words");
    expect(out).not.toContain("2–2");
  });

  it("returns nothing for a section with no generated fields", () => {
    expect(outputContract(section({ fields: [field({ generate: false })] }), plan())).toBe("");
  });
});
