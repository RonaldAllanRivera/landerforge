import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Which model runs a given call is a SETTING, not a constant — see lib/core/settings.
 * These are the fallbacks used when no settings row can be read.
 */
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const CLASSIFIER_MODEL = "claude-haiku-4-5";

/**
 * $/MTok per model, for the cost roll-up.
 *
 * Prices are recorded per call rather than computed later, so a price change does not
 * silently rewrite history.
 */
const PRICING: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

const FALLBACK_PRICING = PRICING["claude-sonnet-4-6"] as NonNullable<
  (typeof PRICING)[keyof typeof PRICING]
>;

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // Explicit, and typed errors are caught rather than string-matched.
  maxRetries: 2,
});

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Total prompt size is the SUM of the three input fields, not input_tokens alone —
 * a detail that makes cache-hit rates look wrong if you miss it.
 */
export function costUsd(usage: Usage, model: string = DEFAULT_MODEL): number {
  const p = PRICING[model] ?? FALLBACK_PRICING;
  const write = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      write * p.cacheWrite +
      read * p.cacheRead) /
    1_000_000
  );
}

export function cacheHit(usage: Usage): boolean {
  return (usage.cache_read_input_tokens ?? 0) > 0;
}
