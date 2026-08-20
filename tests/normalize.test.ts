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

/**
 * Regressions from the first real generation, where the spec lint reported "1, wh is
 * not in allowedSpecs" and "3 w is not in allowedSpecs". Both came from ordinary prose:
 * a trailing comma was absorbed into the number, and the next word's opening letters
 * were read as a unit. The model was then asked to fix fragments that did not exist.
 */
describe("extractNumbers does not manufacture units out of prose", () => {
  const find = (text: string, value: number) =>
    extractNumbers(normalise(text)).find((n) => n.value === value);

  it("does not read 'when' as watt-hours after a comma", () => {
    const n = find("In 1, when we started", 1);
    expect(n?.unit).toBeNull();
    expect(n?.raw).toBe("1");
  });

  it("does not read 'weeks' as watts", () => {
    const n = find("3 weeks later the barking stopped", 3);
    expect(n?.unit).toBeNull();
  });

  it("does not read an ordinary word starting with a unit letter as a unit", () => {
    expect(find("2 good nights of sleep", 2)?.unit).toBeNull();
    expect(find("5 minor adjustments", 5)?.unit).toBeNull();
  });

  it("still folds a spelled-out unit word, which is a real quantity", () => {
    // "hours" normalises to "h" — that IS a unit, unlike "weeks" or "good".
    expect(find("6 hours of quiet", 6)?.unit).toBe("h");
  });

  it("still reads a real unit that ends a word", () => {
    expect(find("works from 30 ft away", 30)?.unit).toBe("ft");
    expect(find("runs at 18W", 18)?.unit).toBe("W");
    expect(find("a 6000mAh battery", 6000)?.unit).toBe("mAh");
  });

  it("still reads thousands separators, tildes and trailing plus", () => {
    expect(find("1,284 households", 1284)?.value).toBe(1284);
    expect(find("50,000+ homes", 50000)?.approximate).toBe(true);
    expect(find("~400 g", 400)?.approximate).toBe(true);
  });

  it("does not merge a comma-separated list into one number", () => {
    // "1, 2" is two numbers, not the number 12.
    const values = extractNumbers(normalise("steps 1, 2 and 3")).map((n) => n.value);
    expect(values).toContain(1);
    expect(values).toContain(2);
    expect(values).not.toContain(12);
  });
});
