-- LanderForge schema.
--
-- Conventions: timestamptz (never bare timestamp) defaulting to now(); text (never
-- varchar(n)); id bigint generated always as identity except where a natural key is
-- shown. A moddatetime trigger goes on every table that declares updated_at;
-- append-only tables declare only created_at.

create extension if not exists moddatetime schema extensions;

-- ── Auth -------------------------------------------------------------------

create type public.app_role as enum ('admin', 'editor', 'viewer');

-- Sign-in is Google OAuth only, restricted to addresses on this list. Match FULL
-- addresses, not the domain: a gmail.com domain rule would admit all of Google.
create table public.allowed_emails (
  email       text primary key,
  role        public.app_role not null default 'editor',
  note        text,
  invited_by  uuid references auth.users on delete set null,
  created_at  timestamptz not null default now()
);

create table public.user_roles (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references auth.users on delete cascade,
  role     public.app_role not null,
  unique (user_id, role)
);

-- The access-token hook does `select role into ...`, which would otherwise pick an
-- arbitrary row.
create unique index user_roles_one_per_user on public.user_roles (user_id);

-- ── Content ----------------------------------------------------------------

create table public.templates (
  id          bigint generated always as identity primary key,
  slug        text not null unique,
  name        text not null,
  manifest    jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.projects (
  id                   bigint generated always as identity primary key,
  owner_id             uuid not null default auth.uid() references auth.users,
  name                 text not null,
  product_name         text not null,
  -- The literal-name lint matches all of these, not just product_name: one real page
  -- renders "Pest Pulse Pro Solar" in the body and "PestPulsePro Solar" in its title.
  product_name_aliases text[] not null default '{}',
  niche                text,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table public.sources (
  id                      bigint generated always as identity primary key,
  project_id              bigint not null references public.projects on delete cascade,
  source_type             text not null check (source_type in ('url', 'paste', 'screenshot')),
  url                     text,
  url_normalized          text,
  scraped_at              timestamptz,
  -- url: set by the scrape ladder. paste: 'manual'. screenshot: inserted 'pending',
  -- then 'ok' by the transcription function, or 'failed'.
  status                  text not null default 'pending'
                          check (status in ('pending','ok','blocked','failed','manual')),
  -- The typed block array: the density substrate. Written by whichever extractor
  -- produced this source, then editable by the operator on the ocr path only.
  -- raw_text is always its concatenation. Never written by Step 1.
  blocks                  jsonb,
  raw_text                text,
  raw_text_truncated      boolean not null default false,
  transcript_confirmed_at timestamptz,
  raw_html_path           text,
  created_at              timestamptz not null default now()
);

create table public.source_screenshots (
  id              bigint generated always as identity primary key,
  source_id       bigint not null references public.sources on delete cascade,
  position        integer not null,
  original_path   text,
  derivative_path text,
  width           integer,
  height          integer,
  bytes           integer,
  created_at      timestamptz not null default now(),
  unique (source_id, position)
);

create table public.generations (
  id                bigint generated always as identity primary key,
  owner_id          uuid not null default auth.uid() references auth.users,
  project_id        bigint not null references public.projects on delete cascade,
  template_id       bigint not null references public.templates,
  source_id         bigint references public.sources,
  -- Snapshot the manifest at run time. Editing a template must not re-judge or
  -- re-render historical generations against rules they were never written for.
  manifest_snapshot jsonb not null,
  version_num       integer not null,
  parent_id         bigint references public.generations,
  special_notes     text,
  -- Step 1 output: blockMap + the code-built sectionPlan + allowedSpecs + upgrade plan.
  brief             jsonb,
  status            text not null default 'queued'
                    check (status in ('queued','scraping','briefing','generating','done','failed')),
  error_message     text,
  -- Run-level findings that are not attributable to one field.
  run_notes         jsonb,
  retry_count       integer not null default 0,
  total_cost_usd    numeric(10, 4),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (project_id, version_num)
);

create table public.generation_sections (
  id            bigint generated always as identity primary key,
  generation_id bigint not null references public.generations on delete cascade,
  section_id    text not null,
  output        jsonb,
  status        text not null default 'pending' check (status in ('pending','done','flagged')),
  violations    jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (generation_id, section_id)
);

-- Required, not optional: the only debugging surface when copy quality drifts, and
-- the only way to confirm the prompt cache is actually being hit.
create table public.generation_steps (
  id                          bigint generated always as identity primary key,
  generation_id               bigint not null references public.generations on delete cascade,
  step                        text not null,
  section_id                  text,
  attempt                     integer not null default 0,
  prompt                      jsonb,
  response                    jsonb,
  model                       text,
  stop_reason                 text,
  input_tokens                integer,
  output_tokens               integer,
  cache_creation_input_tokens integer,
  cache_read_input_tokens     integer,
  latency_ms                  integer,
  cost_usd                    numeric(10, 6),
  created_at                  timestamptz not null default now()
);

create table public.rules (
  id         bigint generated always as identity primary key,
  scope      text not null check (scope in ('global', 'project')),
  project_id bigint references public.projects on delete cascade,
  body       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'global' and project_id is null)
      or (scope = 'project' and project_id is not null))
);

create table public.client_config (
  id                        bigint generated always as identity primary key,
  supported_runtime_versions text[] not null default '{}',
  latest_apk_url            text,
  updated_at                timestamptz not null default now()
);

-- ── Indexes ----------------------------------------------------------------
-- Postgres does not index foreign keys for you, and RLS filters on owner_id.

create index on public.sources (project_id);
create index on public.source_screenshots (source_id);
create index on public.generations (project_id);
create index on public.generations (template_id);
create index on public.generations (source_id);
create index on public.generations (parent_id);
create index on public.generations (owner_id);
create index on public.generation_sections (generation_id);
create index on public.generation_steps (generation_id);
create index on public.rules (project_id);
create index on public.projects (owner_id);

-- ── Triggers ---------------------------------------------------------------

create trigger set_updated_at before update on public.templates
  for each row execute function extensions.moddatetime (updated_at);
create trigger set_updated_at before update on public.projects
  for each row execute function extensions.moddatetime (updated_at);
create trigger set_updated_at before update on public.generations
  for each row execute function extensions.moddatetime (updated_at);
create trigger set_updated_at before update on public.generation_sections
  for each row execute function extensions.moddatetime (updated_at);
create trigger set_updated_at before update on public.rules
  for each row execute function extensions.moddatetime (updated_at);
create trigger set_updated_at before update on public.client_config
  for each row execute function extensions.moddatetime (updated_at);

-- Ownership is immutable after insert. Role-gated UPDATE means neither `using` nor
-- `with check` constrains what owner_id becomes, so this needs a trigger.
create or replace function public.freeze_owner()
returns trigger language plpgsql as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id is immutable';
  end if;
  return new;
end;
$$;

create trigger freeze_owner before update on public.generations
  for each row execute function public.freeze_owner();
create trigger freeze_owner before update on public.projects
  for each row execute function public.freeze_owner();

-- version_num and manifest_snapshot are assigned here, not by the caller.
-- Projects are shared, so two editors would otherwise read the same max and the
-- second insert would surface a raw duplicate-key error. And manifest_snapshot
-- decides which rules a run is judged against: if the client supplies it, an editor
-- picks their own grading criteria and no policy would notice.
create or replace function public.assign_generation_defaults()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  parent public.generations%rowtype;
begin
  select coalesce(max(version_num), 0) + 1 into new.version_num
    from public.generations where project_id = new.project_id;

  if new.parent_id is null then
    select manifest into new.manifest_snapshot
      from public.templates where id = new.template_id;
  else
    -- A clone stamped with the CURRENT template would be judged against a manifest
    -- its copied-over sections were never written for.
    select * into parent from public.generations where id = new.parent_id;
    new.manifest_snapshot := parent.manifest_snapshot;
    new.source_id := parent.source_id;
  end if;

  if new.manifest_snapshot is null then
    raise exception 'no manifest for template %', new.template_id;
  end if;
  return new;
end;
$$;

create trigger assign_generation_defaults before insert on public.generations
  for each row execute function public.assign_generation_defaults();
