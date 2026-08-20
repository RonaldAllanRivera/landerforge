import { buildCostReport } from "@/lib/core/costs";
import { loadSettings } from "@/lib/core/settings";
import { createClient, requireUser } from "@/lib/supabase/server";
import { updateSettingsAction } from "./actions";

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

export default async function Costs() {
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
          <h2>Spend by model</h2>
          <div className="card">
            {report.byModel.map((m) => (
              <div className="field" key={m.model}>
                <div className="field-head">
                  <span>{m.model}</span>
                  <span className="badge">
                    {usd(m.usd)} over {m.calls} calls
                  </span>
                </div>
              </div>
            ))}
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

            <label htmlFor="standard_model">Standard model</label>
            <input
              id="standard_model"
              name="standard_model"
              defaultValue={settings.standard_model}
            />
            <p className="muted">Prose-heavy sections, and always the brief.</p>

            <label htmlFor="fast_model">Fast model</label>
            <input id="fast_model" name="fast_model" defaultValue={settings.fast_model} />
            <p className="muted">
              Sections a manifest marks <code>tier: &quot;fast&quot;</code> — currently the CTA and
              sidebar, which are short constrained strings.
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
