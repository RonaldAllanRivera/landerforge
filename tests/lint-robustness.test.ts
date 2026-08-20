import { describe, expect, it, vi } from "vitest";
import { LINTS, lintField, runLints } from "@/lib/shared/lints";
import { ctx, field } from "./helpers";

/**
 * Regressions from the first real generation.
 *
 * The model returned a scaffolded field whose items had no `copy` key. The scaffold
 * lint dereferenced it, and because `validateSection` runs outside `step.run`, the
 * TypeError escaped as a 500. Inngest retried, replayed the memoized steps, and threw
 * again — the run wedged in `generating` permanently, after the copy had been paid for.
 *
 * Every case here is a shape the model actually can and did emit. `lintField` must
 * return a violation for each one, and must never throw.
 */

const scaffolded = field({
  key: "benefits_list",
  type: "scaffolded",
  lineTemplates: { check: "✓ {copy}", plain: "{copy}" },
});

const lintScaffold = (value: unknown) =>
  // biome-ignore lint/suspicious/noExplicitAny: the point is that the value is untyped.
  lintField(ctx(value as any, { field: scaffolded, address: "sidebar.benefits_list" }));

describe("lintField shape gate", () => {
  it("does not throw when scaffold items are missing the copy key", () => {
    const v = lintScaffold({ items: [{ variant: "check", text: "30 m range" }] });
    expect(v).toHaveLength(1);
    expect(v[0]?.category).toBe("scaffold");
    expect(v[0]?.message).toContain("copy");
  });

  it("does not throw when items is absent entirely", () => {
    expect(() => lintScaffold({ benefits: ["a", "b"] })).not.toThrow();
    expect(lintScaffold({ benefits: ["a", "b"] })[0]?.category).toBe("scaffold");
  });

  it("does not throw when items holds bare strings instead of objects", () => {
    const v = lintScaffold({ items: ["30 m range", "humane"] });
    expect(v).toHaveLength(1);
    expect(v[0]?.category).toBe("scaffold");
  });

  it("names the permitted variants, so the retry has something to act on", () => {
    const v = lintScaffold({ items: [{ variant: "check" }] });
    expect(v[0]?.message).toContain("check | plain");
  });

  it("quotes the offending value back, truncated", () => {
    const v = lintScaffold({ items: [{ variant: "check", copy: 42 }] });
    expect(v[0]?.excerpt).toBeDefined();
    expect((v[0]?.excerpt ?? "").length).toBeLessThanOrEqual(200);
  });

  it("accepts a well-formed scaffolded value", () => {
    const v = lintScaffold({ items: [{ variant: "check", copy: "Works up to 9 m (30 ft)" }] });
    expect(v.filter((x) => x.category === "scaffold")).toHaveLength(0);
  });

  it("reports an object where a prose field expects a string", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately the wrong shape.
    const v = lintField(ctx({ body: "text" } as any));
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("must emit a string");
  });

  it("treats a null required value as malformed rather than crashing", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately the wrong shape.
    expect(() => lintField(ctx(null as any))).not.toThrow();
  });

  it("flags a malformed OPTIONAL field rather than mistaking it for absent", () => {
    const optional = field({
      key: "benefits_list",
      type: "scaffolded",
      optional: true,
      lineTemplates: { check: "{copy}" },
    });
    // biome-ignore lint/suspicious/noExplicitAny: deliberately the wrong shape.
    const v = lintField(ctx({ benefits: ["a"] } as any, { field: optional }));
    expect(v).toHaveLength(1);
    expect(v[0]?.category).toBe("scaffold");
  });

  it("still treats an explicitly empty optional item list as absent", () => {
    const optional = field({
      key: "benefits_list",
      type: "scaffolded",
      optional: true,
      lineTemplates: { check: "{copy}" },
    });
    // biome-ignore lint/suspicious/noExplicitAny: shape is checked at runtime.
    expect(lintField(ctx({ items: [] } as any, { field: optional }))).toHaveLength(0);
  });

  it("still skips an absent optional field", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately the wrong shape.
    expect(lintField(ctx(null as any, { field: field({ optional: true }) }))).toHaveLength(0);
  });
});

describe("lintField crash containment", () => {
  it("converts a throwing lint into an internal violation instead of a 500", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    // The exact failure from the real run: a lint dereferencing a key that is absent.
    const exploding = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'includes')");
    };

    try {
      const v = runLints(ctx("Some perfectly ordinary copy."), [exploding]);
      expect(v).toHaveLength(1);
      expect(v[0]?.category).toBe("internal");
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps the violations from lints that did succeed", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const exploding = () => {
      throw new Error("boom");
    };
    try {
      const v = runLints(ctx("Buy {{producturl}} today"), [
        exploding,
        ...LINTS.filter((l) => l.name === "tokenLint"),
      ]);
      expect(v.map((x) => x.category)).toContain("internal");
      expect(v.map((x) => x.category)).toContain("token");
    } finally {
      errorLog.mockRestore();
    }
  });
});
