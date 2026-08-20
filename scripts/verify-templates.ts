/**
 * Run one real generation per template and report what came back.
 *
 * The last acceptance criterion for Phases 4 and 5 is the only one that needs API
 * budget, so it is a single command rather than a list of manual steps: when credit is
 * available, `make verify-live` answers whether each template's contract survives
 * contact with the model.
 *
 * Usage:  pnpm run verify:live [slug ...]
 *
 * Needs the app and the Inngest dev server running (`make dev`). Costs roughly $0.20 to
 * $0.60 a template at the shipped settings — Interstitial is the expensive one, with 14
 * generating sections against Advertorial's five.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { extractBlocks } from "@/lib/scrape/extract";
import { parseManifest } from "@/lib/shared/manifest";
import { loadEnv } from "../supabase/load-env";

loadEnv();

/** A live lander of each shape, so the brief has real source material to match. */
const SOURCES: Record<string, string> = {
  advertorial_v1:
    "https://buybarkcontrol.com/trending/goodbye-barking-how-one-button-instantly-brought-the-zen-back-to-my-home",
  reasons_v1:
    "https://pestpulseprosolar.com/7-reasons-families-are-calling-the-pestpulsepro-solar-the-smartest-way-to-beat-mosquitoes-this-summer",
  comparison_v1:
    "https://buypestvault.com/i-tested-the-5-best-mouse-repellents-of-2026-only-one-stopped-them-coming-back",
  interstitial_v1: "https://breezeboxcooling.com/limited-offer/breezebox",
};

const INNGEST_URL = process.env.INNGEST_DEV_URL ?? "http://localhost:8288/e/local";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const POLL_MS = 5_000;
const TIMEOUT_MS = 20 * 60 * 1000;

type Db = SupabaseClient;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) {
    throw new Error(`this script is local-only; refusing to run against ${url || "(unset)"}`);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: users } = await db.auth.admin.listUsers({ perPage: 100 });
  const owner = users.users.find((u) => u.email === "dev@localhost.test");
  if (!owner) throw new Error("no dev account — run `make seed-dev` first");

  /**
   * Preflight before anything is written. Discovering the worker is unreachable after
   * inserting a project, a source and a generation leaves three orphan rows per
   * template and a database that has to be tidied by hand.
   */
  await requireInngest();

  const wanted = process.argv.slice(2);
  const slugs = wanted.length > 0 ? wanted : Object.keys(SOURCES);

  const results: Array<Record<string, string>> = [];
  for (const slug of slugs) {
    const source = SOURCES[slug];
    if (!source) {
      console.error(`no source URL configured for ${slug}`);
      continue;
    }
    console.log(`\n── ${slug} ─────────────────────────────`);
    results.push(await verify(db, owner.id, slug, source));
  }

  console.log("\n===== summary =====");
  for (const r of results) {
    console.log(
      `${(r.slug ?? "").padEnd(16)} ${(r.status ?? "").padEnd(9)} ${(r.cost ?? "").padStart(8)}  ${r.sections ?? ""}`,
    );
  }
  const failed = results.filter((r) => r.status !== "done");
  if (failed.length > 0) process.exitCode = 1;
}

/** A connection refusal here is the common case, and `fetch failed` does not say why. */
async function requireInngest(): Promise<void> {
  try {
    const response = await fetch(INNGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "verify.preflight", data: {} }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot reach the Inngest dev server at ${INNGEST_URL} (${reason}). Start the stack with \`make dev\` first — nothing has been written.`,
    );
  }
}

async function verify(db: Db, ownerId: string, slug: string, sourceUrl: string) {
  const { data: template } = await db
    .from("templates")
    .select("id, manifest")
    .eq("slug", slug)
    .single();
  if (!template) throw new Error(`${slug} is not seeded — run \`make seed\``);

  const projectName = `Live check — ${slug}`;
  const { data: existing } = await db
    .from("projects")
    .select("id")
    .ilike("name", projectName)
    .maybeSingle();
  let projectId = existing?.id as number | undefined;
  if (projectId === undefined) {
    const { data: created, error } = await db
      .from("projects")
      .insert({ owner_id: ownerId, name: projectName, product_name: "Verification Product" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    projectId = created.id as number;
  }

  const manifest = parseManifest(template.manifest);
  const response = await fetch(sourceUrl, { headers: { "user-agent": BROWSER_UA } });
  if (!response.ok) throw new Error(`fetching ${sourceUrl} returned ${response.status}`);
  const extracted = extractBlocks(await response.text(), manifest);
  console.log(`  source: ${extracted.blocks.length} blocks, ${extracted.rawText.length} chars`);

  const { data: source, error: sourceError } = await db
    .from("sources")
    .insert({
      project_id: projectId,
      source_type: "url",
      url: sourceUrl,
      url_normalized: `${sourceUrl}#${Date.now()}`,
      status: "ok",
      blocks: extracted.blocks,
      raw_text: extracted.rawText,
      raw_text_truncated: extracted.truncated,
      scraped_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (sourceError) throw new Error(sourceError.message);

  const { data: generation, error: genError } = await db
    .from("generations")
    .insert({
      owner_id: ownerId,
      project_id: projectId,
      template_id: template.id,
      source_id: source.id,
      special_notes: "Match the source density. Ships worldwide.",
      status: "queued",
    })
    .select("id")
    .single();
  if (genError) throw new Error(genError.message);

  const sent = await fetch(INNGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "generation.requested",
      data: { generationId: generation.id, attempt: 0 },
    }),
  });
  if (!sent.ok) throw new Error(`Inngest rejected the event: HTTP ${sent.status}`);
  console.log(`  generation ${generation.id} queued — http://localhost:3000/generations/${generation.id}`);

  const deadline = Date.now() + TIMEOUT_MS;
  let status = "queued";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const { data } = await db
      .from("generations")
      .select("status")
      .eq("id", generation.id)
      .maybeSingle();
    status = (data?.status as string) ?? status;
    if (status === "done" || status === "failed") break;
  }

  const { data: run } = await db
    .from("generations")
    .select("total_cost_usd, run_notes")
    .eq("id", generation.id)
    .maybeSingle();
  const { data: sections } = await db
    .from("generation_sections")
    .select("section_id, status, violations")
    .eq("generation_id", generation.id)
    .order("section_id");

  const clean = (sections ?? []).filter((s) => s.status === "done").length;
  const flagged = (sections ?? []).filter((s) => s.status !== "done").length;
  const cost = run?.total_cost_usd == null ? "—" : `$${Number(run.total_cost_usd).toFixed(4)}`;

  console.log(`  status: ${status}  cost: ${cost}  sections: ${clean} clean / ${flagged} flagged`);
  for (const section of sections ?? []) {
    const violations = (section.violations ?? []) as Array<{ category: string; message: string }>;
    if (violations.length === 0) continue;
    console.log(`    ${section.section_id}:`);
    for (const v of violations) console.log(`      [${v.category}] ${v.message.slice(0, 90)}`);
  }
  if (Array.isArray(run?.run_notes) && run.run_notes.length > 0) {
    console.log(`  run notes: ${JSON.stringify(run.run_notes)}`);
  }

  return {
    slug,
    status,
    cost,
    sections: `${clean} clean / ${flagged} flagged`,
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
