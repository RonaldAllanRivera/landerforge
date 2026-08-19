/**
 * Idempotent manifest seed, keyed on templates.slug.
 *
 * The repo is the source of truth for manifests: they get code review, history, and
 * survive losing the database. "DB edit, no deploy" means edit the file and re-run
 * this — still no deploy.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { parseManifest } from "../src/lib/shared/manifest";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required");

const db = createClient(url, key, { auth: { persistSession: false } });
const dir = join(process.cwd(), "manifests");

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  // Validate before writing: a malformed manifest should fail here, loudly, rather
  // than at generation time.
  const manifest = parseManifest(JSON.parse(readFileSync(join(dir, file), "utf8")));
  const { error } = await db
    .from("templates")
    .upsert({ slug: manifest.slug, name: manifest.name, manifest }, { onConflict: "slug" });
  if (error) throw new Error(`${file}: ${error.message}`);
  console.log(`seeded ${manifest.slug} (${manifest.sections.length} sections)`);
}
