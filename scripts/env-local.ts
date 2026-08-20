/**
 * Write the local Supabase credentials into .env.
 *
 * `supabase start` prints them and the setup guide asked you to copy three values by
 * hand. That step fails silently: the app simply cannot reach the database, and the
 * placeholder values in .env.example look plausible enough to survive a glance. This
 * project also pins the API to port 55321 rather than the Supabase default, so the
 * mistake is easy to make and hard to see.
 *
 * Local only, and it never touches a key it did not generate.
 */
import { execFileSync } from "node:child_process";
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";

const KEYS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "API_URL",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "PUBLISHABLE_KEY",
  SUPABASE_SECRET_KEY: "SECRET_KEY",
};

function main() {
  if (!existsSync(".env")) {
    copyFileSync(".env.example", ".env");
    console.log("created .env from .env.example");
  }

  let status: string;
  try {
    status = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8" });
  } catch {
    throw new Error("could not read `supabase status` — is the local stack running? (make db-start)");
  }

  const live = new Map<string, string>();
  for (const line of status.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) live.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^"|"$/g, ""));
  }

  const url = live.get("API_URL") ?? "";
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) {
    throw new Error(`refusing to write a non-local API url: ${url}`);
  }

  const lines = readFileSync(".env", "utf8").split("\n");
  const written: string[] = [];
  for (const [envKey, statusKey] of Object.entries(KEYS)) {
    const value = live.get(statusKey);
    if (!value) continue;
    const i = lines.findIndex((l) => l.startsWith(`${envKey}=`));
    if (i === -1) lines.push(`${envKey}=${value}`);
    else lines[i] = `${envKey}=${value}`;
    written.push(envKey);
  }
  writeFileSync(".env", lines.join("\n"));

  console.log(`wrote ${written.length} values into .env:`);
  for (const k of written) console.log(`  ${k}`);
  console.log("\nAnthropic, Browserless and Inngest keys are yours to fill in.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
