/**
 * Drive one real generation against local Supabase, without a browser sign-in.
 *
 * Usage:  pnpm run dev:generate [sourceUrl]
 *
 * The app and the Inngest dev server must both be running (`make dev`). The source page
 * is fetched here and stored already extracted, so the run does not need a Browserless
 * token; the worker skips scraping for a source already at status 'ok', which is the
 * genuine cache-reuse path rather than a bypass.
 */
import { createClient } from "@supabase/supabase-js";
import { extractBlocks } from "@/lib/scrape/extract";
import { parseManifest } from "@/lib/shared/manifest";
import { loadEnv } from "../supabase/load-env";

loadEnv();

const DEFAULT_URL =
  "https://buybarkcontrol.com/trending/goodbye-barking-how-one-button-instantly-brought-the-zen-back-to-my-home";
const INNGEST_URL = process.env.INNGEST_DEV_URL ?? "http://localhost:8288/e/local";

// Some hosts serve a challenge page to an unfamiliar agent.
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function main() {
  const sourceUrl = process.argv[2] ?? DEFAULT_URL;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) {
    throw new Error(`this script is local-only; refusing to run against ${url || "(unset)"}`);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: users } = await db.auth.admin.listUsers({ perPage: 100 });
  const owner = users.users.find((u) => u.email === "dev@localhost.test");
  if (!owner) throw new Error("no dev account — run `make seed-dev` first");

  const { data: template } = await db
    .from("templates")
    .select("id, manifest")
    .eq("slug", "advertorial_v1")
    .single();
  if (!template) throw new Error("no templates — run `make seed` first");

  const response = await fetch(sourceUrl, { headers: { "user-agent": BROWSER_UA } });
  if (!response.ok) throw new Error(`fetching the source returned ${response.status}`);
  const manifest = parseManifest(template.manifest);
  const extracted = extractBlocks(await response.text(), manifest);
  if (extracted.blocks.length === 0) throw new Error("extracted no blocks — wrong URL?");

  /**
   * Reuse the project rather than minting a timestamped one per run. Names are unique
   * now, and more usefully, repeated runs against the same project accumulate as
   * versions — which is the thing the project history screen exists to show.
   */
  const projectName = process.env.DEV_PROJECT ?? "NoBarkUltra (local)";
  const { data: existing } = await db
    .from("projects")
    .select("id")
    .ilike("name", projectName)
    .maybeSingle();

  let projectId = existing?.id as number | undefined;
  if (projectId === undefined) {
    const { data: created, error: projectError } = await db
      .from("projects")
      .insert({ owner_id: owner.id, name: projectName, product_name: "NoBarkUltra", niche: "pet" })
      .select("id")
      .single();
    if (projectError) throw new Error(projectError.message);
    projectId = created.id as number;
  }
  const project = { id: projectId };

  const { data: source, error: sourceError } = await db
    .from("sources")
    .insert({
      project_id: project.id,
      source_type: "url",
      url: sourceUrl,
      url_normalized: sourceUrl,
      status: "ok",
      blocks: extracted.blocks,
      raw_text: extracted.rawText,
      raw_text_truncated: extracted.truncated,
      scraped_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (sourceError) throw new Error(sourceError.message);

  // version_num and manifest_snapshot are assigned by a database trigger.
  const { data: generation, error: generationError } = await db
    .from("generations")
    .insert({
      owner_id: owner.id,
      project_id: project.id,
      template_id: template.id,
      source_id: source.id,
      special_notes: process.env.DEV_NOTES ?? "Product ships worldwide.",
      status: "queued",
    })
    .select("id")
    .single();
  if (generationError) throw new Error(generationError.message);

  const sent = await fetch(INNGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "generation.requested",
      data: { generationId: generation.id, attempt: 0 },
    }),
  });
  if (!sent.ok) {
    throw new Error(`could not reach the Inngest dev server at ${INNGEST_URL} — is \`make dev\` running?`);
  }

  console.log(`generation ${generation.id} queued`);
  console.log(`  blocks    ${extracted.blocks.length} (${extracted.blocks.filter((b) => b.selectorHint).length} with a selector hint)`);
  console.log(`  watch     http://localhost:3000/generations/${generation.id}`);
  console.log(`  costs     http://localhost:3000/costs`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
