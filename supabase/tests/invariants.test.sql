-- Database-enforced invariants.
--
-- These exist because an invariant living only in application code is an invariant
-- with a hole in it the moment a second client appears. Note that surrogate ids are
-- always resolved dynamically: identity sequences do not roll back between runs, so
-- a literal id is a different row on the second run.

begin;
select plan(6);

insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, aud, role)
values ('55555555-5555-5555-5555-555555555555', 'owner@example.com', '{}', '{}',
        'authenticated', 'authenticated');

-- A fixture-only slug; see the note in rls.test.sql.
insert into public.templates (slug, name, manifest)
values ('zz_test_invariants', 'Fixture',
        '{"slug":"advertorial_v1","name":"A","sections":[]}'::jsonb);

insert into public.projects (owner_id, name, product_name)
values ('55555555-5555-5555-5555-555555555555', 'zz_test_project', 'Widget');

create temp table fixture as
select (select id from public.templates where slug like 'zz_test_%') as template_id,
       (select id from public.projects where name = 'zz_test_project') as project_id;

-- version_num is assigned by a trigger, not the caller: two editors generating into
-- one shared project would otherwise read the same max and collide on the unique key.
insert into public.generations (owner_id, project_id, template_id)
select '55555555-5555-5555-5555-555555555555', project_id, template_id from fixture;
insert into public.generations (owner_id, project_id, template_id)
select '55555555-5555-5555-5555-555555555555', project_id, template_id from fixture;

select results_eq(
  $$ select version_num from public.generations
     where project_id = (select project_id from fixture) order by version_num $$,
  $$ values (1), (2) $$,
  'version_num is assigned sequentially per project by the trigger'
);

-- manifest_snapshot is copied from the template, never supplied. If a client could
-- supply it, an editor would pick the rules their own run is judged against.
select isnt(
  (select manifest_snapshot from public.generations
   where version_num = 1 and project_id = (select project_id from fixture)),
  null,
  'manifest_snapshot is stamped from the template at insert'
);

select results_eq(
  $$ select (manifest_snapshot ->> 'slug') from public.generations
     where version_num = 1 and project_id = (select project_id from fixture) $$,
  $$ values ('advertorial_v1') $$,
  'the snapshot is the template manifest, not caller input'
);

-- A regenerate clone inherits the PARENT's snapshot. Stamping it with the CURRENT
-- template would judge copied-over sections against rules they were never written for
-- the moment anyone edits that template — and nothing would surface it.
update public.templates
set manifest = '{"slug":"advertorial_v1","name":"CHANGED","sections":[]}'::jsonb
where slug like 'zz_test_%';

insert into public.generations (owner_id, project_id, template_id, parent_id)
select '55555555-5555-5555-5555-555555555555', f.project_id, f.template_id,
       (select id from public.generations
        where version_num = 1 and project_id = (select project_id from fixture))
from fixture f;

select results_eq(
  $$ select (manifest_snapshot ->> 'name') from public.generations
     where parent_id is not null and project_id = (select project_id from fixture) $$,
  $$ values ('A') $$,
  'a clone inherits the parent snapshot, not the edited live template'
);

-- Ownership is immutable. UPDATE gates on role, so neither policy clause constrains
-- what owner_id becomes — that needs a trigger.
select throws_ok(
  $$ update public.generations
     set owner_id = '00000000-0000-0000-0000-000000000000'
     where version_num = 1 and project_id = (select project_id from fixture) $$,
  'owner_id is immutable',
  'ownership cannot be reassigned after insert'
);

-- rules rows cannot be incoherent.
select throws_ok(
  $$ insert into public.rules (scope, project_id, body) values ('project', null, 'x') $$,
  '23514',
  null,
  'a project-scoped rule must name a project'
);

select * from finish();
rollback;
