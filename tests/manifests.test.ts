import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest, type TemplateManifest } from "@/lib/shared/manifest";

/**
 * Every shipped manifest, checked against the rules the schema cannot express.
 *
 * These are data files that reach production through a seed script, so a mistake in one
 * surfaces at generation time as strange output rather than as an error. The invariants
 * below are the ones that would otherwise fail silently — a selector pointing at a field
 * that does not exist yields no hints and no complaint, and a repeating section where
 * nothing repeats yields one instance forever.
 */
const DIR = join(process.cwd(), "manifests");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

const loaded: Array<[string, TemplateManifest]> = files.map((file) => [
  file,
  parseManifest(JSON.parse(readFileSync(join(DIR, file), "utf8"))),
]);

it("ships every template the schema reserves a slug for", () => {
  expect(loaded.map(([, m]) => m.slug).sort()).toEqual([
    "advertorial_v1",
    "comparison_v1",
    "interstitial_v1",
    "reasons_v1",
  ]);
});

describe.each(loaded)("%s", (file, manifest) => {
  it("is named after its slug, so seeding cannot silently overwrite another", () => {
    expect(file).toBe(`${manifest.slug}.json`);
  });

  it("has no duplicate field keys inside a section", () => {
    for (const section of manifest.sections) {
      const keys = section.fields.map((f) => f.key);
      expect(new Set(keys).size, `${section.id} repeats a key`).toBe(keys.length);
    }
  });

  it("has no duplicate section ids", () => {
    const ids = manifest.sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every repeating section something that actually repeats", () => {
    // All fields marked repeats:false would render one instance and never grow.
    for (const section of manifest.sections) {
      if (!section.repeat) continue;
      const varying = section.fields.filter((f) => f.generate && f.repeats !== false);
      expect(varying.length, `${section.id} repeats but nothing in it varies`).toBeGreaterThan(0);
    }
  });

  it("keeps repeat bounds sane", () => {
    for (const section of manifest.sections) {
      if (!section.repeat) continue;
      const [min, max] = section.repeat;
      expect(min, `${section.id}`).toBeGreaterThan(0);
      expect(max, `${section.id}`).toBeGreaterThanOrEqual(min);
    }
  });

  it("orders every word target low to high", () => {
    for (const section of manifest.sections) {
      for (const field of section.fields) {
        const target = field.fallbackWordTarget;
        if (!target) continue;
        expect(target[0], `${section.id}.${field.key}`).toBeGreaterThan(0);
        expect(target[1], `${section.id}.${field.key}`).toBeGreaterThanOrEqual(target[0]);
      }
    }
  });

  it("declares what every non-generated field looks like", () => {
    // Without displayKind the review screen cannot tell a toggle from an image slot.
    for (const section of manifest.sections) {
      for (const field of section.fields) {
        if (field.type !== "display") continue;
        expect(field.displayKind, `${section.id}.${field.key}`).toBeDefined();
      }
    }
  });

  it("gives every scaffolded field its line templates", () => {
    for (const section of manifest.sections) {
      for (const field of section.fields) {
        if (field.type !== "scaffolded") continue;
        expect(
          Object.keys(field.lineTemplates ?? {}).length,
          `${section.id}.${field.key}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("never asks the model to write a field it does not generate", () => {
    for (const section of manifest.sections) {
      for (const field of section.fields) {
        if (field.generate) continue;
        expect(field.fallbackWordTarget, `${section.id}.${field.key}`).toBeUndefined();
      }
    }
  });

  it("points every selector at a field that exists", () => {
    // A typo here produces no hints and no error — the brief just guesses instead.
    for (const [selector, target] of Object.entries(manifest.selectors ?? {})) {
      const [sectionId, fieldKey] = target.split(".");
      const section = manifest.sections.find((s) => s.id === sectionId);
      expect(section, `${selector} -> unknown section "${sectionId}"`).toBeDefined();
      expect(
        section?.fields.some((f) => f.key === fieldKey),
        `${selector} -> ${sectionId} has no field "${fieldKey}"`,
      ).toBe(true);
    }
  });

  it("generates something", () => {
    const generated = manifest.sections.flatMap((s) => s.fields.filter((f) => f.generate));
    expect(generated.length).toBeGreaterThan(0);
  });
});
