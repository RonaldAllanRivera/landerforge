import { describe, expect, it } from "vitest";
import { unverifiedSourceSpecs } from "@/lib/shared/spec-guard";

const spec = (value: number, origin = "source", label = `spec ${value}`) => ({
  label,
  value,
  origin,
});

/**
 * The guard is the anti-fabrication rule, and it stops a run outright — so a false
 * positive is not a warning, it is a paid-for generation thrown away at the brief.
 */
describe("source spec verification", () => {
  it("passes a number that is plainly in the source", () => {
    expect(unverifiedSourceSpecs([spec(30)], "works from up to 30 ft away")).toEqual([]);
  });

  it("passes a number the page writes with thousands separators", () => {
    // The failure that killed a real run: the page says "1,500", the brief correctly
    // records 1500, and a substring match finds nothing.
    expect(unverifiedSourceSpecs([spec(1500)], "trusted by 1,500 families")).toEqual([]);
    expect(unverifiedSourceSpecs([spec(4000)], "covers 4,000 sq ft")).toEqual([]);
  });

  it("passes a number the page spells out", () => {
    expect(unverifiedSourceSpecs([spec(2)], "weighs just two ounces")).toEqual([]);
  });

  it("passes a decimal written with trailing zeros", () => {
    expect(unverifiedSourceSpecs([spec(9.8)], "rated 9.80 out of 10")).toEqual([]);
  });

  it("still catches a number that is genuinely not there", () => {
    expect(unverifiedSourceSpecs([spec(99, "source", "made up")], "no digits here")).toEqual([
      "made up",
    ]);
  });

  it("does not check specs the brief attributes elsewhere", () => {
    // user_notes and conversion have their own provenance; only "source" claims the page.
    expect(unverifiedSourceSpecs([spec(99, "user_notes"), spec(98, "conversion")], "")).toEqual([]);
  });

  it("reports every offender, not just the first", () => {
    const result = unverifiedSourceSpecs(
      [spec(1, "source", "a"), spec(2, "source", "b")],
      "nothing numeric",
    );
    expect(result).toEqual(["a", "b"]);
  });

  it("fails everything when there is no source text at all", () => {
    expect(unverifiedSourceSpecs([spec(30, "source", "range")], "")).toEqual(["range"]);
  });

  it("does not accept a digit that only appears inside a longer number", () => {
    // "30" appears inside "300", but the page never claims 30.
    expect(unverifiedSourceSpecs([spec(30, "source", "range")], "covers 300 homes")).toEqual([
      "range",
    ]);
  });
});
