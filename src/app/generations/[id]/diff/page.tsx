import Link from "next/link";
import { notFound } from "next/navigation";
import { diffGenerations, type Token } from "@/lib/shared/diff";
import { parseManifest } from "@/lib/shared/manifest";
import type { SectionOutput } from "@/lib/shared/section-io";
import { createClient } from "@/lib/supabase/server";

interface Row {
  id: number;
  version_num: number;
  status: string;
  created_at: string;
  project_id: number;
  parent_id: number | null;
  manifest_snapshot: unknown;
}

/** Section outputs keyed by section id, which is the shape the diff wants. */
async function outputsFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  generationId: number,
): Promise<Record<string, SectionOutput | null>> {
  const { data } = await supabase
    .from("generation_sections")
    .select("section_id, output")
    .eq("generation_id", generationId);
  const map: Record<string, SectionOutput | null> = {};
  for (const row of data ?? []) map[row.section_id] = row.output as SectionOutput | null;
  return map;
}

export default async function DiffPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ vs?: string }>;
}) {
  const { id } = await params;
  const { vs } = await searchParams;
  const afterId = Number(id);
  if (!Number.isInteger(afterId)) notFound();

  const supabase = await createClient();
  const { data: after } = await supabase
    .from("generations")
    .select("id, version_num, status, created_at, project_id, parent_id, manifest_snapshot")
    .eq("id", afterId)
    .maybeSingle<Row>();
  if (!after) notFound();

  // Every other version of the same project, newest first, as comparison candidates.
  const { data: siblings } = await supabase
    .from("generations")
    .select("id, version_num, status, created_at, project_id, parent_id, manifest_snapshot")
    .eq("project_id", after.project_id)
    .neq("id", afterId)
    .order("version_num", { ascending: false })
    .returns<Row[]>();

  const candidates = siblings ?? [];
  /**
   * Default to the version this one was cloned from, falling back to the one before it.
   * "What did my regenerate change" is the question this screen exists to answer, and
   * making somebody pick the answer's other half first is a poor way to ask it.
   */
  const requested = vs ? candidates.find((c) => c.id === Number(vs)) : undefined;
  const before =
    requested ??
    candidates.find((c) => c.id === after.parent_id) ??
    candidates.find((c) => c.version_num < after.version_num);

  const { data: project } = await supabase
    .from("projects")
    .select("name")
    .eq("id", after.project_id)
    .maybeSingle();

  if (!before) {
    return (
      <main>
        <h1>Compare versions</h1>
        <p className="sub">{project?.name}</p>
        <div className="card">
          <p className="muted">
            Version {after.version_num} is the only run in this project, so there is nothing to
            compare it against yet. <Link href={`/generations/${after.id}`}>Open it</Link> or
            generate another version.
          </p>
        </div>
      </main>
    );
  }

  const manifest = parseManifest(after.manifest_snapshot);
  const [beforeOutputs, afterOutputs] = await Promise.all([
    outputsFor(supabase, before.id),
    outputsFor(supabase, after.id),
  ]);
  const diff = diffGenerations(manifest, beforeOutputs, afterOutputs);

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>
            v{before.version_num} → v{after.version_num}
          </h1>
          <p className="sub">
            <Link href={`/projects/${after.project_id}`}>{project?.name}</Link> ·{" "}
            {diff.changed === 0
              ? "nothing changed"
              : `${diff.changed} field${diff.changed === 1 ? "" : "s"} changed`}
            , {diff.unchanged} unchanged
          </p>
        </div>
        <Link href={`/generations/${after.id}`} className="ghost-link">
          Open v{after.version_num}
        </Link>
      </div>

      {/* A GET form so a comparison is a linkable URL. */}
      <form className="row search" action={`/generations/${after.id}/diff`} method="get">
        <label htmlFor="vs" className="muted">
          Compare against
        </label>
        <select id="vs" name="vs" defaultValue={String(before.id)}>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              v{c.version_num} — {new Date(c.created_at).toLocaleString()}
            </option>
          ))}
        </select>
        <button type="submit" className="ghost">
          Compare
        </button>
      </form>

      {diff.changed === 0 && (
        <div className="card">
          <p className="muted">
            These two versions produced identical copy in every generated field.
          </p>
        </div>
      )}

      {diff.sections
        .filter((section) => section.changed > 0)
        .map((section) => (
          <section key={section.sectionId}>
            <div className="panel-head">
              <span className="panel-toggle">{section.label}</span>
              <span className="badge flag">{section.changed} changed</span>
            </div>
            <div className="card">
              {section.fields
                .filter((f) => f.kind !== "same")
                .map((f) => (
                  <div className="field" key={`${f.instance ?? ""}${f.key}`}>
                    <div className="field-head">
                      <span className="field-label">
                        {f.instance ? `${f.instance} · ${f.label}` : f.label}
                      </span>
                      <span className={`badge ${f.kind === "removed" ? "flag" : "ok"}`}>
                        {f.kind}
                      </span>
                    </div>
                    {isWholesale(f.tokens) ? (
                      /* Nothing survived, so the two are shown as blocks. Running them
                         together as one paragraph reads as a single garbled sentence. */
                      <>
                        {f.before && (
                          <p className="diff">
                            <span className="diff-label">before</span>
                            <span className="del">{f.before}</span>
                          </p>
                        )}
                        {f.after && (
                          <p className="diff">
                            <span className="diff-label">after</span>
                            <span className="ins">{f.after}</span>
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="diff">
                        {withOffsets(f.tokens).map(({ token, offset }) => (
                          <TokenSpan key={`${token.kind}-${offset}`} token={token} />
                        ))}
                      </p>
                    )}
                  </div>
                ))}
            </div>
          </section>
        ))}
    </main>
  );
}

/** The diff fell back to whole-block replacement — nothing recognisable survived. */
function isWholesale(tokens: readonly Token[]): boolean {
  return tokens.length > 0 && tokens.every((t) => t.kind !== "same");
}

/**
 * A stable key per token: its character offset in the rendered stream. Tokens have no
 * identity of their own, and an offset is unique and does not shift when a neighbouring
 * token changes kind.
 */
function withOffsets(tokens: readonly Token[]): Array<{ token: Token; offset: number }> {
  let offset = 0;
  return tokens.map((token) => {
    const at = offset;
    offset += token.text.length;
    return { token, offset: at };
  });
}

function TokenSpan({ token }: { token: Token }) {
  if (token.kind === "same") return <span>{token.text}</span>;
  return <span className={token.kind === "added" ? "ins" : "del"}>{token.text}</span>;
}
