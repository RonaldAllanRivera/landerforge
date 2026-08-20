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
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  created_at: string;
}

/** Final outcome of one section, which is where "is the output any good" lives. */
export interface SectionRow {
  generation_id: number;
  section_id: string;
  status: string;
}

/**
 * Cost and quality for one model, side by side.
 *
 * Separating them hides the only comparison that matters. A cheaper model that fails
 * validation and burns three attempts is not cheaper, and a run measured here showed
 * exactly that: half the price per call, nothing usable at the end of it.
 */
export interface ModelReport {
  model: string;
  calls: number;
  usd: number;
  outputTokens: number;
  /** Sections this model produced, however many attempts each took. */
  sections: number;
  /** Sections it got right on the first attempt — the headline quality number. */
  firstPassClean: number;
  /** Sections still failing validation after the retry budget ran out. */
  flagged: number;
  usdPerSection: number | null;
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
  byModel: ModelReport[];
  /** Share of sections that passed validation on the first attempt. Null before any run. */
  firstPassRate: number | null;
  /** Share of sections still flagged after the retry budget. Null before any run. */
  flaggedRate: number | null;
  sectionsMeasured: number;
  recentRuns: Array<{ generationId: number; usd: number; calls: number; at: string }>;
}

/** A step id is either "brief" or "generate:<sectionId>". */
export function sectionIdOf(step: string): string | null {
  return step.startsWith("generate:") ? step.slice("generate:".length) : null;
}

export function summarise(
  steps: readonly StepRow[],
  sections: readonly SectionRow[],
  budgetUsd: number | null,
): CostReport {
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

  const models = new Map<string, { calls: number; usd: number; outputTokens: number }>();
  for (const s of steps) {
    const key = s.model ?? "unknown";
    const entry = models.get(key) ?? { calls: 0, usd: 0, outputTokens: 0 };
    entry.calls += 1;
    entry.usd += Number(s.cost_usd ?? 0);
    entry.outputTokens += Number(s.output_tokens ?? 0);
    models.set(key, entry);
  }

  /**
   * Attribute each SECTION to the model that wrote it, then to its final status. Steps
   * carry the model, sections carry the outcome, and neither alone answers "is this
   * model producing usable copy".
   */
  const status = new Map<string, string>();
  for (const row of sections) status.set(`${row.generation_id}:${row.section_id}`, row.status);

  const perSection = new Map<string, { model: string; attempts: number }>();
  for (const step of steps) {
    const sectionId = sectionIdOf(step.step);
    if (sectionId === null) continue;
    const key = `${step.generation_id}:${sectionId}`;
    const entry = perSection.get(key) ?? { model: step.model ?? "unknown", attempts: 0 };
    entry.attempts += 1;
    perSection.set(key, entry);
  }

  const quality = new Map<string, { sections: number; firstPassClean: number; flagged: number }>();
  let sectionsMeasured = 0;
  let firstPassClean = 0;
  let flagged = 0;

  for (const [key, entry] of perSection) {
    // A section with no recorded outcome is still in flight; counting it would drag
    // every rate down for as long as a run is open.
    const outcome = status.get(key);
    if (outcome === undefined) continue;

    const q = quality.get(entry.model) ?? { sections: 0, firstPassClean: 0, flagged: 0 };
    q.sections += 1;
    sectionsMeasured += 1;
    if (outcome === "flagged") {
      q.flagged += 1;
      flagged += 1;
    } else if (entry.attempts === 1) {
      q.firstPassClean += 1;
      firstPassClean += 1;
    }
    quality.set(entry.model, q);
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
    firstPassRate: sectionsMeasured === 0 ? null : firstPassClean / sectionsMeasured,
    flaggedRate: sectionsMeasured === 0 ? null : flagged / sectionsMeasured,
    sectionsMeasured,
    byModel: [...models.entries()]
      .map(([model, v]) => {
        const q = quality.get(model) ?? { sections: 0, firstPassClean: 0, flagged: 0 };
        return {
          model,
          ...v,
          ...q,
          usdPerSection: q.sections === 0 ? null : v.usd / q.sections,
        };
      })
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
