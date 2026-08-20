import { describe, expect, it } from "vitest";
import { lintField } from "@/lib/shared/lints";
import { block, ctx, field, spec } from "./helpers";

const categories = (violations: ReturnType<typeof lintField>) => violations.map((v) => v.category);

describe("token lint", () => {
  it("rejects an unknown token", () => {
    const v = lintField(ctx("Buy {{producturl}} today"));
    expect(categories(v)).toContain("token");
  });

  it("rejects a case variant of a real token", () => {
    const v = lintField(ctx("Get {{clickurl}} now"));
    expect(v.some((x) => x.message.includes("unknown token"))).toBe(true);
  });

  it("requires a literal % after the discount token", () => {
    expect(
      lintField(ctx("Save {{discountValue}} today")).some((v) => v.message.includes("literal %")),
    ).toBe(true);
    expect(
      lintField(ctx("Save {{discountValue}}% today")).some((v) => v.message.includes("literal %")),
    ).toBe(false);
  });

  it("rejects a hardcoded price", () => {
    expect(
      lintField(ctx("Just $49.99 today")).some((v) => v.message.includes("hardcoded price")),
    ).toBe(true);
  });

  it("rejects the literal product name, including an unspaced alias", () => {
    const aliases = ["Pest Pulse Pro Solar", "PestPulsePro Solar"];
    const spaced = lintField(ctx("Try Pest Pulse Pro Solar", { productNameAliases: aliases }));
    const unspaced = lintField(ctx("Try PestPulsePro Solar", { productNameAliases: aliases }));
    expect(spaced.some((v) => v.message.includes("literal product name"))).toBe(true);
    expect(unspaced.some((v) => v.message.includes("literal product name"))).toBe(true);
  });

  it("rejects a legal-URL token — those belong to the Disclaimers resource", () => {
    expect(lintField(ctx("See [terms]({{terms_url}})")).some((v) => v.category === "token")).toBe(
      true,
    );
  });

  it("rejects an unbalanced conditional block", () => {
    expect(
      lintField(ctx("{{if:country=DE}}Impressum")).some((v) => v.message.includes("balance")),
    ).toBe(true);
  });

  it("rejects the literal XX placeholder but accepts a real country code", () => {
    expect(
      lintField(ctx("{{if:country=XX}}x{{endif}}")).some((v) => v.message.includes("XX")),
    ).toBe(true);
    expect(lintField(ctx("{{if:country=DE}}x{{endif}}")).some((v) => v.category === "token")).toBe(
      false,
    );
  });

  it("rejects a hardcoded year", () => {
    expect(lintField(ctx("Best of 2026")).some((v) => v.message.includes("hardcoded year"))).toBe(
      true,
    );
  });
});

describe("bold lint", () => {
  it("rejects two bold spans in one sentence", () => {
    expect(
      lintField(ctx("This is **very** and **also** bold.")).some((v) => v.category === "bold"),
    ).toBe(true);
  });

  it("allows bold in a markdownBold:false field — the markers are annotations", () => {
    const v = lintField(ctx("A **real** benefit.", { field: field({ markdownBold: false }) }));
    expect(categories(v)).not.toContain("bold");
  });
});

describe("link lint", () => {
  it("rejects a link to anything but {{clickURL}}", () => {
    const f = field({ linkPolicy: "free_anchor" });
    expect(
      lintField(ctx("[grab it](https://evil.test)", { field: f })).some(
        (v) => v.category === "link",
      ),
    ).toBe(true);
  });

  it("accepts free anchor text pointing at {{clickURL}}", () => {
    const f = field({ linkPolicy: "free_anchor" });
    const v = lintField(
      ctx("So [grab yours at {{discountValue}}% off]({{clickURL}}) today", { field: f }),
    );
    expect(categories(v)).not.toContain("link");
  });

  it("rejects a bare URL anywhere", () => {
    expect(
      lintField(ctx("Visit https://example.test now")).some((v) => v.category === "link"),
    ).toBe(true);
  });
});

describe("spec lint", () => {
  it("exempts a rhetorical integer under ten", () => {
    expect(categories(lintField(ctx("3 simple steps")))).not.toContain("spec");
  });

  it("requires a match for a bare integer of ten or more", () => {
    expect(lintField(ctx("487 verified reviews")).some((v) => v.category === "spec")).toBe(true);
  });

  it("accepts a sourced spec", () => {
    const v = lintField(
      ctx("Weighs 57 g (2 oz)", { allowedSpecs: [spec(57, "g"), spec(2, "oz")] }),
    );
    expect(categories(v)).not.toContain("spec");
  });

  it("accepts a correct conversion at the printed precision", () => {
    // 2 oz -> 56.699 g, which rounds to 57 at zero decimals.
    const v = lintField(ctx("Weighs 57 g (2 oz)", { allowedSpecs: [spec(2, "oz")] }));
    expect(categories(v)).not.toContain("spec");
  });

  it("matches a spelled-out source spec after normalisation", () => {
    // "two ounces" normalises to 2 oz, so a {value:2, unit:'oz'} entry matches.
    const v = lintField(ctx("It weighs two ounces", { allowedSpecs: [spec(2, "oz")] }));
    expect(categories(v)).not.toContain("spec");
  });

  it("does not read '1 in 3' as an inch measurement", () => {
    const v = lintField(ctx("1 in 3 customers agree"));
    expect(categories(v)).not.toContain("spec");
    expect(categories(v)).not.toContain("compliance");
  });

  it("is skipped entirely on a specPolicy:exempt field", () => {
    const f = field({ specPolicy: "exempt", key: "time_ago" });
    expect(categories(lintField(ctx("11 hours ago", { field: f })))).not.toContain("spec");
  });
});

describe("compliance lint", () => {
  it("requires a metric counterpart for an imperial figure", () => {
    const v = lintField(ctx("Weighs just 2 oz.", { allowedSpecs: [spec(2, "oz")] }));
    expect(v.some((x) => x.category === "compliance")).toBe(true);
  });

  it("accepts metric-first dual units for AREA — these sell outside the US", () => {
    const v = lintField(
      ctx("Covers 372 sq m (4,000 sq ft).", {
        allowedSpecs: [spec(4000, "sq ft"), spec(372, "sq m")],
      }),
    );
    expect(categories(v)).not.toContain("compliance");
  });

  it("rejects an absolute efficacy claim", () => {
    expect(lintField(ctx("It eliminates barking.")).some((v) => v.category === "compliance")).toBe(
      true,
    );
  });

  it("rejects a US-state testimonial location", () => {
    expect(
      lintField(ctx("Sarah from Texas loves it.")).some((v) => v.category === "compliance"),
    ).toBe(true);
  });
});

describe("verbatim lint", () => {
  const source = "the quick brown fox jumps over the lazy dog and then keeps running onward";

  it("flags a twelve-word lift", () => {
    const v = lintField(ctx(source, { blocks: [block(source)] }));
    expect(v.some((x) => x.category === "verbatim")).toBe(true);
  });

  it("ignores disclaimer blocks — the tool never generates footer copy", () => {
    const v = lintField(ctx(source, { blocks: [block(source, "disclaimer")] }));
    expect(categories(v)).not.toContain("verbatim");
  });
});

describe("scaffold lint", () => {
  const f = field({
    type: "scaffolded",
    lineTemplates: { positive: '- <span class="fa-li positive"></span> {copy}' },
  });

  it("rejects an unknown variant", () => {
    const v = lintField(ctx({ items: [{ variant: "nope", copy: "Fast" }] }, { field: f }));
    expect(v.some((x) => x.category === "scaffold")).toBe(true);
  });

  it("allows tokens inside a copy slot — production does exactly this", () => {
    const v = lintField(
      ctx(
        { items: [{ variant: "positive", copy: "{{discountValue}}% Discounted today" }] },
        { field: f },
      ),
    );
    expect(categories(v)).not.toContain("scaffold");
  });
});

describe("optional fields", () => {
  it("skips every lint when an optional field is absent", () => {
    const f = field({ optional: true, fallbackWordTarget: [10, 20] });
    expect(lintField(ctx("", { field: f }))).toHaveLength(0);
  });
});

/**
 * From the first real generation. The model wrote
 * "**Works from up to 30 ft (9.1 m) away**" and was told "30 ft needs a metric
 * counterpart in m earlier in the sentence". A counterpart was right there, so the
 * message read as simply wrong and the text went unchanged through all three
 * corrective attempts — $0.19 of retries buying the same output.
 */
describe("dual-unit feedback names the actual problem", () => {
  const dual = (text: string) => lintField(ctx(text)).filter((v) => v.category === "compliance");

  it("says imperial-first, not missing, when the metric value follows", () => {
    const v = dual("Works from up to 30 ft (9.1 m) away.");
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("imperial-first");
    expect(v[0]?.message).not.toContain("needs a metric counterpart");
  });

  it("shows the corrected ordering the model should write", () => {
    expect(dual("Works from up to 30 ft (9.1 m) away.")[0]?.message).toContain("9.1 m (30 ft)");
  });

  it("still reports a genuinely absent counterpart as missing", () => {
    const v = dual("Works from up to 30 ft away.");
    expect(v[0]?.message).toContain("needs a metric counterpart");
  });

  it("accepts metric-first", () => {
    expect(dual("Works from up to 9.1 m (30 ft) away.")).toHaveLength(0);
  });
});
