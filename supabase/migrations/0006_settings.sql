-- Cost controls, as data rather than constants.
--
-- Every value here was previously hardcoded in the pipeline. Moving them into a table
-- makes tuning a form submission instead of a deploy, which matters because the right
-- values are only discoverable by watching real runs.

create table public.settings (
  -- A single row, enforced rather than left to convention: a second row would
  -- silently shadow the first depending on read order.
  id                 integer primary key default 1 check (id = 1),

  -- Hard ceiling on API calls in one generation. The backstop against a validation
  -- loop that never converges — the app's own guard, independent of the provider's.
  max_calls_per_run  integer not null default 60 check (max_calls_per_run between 5 and 500),

  -- Manifests name a TIER; these name the model behind it. Swapping in a newer fast
  -- model is then one settings change rather than an edit to every manifest.
  standard_model     text not null default 'claude-sonnet-4-6',
  fast_model         text not null default 'claude-haiku-4-5',

  -- Advisory only. Surfaced on the cost screen; nothing blocks on it, because a hard
  -- stop mid-run would leave a half-written page.
  monthly_budget_usd numeric(10, 2),

  updated_at         timestamptz not null default now()
);

insert into public.settings (id) values (1);

create trigger set_updated_at before update on public.settings
  for each row execute function extensions.moddatetime (updated_at);

alter table public.settings enable row level security;

-- Everyone signed in reads them — the pipeline and the cost screen both need them.
-- Only an admin writes, and via a live role check rather than the JWT claim, because
-- these values move money and an hour of stale authority is not acceptable.
create policy "read all" on public.settings for select to authenticated using (true);
create policy "admin writes" on public.settings for update to authenticated
  using ((select private.has_role('admin')))
  with check ((select private.has_role('admin')));

grant select, update on public.settings to authenticated;

-- No insert or delete grant at all: there is exactly one row and it already exists.
