"use client";

import { useCallback, useEffect, useState } from "react";
import { assembleScaffold, type Violation } from "@/lib/shared/lints";
import type { TemplateField, TemplateManifest } from "@/lib/shared/manifest";
import { countWords } from "@/lib/shared/normalize";
import { createClient } from "@/lib/supabase/client";

interface SectionRow {
  section_id: string;
  output: Record<string, unknown> | null;
  status: string;
  violations: Violation[] | null;
}

interface Props {
  generationId: number;
  initialStatus: string;
  errorMessage: string | null;
  runNotes: unknown[];
  costUsd: number | null;
  manifest: TemplateManifest;
  initialSections: SectionRow[];
}

export function ReviewScreen(props: Props) {
  const [status, setStatus] = useState(props.initialStatus);
  const [sections, setSections] = useState<SectionRow[]>(props.initialSections);

  /**
   * Subscribe to BOTH tables. A run that fails during the scrape or the brief writes
   * no section rows at all, so a generation_sections-only subscription would leave
   * the screen spinning forever on a failed run.
   *
   * Every payload is treated as a signal and the row refetched — change payloads cap
   * at 1 MB and are delivered TRUNCATED rather than dropped, so trusting them fails
   * silently.
   */
  useEffect(() => {
    const supabase = createClient();
    const refetch = async () => {
      const [{ data: run }, { data: rows }] = await Promise.all([
        supabase.from("generations").select("status").eq("id", props.generationId).maybeSingle(),
        supabase
          .from("generation_sections")
          .select("section_id, output, status, violations")
          .eq("generation_id", props.generationId),
      ]);
      if (run) setStatus(run.status);
      if (rows) setSections(rows as SectionRow[]);
    };

    const channel = supabase
      .channel(`generation-${props.generationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "generation_sections",
          filter: `generation_id=eq.${props.generationId}`,
        },
        refetch,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "generations",
          filter: `id=eq.${props.generationId}`,
        },
        refetch,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [props.generationId]);

  const bySection = new Map(sections.map((s) => [s.section_id, s]));

  return (
    <main>
      <h1>Generation #{props.generationId}</h1>
      <p className="sub">
        <span className={`badge ${status === "done" ? "ok" : status === "failed" ? "flag" : ""}`}>
          {status}
        </span>
        {props.costUsd !== null && <> · ${Number(props.costUsd).toFixed(3)}</>}
      </p>

      {status === "failed" && (
        <div className="card">
          <strong>This run failed.</strong>
          <p className="muted">{props.errorMessage ?? "No error recorded."}</p>
          {/* Retry is a distinct event with its own idempotency key: re-firing the
              original would be deduplicated for 24 hours and the button would look dead. */}
          <form action={`/api/v1/generations/${props.generationId}/retry`} method="post">
            <button type="submit" className="ghost">
              Retry run
            </button>
          </form>
        </div>
      )}

      {props.runNotes.length > 0 && (
        <div className="card">
          <strong>Run notes</strong>
          {props.runNotes.map((note) => {
            const text = JSON.stringify(note);
            return (
              <p className="muted" key={text}>
                {text}
              </p>
            );
          })}
        </div>
      )}

      {/* Sections render in manifest order — which follows the CMS's rendered panel
          order — so copying into the CMS is a straight top-to-bottom walk. */}
      {props.manifest.sections.map((section) => {
        const row = bySection.get(section.id);
        return (
          <section key={section.id}>
            <h2>
              {section.label}{" "}
              {row && (
                <span className={`badge ${row.status === "flagged" ? "flag" : "ok"}`}>
                  {row.status}
                </span>
              )}
            </h2>
            <div className="card">
              {section.fields.map((field) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  value={row?.output?.[field.key]}
                  violations={(row?.violations ?? []).filter((v) =>
                    v.address.endsWith(`.${field.key}`),
                  )}
                />
              ))}
            </div>
          </section>
        );
      })}
    </main>
  );
}

function FieldRow({
  field,
  value,
  violations,
}: {
  field: TemplateField;
  value: unknown;
  violations: Violation[];
}) {
  const [copied, setCopied] = useState(false);
  const rendered = renderValue(field, value);

  const copy = useCallback(() => {
    /**
     * markdownBold describes the CMS field, not the copy. On a WYSIWYG field the **
     * markers are working annotations: the screen renders them so the operator can
     * see what to emphasise, and the clipboard gets clean text they re-bold with the
     * toolbar. Markdown links survive — the {{clickURL}} token has to reach the paste.
     */
    const text = field.markdownBold ? rendered : rendered.replace(/\*\*/g, "");
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [field.markdownBold, rendered]);

  // display fields are position markers so the CMS walk stays aligned — the CMS shows
  // toggles and image slots interleaved with copy, not clustered.
  if (!field.generate) {
    return (
      <div className="field">
        <div className="field-head">
          <span className="field-label">{field.label}</span>
          <span className="badge">not generated</span>
        </div>
      </div>
    );
  }

  const words = countWords(rendered);
  const target = field.fallbackWordTarget;
  const inRange = !target || (words >= target[0] && words <= target[1]);

  return (
    <div className="field">
      <div className="field-head">
        <span className="field-label">{field.label}</span>
        <span className="row">
          {target && (
            <span className={`badge ${inRange ? "ok" : "flag"}`}>
              {words}w / {target[0]}–{target[1]}
            </span>
          )}
          <button type="button" className="ghost" onClick={copy} disabled={!rendered}>
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      <p className="copy-value">{rendered || <span className="muted">pending…</span>}</p>
      {violations.map((v) => (
        <p className="violation" key={`${v.category}:${v.message}`}>
          [{v.category}] {v.message}
        </p>
      ))}
    </div>
  );
}

function renderValue(field: TemplateField, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  // Scaffolded fields: code assembles the markup, so it is correct by construction
  // rather than by a byte-for-byte retry loop.
  if (field.type === "scaffolded" && typeof value === "object" && "items" in value) {
    return assembleScaffold(
      (value as { items: Array<{ variant: string; copy: string }> }).items,
      field.lineTemplates ?? {},
    );
  }
  return JSON.stringify(value, null, 2);
}
