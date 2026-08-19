import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest } from "@/lib/shared/manifest";

const DIR = join(process.cwd(), "manifests");

describe("seeded manifests", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

  it("ships at least one manifest", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} round-trips through the Zod schema`, () => {
      const parsed = parseManifest(JSON.parse(readFileSync(join(DIR, file), "utf8")));
      expect(parsed.sections.length).toBeGreaterThan(0);
    });

    it(`${file} declares no disclaimer field — the footer is never generated`, () => {
      const parsed = parseManifest(JSON.parse(readFileSync(join(DIR, file), "utf8")));
      const keys = parsed.sections.flatMap((s) => s.fields.map((f) => `${s.id}.${f.key}`));
      expect(keys.filter((k) => /disclaimer|footer/i.test(k))).toEqual([]);
    });
  }
});

describe("manifest refinements", () => {
  const scaffoldedField = {
    key: "f",
    label: "F",
    type: "scaffolded",
    generate: true,
    markdownBold: true,
    productNameFormat: "plain",
    linkPolicy: "none",
    voice: "brand_we",
  };
  const wrap = (field: Record<string, unknown>) => ({
    slug: "advertorial_v1",
    name: "x",
    sections: [{ id: "s", label: "S", defaultPresent: true, fields: [field] }],
  });

  it("rejects a scaffolded field with no lineTemplates", () => {
    expect(() => parseManifest(wrap(scaffoldedField))).toThrow();
  });

  it("rejects linking a product name the field must not contain", () => {
    expect(() =>
      parseManifest(
        wrap({
          ...scaffoldedField,
          type: "text",
          productNameFormat: "none",
          linkPolicy: "product_name",
        }),
      ),
    ).toThrow();
  });

  it("rejects a display field marked generate", () => {
    expect(() =>
      parseManifest(wrap({ ...scaffoldedField, type: "display", generate: true })),
    ).toThrow();
  });
});
