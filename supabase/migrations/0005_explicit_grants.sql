-- Explicit table grants.
--
-- Supabase's default privileges for `authenticated` differ between CLI and image
-- versions: some grant every table operation on new public tables, some grant none.
-- Depending on that default made the policy tests pass locally and fail in CI with
-- `permission denied for table allowed_emails` — a grant error (42501) raised before
-- RLS is ever consulted.
--
-- Grants and policies are two separate gates, so the grant side has to be stated as
-- deliberately as the policy side. This resets both roles to zero and then grants
-- exactly what each table's policies need, which is also strictly less than the
-- blanket default.

-- ── Reset ────────────────────────────────────────────────────────────────────

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon;

-- `anon` is granted nothing at all: this app has no anonymous access by design.

-- ── Content the app reads and writes ─────────────────────────────────────────
-- DELETE stays granted where an admin-delete policy exists. Revoking it would make
-- that policy permanently unsatisfiable, because PostgREST runs every signed-in user
-- — admins included — as `authenticated`.

grant select, insert, update, delete on public.projects    to authenticated;
grant select, insert, update, delete on public.generations to authenticated;

-- ── Child tables: read via the parent, written only by the worker ────────────
-- The worker holds the secret key and bypasses RLS, so no client write grant is
-- needed and none is given.

grant select on public.source_screenshots  to authenticated;
grant select on public.generation_sections to authenticated;
grant select on public.generation_steps    to authenticated;

-- `sources` is read-only except for the transcript columns, which the confirmation
-- screen writes directly under RLS rather than through an endpoint.
grant select on public.sources to authenticated;
grant update (blocks, raw_text, raw_text_truncated, transcript_confirmed_at)
  on public.sources to authenticated;

-- ── Reference tables: everyone reads, policies restrict writes to admin ──────

grant select, insert, update, delete on public.templates     to authenticated;
grant select, insert, update, delete on public.rules         to authenticated;
grant select, insert, update, delete on public.client_config to authenticated;

-- ── Access control: policies gate these on a LIVE admin check ────────────────

grant select, insert, update, delete on public.allowed_emails to authenticated;
grant select, insert, update, delete on public.user_roles     to authenticated;

-- The auth hooks read these as `supabase_auth_admin`, which is neither anon nor
-- authenticated and so is untouched by the revokes above. Re-stated here because the
-- blanket revoke is easy to extend later without noticing what it would break.
grant select on public.allowed_emails to supabase_auth_admin;
grant all    on public.user_roles     to supabase_auth_admin;
