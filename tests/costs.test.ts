import { describe, expect, it } from "vitest";
import { type StepRow, summarise } from "@/lib/shared/costs";

function step(over: Partial<StepRow> = {}): StepRow {
  return {
    generation_id: 1,
    step: "generate:hero",
    attempt: 0,
    model: "claude-sonnet-4-6",
    cost_usd: 0.01,
    cache_read_input_tokens: 0,
    created_at: "2026-08-19T10:00:00Z",
    ...over,
  };
}

describe("cache hit rate", () => {
  it("excludes the first call of a run — it necessarily writes rather than reads", () => {
    const report = summarise(
      [
        step({ created_at: "2026-08-19T10:00:00Z", cache_read_input_tokens: 0 }),
        step({ created_at: "2026-08-19T10:01:00Z", cache_read_input_tokens: 5000 }),
        step({ created_at: "2026-08-19T10:02:00Z", cache_read_input_tokens: 5000 }),
      ],
      null,
    );
    expect(report.cacheEligibleCalls).toBe(2);
    expect(report.cacheHitRate).toBe(1);
  });

  it("reports a broken cache as zero rather than hiding it", () => {
    const report = summarise(
      [
        step({ created_at: "2026-08-19T10:00:00Z" }),
        step({ created_at: "2026-08-19T10:01:00Z", cache_read_input_tokens: 0 }),
      ],
      null,
    );
    expect(report.cacheHitRate).toBe(0);
  });

  it("is null rather than misleading when there is nothing to measure", () => {
    expect(summarise([step()], null).cacheHitRate).toBeNull();
    expect(summarise([], null).cacheHitRate).toBeNull();
  });

  it("counts eligibility per run, not across the whole month", () => {
    // Two runs of two calls each: two eligible, not three.
    const report = summarise(
      [
        step({ generation_id: 1, created_at: "2026-08-19T10:00:00Z" }),
        step({ generation_id: 1, created_at: "2026-08-19T10:01:00Z", cache_read_input_tokens: 9 }),
        step({ generation_id: 2, created_at: "2026-08-19T11:00:00Z" }),
        step({ generation_id: 2, created_at: "2026-08-19T11:01:00Z", cache_read_input_tokens: 9 }),
      ],
      null,
    );
    expect(report.cacheEligibleCalls).toBe(2);
    expect(report.cacheHitRate).toBe(1);
  });
});

describe("retry burn", () => {
  it("counts only corrective attempts, worst first", () => {
    const report = summarise(
      [
        step({ step: "generate:hero", attempt: 0 }),
        step({ step: "generate:content", attempt: 0 }),
        step({ step: "generate:content", attempt: 1, generation_id: 1 }),
        step({ step: "generate:content", attempt: 1, generation_id: 2 }),
        step({ step: "generate:content", attempt: 2, generation_id: 2 }),
        step({ step: "generate:cta", attempt: 1, generation_id: 1 }),
      ],
      null,
    );
    expect(report.retryBurn[0]).toEqual({ step: "generate:content", runs: 2, extraCalls: 3 });
    expect(report.retryBurn.map((r) => r.step)).not.toContain("generate:hero");
  });
});

describe("spend", () => {
  it("totals the month and medians the runs", () => {
    const report = summarise(
      [
        step({ generation_id: 1, cost_usd: 0.1, created_at: "2026-08-19T10:00:00Z" }),
        step({ generation_id: 2, cost_usd: 0.3, created_at: "2026-08-19T11:00:00Z" }),
        step({ generation_id: 3, cost_usd: 0.2, created_at: "2026-08-19T12:00:00Z" }),
      ],
      50,
    );
    expect(report.monthToDateUsd).toBeCloseTo(0.6);
    expect(report.runCount).toBe(3);
    expect(report.medianRunUsd).toBeCloseTo(0.2);
    expect(report.budgetUsd).toBe(50);
  });

  it("splits spend by model, so a tier change is visible rather than inferred", () => {
    const report = summarise(
      [
        step({ model: "claude-sonnet-4-6", cost_usd: 0.2 }),
        step({ model: "claude-haiku-4-5", cost_usd: 0.01, created_at: "2026-08-19T10:01:00Z" }),
        step({ model: "claude-haiku-4-5", cost_usd: 0.01, created_at: "2026-08-19T10:02:00Z" }),
      ],
      null,
    );
    expect(report.byModel[0]?.model).toBe("claude-sonnet-4-6");
    expect(report.byModel[1]).toEqual({ model: "claude-haiku-4-5", calls: 2, usd: 0.02 });
  });

  it("treats a null cost as zero rather than NaN", () => {
    expect(summarise([step({ cost_usd: null })], null).monthToDateUsd).toBe(0);
  });
});
