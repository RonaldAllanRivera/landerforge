/**
 * Model prices and the cost arithmetic — the pure half.
 *
 * Lives in shared/ for the same reason the cost report does: it is arithmetic with no
 * I/O, so it belongs where a test can reach it. Behind `server-only` in the client
 * module it was unreachable and therefore untested, which is not a state money math
 * should be in. lib/anthropic/client re-exports it, so callers are unchanged.
 */

/**
 * Which model runs a given call is a SETTING, not a constant — see lib/core/settings.
 * These are the fallbacks used when no settings row can be read.
 */
export const DEFAULT_MODEL = "claude-sonnet-5";
export const CLASSIFIER_MODEL = "claude-haiku-4-5";

/**
 * Cache prices are DERIVED rather than listed. The platform defines them as fixed
 * multiples of the base input price, so deriving removes a class of transcription
 * error and keeps adding a model to a single line.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute writes; the 1-hour TTL is 2x.
export const CACHE_READ_MULTIPLIER = 0.1;

export interface ModelPricing {
  input: number;
  output: number;
}

/** Base $/MTok, from the published price list. */
export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

/**
 * The models offered in the settings UI, most capable first.
 *
 * Deliberately ordered by capability rather than price, because the two disagree:
 * Sonnet 5 is both newer AND cheaper than Sonnet 4.6, so a price-sorted list would put
 * the upgrade below the thing it replaces.
 *
 * A model without an entry here has no price, and a run on it would report costs that
 * are quietly wrong — so the settings form offers this list and nothing else. Adding a
 * newly released model is one line here plus one in PRICING.
 */
export interface ModelChoice {
  id: string;
  label: string;
  /** When this is the right pick, in one line. */
  note: string;
}

export const MODEL_CATALOGUE: readonly ModelChoice[] = [
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    note: "Most capable, and 2.5x the price of Sonnet 5. Worth trying when the copy is still weak at Sonnet 5 on high effort — compare the flagged rate below before and after.",
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    note: "The default, and the right starting point. Newer and cheaper than Sonnet 4.6.",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    note: "Previous generation, and more expensive than Sonnet 5. Kept because older runs recorded it; there is no reason to pick it now.",
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    note: "Cheapest and fastest. On this template it could not satisfy the scaffolded-field contract and was flagged on every attempt, so it is not currently used by any section.",
  },
] as const;

export function priceOf(model: string): ModelPricing | undefined {
  return PRICING[model];
}

/**
 * Minimum prefix length for a cache_control breakpoint to do anything.
 *
 * Below it the breakpoint is IGNORED: no error, no usage fields, no signal of any kind.
 * The values differ by a factor of four between Sonnet and Haiku, which is exactly the
 * trap — a prompt that caches on the standard tier can be silently uncacheable on the
 * fast one. Measured against the advertorial manifest, the system block is 3,876
 * tokens on Sonnet 5 and 2,569 on Haiku 4.5: cacheable on one, 1,527 short on the other.
 */
export const MIN_CACHEABLE_TOKENS: Record<string, number> = {
  "claude-opus-5": 512,
  "claude-sonnet-5": 1024,
  "claude-sonnet-4-6": 1024,
  "claude-haiku-4-5": 4096,
  "claude-haiku-4-5-20251001": 4096,
};

/**
 * Claude 4.7 and later use a tokenizer that emits roughly 30% more tokens for the same
 * text. It makes per-MTok prices non-comparable across the boundary: Sonnet 5 at $2 is
 * about 13% cheaper than Sonnet 4.6 at $3 in practice, not 33%. Flagged because the
 * /costs screen compares models by spend and the counts are not like for like.
 */
/**
 * Models accepting `output_config.effort`, from `client.models.retrieve`.
 *
 * Haiku 4.5 reports every effort level unsupported, so sending the parameter to it is a
 * 400 — which matters because the fast tier is exactly where a cheap effort setting
 * would otherwise be most attractive.
 */
export const SUPPORTS_EFFORT = new Set(["claude-opus-5", "claude-sonnet-5", "claude-sonnet-4-6"]);

/**
 * How hard the model reasons before answering. Measured on a real section call with an
 * identical prompt and a 16,000-token ceiling:
 *
 *   high    16,000 output tokens, two characters of JSON — the budget went entirely to
 *           reasoning and the response was truncated. $0.16 for nothing.
 *   medium   2,746 output tokens, copy on target.
 *   low      1,568 output tokens, copy still inside the word target.
 *
 * The default is not a safe choice because it is not stable: the same call measured
 * 2,673 output tokens once and 14,963 another time. Setting it explicitly is what makes
 * per-section cost predictable.
 */
export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const NEW_TOKENIZER = new Set(["claude-opus-5", "claude-sonnet-5"]);

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
  const p = PRICING[model] ?? PRICING[DEFAULT_MODEL];
  if (!p) throw new Error(`no pricing for ${model} and none for the default either`);
  const write = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      write * p.input * CACHE_WRITE_MULTIPLIER +
      read * p.input * CACHE_READ_MULTIPLIER) /
    1_000_000
  );
}

export function cacheHit(usage: Usage): boolean {
  return (usage.cache_read_input_tokens ?? 0) > 0;
}

/**
 * Neither written nor read. Distinct from an ordinary miss, which still writes: this
 * means the breakpoint did nothing at all, and the overwhelmingly likely cause is a
 * prefix below the model's minimum rather than an invalidated one.
 */
export function cacheInert(usage: Usage): boolean {
  return (
    (usage.cache_creation_input_tokens ?? 0) === 0 && (usage.cache_read_input_tokens ?? 0) === 0
  );
}
