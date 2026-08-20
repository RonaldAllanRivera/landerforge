import { describe, expect, it } from "vitest";
import { diffGenerations, diffWords, INLINE_DIFF_WORD_CAP } from "@/lib/shared/diff";
import type { TemplateManifest } from "@/lib/shared/manifest";
import { field } from "./helpers";

const text = (tokens: ReturnType<typeof diffWords>) => tokens.map((t) => t.text).join("");
const kinds = (tokens: ReturnType<typeof diffWords>) => tokens.map((t) => t.kind);

describe("word diff", () => {
  it("reports identical copy as unchanged", () => {
    expect(diffWords("the same words", "the same words")).toEqual([
      { kind: "same", text: "the same words" },
    ]);
  });

  it("reconstructs both sides exactly, whitespace included", () => {
    // Anything less and the diff cannot be rendered without corrupting the copy.
    const tokens = diffWords("one  two\nthree", "one two three four");
    expect(
      tokens
        .filter((t) => t.kind !== "added")
        .map((t) => t.text)
        .join(""),
    ).toBe("one  two\nthree");
    expect(
      tokens
        .filter((t) => t.kind !== "removed")
        .map((t) => t.text)
        .join(""),
    ).toBe("one two three four");
  });

  it("marks only the words that moved", () => {
    const tokens = diffWords("stops barking instantly", "stops barking humanely");
    expect(text(tokens.filter((t) => t.kind === "same"))).toContain("stops barking");
    expect(text(tokens.filter((t) => t.kind === "removed"))).toContain("instantly");
    expect(text(tokens.filter((t) => t.kind === "added"))).toContain("humanely");
  });

  it("merges runs so the output is spans, not confetti", () => {
    const tokens = diffWords("a b c d", "a x y d");
    // Not one token per word: adjacent changes of the same kind collapse.
    expect(kinds(tokens).join(",")).not.toContain("removed,removed");
    expect(kinds(tokens).join(",")).not.toContain("added,added");
  });

  it("handles one side being empty", () => {
    expect(kinds(diffWords("", "brand new"))).toEqual(["added"]);
    expect(kinds(diffWords("gone", ""))).toEqual(["removed"]);
    expect(diffWords("", "")).toEqual([]);
  });

  it("falls back to whole-block replacement past the cap rather than hanging", () => {
    // The table is words-before x words-after cells; a pathological pair must not
    // freeze a review screen.
    const huge = "word ".repeat(INLINE_DIFF_WORD_CAP + 10);
    const tokens = diffWords(huge, `${huge}tail`);
    expect(kinds(tokens)).toEqual(["removed", "added"]);
  });
});

const manifest = (): TemplateManifest =>
  ({
    slug: "advertorial_v1",
    name: "T",
    sections: [
      {
        id: "hero",
        label: "Hero",
        defaultPresent: true,
        fields: [
          field({ key: "page_title", type: "text" }),
          field({ key: "summary", type: "textarea" }),
        ],
      },
      {
        id: "reviews",
        label: "Reviews",
        defaultPresent: true,
        repeat: [2, 5],
        fields: [field({ key: "review_text", type: "textarea" })],
      },
      {
        id: "exit_pop",
        label: "Exit Pop",
        defaultPresent: false,
        fields: [field({ key: "marker", generate: false })],
      },
    ],
  }) as unknown as TemplateManifest;

describe("diffing two versions", () => {
  it("separates what changed from what did not", () => {
    const result = diffGenerations(
      manifest(),
      { hero: { page_title: "Old title", summary: "Same summary" } },
      { hero: { page_title: "New title", summary: "Same summary" } },
    );
    expect(result.changed).toBe(1);
    expect(result.unchanged).toBe(1);
    const hero = result.sections.find((s) => s.sectionId === "hero");
    expect(hero?.fields.find((f) => f.key === "page_title")?.kind).toBe("changed");
    expect(hero?.fields.find((f) => f.key === "summary")?.kind).toBe("same");
  });

  it("reports a field the older version never produced as added", () => {
    // Driven by the manifest, not by the stored keys — otherwise a newly filled field
    // is invisible, which is precisely the change worth seeing.
    const result = diffGenerations(
      manifest(),
      { hero: { page_title: "Only a title" } },
      { hero: { page_title: "Only a title", summary: "And now a summary" } },
    );
    expect(result.sections[0]?.fields.find((f) => f.key === "summary")?.kind).toBe("added");
  });

  it("reports a field that was emptied as removed", () => {
    const result = diffGenerations(
      manifest(),
      { hero: { page_title: "t", summary: "went away" } },
      { hero: { page_title: "t" } },
    );
    expect(result.sections[0]?.fields.find((f) => f.key === "summary")?.kind).toBe("removed");
  });

  it("compares repeating sections instance by instance and labels them", () => {
    const result = diffGenerations(
      manifest(),
      { reviews: { review_text: ["first", "second"] } },
      { reviews: { review_text: ["first", "SECOND rewritten"] } },
    );
    const reviews = result.sections.find((s) => s.sectionId === "reviews");
    expect(reviews?.fields).toHaveLength(2);
    expect(reviews?.fields[0]?.instance).toBe("Review 1");
    expect(reviews?.fields[0]?.kind).toBe("same");
    expect(reviews?.fields[1]?.instance).toBe("Review 2");
    expect(reviews?.fields[1]?.kind).toBe("changed");
  });

  it("shows an instance the newer version added", () => {
    const result = diffGenerations(
      manifest(),
      { reviews: { review_text: ["one", "two"] } },
      { reviews: { review_text: ["one", "two", "three"] } },
    );
    const reviews = result.sections.find((s) => s.sectionId === "reviews");
    expect(reviews?.fields.find((f) => f.instance === "Review 3")?.kind).toBe("added");
  });

  it("ignores sections that generate nothing", () => {
    const result = diffGenerations(manifest(), {}, {});
    expect(result.sections.some((s) => s.sectionId === "exit_pop")).toBe(false);
  });

  it("survives a version with no sections stored at all", () => {
    const result = diffGenerations(manifest(), {}, { hero: { page_title: "brand new run" } });
    expect(result.changed).toBe(1);
    expect(result.sections[0]?.fields[0]?.kind).toBe("added");
  });

  it("counts changes per section, for a summary that does not need the detail", () => {
    const result = diffGenerations(
      manifest(),
      { hero: { page_title: "a", summary: "b" } },
      { hero: { page_title: "A", summary: "B" } },
    );
    expect(result.sections[0]?.changed).toBe(2);
  });
});

describe("when the two versions barely overlap", () => {
  it("shows before and after as blocks rather than interleaving them", () => {
    // Two versions written from different source URLs. Inline marks are technically
    // correct here and produce a page of alternating strikethrough and underline.
    const before = "Ditch the reading glasses that never focus at every distance";
    const after = "Solar powered mosquito control that covers the whole patio";
    expect(kinds(diffWords(before, after))).toEqual(["removed", "added"]);
  });

  it("still marks words inline when most of the sentence survived", () => {
    const tokens = diffWords(
      "Stops barking instantly, without harm to your dog",
      "Stops barking instantly, without stress for your dog",
    );
    expect(kinds(tokens)).toContain("same");
    expect(kinds(tokens).length).toBeGreaterThan(2);
  });

  it("does not treat shared whitespace as similarity", () => {
    // Two unrelated texts share spaces; counting them would defeat the threshold.
    const before = "aaaa bbbb cccc dddd eeee";
    const after = "ffff gggg hhhh iiii jjjj";
    expect(kinds(diffWords(before, after))).toEqual(["removed", "added"]);
  });

  it("keeps a rename readable rather than collapsing it", () => {
    const tokens = diffWords(
      "The quick brown fox jumps over the lazy dog every single morning",
      "The quick brown fox leaps over the lazy dog every single morning",
    );
    expect(text(tokens.filter((t) => t.kind === "removed"))).toContain("jumps");
    expect(text(tokens.filter((t) => t.kind === "added"))).toContain("leaps");
  });
});
