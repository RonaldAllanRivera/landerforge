/**
 * Environment loading for the standalone scripts.
 *
 * The app gets this for free — Next reads .env itself — but `tsx supabase/seed.ts` is a
 * bare Node process and gets nothing, which made `make seed` fail on a fresh clone with
 * a message about missing variables that were in fact sitting in .env all along.
 *
 * Precedence matches Next's: a variable already set in the real environment always
 * wins, then .env.local, then .env. That ordering is what makes CI work — it exports
 * secrets as real environment variables and has no .env file at all.
 */
import { existsSync, readFileSync } from "node:fs";

const FILES = [".env.local", ".env"];

export function loadEnv(): void {
  for (const file of FILES) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      // First writer wins, which given the file order gives .env.local precedence
      // over .env, and the real environment precedence over both.
      if (process.env[key] !== undefined) continue;
      process.env[key] = stripQuotes(trimmed.slice(eq + 1).trim());
    }
  }
}

function stripQuotes(value: string): string {
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  return quoted?.[2] ?? value;
}
