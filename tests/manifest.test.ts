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

    /**
     * The page footer and the legal disclaimers belong to the CMS's own Disclaimers
     * resource, which this tool never writes. Interstitial V1 has a Footer panel in its
     * CMS nav and it is deliberately absent from the manifest.
     *
     * Scoped to the footer SECTION and to the word "disclaimer" rather than to the
     * substring "footer" anywhere. The loose version flagged `cta.cta_footer_text`,
     * which is the reassurance line under the CTA button — "{{guaranteeDays}}-Day
     * Money-Back Guarantee" — and is ordinary CTA copy in the CTA panel.
     */
    it(`${file} generates no footer section and no disclaimer field`, () => {
      const parsed = parseManifest(JSON.parse(readFileSync(join(DIR, file), "utf8")));
      const offenders = parsed.sections.flatMap((s) =>
        s.fields
          .filter((f) => f.generate)
          .filter((f) => /^footer$/i.test(s.id) || /disclaimer/i.test(`${f.key} ${f.label}`))
          .map((f) => `${s.id}.${f.key}`),
      );
      expect(offenders).toEqual([]);
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

describe("the footer rule is scoped, not a substring match", () => {
  it("still refuses a generated field in a footer section", () => {
    const manifest = {
      slug: "advertorial_v1",
      name: "T",
      sections: [
        {
          id: "footer",
          label: "Footer",
          defaultPresent: true,
          fields: [
            {
              key: "small_print",
              label: "Small Print",
              type: "text",
              generate: true,
              markdownBold: false,
              productNameFormat: "none",
              linkPolicy: "none",
              voice: "brand_we",
            },
          ],
        },
      ],
    };
    const parsed = parseManifest(manifest);
    const offenders = parsed.sections.flatMap((s) =>
      s.fields
        .filter((f) => f.generate)
        .filter((f) => /^footer$/i.test(s.id) || /disclaimer/i.test(`${f.key} ${f.label}`))
        .map((f) => `${s.id}.${f.key}`),
    );
    expect(offenders).toEqual(["footer.small_print"]);
  });
});
