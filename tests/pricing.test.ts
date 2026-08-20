import { describe, expect, it } from "vitest";
import {
  cacheHit,
  cacheInert,
  costUsd,
  DEFAULT_MODEL,
  MIN_CACHEABLE_TOKENS,
  PRICING,
} from "@/lib/shared/pricing";

const usage = (o: Partial<Parameters<typeof costUsd>[0]> = {}) => ({
  input_tokens: 0,
  output_tokens: 0,
  ...o,
});

describe("costUsd", () => {
  it("prices plain input and output at the published rate", () => {
    // Sonnet 5: $2/MTok in, $10/MTok out.
    expect(costUsd(usage({ input_tokens: 1_000_000 }), "claude-sonnet-5")).toBeCloseTo(2, 10);
    expect(costUsd(usage({ output_tokens: 1_000_000 }), "claude-sonnet-5")).toBeCloseTo(10, 10);
  });

  it("derives the 5-minute cache write at 1.25x input", () => {
    expect(
      costUsd(usage({ cache_creation_input_tokens: 1_000_000 }), "claude-sonnet-5"),
    ).toBeCloseTo(2.5, 10);
  });

  it("derives the cache read at 0.1x input", () => {
    expect(costUsd(usage({ cache_read_input_tokens: 1_000_000 }), "claude-sonnet-5")).toBeCloseTo(
      0.2,
      10,
    );
  });

  it("sums all four components rather than treating input_tokens as the total", () => {
    const measured = usage({
      input_tokens: 347,
      output_tokens: 14_963,
      cache_creation_input_tokens: 11_630,
      cache_read_input_tokens: 3_871,
    });
    const expected = (347 * 2 + 14_963 * 10 + 11_630 * 2 * 1.25 + 3_871 * 2 * 0.1) / 1_000_000;
    expect(costUsd(measured, "claude-sonnet-5")).toBeCloseTo(expected, 12);
  });

  it("prices Haiku at half of Sonnet 5", () => {
    const u = usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(costUsd(u, "claude-haiku-4-5")).toBeCloseTo(costUsd(u, "claude-sonnet-5") / 2, 10);
  });

  it("still prices Sonnet 4.6 correctly, since old rows keep their recorded model", () => {
    expect(costUsd(usage({ input_tokens: 1_000_000 }), "claude-sonnet-4-6")).toBeCloseTo(3, 10);
  });

  it("falls back to the default model rather than returning zero for an unknown one", () => {
    const u = usage({ input_tokens: 1_000_000 });
    expect(costUsd(u, "claude-something-unreleased")).toBe(costUsd(u, DEFAULT_MODEL));
    expect(costUsd(u, "claude-something-unreleased")).toBeGreaterThan(0);
  });

  it("treats null cache fields as zero, not NaN", () => {
    const cost = costUsd(
      {
        input_tokens: 100,
        output_tokens: 100,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
      "claude-sonnet-5",
    );
    expect(Number.isFinite(cost)).toBe(true);
  });
});

describe("cache diagnostics", () => {
  it("separates a read from an inert breakpoint", () => {
    expect(cacheHit(usage({ cache_read_input_tokens: 3871 }))).toBe(true);
    expect(cacheInert(usage({ cache_read_input_tokens: 3871 }))).toBe(false);
    // A write with no read is a miss, but the breakpoint DID work.
    expect(cacheInert(usage({ cache_creation_input_tokens: 11_435 }))).toBe(false);
    // Neither: the prefix never reached the model's minimum.
    expect(cacheInert(usage())).toBe(true);
  });
});

describe("cache minimums", () => {
  it("records Haiku's minimum as four times Sonnet's — the silent-failure trap", () => {
    expect(MIN_CACHEABLE_TOKENS["claude-haiku-4-5"]).toBe(4096);
    expect(MIN_CACHEABLE_TOKENS["claude-sonnet-5"]).toBe(1024);
  });

  it("has a price and a minimum for every model it lists", () => {
    for (const model of Object.keys(PRICING)) {
      expect(MIN_CACHEABLE_TOKENS[model], `no minimum for ${model}`).toBeDefined();
    }
  });
});
