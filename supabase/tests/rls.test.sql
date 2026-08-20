-- RLS policy tests.
--
-- These are the exception to "no E2E". Policies are the only security boundary in
-- this system and they fail SILENTLY AND PERMISSIVELY when wrong, so every case here
-- asserts a DENIAL, not just an allow. Seeing a button disappear is not evidence.

begin;
select plan(21);

-- ── Impersonation helpers ───────────────────────────────────────────────────
-- Defined inside this transaction, so they vanish on rollback. A function that
-- writes request.jwt.claims would let any signed-in user forge a role, so it must
-- never exist in a committed schema.
--
-- PostgREST does `set role authenticated` for EVERY signed-in user, admin included,
-- and reads identity from the claims. Reproducing both is what makes these tests
-- exercise the real path rather than a superuser shortcut.

create schema tests;
-- The impersonated roles need to reach the helpers they call.
grant usage on schema tests to authenticated, anon;

create function tests.authenticate_as(user_id uuid, user_role text)
returns void language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_id::text, 'role', 'authenticated',
                      'user_role', user_role)::text, true);
end;
$fn$;

-- A signed-in user whose role row is missing: the JWT carries user_role: null. This
-- is what a mis-granted access-token hook produces, and login still succeeds, so it
-- has to be tested explicitly.
create function tests.authenticate_with_null_role(user_id uuid)
returns void language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_id::text, 'role', 'authenticated',
                      'user_role', null)::text, true);
end;
$fn$;

create function tests.clear_authentication()
returns void language plpgsql as $fn$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
end;
$fn$;

-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, aud, role)
values
  ('11111111-1111-1111-1111-111111111111', 'admin@example.com',  '{}', '{}', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'editor@example.com', '{}', '{}', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'other@example.com',  '{}', '{}', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'viewer@example.com', '{}', '{}', 'authenticated', 'authenticated');

insert into public.user_roles (user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'admin'),
  ('22222222-2222-2222-2222-222222222222', 'editor'),
  ('33333333-3333-3333-3333-333333333333', 'editor'),
  ('44444444-4444-4444-4444-444444444444', 'viewer');

-- A fixture-only slug. Reusing a real one collides with seeded data, which makes
-- these tests pass on a fresh database and fail on a working one.
insert into public.templates (slug, name, manifest)
values ('zz_test_rls', 'Fixture', '{"slug":"advertorial_v1","sections":[]}'::jsonb);

insert into public.projects (owner_id, name, product_name)
values ('22222222-2222-2222-2222-222222222222', 'zz_test_project', 'Widget');

-- Identity sequences are not rolled back, so ids differ between runs. Resolve them
-- once into a temp table and reference that everywhere.
create temp table fixture as
select (select id from public.templates where slug like 'zz_test_%') as template_id,
       (select id from public.projects where name = 'zz_test_project') as project_id;

insert into public.generations (owner_id, project_id, template_id)
select '22222222-2222-2222-2222-222222222222', project_id, template_id from fixture;

create temp table gen as
select id from public.generations
where project_id = (select project_id from fixture) order by id limit 1;

-- A generated section to edit. The worker writes these under the secret key; the
-- policy added in 0009 is what decides whether a reviewer may change one.
insert into public.generation_sections (generation_id, section_id, output, status)
select id, 'hero', '{"page_title":"original"}'::jsonb, 'done' from gen;

grant select on fixture, gen to authenticated;

-- ── The allowlist is the gate, and it is admin-only ─────────────────────────

select tests.authenticate_as('22222222-2222-2222-2222-222222222222', 'editor');

select is_empty(
  $$ select email from public.allowed_emails $$,
  'editor cannot read the allowlist'
);

select throws_ok(
  $$ insert into public.allowed_emails (email) values ('sneak@example.com') $$,
  '42501',
  null,
  'editor cannot add themselves to the allowlist'
);

select throws_ok(
  $$ insert into public.user_roles (user_id, role)
     values ('22222222-2222-2222-2222-222222222222', 'admin') $$,
  '42501',
  null,
  'editor cannot escalate their own role'
);

-- ── Shared visibility, role-gated mutation ──────────────────────────────────

select isnt_empty(
  $$ select id from public.generations where id = (select id from gen) $$,
  'editor reads every generation, not just their own'
);

select lives_ok(
  $$ update public.generations set special_notes = 'edited'
     where id = (select id from gen) $$,
  'editor updates a generation they own'
);

-- Mutation gates on ROLE, not ownership. An editor may retry and regenerate any
-- run, which is what keeps the review screen buttons honest for every run it shows.
select tests.authenticate_as('33333333-3333-3333-3333-333333333333', 'editor');

select lives_ok(
  $$ update public.generations set special_notes = 'by a non-owner'
     where id = (select id from gen) $$,
  'a non-owner editor may update — mutation is role-gated by design'
);

select throws_ok(
  $$ insert into public.generations (owner_id, project_id, template_id)
     select '22222222-2222-2222-2222-222222222222', project_id, template_id from fixture $$,
  '42501',
  null,
  'an editor cannot create a generation owned by someone else'
);

-- ── The viewer, including the case that catches an ownership-gated policy ───

select tests.authenticate_as('44444444-4444-4444-4444-444444444444', 'viewer');

select isnt_empty(
  $$ select id from public.generations where id = (select id from gen) $$,
  'viewer can read'
);

select throws_ok(
  $$ insert into public.generations (owner_id, project_id, template_id)
     select '44444444-4444-4444-4444-444444444444', project_id, template_id from fixture $$,
  '42501',
  null,
  'viewer cannot create a generation'
);

select results_eq(
  $$ with attempted as (
       update public.generations set special_notes = 'viewer edit'
       where id = (select id from gen) returning 1
     ) select count(*)::int from attempted $$,
  $$ values (0) $$,
  'viewer update matches zero rows even on a project they can read'
);

-- A viewer who OWNS the row. This is the case that catches a policy gating on
-- ownership instead of role — a demoted editor keeping write access forever.
select tests.clear_authentication();
insert into public.generations (owner_id, project_id, template_id)
select '44444444-4444-4444-4444-444444444444', project_id, template_id from fixture;

create temp table viewer_gen as
select id from public.generations
where owner_id = '44444444-4444-4444-4444-444444444444'
  and project_id = (select project_id from fixture);
grant select on viewer_gen to authenticated;

select tests.authenticate_as('44444444-4444-4444-4444-444444444444', 'viewer');

select results_eq(
  $$ with attempted as (
       update public.generations set special_notes = 'own row'
       where id = (select id from viewer_gen) returning 1
     ) select count(*)::int from attempted $$,
  $$ values (0) $$,
  'viewer cannot update EVEN A ROW THEY OWN — the policy gates on role'
);

-- ── A null role claim: what a mis-granted access-token hook produces ────────

select tests.authenticate_with_null_role('22222222-2222-2222-2222-222222222222');

select results_eq(
  $$ with attempted as (
       update public.generations set special_notes = 'null role'
       where id = (select id from gen) returning 1
     ) select count(*)::int from attempted $$,
  $$ values (0) $$,
  'a null user_role claim denies every write rather than defaulting open'
);

select throws_ok(
  $$ insert into public.generations (owner_id, project_id, template_id)
     select '22222222-2222-2222-2222-222222222222', project_id, template_id from fixture $$,
  '42501',
  null,
  'a null user_role claim cannot insert'
);

-- ── Delete is admin-only, and the admin path actually works ─────────────────
-- If DELETE were revoked from `authenticated`, this would fail with 42501 before
-- RLS was consulted, because admins are `authenticated` too.

select tests.authenticate_as('22222222-2222-2222-2222-222222222222', 'editor');
select results_eq(
  $$ with attempted as (
       delete from public.generations where id = (select id from viewer_gen) returning 1
     ) select count(*)::int from attempted $$,
  $$ values (0) $$,
  'editor cannot delete'
);

select tests.authenticate_as('11111111-1111-1111-1111-111111111111', 'admin');
select results_eq(
  $$ with attempted as (
       delete from public.generations where id = (select id from viewer_gen) returning 1
     ) select count(*)::int from attempted $$,
  $$ values (1) $$,
  'admin CAN delete — the grant is open enough for the policy to run'
);

select lives_ok(
  $$ insert into public.allowed_emails (email, role) values ('new@example.com', 'editor') $$,
  'admin manages the allowlist'
);

-- ── Editing generated copy ──────────────────────────────────────────────────
-- Review is not read-only: a flagged section is meant to be fixed. The gate is the
-- same one generations and sources use — role, not ownership.

select tests.authenticate_as('44444444-4444-4444-4444-444444444444', 'viewer');

select isnt_empty(
  $$ select section_id from public.generation_sections where generation_id = (select id from gen) $$,
  'viewer reads generated copy'
);

-- lives_ok, not throws_ok: a failing UPDATE policy matches zero rows rather than
-- raising, so the assertion has to be that NOTHING CHANGED.
select lives_ok(
  $$ update public.generation_sections set output = '{"page_title":"viewer was here"}'::jsonb
     where generation_id = (select id from gen) $$,
  'viewer update raises nothing — which is exactly why the next assertion exists'
);

select tests.clear_authentication();

select is(
  (select output->>'page_title' from public.generation_sections
    where generation_id = (select id from gen) and section_id = 'hero'),
  'original',
  'viewer silently changed nothing'
);

select tests.authenticate_as('22222222-2222-2222-2222-222222222222', 'editor');

update public.generation_sections
   set output = '{"page_title":"edited by hand"}'::jsonb
 where generation_id = (select id from gen);

select tests.clear_authentication();

select is(
  (select output->>'page_title' from public.generation_sections
    where generation_id = (select id from gen) and section_id = 'hero'),
  'edited by hand',
  'editor may fix a flagged section'
);

-- ── Anonymous access is revoked outright ────────────────────────────────────

select tests.clear_authentication();
set role anon;

select throws_ok(
  $$ select id from public.generations $$,
  '42501',
  null,
  'anon has no grant at all — not merely no matching policy'
);

reset role;
select tests.clear_authentication();

select * from finish();
rollback;
