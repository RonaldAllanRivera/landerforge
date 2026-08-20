import { describe, expect, it } from "vitest";
import {
  CreateProjectInput,
  normaliseProjectName,
  PROJECT_NAME_MAX,
  parseAliases,
  sameProjectName,
} from "@/lib/shared/project";

/**
 * The application's idea of "the same name" has to match the database's, which indexes
 * on lower(btrim(name)). If the two ever disagree, the symptom is a confusing unique
 * violation on a name that looks different to the person typing it.
 */
describe("project name normalisation", () => {
  it("trims and collapses whitespace", () => {
    expect(normaliseProjectName("  Breeze   box  ")).toBe("Breeze box");
  });

  it("treats case and spacing differences as the same name", () => {
    expect(sameProjectName("Breezebox", "breezebox ")).toBe(true);
    expect(sameProjectName("Breeze box", "Breeze  box")).toBe(true);
  });

  it("keeps genuinely different names apart", () => {
    expect(sameProjectName("Breezebox", "Breeze box")).toBe(false);
  });
});

describe("project creation input", () => {
  const valid = { name: "Breezebox", product_name: "BreezeBox Cooler" };

  it("accepts a normal project", () => {
    const parsed = CreateProjectInput.safeParse(valid);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.product_name_aliases).toEqual([]);
  });

  it("stores the normalised name, so the stored value matches what uniqueness compares", () => {
    expect(CreateProjectInput.parse({ ...valid, name: "  Breeze   box " }).name).toBe("Breeze box");
  });

  it("rejects a name that is only whitespace", () => {
    expect(CreateProjectInput.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("rejects a one-character name", () => {
    expect(CreateProjectInput.safeParse({ ...valid, name: "x" }).success).toBe(false);
  });

  it("rejects a name past the column's practical limit", () => {
    const long = "x".repeat(PROJECT_NAME_MAX + 1);
    expect(CreateProjectInput.safeParse({ ...valid, name: long }).success).toBe(false);
  });

  it("requires a product name — the validator needs it to catch a literal in the copy", () => {
    expect(CreateProjectInput.safeParse({ ...valid, product_name: "  " }).success).toBe(false);
  });

  it("explains itself when it refuses", () => {
    const result = CreateProjectInput.safeParse({ ...valid, name: "x" });
    expect(result.error?.issues[0]?.message).toContain("two characters");
  });
});

describe("alias parsing", () => {
  it("splits on commas and drops the gaps", () => {
    // Real pages use more than one spelling of their own product name.
    expect(parseAliases("PestPulsePro Solar, Pest Pulse Pro ,, ")).toEqual([
      "PestPulsePro Solar",
      "Pest Pulse Pro",
    ]);
  });

  it("returns nothing for an empty field", () => {
    expect(parseAliases("")).toEqual([]);
    expect(parseAliases(null)).toEqual([]);
  });
});
