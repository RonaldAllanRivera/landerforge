import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * The SDK instance, and nothing else.
 *
 * Everything price-related lives in lib/shared/pricing: it is pure arithmetic, so it
 * belongs where a test can reach it rather than behind `server-only`. Re-exported here
 * so call sites import one module.
 */
export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // Explicit, and typed errors are caught rather than string-matched.
  maxRetries: 2,
});

export {
  CLASSIFIER_MODEL,
  cacheHit,
  cacheInert,
  costUsd,
  DEFAULT_MODEL,
  MIN_CACHEABLE_TOKENS,
  NEW_TOKENIZER,
  type Usage,
} from "@/lib/shared/pricing";
