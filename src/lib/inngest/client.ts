import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "landerforge" });

export type Events = {
  /**
   * `attempt` is on BOTH events and always sent, because it is part of the function's
   * idempotency key. A retry with no attempt number would be deduplicated against the
   * original for 24 hours and the button would look dead.
   */
  "generation.requested": { data: { generationId: number; attempt: number } };
  "generation.retry.requested": { data: { generationId: number; attempt: number } };
  "generation.section.requested": {
    data: { generationId: number; sectionId: string; feedback?: string };
  };
};

/**
 * All three functions declare the SAME object. A bare { limit: 1 } is scoped to one
 * function, so three of them would get three independent queues and a regenerate
 * could still run alongside a full run.
 *
 * `key` and `idempotency` are CEL expressions, not literal strings: a bare
 * landerforge-generation parses as identifier arithmetic, so a constant must be
 * quoted INSIDE the expression.
 */
export const SHARED_CONCURRENCY = {
  scope: "account" as const,
  key: '"landerforge-generation"',
  limit: 1,
};
