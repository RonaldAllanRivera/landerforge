import { describe, expect, it } from "vitest";
import { lintField } from "@/lib/shared/lints";
import { plainText } from "@/lib/shared/lints/types";
import type { TemplateSection } from "@/lib/shared/manifest";
import { outputContract } from "@/lib/shared/output-contract";
import { parseList, renderFieldValue } from "@/lib/shared/section-io";
import { ctx, field } from "./helpers";

/**
 * The Comparison template's Pros and Cons: a list of single-line strings, each its own
 * input in the CMS. Inside a REPEATING section the value is string[][] — one array of
 * entries per competitor — which is the shape that breaks things quietly.
 */
const pros = field({ key: "pros", type: "list", fallbackItemCount: 4 });

describe("editing a list", () => {
  it("shows one entry per line", () => {
    expect(renderFieldValue(pros, ["Adjusts automatically", "Stays sharp"])).toBe(
      "Adjusts automatically\nStays sharp",
    );
  });

  it("parses the lines back into entries", () => {
    expect(parseList("Adjusts automatically\nStays sharp")).toEqual([
      "Adjusts automatically",
      "Stays sharp",
    ]);
  });

  it("drops blank lines rather than creating empty entries", () => {
    expect(parseList("a\n\n  \nb\n")).toEqual(["a", "b"]);
  });

  it("round-trips", () => {
    const entries = ["One pair covers near and far", "Built-in blue light protection"];
    expect(parseList(renderFieldValue(pros, entries))).toEqual(entries);
  });

  it("does not JSON-dump an array it was handed", () => {
    // The generic branch stringifies, which would put brackets and quotes in a textarea.
    expect(renderFieldValue(pros, ["a", "b"])).not.toContain("[");
  });
});

describe("a list inside a repeating section", () => {
  const nested = [
    ["Switches focus with a swipe", "App sets reading strength"],
    ["Very expensive", "Needs charging"],
  ];

  it("counts words across every entry of every instance", () => {
    // Array#join would stringify the inner arrays with commas and fuse words together.
    const text = plainText(nested);
    expect(text).not.toContain(",");
    expect(text.split("\n")).toHaveLength(4);
  });

  it("checks item count per instance, not by counting instances", () => {
    // Counting the outer array reports "2 items, expected 2" on a section that has two
    // entries per competitor — right number, wrong thing measured.
    const v = lintField(
      // biome-ignore lint/suspicious/noExplicitAny: the shape is the point of the test.
      ctx(nested as any, { field: field({ key: "pros", type: "list", fallbackItemCount: 2 }) }),
    );
    expect(v.filter((x) => x.category === "item_count")).toHaveLength(0);
  });

  it("names the offending instance when one is short", () => {
    const short = [["only one"], ["a", "b"]];
    const v = lintField(
      // biome-ignore lint/suspicious/noExplicitAny: the shape is the point of the test.
      ctx(short as any, { field: field({ key: "pros", type: "list", fallbackItemCount: 2 }) }),
    );
    expect(v.some((x) => x.message.includes("entry 1 has 1 items"))).toBe(true);
    expect(v.some((x) => x.message.includes("entry 2"))).toBe(false);
  });
});

describe("the contract for a list", () => {
  const winner = {
    id: "winner",
    label: "Winner",
    defaultPresent: true,
    fields: [
      field({ key: "pros", type: "list", fallbackItemCount: 9, fallbackWordTarget: [55, 80] }),
    ],
  } as unknown as TemplateSection;

  it("asks for an array of lines, not a markdown blob", () => {
    const out = outputContract(winner, undefined);
    expect(out).toContain('"pros": [ "<one line>", … ]');
    expect(out).toContain("no bullet characters");
  });

  it("states the item count", () => {
    expect(outputContract(winner, undefined)).toContain("9 items");
  });

  it("says 'word' not 'words' when the per-entry figure is one", () => {
    const bars = {
      id: "scorecard_bars",
      label: "Scorecard Bars",
      defaultPresent: true,
      repeat: [3, 6],
      fields: [field({ key: "label", type: "text", fallbackWordTarget: [2, 4] })],
    } as unknown as TemplateSection;
    expect(outputContract(bars, undefined)).not.toContain("1 words each");
  });
});

describe("the shape gate and list fields", () => {
  const lint = (value: unknown) =>
    // biome-ignore lint/suspicious/noExplicitAny: the shape is what is under test.
    lintField(ctx(value as any, { field: pros }));

  it("accepts a flat array of lines", () => {
    expect(lint(["a", "b"]).filter((v) => v.category === "scaffold")).toHaveLength(0);
  });

  it("accepts one array of lines per instance", () => {
    expect(lint([["a"], ["b", "c"]]).filter((v) => v.category === "scaffold")).toHaveLength(0);
  });

  it("rejects a markdown blob where a list belongs", () => {
    // The model reaching for "- a\n- b" is the likely mistake, and it has to be told.
    const v = lint("- a\n- b");
    expect(v.some((x) => x.message.includes("array of single-line strings"))).toBe(true);
  });

  it("rejects entries that are not strings", () => {
    expect(lint([{ copy: "a" }]).some((x) => x.category === "scaffold")).toBe(true);
  });
});
