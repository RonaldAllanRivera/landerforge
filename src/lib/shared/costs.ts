/**
 * Cost reporting — the pure half.
 *
 * Lives in shared/ because it is arithmetic over rows with no I/O, which makes it
 * testable in milliseconds and reusable from a future mobile client. The database
 * query that feeds it is in lib/core/costs.
 *
 * The report leads with cache hit rate and retry burn rather than raw spend, because
 * both are invisible from the outside and both cost multiples of a model swap.
 */

export interface StepRow {
  generation_id: number;
  step: string;
  attempt: number;
  model: string | null;
  cost_usd: number | null;
  cache_read_input_tokens: number | null;
  created_at: string;
}

export interface CostReport {
  monthToDateUsd: number;
  budgetUsd: number | null;
  runCount: number;
  medianRunUsd: number | null;
  /** Share of non-first calls in each run that read from cache. Should be near 1. */
  cacheHitRate: number | null;
  cacheEligibleCalls: number;
  /** Sections that needed a corrective pass, worst first. */
  retryBurn: Array<{ step: string; runs: number; extraCalls: number }>;
  byModel: Array<{ model: string; calls: number; usd: number }>;
  recentRuns: Array<{ generationId: number; usd: number; calls: number; at: string }>;
}

export function summarise(steps: readonly StepRow[], budgetUsd: number | null): CostReport {
  const byRun = new Map<number, StepRow[]>();
  for (const s of steps) {
    const list = byRun.get(s.generation_id) ?? [];
    list.push(s);
    byRun.set(s.generation_id, list);
  }

  const runTotals: Array<{ generationId: number; usd: number; calls: number; at: string }> = [];
  let cacheEligible = 0;
  let cacheHits = 0;

  for (const [generationId, rows] of byRun) {
    const ordered = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
    runTotals.push({
      generationId,
      usd: ordered.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0),
      calls: ordered.length,
      at: ordered[0]?.created_at ?? "",
    });
    // Eligibility is per RUN: the first call necessarily writes the cache, and only
    // later calls in the same run can read it.
    for (const row of ordered.slice(1)) {
      cacheEligible++;
      if ((row.cache_read_input_tokens ?? 0) > 0) cacheHits++;
    }
  }

  const retries = new Map<string, { runs: Set<number>; extraCalls: number }>();
  for (const s of steps) {
    if (s.attempt === 0) continue;
    const entry = retries.get(s.step) ?? { runs: new Set<number>(), extraCalls: 0 };
    entry.runs.add(s.generation_id);
    entry.extraCalls += 1;
    retries.set(s.step, entry);
  }

  const models = new Map<string, { calls: number; usd: number }>();
  for (const s of steps) {
    const key = s.model ?? "unknown";
    const entry = models.get(key) ?? { calls: 0, usd: 0 };
    entry.calls += 1;
    entry.usd += Number(s.cost_usd ?? 0);
    models.set(key, entry);
  }

  const sortedTotals = runTotals.map((r) => r.usd).sort((a, b) => a - b);

  return {
    monthToDateUsd: steps.reduce((sum, s) => sum + Number(s.cost_usd ?? 0), 0),
    budgetUsd,
    runCount: byRun.size,
    medianRunUsd: median(sortedTotals),
    cacheHitRate: cacheEligible === 0 ? null : cacheHits / cacheEligible,
    cacheEligibleCalls: cacheEligible,
    retryBurn: [...retries.entries()]
      .map(([step, v]) => ({ step, runs: v.runs.size, extraCalls: v.extraCalls }))
      .sort((a, b) => b.extraCalls - a.extraCalls)
      .slice(0, 8),
    byModel: [...models.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.usd - a.usd),
    recentRuns: runTotals.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15),
  };
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
