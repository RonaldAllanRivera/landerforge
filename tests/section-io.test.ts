import { describe, expect, it } from "vitest";
import type { TemplateSection } from "@/lib/shared/manifest";
import {
  addInstance,
  canAddInstance,
  canRemoveInstance,
  instanceCount,
  parseScaffold,
  readField,
  removeInstance,
  renderFieldValue,
  writeField,
} from "@/lib/shared/section-io";
import { field } from "./helpers";

/**
 * A repeating section stores PARALLEL ARRAYS, one entry per instance. Every edit has
 * to touch each generated field together, or instance 2's name pairs with instance 3's
 * text — a corruption that looks like a model failure and is not.
 */
const reviews = {
  id: "reviews",
  label: "Reviews",
  defaultPresent: true,
  repeat: [3, 8],
  fields: [
    field({ key: "reviewer_name", type: "text" }),
    field({ key: "review_text", type: "textarea" }),
    field({ key: "reviewer_photo", type: "display", generate: false }),
  ],
} as unknown as TemplateSection;

const hero = {
  id: "hero",
  label: "Hero",
  defaultPresent: true,
  fields: [field({ key: "page_title", type: "text" })],
} as unknown as TemplateSection;

const threeReviews = {
  reviewer_name: ["Olivia", "James", "Daniel"],
  review_text: ["a", "b", "c"],
};

describe("instance counting", () => {
  it("counts the longest field, so a field the model skipped still gets a box", () => {
    expect(instanceCount(reviews, { reviewer_name: ["a", "b"], review_text: ["a"] })).toBe(3);
  });

  it("never drops below the manifest minimum", () => {
    expect(instanceCount(reviews, null)).toBe(3);
    expect(instanceCount(reviews, { reviewer_name: ["only one"] })).toBe(3);
  });

  it("is always one for a non-repeating section", () => {
    expect(instanceCount(hero, { page_title: "x" })).toBe(1);
  });
});

describe("reading and writing one instance", () => {
  it("reads the entry at its position", () => {
    expect(readField(reviews, threeReviews, "review_text", 1)).toBe("b");
  });

  it("writes without disturbing its siblings", () => {
    const next = writeField(reviews, threeReviews, "review_text", 1, "EDITED");
    expect(next.review_text).toEqual(["a", "EDITED", "c"]);
    expect(next.reviewer_name).toEqual(["Olivia", "James", "Daniel"]);
  });

  it("does not mutate the input", () => {
    writeField(reviews, threeReviews, "review_text", 0, "changed");
    expect(threeReviews.review_text[0]).toBe("a");
  });

  it("pads rather than leaving holes", () => {
    // A sparse array serialises to nulls that read as "the model produced nothing",
    // when in fact nobody has typed there yet.
    const next = writeField(reviews, { review_text: ["a"] }, "review_text", 2, "c");
    expect(next.review_text).toEqual(["a", "", "c"]);
  });

  it("treats a non-repeating field as a plain value", () => {
    expect(writeField(hero, { page_title: "old" }, "page_title", 0, "new").page_title).toBe("new");
  });
});

describe("adding and removing instances", () => {
  it("adds an empty entry to every generated field at once", () => {
    const next = addInstance(reviews, threeReviews);
    expect(next.reviewer_name).toEqual(["Olivia", "James", "Daniel", ""]);
    expect(next.review_text).toEqual(["a", "b", "c", ""]);
  });

  it("does not create an array for a field that is not generated", () => {
    expect(addInstance(reviews, threeReviews).reviewer_photo).toBeUndefined();
  });

  it("removes the same position from every field, keeping them in step", () => {
    const next = removeInstance(reviews, threeReviews, 1);
    expect(next.reviewer_name).toEqual(["Olivia", "Daniel"]);
    expect(next.review_text).toEqual(["a", "c"]);
  });

  it("honours the manifest's repeat bounds", () => {
    expect(canRemoveInstance(reviews, 3)).toBe(false); // minimum is 3
    expect(canRemoveInstance(reviews, 4)).toBe(true);
    expect(canAddInstance(reviews, 8)).toBe(false); // maximum is 8
    expect(canAddInstance(reviews, 7)).toBe(true);
  });

  it("offers neither on a non-repeating section", () => {
    expect(canAddInstance(hero, 1)).toBe(false);
    expect(canRemoveInstance(hero, 1)).toBe(false);
  });
});

describe("scaffolded fields round-trip through the textarea", () => {
  const benefits = field({
    key: "benefits_list",
    type: "scaffolded",
    lineTemplates: {
      positive: '- <span class="fa-li positive"></span> {copy}',
      negative: '- <span class="fa-li negative"></span> {copy}',
    },
  });

  const stored = {
    items: [
      { variant: "positive", copy: "9.8 average rating" },
      { variant: "negative", copy: "Only available online" },
    ],
  };

  it("renders the assembled markdown the CMS shows", () => {
    const text = renderFieldValue(benefits, stored);
    expect(text).toContain('- <span class="fa-li positive"></span> 9.8 average rating');
    expect(text.split("\n")).toHaveLength(2);
  });

  it("parses the edited markdown back into copy slots", () => {
    expect(parseScaffold(benefits, renderFieldValue(benefits, stored))).toEqual(stored);
  });

  it("survives an operator editing the copy inside a line", () => {
    const edited = renderFieldValue(benefits, stored).replace("9.8", "9.9");
    expect(parseScaffold(benefits, edited).items[0]).toEqual({
      variant: "positive",
      copy: "9.9 average rating",
    });
  });

  it("keeps a line that matches no template rather than discarding it", () => {
    // Losing what somebody typed is worse than guessing its variant.
    const parsed = parseScaffold(benefits, "just some text");
    expect(parsed.items).toEqual([{ variant: "positive", copy: "just some text" }]);
  });

  it("drops blank lines rather than emitting empty bullets", () => {
    expect(parseScaffold(benefits, "a\n\n\nb").items).toHaveLength(2);
  });

  it("does not crash on a malformed stored value", () => {
    expect(renderFieldValue(benefits, { items: "nope" })).toContain("nope");
    expect(renderFieldValue(benefits, null)).toBe("");
  });
});

/**
 * A repeating section can hold a field that occurs once — the Reasons template's Social
 * Proof panel is one heading above N review cards. Treating it as an array would repeat
 * the heading per card, and add/remove would edit it.
 */
describe("a field that does not repeat inside a repeating section", () => {
  const socialProof = {
    id: "social_proof",
    label: "Social Proof",
    defaultPresent: true,
    repeat: [3, 6],
    fields: [
      field({ key: "social_proof_heading", type: "text", repeats: false }),
      field({ key: "name", type: "text" }),
      field({ key: "review_text", type: "textarea" }),
    ],
  } as unknown as TemplateSection;

  const stored = {
    social_proof_heading: "What Customers Are Saying",
    name: ["Jason", "Amanda", "Derek"],
    review_text: ["a", "b", "c"],
  };

  it("reads the same value for every instance", () => {
    for (const i of [0, 1, 2]) {
      expect(readField(socialProof, stored, "social_proof_heading", i)).toBe(
        "What Customers Are Saying",
      );
    }
  });

  it("writes it as a plain value, not an array entry", () => {
    const next = writeField(socialProof, stored, "social_proof_heading", 1, "Reviews");
    expect(next.social_proof_heading).toBe("Reviews");
  });

  it("is ignored when counting instances", () => {
    // Otherwise a single string would be read as a one-instance section.
    expect(instanceCount(socialProof, stored)).toBe(3);
  });

  it("gains nothing when an instance is added", () => {
    const next = addInstance(socialProof, stored);
    expect(next.social_proof_heading).toBe("What Customers Are Saying");
    expect(next.name).toHaveLength(4);
  });

  it("survives an instance being removed", () => {
    const next = removeInstance(socialProof, stored, 0);
    expect(next.social_proof_heading).toBe("What Customers Are Saying");
    expect(next.name).toEqual(["Amanda", "Derek"]);
  });

  it("still treats the other fields as repeating", () => {
    expect(readField(socialProof, stored, "name", 2)).toBe("Derek");
  });
});
