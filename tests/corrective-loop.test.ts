import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCorrectiveFeedback,
  isActionable,
  runCorrectiveLoop,
  sectionStatus,
} from "@/lib/shared/corrective";
import type { Violation } from "@/lib/shared/lints";
import { parseManifest } from "@/lib/shared/manifest";
import { validateSection } from "@/lib/shared/validate-section";

/**
 * Phase 3's outstanding piece: the corrective loop exercised against seeded bad output.
 *
 * The model is a script here, not an API call — the loop's job is control flow, and the
 * expensive way to test control flow is to buy a generation for every branch. What is
 * NOT faked is the validator: these fixtures go through the real `validateSection`
 * against the real Advertorial manifest, so a lint that stops firing breaks these tests.
 */

const manifest = parseManifest(
  JSON.parse(readFileSync(join(process.cwd(), "manifests/advertorial_v1.json"), "utf8")),
);

const context = {
  manifest,
  allowedSpecs: [{ label: "range", value: 9, unit: "m", origin: "source" as const }],
  sectionPlan: [],
  blocks: [],
};

const validateCta = (output: Record<string, unknown>) => validateSection(context, "cta", output);

/** Copy that passes every lint, for the attempt where the model gets it right. */
const CLEAN = {
  cta_button_text: "Claim Your {{discountValue}}% Discount Now",
  mobile_cta_text: "Shop Now",
};

/** The real failure from a real run: the token without its literal percent sign. */
const MISSING_PERCENT = {
  cta_button_text: "Claim Your {{discountValue}} Discount Now",
  mobile_cta_text: "Shop Now",
};

describe("the seeded fixtures still trip the validator", () => {
  it("passes clean copy", () => {
    expect(validateCta(CLEAN)).toEqual([]);
  });

  it("catches a discount token with no percent sign", () => {
    const violations = validateCta(MISSING_PERCENT);
    expect(violations.some((v) => v.category === "token")).toBe(true);
  });

  it("catches a hardcoded price", () => {
    const violations = validateCta({ ...CLEAN, cta_button_text: "Only $49 today" });
    expect(violations.some((v) => v.message.includes("hardcoded price"))).toBe(true);
  });

  it("catches a literal product name", () => {
    const violations = validateSection({ ...context, productNameAliases: ["NoBarkUltra"] }, "cta", {
      ...CLEAN,
      cta_button_text: "Get NoBarkUltra Now",
    });
    expect(violations.some((v) => v.message.includes("literal product name"))).toBe(true);
  });
});

describe("the loop converges", () => {
  it("stops after one call when the first attempt is clean", async () => {
    const attempt = vi.fn().mockResolvedValue(CLEAN);
    const result = await runCorrectiveLoop({ maxRetries: 2, attempt, validate: validateCta });

    expect(result.attempts).toBe(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sectionStatus(result.violations)).toBe("done");
  });

  it("retries once and stops when the model fixes it", async () => {
    const attempt = vi.fn().mockResolvedValueOnce(MISSING_PERCENT).mockResolvedValueOnce(CLEAN);
    const result = await runCorrectiveLoop({ maxRetries: 2, attempt, validate: validateCta });

    expect(result.attempts).toBe(2);
    expect(sectionStatus(result.violations)).toBe("done");
  });

  it("hands the previous violations to the next attempt", async () => {
    // Without this the retry is the identical call and the loop is just a bill.
    const seen: Violation[][] = [];
    const attempt = vi.fn(async (previous: readonly Violation[]) => {
      seen.push([...previous]);
      return seen.length === 1 ? MISSING_PERCENT : CLEAN;
    });
    await runCorrectiveLoop({ maxRetries: 2, attempt, validate: validateCta });

    expect(seen[0]).toEqual([]);
    expect(seen[1]?.some((v) => v.category === "token")).toBe(true);
  });
});

describe("the loop gives up", () => {
  it("spends exactly the retry budget on copy that never improves", async () => {
    const attempt = vi.fn().mockResolvedValue(MISSING_PERCENT);
    const result = await runCorrectiveLoop({ maxRetries: 2, attempt, validate: validateCta });

    // One first attempt plus two corrective ones, and not a call more.
    expect(result.attempts).toBe(3);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sectionStatus(result.violations)).toBe("flagged");
  });

  it("keeps the last output rather than discarding the section", async () => {
    const attempt = vi.fn().mockResolvedValue(MISSING_PERCENT);
    const result = await runCorrectiveLoop({ maxRetries: 2, attempt, validate: validateCta });
    expect(result.output).toEqual(MISSING_PERCENT);
  });

  it("respects a retry budget of zero", async () => {
    const attempt = vi.fn().mockResolvedValue(MISSING_PERCENT);
    const result = await runCorrectiveLoop({ maxRetries: 0, attempt, validate: validateCta });
    expect(result.attempts).toBe(1);
  });
});

describe("the loop does not waste calls on what the model cannot fix", () => {
  const internalOnly: Violation[] = [
    { category: "internal", address: "cta.cta_button_text", message: "a check failed to run" },
  ];

  it("stops immediately when only internal violations remain", async () => {
    const attempt = vi.fn().mockResolvedValue(CLEAN);
    const result = await runCorrectiveLoop({
      maxRetries: 2,
      attempt,
      validate: () => internalOnly,
    });

    expect(result.attempts).toBe(1);
    expect(sectionStatus(result.violations)).toBe("flagged");
  });

  it("still retries when an actionable violation sits alongside an internal one", async () => {
    const mixed: Violation[] = [
      ...internalOnly,
      { category: "token", address: "cta.cta_button_text", message: "needs a literal %" },
    ];
    let call = 0;
    const attempt = vi.fn().mockResolvedValue(CLEAN);
    await runCorrectiveLoop({
      maxRetries: 2,
      attempt,
      validate: () => (++call === 1 ? mixed : []),
    });
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe("what the model is told", () => {
  it("quotes category, address, message and excerpt", () => {
    const feedback = buildCorrectiveFeedback([
      {
        category: "token",
        address: "cta.cta_button_text",
        message: "{{discountValue}} must be followed by a literal %",
        excerpt: "Claim Your {{discountValue}} Discount Now",
      },
    ]);
    expect(feedback).toContain("[token] cta.cta_button_text");
    expect(feedback).toContain("must be followed by a literal %");
    expect(feedback).toContain('"Claim Your {{discountValue}} Discount Now"');
    expect(feedback).toContain("Fix every one");
  });

  it("says nothing at all when there is nothing actionable", () => {
    // An identical prompt keeps the cached prefix intact.
    expect(buildCorrectiveFeedback([])).toBe("");
    expect(
      buildCorrectiveFeedback([
        { category: "internal", address: "cta.x", message: "a check failed to run" },
      ]),
    ).toBe("");
  });

  it("omits the quote when a violation has no excerpt", () => {
    const feedback = buildCorrectiveFeedback([
      { category: "word_count", address: "cta.cta_button_text", message: "3 words, expected 5–6" },
    ]);
    expect(feedback).not.toContain('""');
  });

  it("lists every actionable violation, not just the first", () => {
    const feedback = buildCorrectiveFeedback([
      { category: "token", address: "a.b", message: "one" },
      { category: "spec", address: "a.c", message: "two" },
    ]);
    expect(feedback.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
  });
});

describe("isActionable", () => {
  it("treats every copy category as actionable and internal as not", () => {
    for (const category of ["token", "spec", "word_count", "bold", "verbatim"] as const) {
      expect(isActionable({ category, address: "a.b", message: "m" })).toBe(true);
    }
    expect(isActionable({ category: "internal", address: "a.b", message: "m" })).toBe(false);
  });
});
