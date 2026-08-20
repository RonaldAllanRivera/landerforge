import { z } from "zod";

/**
 * Project identity — the pure half.
 *
 * A project name is a handle, not prose: it goes in a dropdown, it is how somebody
 * finds last month's work, and it has to be unique. Normalising here keeps the
 * application's idea of "the same name" identical to the database's, which indexes on
 * `lower(btrim(name))`.
 */

export const PROJECT_NAME_MAX = 80;

/** Collapse runs of whitespace and trim. "  Breeze   box " -> "Breeze box". */
export function normaliseProjectName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** Two names collide when the database would consider them equal. */
export function sameProjectName(a: string, b: string): boolean {
  return normaliseProjectName(a).toLowerCase() === normaliseProjectName(b).toLowerCase();
}

export const CreateProjectInput = z.object({
  name: z
    .string()
    .transform(normaliseProjectName)
    .pipe(
      z
        .string()
        .min(2, "Give the project a name of at least two characters.")
        .max(PROJECT_NAME_MAX, `Keep the name under ${PROJECT_NAME_MAX} characters.`),
    ),
  product_name: z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1, "The product name is required — it is what the copy is about.")),
  /** Comma-separated in the form; one real page uses two spellings of its own name. */
  product_name_aliases: z.array(z.string()).default([]),
  niche: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

export type CreateProjectInput = z.input<typeof CreateProjectInput>;
export type CreateProjectValues = z.output<typeof CreateProjectInput>;

/** "a, b , ,c" -> ["a","b","c"]. Empty entries are a typo, not an alias. */
export function parseAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => normaliseProjectName(v))
    .filter((v) => v.length > 0);
}
