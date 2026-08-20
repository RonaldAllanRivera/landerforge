-- Editing generated copy in place.
--
-- Until now the child tables were read-only to clients — the worker owned them under
-- the secret key. Review is not a read-only activity though: the point of flagging a
-- section is that somebody fixes it, and making them fix it in the CMS instead means
-- the violation list never clears and the next run has nothing to learn from.
--
-- The gate is the same one `generations` and `sources` already use: ROLE, not
-- ownership. Gating on ownership alone leaves a demoted editor with permanent write
-- access to every row they already own, because the policy never consults the role.

create policy "editors update" on public.generation_sections for update to authenticated
  using ((select public.jwt_role()) in ('admin', 'editor'))
  with check ((select public.jwt_role()) in ('admin', 'editor'));

-- Who last touched the copy by hand. Worth recording on its own terms: "flagged by the
-- validator" and "a person has been in here" are different states, and a section that
-- was edited should not be silently overwritten by a regenerate without warning.
alter table public.generation_sections
  add column edited_at timestamptz,
  add column edited_by uuid references auth.users (id);

/**
 * Stamped by the database, not the caller.
 *
 * A column-level grant would still let a client write someone else's id into
 * edited_by. Deriving it from the session removes the question entirely.
 *
 * The worker writes these rows too, under the secret key, where auth.uid() is null —
 * so a generated section is left unstamped and only a human edit sets the columns.
 */
create or replace function public.stamp_section_edit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.edited_at := now();
    new.edited_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger stamp_section_edit before update on public.generation_sections
  for each row execute function public.stamp_section_edit();

-- Only the three columns a review can legitimately change. status and violations are
-- recomputed server-side from the edited output, so an operator cannot mark their own
-- section clean by editing the badge instead of the copy.
grant update (output, status, violations) on public.generation_sections to authenticated;
