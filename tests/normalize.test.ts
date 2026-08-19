import { describe, expect, it } from "vitest";
import { truncateBlocks } from "@/lib/shared/blocks";
import { countWords, extractNumbers, normalise } from "@/lib/shared/normalize";

describe("normalisation", () => {
  it("folds number words to digits", () => {
    expect(normalise("weighs just two ounces")).toContain("2 oz");
  });

  it("folds hyphenated compounds", () => {
    expect(normalise("twenty-five percent")).toContain("25 %");
  });

  it("leaves vague quantifiers alone", () => {
    expect(normalise("thousands of homeowners")).toContain("thousands");
  });

  it("folds the unicode minus sign", () => {
    expect(normalise("−6 to +3 diopters")).toContain("-6");
  });

  it("canonicalises every area spelling to sq m / sq ft", () => {
    expect(normalise("372 m²")).toContain("sq m");
    expect(normalise("4,000 square feet")).toContain("sq ft");
  });
});

describe("number extraction", () => {
  it("strips thousands separators", () => {
    const [n] = extractNumbers(normalise("1,284 reviews"));
    expect(n?.value).toBe(1284);
  });

  it("records approximation markers", () => {
    expect(extractNumbers(normalise("50,000+ families"))[0]?.approximate).toBe(true);
    expect(extractNumbers(normalise("~400 sq ft"))[0]?.approximate).toBe(true);
  });

  it("reads a unit abutting the digit", () => {
    const [n] = extractNumbers(normalise("6000mAh battery"));
    expect(n?.unit).toBe("mAh");
  });

  it("does not treat 'in' as inches mid-phrase", () => {
    const [n] = extractNumbers(normalise("1 in 3 customers"));
    expect(n?.unit).toBeNull();
  });

  it("keeps printed precision for the conversion tolerance", () => {
    expect(extractNumbers(normalise("4.4 fl oz"))[0]?.precision).toBe(1);
  });
});

describe("word counting", () => {
  it("counts a token as one word", () => {
    expect(countWords("Try {{productName}} today")).toBe(3);
  });
});

describe("block truncation", () => {
  it("drops whole trailing blocks so raw_text stays the exact concatenation", () => {
    const big = { type: "paragraph" as const, text: "x".repeat(150_000) };
    const result = truncateBlocks([big, big, big]);
    expect(result.truncated).toBe(true);
    expect(result.rawText).toBe(result.blocks.map((b) => b.text).join("\n\n"));
  });
});
