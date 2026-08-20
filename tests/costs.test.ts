import { describe, expect, it } from "vitest";
import { type StepRow, summarise } from "@/lib/shared/costs";

function step(over: Partial<StepRow> = {}): StepRow {
  return {
    generation_id: 1,
    step: "generate:hero",
    attempt: 0,
    model: "claude-sonnet-4-6",
    cost_usd: 0.01,
    output_tokens: 0,
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
      [],
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
      [],
      null,
    );
    expect(report.cacheHitRate).toBe(0);
  });

  it("is null rather than misleading when there is nothing to measure", () => {
    expect(summarise([step()], [], null).cacheHitRate).toBeNull();
    expect(summarise([], [], null).cacheHitRate).toBeNull();
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
      [],
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
      [],
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
      [],
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
      [],
      null,
    );
    expect(report.byModel[0]?.model).toBe("claude-sonnet-4-6");
    expect(report.byModel[1]).toMatchObject({ model: "claude-haiku-4-5", calls: 2, usd: 0.02 });
  });

  it("treats a null cost as zero rather than NaN", () => {
    expect(summarise([step({ cost_usd: null })], [], null).monthToDateUsd).toBe(0);
  });
});

/**
 * Cost alone cannot answer "is this model good enough". A measured run had the fast
 * model at half the price per call and nothing usable at the end of it, so spend and
 * outcome are reported together or the comparison misleads.
 */
describe("quality by model", () => {
  const section = (generation_id: number, section_id: string, status: string) => ({
    generation_id,
    section_id,
    status,
  });

  it("credits a section to the model that wrote it", () => {
    const report = summarise(
      [
        step({ step: "generate:hero", model: "claude-sonnet-5", cost_usd: 0.02 }),
        step({ step: "generate:sidebar", model: "claude-haiku-4-5", cost_usd: 0.01 }),
      ],
      [section(1, "hero", "done"), section(1, "sidebar", "flagged")],
      null,
    );
    const sonnet = report.byModel.find((m) => m.model === "claude-sonnet-5");
    const haiku = report.byModel.find((m) => m.model === "claude-haiku-4-5");
    expect(sonnet).toMatchObject({ sections: 1, firstPassClean: 1, flagged: 0 });
    expect(haiku).toMatchObject({ sections: 1, firstPassClean: 0, flagged: 1 });
  });

  it("counts a section clean only when it took a single attempt", () => {
    const report = summarise(
      [
        step({ step: "generate:hero", attempt: 0 }),
        step({ step: "generate:hero", attempt: 1, created_at: "2026-08-19T10:01:00Z" }),
      ],
      [section(1, "hero", "done")],
      null,
    );
    // Recovered on retry: a real outcome, but not a first-pass one.
    expect(report.byModel[0]).toMatchObject({ sections: 1, firstPassClean: 0, flagged: 0 });
    expect(report.firstPassRate).toBe(0);
    expect(report.flaggedRate).toBe(0);
  });

  it("reports cost per section, which is the number worth comparing", () => {
    const report = summarise(
      [
        step({ step: "generate:hero", cost_usd: 0.06 }),
        step({
          step: "generate:hero",
          attempt: 1,
          cost_usd: 0.04,
          created_at: "2026-08-19T10:01:00Z",
        }),
      ],
      [section(1, "hero", "done")],
      null,
    );
    expect(report.byModel[0]?.usdPerSection).toBeCloseTo(0.1);
  });

  it("ignores sections still in flight rather than counting them as failures", () => {
    const report = summarise(
      [step({ step: "generate:hero" }), step({ step: "generate:cta" })],
      [section(1, "hero", "done")],
      null,
    );
    expect(report.sectionsMeasured).toBe(1);
    expect(report.firstPassRate).toBe(1);
  });

  it("excludes the brief, which is not a section and has no outcome", () => {
    const report = summarise(
      [step({ step: "brief" }), step({ step: "generate:hero" })],
      [section(1, "hero", "done")],
      null,
    );
    expect(report.sectionsMeasured).toBe(1);
    expect(report.byModel[0]?.calls).toBe(2);
  });

  it("has no rates at all before anything has run", () => {
    const report = summarise([], [], null);
    expect(report.firstPassRate).toBeNull();
    expect(report.flaggedRate).toBeNull();
  });

  it("does not confuse two runs that share a section id", () => {
    const report = summarise(
      [
        step({ generation_id: 1, step: "generate:hero" }),
        step({ generation_id: 2, step: "generate:hero" }),
      ],
      [section(1, "hero", "done"), section(2, "hero", "flagged")],
      null,
    );
    expect(report.sectionsMeasured).toBe(2);
    expect(report.byModel[0]).toMatchObject({ firstPassClean: 1, flagged: 1 });
  });
});
