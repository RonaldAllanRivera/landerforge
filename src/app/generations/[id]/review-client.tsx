"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { Violation } from "@/lib/shared/lints";
import type { TemplateField, TemplateManifest, TemplateSection } from "@/lib/shared/manifest";
import { countWords } from "@/lib/shared/normalize";
import {
  addInstance,
  canAddInstance,
  canRemoveInstance,
  fieldRepeats,
  generatedFields,
  instanceCount,
  isRepeating,
  parseList,
  parseScaffold,
  readField,
  removeInstance,
  renderFieldValue,
  type SectionOutput,
  writeField,
} from "@/lib/shared/section-io";
import { createClient } from "@/lib/supabase/client";
import { regenerateAction, retryGenerationAction, saveSectionAction } from "./actions";

interface SectionRow {
  section_id: string;
  output: SectionOutput | null;
  status: string;
  violations: Violation[] | null;
  edited_at?: string | null;
}

interface Props {
  generationId: number;
  initialStatus: string;
  errorMessage: string | null;
  runNotes: unknown[];
  costUsd: number | null;
  spend: Record<string, { usd: number; attempts: number; model: string | null }>;
  manifest: TemplateManifest;
  initialSections: SectionRow[];
  canEdit: boolean;
  /** Prefills the regenerate box, because a re-run usually means "same brief, but…". */
  specialNotes: string | null;
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
          .select("section_id, output, status, violations, edited_at")
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
        {!props.canEdit && <> · read-only (viewers cannot change copy)</>}
        {" · "}
        <a href={`/generations/${props.generationId}/diff`}>Compare versions</a>
      </p>

      {status !== "done" && props.canEdit && (
        <RetryCard
          generationId={props.generationId}
          status={status}
          errorMessage={props.errorMessage}
        />
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
      {/* Only sections that generate copy. The rest were CMS position markers, which
          turned out to be noise on a screen whose job is reading and fixing prose. */}
      {props.manifest.sections
        .filter((section) => section.fields.some((f) => f.generate))
        .map((section) => (
          <SectionPanel
            key={section.id}
            section={section}
            row={bySection.get(section.id)}
            spend={props.spend[section.id]}
            generationId={props.generationId}
            canEdit={props.canEdit}
          />
        ))}

      {props.canEdit && status === "done" && (
        <RegenerateCard generationId={props.generationId} notes={props.specialNotes ?? ""} />
      )}
    </main>
  );
}

/**
 * Write it again as the next version, keeping this one.
 *
 * The notes are editable and prefilled, because "same brief, but make the headline
 * less breathless" is what a regenerate almost always is — and retyping the whole brief
 * into the wizard to say it was the only way to do this before.
 */
function RegenerateCard({ generationId, notes }: { generationId: number; notes: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState(notes);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <section>
      <div className="panel-head">
        <span className="panel-toggle">Not right yet?</span>
      </div>
      <div className="card">
        <p className="muted">
          Writes the copy again as <strong>the next version</strong>, against the same source and
          the same template. This version is kept, and the two can be compared side by side
          afterwards.
        </p>
        <label htmlFor="regen-notes">Special notes for the new version</label>
        <textarea
          id="regen-notes"
          value={draft}
          rows={4}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Angle, claims, constraints — what to do differently this time."
        />
        <div className="field-head save-row">
          <span className="muted">
            {error ? <span className="violation">{error}</span> : "Costs another run."}
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await regenerateAction(generationId, draft);
                if (result.ok && result.generationId) {
                  router.push(`/generations/${result.generationId}`);
                } else {
                  setError(result.message ?? "Could not start a new version.");
                }
              })
            }
          >
            {pending ? "Starting…" : "Regenerate"}
          </button>
        </div>
      </div>
    </section>
  );
}

/** "Reviews" -> "Review", for a single entry's header and the add button. */
function singular(label: string): string {
  return label.replace(/ies$/, "y").replace(/s$/, "");
}

/**
 * Offered for anything that is not finished, not only for `failed`.
 *
 * A run whose event is lost sits at `queued` forever. That is not a failure state, so
 * the old condition showed nothing at all and the only recovery was to start again.
 */
function RetryCard({
  generationId,
  status,
  errorMessage,
}: {
  generationId: number;
  status: string;
  errorMessage: string | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const stalled = status === "queued";
  return (
    <div className="card">
      <strong>
        {status === "failed"
          ? "This run failed."
          : stalled
            ? "This run never started."
            : `This run is ${status}.`}
      </strong>
      <p className="muted">
        {error ? (
          <span className="violation">{error}</span>
        ) : status === "failed" ? (
          (errorMessage ?? "No error recorded.")
        ) : stalled ? (
          "It was queued but no worker picked it up — usually the Inngest dev server was not running when it was submitted."
        ) : (
          "Still working. Re-running will abandon what is in flight and start the sections again."
        )}
      </p>
      <button
        type="button"
        className="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await retryGenerationAction(generationId);
            if (!result.ok) setError(result.message ?? "Could not re-run.");
          })
        }
      >
        {pending ? "Re-running…" : "Re-run"}
      </button>
    </div>
  );
}

function SectionPanel({
  section,
  row,
  spend,
  generationId,
  canEdit,
}: {
  section: TemplateSection;
  row: SectionRow | undefined;
  spend?: { usd: number; attempts: number; model: string | null };
  generationId: number;
  canEdit: boolean;
}) {
  /**
   * A local working copy. Editing straight into the fetched row would make every
   * realtime refetch overwrite whatever is half-typed, and a run finishing while
   * someone is mid-sentence is the normal case, not an edge one.
   */
  const [draft, setDraft] = useState<SectionOutput | null>(row?.output ?? null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [open, setOpen] = useState(true);

  // Adopt server changes only while there is nothing local to lose.
  useEffect(() => {
    if (!dirty) setDraft(row?.output ?? null);
  }, [row?.output, dirty]);

  const output = dirty ? draft : (row?.output ?? null);
  const count = instanceCount(section, output);
  const violations = row?.violations ?? [];
  const fields = generatedFields(section);

  const update = useCallback(
    (fieldKey: string, instance: number, value: unknown) => {
      setDraft((current) => writeField(section, current ?? output, fieldKey, instance, value));
      setDirty(true);
      setError(null);
    },
    [section, output],
  );

  const save = () => {
    startSave(async () => {
      const result = await saveSectionAction(generationId, section.id, draft ?? {});
      if (result.ok) {
        setDirty(false);
        setError(null);
      } else {
        setError(result.message ?? "Could not save.");
      }
    });
  };

  const hasEditableFields = fields.length > 0;

  return (
    <section>
      <div className="panel-head">
        <button type="button" className="panel-toggle" onClick={() => setOpen((v) => !v)}>
          <span aria-hidden>{open ? "▾" : "▸"}</span> {section.label}
        </button>
        <span className="row">
          {row && (
            <span className={`badge ${row.status === "flagged" ? "flag" : "ok"}`}>
              {row.status}
            </span>
          )}
          {row?.edited_at && <span className="badge">edited</span>}
          {spend && (
            /* An expensive section that also failed is the one worth changing
               something for; a cheap one that failed rarely is not. */
            <span className={`badge ${spend.attempts > 1 ? "flag" : ""}`}>
              ${spend.usd.toFixed(3)}
              {spend.attempts > 1 && ` · ${spend.attempts} attempts`}
            </span>
          )}
        </span>
      </div>

      {open && (
        <div className="card">
          {isRepeating(section) ? (
            <>
              {/* Fields that occur once for the whole panel sit above the cards, which
                  is where the CMS puts them. */}
              {section.fields
                .filter((field) => !fieldRepeats(section, field))
                .map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    section={section}
                    output={output}
                    instance={0}
                    violations={violations.filter((v) => v.address.endsWith(`.${field.key}`))}
                    canEdit={canEdit}
                    onChange={update}
                  />
                ))}
              {Array.from({ length: count }, (_, instance) => (
                /* The index IS the identity here: instances are positions in parallel
                   arrays, and there is no stable id to key on. Reordering is not
                   offered for exactly that reason. */
                // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
                <div className="instance" key={`${section.id}-${instance}`}>
                  <div className="field-head">
                    <span className="field-label">
                      {singular(section.label)} {instance + 1}
                    </span>
                    {canEdit && canRemoveInstance(section, count) && (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          setDraft(removeInstance(section, output, instance));
                          setDirty(true);
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {section.fields
                    .filter((field) => fieldRepeats(section, field))
                    .map((field) => (
                      <FieldRow
                        key={field.key}
                        field={field}
                        section={section}
                        output={output}
                        instance={instance}
                        violations={violations.filter((v) => v.address.endsWith(`.${field.key}`))}
                        canEdit={canEdit}
                        onChange={update}
                      />
                    ))}
                </div>
              ))}
              {canEdit && (
                <div className="field-head">
                  <button
                    type="button"
                    className="ghost"
                    disabled={!canAddInstance(section, count)}
                    onClick={() => {
                      setDraft(addInstance(section, output));
                      setDirty(true);
                    }}
                  >
                    + Add {singular(section.label)}
                  </button>
                  <span className="muted">
                    {count} of {section.repeat?.[0]}–{section.repeat?.[1]}
                  </span>
                </div>
              )}
            </>
          ) : (
            section.fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                section={section}
                output={output}
                instance={0}
                violations={violations.filter((v) => v.address.endsWith(`.${field.key}`))}
                canEdit={canEdit}
                onChange={update}
              />
            ))
          )}

          {/* Violations that belong to no visible field — a whole-section complaint. */}
          {violations
            .filter((v) => !section.fields.some((f) => v.address.endsWith(`.${f.key}`)))
            .map((v) => (
              <p className="violation" key={`${v.category}:${v.message}`}>
                [{v.category}] {v.message}
              </p>
            ))}

          {canEdit && hasEditableFields && (
            <div className="field-head save-row">
              <span className="muted">
                {/* Silence when nothing has happened. "Saved." on a section nobody has
                    touched claims an edit that never took place. */}
                {error ? (
                  <span className="violation">{error}</span>
                ) : dirty ? (
                  "Unsaved changes. Saving re-runs the checks on what you wrote."
                ) : row?.edited_at ? (
                  `Edited by hand ${new Date(row.edited_at).toLocaleString()}`
                ) : (
                  ""
                )}
              </span>
              <button type="button" onClick={save} disabled={!dirty || saving}>
                {saving ? "Saving…" : "Save section"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function FieldRow({
  field,
  section,
  output,
  instance,
  violations,
  canEdit,
  onChange,
}: {
  field: TemplateField;
  section: TemplateSection;
  output: SectionOutput | null;
  instance: number;
  violations: Violation[];
  canEdit: boolean;
  onChange: (fieldKey: string, instance: number, value: unknown) => void;
}) {
  const [copied, setCopied] = useState(false);
  const raw = readField(section, output, field.key, instance);
  const text = useMemo(() => renderFieldValue(field, raw), [field, raw]);

  const copy = useCallback(() => {
    /**
     * markdownBold describes the CMS field, not the copy. On a WYSIWYG field the **
     * markers are working annotations: the screen renders them so the operator can
     * see what to emphasise, and the clipboard gets clean text they re-bold with the
     * toolbar. Markdown links survive — the {{clickURL}} token has to reach the paste.
     */
    void navigator.clipboard.writeText(field.markdownBold ? text : text.replace(/\*\*/g, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [field.markdownBold, text]);

  // Nothing that is not generated appears here. Toggles, image slots and relation
  // pickers are set in the CMS and were only ever shown to keep the panel order
  // aligned with it — which cost more attention than the alignment was worth.
  if (!field.generate) return null;

  const words = countWords(text);
  const target = field.fallbackWordTarget;
  const inRange = !target || (words >= target[0] && words <= target[1]);
  const overLimit = field.charLimit !== undefined && text.length > field.charLimit;

  /**
   * The control matches the CMS control, because the point of this screen is that the
   * two can be read side by side. A scaffolded field is a plain markdown box in the
   * CMS even though it is stored here as copy slots, so it is edited as text and
   * parsed back on the way in.
   */
  const multiline = field.type !== "text";

  const emit = (next: string) => {
    // Each control writes back the shape the field is stored in, not the shape it is
    // edited in: a list is lines on screen and an array in the row.
    if (field.type === "scaffolded")
      return onChange(field.key, instance, parseScaffold(field, next));
    if (field.type === "list") return onChange(field.key, instance, parseList(next));
    return onChange(field.key, instance, next);
  };

  /**
   * The copy sits in the measure; everything measuring it sits in the margin. Running
   * the counts down a single right-aligned edge means a page of sections can be scanned
   * for red in one pass, rather than reading every field to find the one that is wrong.
   */
  return (
    <div className="proof">
      <div className="proof-rail">
        <span className="proof-name">{field.label}</span>
        {target && (
          <span className={`badge ${inRange ? "ok" : "flag"}`}>
            {words}w / {target[0]}–{target[1]}
          </span>
        )}
        {field.charLimit !== undefined && (
          <span className={`badge ${overLimit ? "flag" : ""}`}>
            {text.length}/{field.charLimit}
          </span>
        )}
        <button type="button" className="ghost" onClick={copy} disabled={!text}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="proof-body">
        {multiline ? (
          <textarea
            value={text}
            readOnly={!canEdit}
            rows={field.type === "markdown" ? 14 : 4}
            onChange={(e) => emit(e.target.value)}
            placeholder={canEdit ? "" : "pending…"}
            aria-label={field.label}
          />
        ) : (
          <input
            type="text"
            value={text}
            readOnly={!canEdit}
            onChange={(e) => emit(e.target.value)}
            aria-label={field.label}
          />
        )}

        {violations.map((v) => (
          <p className="violation" key={`${v.category}:${v.message}`}>
            [{v.category}] {v.message}
          </p>
        ))}
      </div>
    </div>
  );
}
