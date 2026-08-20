import { buildCostReport } from "@/lib/core/costs";
import { loadSettings } from "@/lib/core/settings";
import { EFFORT_LEVELS, MODEL_CATALOGUE, priceOf } from "@/lib/shared/pricing";
import { createClient, requireUser } from "@/lib/supabase/server";
import { updateSettingsAction } from "./actions";

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** "Claude Sonnet 5 — $2 / $10 per MTok", for the model pickers. */
function modelOptionLabel(id: string, label: string): string {
  const price = priceOf(id);
  return price ? `${label} — $${price.input} / $${price.output} per MTok` : label;
}

function ModelSelect({ name, value }: { name: string; value: string }) {
  /**
   * A select, not a text field. A typo in a free-text model name is not a visible
   * error: the run fails at the API, or worse it succeeds on a model with no price
   * entry and every cost figure on this page is quietly wrong.
   */
  const known = MODEL_CATALOGUE.some((m) => m.id === value);
  return (
    <select id={name} name={name} defaultValue={value}>
      {!known && <option value={value}>{value} (not in the price list)</option>}
      {MODEL_CATALOGUE.map((m) => (
        <option key={m.id} value={m.id}>
          {modelOptionLabel(m.id, m.label)}
        </option>
      ))}
    </select>
  );
}

export default async function Costs({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { error, saved } = await searchParams;
  const actor = await requireUser();
  const supabase = await createClient();
  const settings = await loadSettings(supabase);
  const report = await buildCostReport(supabase, settings.monthly_budget_usd);

  const cacheOk = report.cacheHitRate === null || report.cacheHitRate > 0.8;
  const overBudget = report.budgetUsd !== null && report.monthToDateUsd > report.budgetUsd;

  return (
    <main>
      <h1>Costs</h1>
      <p className="sub">Month to date, and the two things that quietly multiply it.</p>

      {/* Cache first: a broken cache costs more than any other lever saves, and is
          invisible without this number. */}
      <div className="card">
        <div className="field-head">
          <span className="field-label">Cache hit rate</span>
          <span className={`badge ${cacheOk ? "ok" : "flag"}`}>
            {report.cacheHitRate === null ? "no data yet" : pct(report.cacheHitRate)}
          </span>
        </div>
        <p className="muted">
          {report.cacheHitRate === null ? (
            <>Run a generation to measure this.</>
          ) : cacheOk ? (
            <>Healthy, across {report.cacheEligibleCalls} calls that could have read from cache.</>
          ) : (
            <>
              <strong>Something varying is being sent on every request.</strong> Nothing can be
              reused, so you are paying several times more than necessary. This is a code problem,
              not a settings one — check the caching section of the plan before touching anything
              below.
            </>
          )}
        </p>
      </div>

      <div className="card">
        <div className="field-head">
          <span className="field-label">Month to date</span>
          <span className={`badge ${overBudget ? "flag" : ""}`}>
            {usd(report.monthToDateUsd)}
            {report.budgetUsd !== null && ` / ${usd(report.budgetUsd)}`}
          </span>
        </div>
        <p className="muted">
          {report.runCount} runs
          {report.medianRunUsd !== null && `, median ${usd(report.medianRunUsd)} each`}.
        </p>
      </div>

      {report.retryBurn.length > 0 && (
        <>
          <h2>Retry burn</h2>
          <div className="card">
            <p className="muted">
              Sections that failed validation and needed a corrective pass. A section that always
              needs one is a prompt or manifest problem, and fixing it saves more than any model
              change.
            </p>
            {report.retryBurn.map((r) => (
              <div className="field" key={r.step}>
                <div className="field-head">
                  <span>{r.step}</span>
                  <span className="badge flag">
                    +{r.extraCalls} calls across {r.runs} runs
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {report.byModel.length > 0 && (
        <>
          <h2>Output quality, and what it costs</h2>
          <div className="card">
            <p className="muted">
              Price per token is the least useful way to compare models here. A cheaper one that
              fails validation and burns three attempts is not cheaper — measured on this template,
              the fast model cost half as much per call and produced nothing usable. Judge a model
              on <strong>clean first pass</strong> and <strong>cost per section</strong> together.
            </p>
            {report.byModel.map((m) => {
              const price = priceOf(m.model);
              const weak = m.sections > 0 && m.flagged / m.sections > 0.34;
              return (
                <div className="field" key={m.model}>
                  <div className="field-head">
                    <span>
                      {MODEL_CATALOGUE.find((c) => c.id === m.model)?.label ?? m.model}
                      {price && (
                        <span className="muted">
                          {" "}
                          · ${price.input}/${price.output} per MTok
                        </span>
                      )}
                    </span>
                    <span className={`badge ${weak ? "flag" : "ok"}`}>
                      {m.sections === 0
                        ? `${usd(m.usd)}, no sections yet`
                        : `${pct(m.firstPassClean / m.sections)} clean first pass`}
                    </span>
                  </div>
                  <p className="muted">
                    {usd(m.usd)} over {m.calls} calls
                    {m.usdPerSection !== null && <> · {usd(m.usdPerSection)} per section</>}
                    {m.sections > 0 && (
                      <>
                        {" "}
                        · {m.sections} sections, {m.flagged} still flagged
                      </>
                    )}{" "}
                    · {m.outputTokens.toLocaleString()} output tokens
                  </p>
                  {weak && (
                    <p className="muted">
                      <strong>More than a third of its sections never passed validation.</strong>{" "}
                      Before paying for a bigger model, check the retry burn above — a section that
                      always fails the same lint is usually a manifest or prompt problem. If the
                      failures are spread across sections, raise the effort first, then move up the
                      model list; both are below.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <h2>Recent runs</h2>
      <div className="card">
        {report.recentRuns.length === 0 && <p className="muted">Nothing yet this month.</p>}
        {report.recentRuns.map((r) => (
          <div className="field" key={r.generationId}>
            <div className="field-head">
              <a href={`/generations/${r.generationId}`}>#{r.generationId}</a>
              <span className="badge">
                {usd(r.usd)} · {r.calls} calls
              </span>
            </div>
          </div>
        ))}
      </div>

      {actor?.role === "admin" && (
        <>
          <h2>Settings</h2>
          {error && (
            <div className="card">
              <div className="field-head">
                <span className="field-label">Not saved</span>
                <span className="badge flag">rejected</span>
              </div>
              <p className="muted">{error}</p>
            </div>
          )}
          {saved && (
            <div className="card">
              <p className="muted">Saved. It applies to the next run, not to one already going.</p>
            </div>
          )}
          <form action={updateSettingsAction} className="card">
            <p className="muted">
              Change these here rather than in code. Work down the list: fix the cache first, then
              retry burn, and only then move sections to the fast model — confirming above that it
              actually helped.
            </p>

            <label htmlFor="max_calls_per_run">Maximum API calls per generation</label>
            <input
              id="max_calls_per_run"
              name="max_calls_per_run"
              type="number"
              min={5}
              max={500}
              defaultValue={settings.max_calls_per_run}
            />
            <p className="muted">
              The backstop against a validation loop that never converges. A normal run uses six to
              twenty.
            </p>

            <label htmlFor="effort">Reasoning effort</label>
            <select id="effort" name="effort" defaultValue={settings.effort}>
              {EFFORT_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
            <p className="muted">
              The largest lever here, and the one most worth leaving alone once it works. Output
              tokens were 88% of the cost of a measured run. On one real section, with the same
              prompt and a 16,000-token ceiling: <strong>low</strong> produced 1,568 output tokens,
              <strong> medium</strong> 2,746 and copy on target, and <strong>high</strong> spent the
              entire budget reasoning and returned two characters of JSON — $0.16 for nothing.
              Ignored by models that do not support it.
            </p>

            <label htmlFor="standard_model">Standard model</label>
            <ModelSelect name="standard_model" value={settings.standard_model} />
            <p className="muted">
              Prose-heavy sections, and always the brief.{" "}
              {MODEL_CATALOGUE.find((m) => m.id === settings.standard_model)?.note}
            </p>

            <label htmlFor="fast_model">Fast model</label>
            <ModelSelect name="fast_model" value={settings.fast_model} />
            <p className="muted">
              Sections a manifest marks <code>tier: &quot;fast&quot;</code>. No manifest currently
              marks any: measured, the fast model returned assembled HTML for a scaffolded field on
              all three attempts while costing half as much, which is not a saving.
            </p>

            <label htmlFor="monthly_budget_usd">Monthly budget (optional)</label>
            <input
              id="monthly_budget_usd"
              name="monthly_budget_usd"
              type="number"
              step="0.01"
              min={0}
              defaultValue={settings.monthly_budget_usd ?? ""}
            />
            <p className="muted">
              Advisory only — shown above, never enforced. A hard stop mid-run would leave a
              half-written page. Set a real ceiling in the Anthropic console instead.
            </p>

            <p />
            <button type="submit">Save settings</button>
          </form>
        </>
      )}
    </main>
  );
}
