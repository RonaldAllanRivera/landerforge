import { describe, expect, it } from "vitest";
import { MODEL_CATALOGUE, PRICING } from "@/lib/shared/pricing";
import { DEFAULT_SETTINGS, effortFor, modelForTier, SettingsSchema } from "@/lib/shared/settings";

const valid = { ...DEFAULT_SETTINGS };

describe("settings validation", () => {
  it("accepts the shipped defaults", () => {
    expect(SettingsSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a model with no published price", () => {
    // An unpriced model still runs; every cost figure would then be computed against
    // the wrong rates and reported as fact.
    const result = SettingsSchema.safeParse({ ...valid, standard_model: "claude-sonnet-9" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("no published price");
  });

  it("rejects an unpriced fast model too, not just the standard one", () => {
    expect(SettingsSchema.safeParse({ ...valid, fast_model: "gpt-4" }).success).toBe(false);
  });

  it("accepts every model the settings UI offers", () => {
    // The dropdown and the validator must not disagree, or a listed option is unusable.
    for (const choice of MODEL_CATALOGUE) {
      expect(
        SettingsSchema.safeParse({ ...valid, standard_model: choice.id }).success,
        `${choice.id} is offered in the UI but rejected by the schema`,
      ).toBe(true);
    }
  });

  it("offers a price for every catalogue entry", () => {
    for (const choice of MODEL_CATALOGUE) {
      expect(PRICING[choice.id], `no price for ${choice.id}`).toBeDefined();
    }
  });

  it("bounds the call ceiling", () => {
    expect(SettingsSchema.safeParse({ ...valid, max_calls_per_run: 4 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...valid, max_calls_per_run: 501 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...valid, max_calls_per_run: 60 }).success).toBe(true);
  });

  it("rejects an effort level the API does not define", () => {
    expect(SettingsSchema.safeParse({ ...valid, effort: "maximum" }).success).toBe(false);
  });
});

describe("model and effort resolution", () => {
  it("uses the fast model only for a fast section", () => {
    expect(modelForTier(valid, "fast")).toBe(valid.fast_model);
    expect(modelForTier(valid, "standard")).toBe(valid.standard_model);
    // A section with no tier declared is standard, not fast.
    expect(modelForTier(valid, undefined)).toBe(valid.standard_model);
  });

  it("omits effort for a model that rejects the parameter", () => {
    // Haiku 4.5 reports every effort level unsupported and 400s if sent one.
    expect(effortFor(valid, "claude-haiku-4-5")).toBeUndefined();
  });

  it("sends effort for a model that accepts it", () => {
    expect(effortFor(valid, "claude-sonnet-5")).toEqual({ effort: "medium" });
    expect(effortFor({ ...valid, effort: "low" }, "claude-opus-5")).toEqual({ effort: "low" });
  });

  it("omits effort for an unrecognised model rather than guessing", () => {
    expect(effortFor(valid, "claude-something-new")).toBeUndefined();
  });
});
