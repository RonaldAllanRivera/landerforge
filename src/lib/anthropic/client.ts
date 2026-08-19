import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/** Sonnet 4.6 for copy; a high-resolution-tier model would be used for OCR. */
export const MODEL = "claude-sonnet-4-6";
export const CLASSIFIER_MODEL = "claude-haiku-4-5";

/** $/MTok, for the per-run cost roll-up. */
const PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } as const;

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
export function costUsd(usage: Usage): number {
  const write = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  return (
    (usage.input_tokens * PRICING.input +
      usage.output_tokens * PRICING.output +
      write * PRICING.cacheWrite +
      read * PRICING.cacheRead) /
    1_000_000
  );
}

export function cacheHit(usage: Usage): boolean {
  return (usage.cache_read_input_tokens ?? 0) > 0;
}
