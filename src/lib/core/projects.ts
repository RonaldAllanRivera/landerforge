import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type CreateProjectValues, normaliseProjectName } from "@/lib/shared/project";

/** The I/O half. Validation and normalisation live in lib/shared/project. */

export interface ProjectSummary {
  id: number;
  name: string;
  product_name: string;
  niche: string | null;
  generations: number;
  lastRunAt: string | null;
  totalUsd: number;
}

export interface ProjectPage {
  items: ProjectSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export const PROJECTS_PER_PAGE = 20;

/**
 * One page of projects, with enough history to be worth listing.
 *
 * Paged and searched in the DATABASE rather than in the page component. This list is
 * expected to reach the hundreds, and the version that fetched everything and counted
 * in JavaScript would have degraded quietly — a list that still renders while getting
 * slower is the kind of thing nobody notices until it is the slowest screen.
 *
 * The generation rollup is scoped to the ids on this page for the same reason.
 */
export async function listProjects(
  db: SupabaseClient,
  options: { search?: string; page?: number } = {},
): Promise<ProjectPage> {
  const pageSize = PROJECTS_PER_PAGE;
  const page = Math.max(1, options.page ?? 1);
  const search = options.search?.trim() ?? "";

  let query = db
    .from("projects")
    .select("id, name, product_name, niche", { count: "exact" })
    .order("name");

  if (search) {
    // Escape the PostgREST filter separators, or a comma in the box splits the
    // condition and a parenthesis makes it unparseable.
    const term = search.replace(/[,()\\]/g, " ").trim();
    if (term) query = query.or(`name.ilike.%${term}%,product_name.ilike.%${term}%`);
  }

  const { data: projects, count } = await query.range((page - 1) * pageSize, page * pageSize - 1);
  const rows = projects ?? [];
  const total = count ?? rows.length;

  const stats = new Map<
    number,
    { generations: number; lastRunAt: string | null; totalUsd: number }
  >();
  if (rows.length > 0) {
    const { data: generations } = await db
      .from("generations")
      .select("project_id, created_at, total_cost_usd")
      .in(
        "project_id",
        rows.map((p) => p.id),
      );
    for (const g of generations ?? []) {
      const entry = stats.get(g.project_id) ?? { generations: 0, lastRunAt: null, totalUsd: 0 };
      entry.generations += 1;
      entry.totalUsd += Number(g.total_cost_usd ?? 0);
      if (entry.lastRunAt === null || g.created_at > entry.lastRunAt) {
        entry.lastRunAt = g.created_at;
      }
      stats.set(g.project_id, entry);
    }
  }

  return {
    items: rows.map((p) => ({
      ...p,
      ...(stats.get(p.id) ?? { generations: 0, lastRunAt: null, totalUsd: 0 }),
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export type CreateProjectOutcome = { ok: true; projectId: number } | { ok: false; message: string };

/**
 * Insert a project, translating the unique-index violation into something readable.
 *
 * Checking for an existing name first and inserting second would still race — two
 * submissions can both find nothing — so the constraint is the check and this handles
 * its error. That is the only version of this that is actually correct.
 */
export async function createProject(
  db: SupabaseClient,
  values: CreateProjectValues,
  ownerId: string,
): Promise<CreateProjectOutcome> {
  const { data, error } = await db
    .from("projects")
    .insert({
      owner_id: ownerId,
      name: values.name,
      product_name: values.product_name,
      product_name_aliases: values.product_name_aliases,
      niche: values.niche || null,
      notes: values.notes || null,
    })
    .select("id")
    .single();

  if (error?.code === "23505") {
    /**
     * Name the project that already exists, not the one they typed. Those differ by
     * exactly the case or spacing that caused the collision, and echoing their input
     * back reads as the tool being wrong about its own contents.
     */
    const { data: clash } = await db
      .from("projects")
      .select("name")
      .ilike("name", normaliseProjectName(values.name))
      .maybeSingle();
    const existing = clash?.name ?? normaliseProjectName(values.name);
    return {
      ok: false,
      message: `"${existing}" already exists — names ignore case and extra spacing. Pick another name, or open that project from Projects.`,
    };
  }
  if (error) return { ok: false, message: error.message };
  return { ok: true, projectId: data.id as number };
}
