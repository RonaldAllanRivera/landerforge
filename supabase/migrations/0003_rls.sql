-- Row Level Security.
--
-- Grants and policies are two separate gates. Supabase grants select/insert/update/
-- delete to anon and authenticated by default on public tables, and adding policies
-- does NOT take those back.

alter table public.allowed_emails     enable row level security;
alter table public.user_roles         enable row level security;
alter table public.templates          enable row level security;
alter table public.projects           enable row level security;
alter table public.sources            enable row level security;
alter table public.source_screenshots enable row level security;
alter table public.generations        enable row level security;
alter table public.generation_sections enable row level security;
alter table public.generation_steps   enable row level security;
alter table public.rules              enable row level security;
alter table public.client_config      enable row level security;

-- This app has no legitimate anonymous access at all.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

-- Do NOT also revoke DELETE from authenticated. Admins are not a separate Postgres
-- role — PostgREST does `set role authenticated` for every signed-in user, admin
-- included — so revoking it would make the admin-delete policy permanently
-- unsatisfiable and deletes would fail with 42501 before RLS is ever consulted.

-- Correcting and confirming a transcript are direct RLS writes, so no endpoint is
-- needed. The grant is column-scoped to exactly those three columns.
revoke update on public.sources from authenticated;
grant update (blocks, raw_text, raw_text_truncated, transcript_confirmed_at)
  on public.sources to authenticated;

-- ── Helpers -----------------------------------------------------------------
-- (select auth.jwt() ...) is wrapped so it runs once per statement, not per row.

create or replace function public.jwt_role()
returns text language sql stable as $$
  select coalesce(auth.jwt() ->> 'user_role', 'none');
$$;

-- ── projects ----------------------------------------------------------------

create policy "read all" on public.projects for select to authenticated using (true);

create policy "editors insert" on public.projects for insert to authenticated
  with check (owner_id = (select auth.uid())
              and (select public.jwt_role()) in ('admin', 'editor'));

create policy "editors update" on public.projects for update to authenticated
  using ((select public.jwt_role()) in ('admin', 'editor'));

create policy "admin delete" on public.projects for delete to authenticated
  using ((select private.has_role('admin')));

-- ── generations --------------------------------------------------------------
-- UPDATE gates on ROLE, not ownership. Gating on ownership alone leaves a demoted
-- editor with permanent write access to every row they already own — indefinitely,
-- because the policy would never consult the role at all.

create policy "read all" on public.generations for select to authenticated using (true);

create policy "editors insert" on public.generations for insert to authenticated
  with check (owner_id = (select auth.uid())
              and (select public.jwt_role()) in ('admin', 'editor'));

create policy "editors update" on public.generations for update to authenticated
  using ((select public.jwt_role()) in ('admin', 'editor'));

create policy "admin delete" on public.generations for delete to authenticated
  using ((select private.has_role('admin')));

-- ── child tables --------------------------------------------------------------
-- Read via the parent. No client write grant: the worker owns them, under the secret
-- key, which bypasses RLS.

create policy "read via project" on public.sources for select to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id));

create policy "update transcript" on public.sources for update to authenticated
  using ((select public.jwt_role()) in ('admin', 'editor'));

create policy "read via source" on public.source_screenshots for select to authenticated
  using (exists (select 1 from public.sources s where s.id = source_id));

create policy "read via generation" on public.generation_sections for select to authenticated
  using (exists (select 1 from public.generations g where g.id = generation_id));

-- Cost is readable by anyone who can read the parent generation: the review screen
-- shows run cost, and Phase 1 acceptance depends on that being visible.
create policy "read via generation" on public.generation_steps for select to authenticated
  using (exists (select 1 from public.generations g where g.id = generation_id));

-- ── reference tables -----------------------------------------------------------

create policy "read all" on public.templates for select to authenticated using (true);
create policy "admin writes" on public.templates for all to authenticated
  using ((select private.has_role('admin'))) with check ((select private.has_role('admin')));

create policy "read all" on public.rules for select to authenticated using (true);
create policy "admin writes" on public.rules for all to authenticated
  using ((select private.has_role('admin'))) with check ((select private.has_role('admin')));

create policy "read all" on public.client_config for select to authenticated using (true);
create policy "admin writes" on public.client_config for all to authenticated
  using ((select private.has_role('admin'))) with check ((select private.has_role('admin')));

-- ── admin-only tables ----------------------------------------------------------
-- Live check, not the claim: revocation must be instant here.

create policy "admin manages allowlist" on public.allowed_emails for all to authenticated
  using ((select private.has_role('admin'))) with check ((select private.has_role('admin')));

create policy "admin manages roles" on public.user_roles for all to authenticated
  using ((select private.has_role('admin'))) with check ((select private.has_role('admin')));

-- ── Realtime --------------------------------------------------------------------
-- Postgres Changes does not fire for tables outside the publication. Subscribe to
-- BOTH: a run that fails during the scrape or brief writes no section rows at all,
-- so without the generations subscription the failed state never reaches the UI.

alter publication supabase_realtime add table public.generations;
alter publication supabase_realtime add table public.generation_sections;
