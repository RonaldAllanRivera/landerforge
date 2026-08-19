-- Auth hooks: the allowlist gate and the role claim.
--
-- supabase_auth_admin has NO default privileges on public — it is neither anon nor
-- authenticated, so Supabase's default grants do not reach it. Both gates must be
-- opened for each hook, and they fail in different ways.

-- ── Before User Created: the allowlist gate --------------------------------
-- Google will happily mint a user for any account that completes consent, and
-- anything that rejects *after* the fact leaves a window with a valid session. This
-- runs before the auth.users row exists and can reject outright.

create or replace function public.hook_restrict_signup(event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  addr text := lower(event -> 'user' ->> 'email');
begin
  if exists (select 1 from public.allowed_emails where lower(email) = addr) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object('message', 'This account is not authorized.', 'http_code', 403)
  );
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant select on table public.allowed_emails to supabase_auth_admin;
grant execute on function public.hook_restrict_signup to supabase_auth_admin;
revoke execute on function public.hook_restrict_signup from authenticated, anon, public;

-- Miss the GRANT and the hook raises permission denied, Auth 500s, and EVERY signup
-- fails including allowlisted ones. Miss the POLICY and RLS returns zero rows with no
-- error, so every signup is rejected as unlisted. Neither names its own cause.
create policy "auth admin reads allowlist" on public.allowed_emails
  for select to supabase_auth_admin using (true);

-- ── Provisioning: allowlist role -> user_roles ------------------------------
-- The before-user-created hook cannot create this row: it runs before auth.users
-- exists and user_roles.user_id is a NOT NULL FK to it. Without this step every
-- admitted user lands with a null claim, unable to do anything.

create or replace function public.provision_user_role()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  assigned public.app_role;
begin
  select role into assigned from public.allowed_emails where lower(email) = lower(new.email);
  if assigned is not null then
    insert into public.user_roles (user_id, role) values (new.id, assigned)
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger provision_user_role after insert on auth.users
  for each row execute function public.provision_user_role();

-- ── Custom Access Token: stamp the role claim -------------------------------

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  claims jsonb := event -> 'claims';
  user_role public.app_role;
begin
  select role into user_role from public.user_roles
    where user_id = (event ->> 'user_id')::uuid;

  -- jsonb_set INTO the existing claims: Supabase validates that iss, aud, exp, sub,
  -- role, session_id and the rest survive, and authentication fails if they do not.
  if user_role is not null then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(user_role));
  else
    -- Present-but-null rather than absent, so compound conditions do not NULL-propagate.
    claims := jsonb_set(claims, '{user_role}', 'null');
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant all on table public.user_roles to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;

-- Without this policy the hook's select returns no rows, the else branch stamps null,
-- LOGIN SUCCEEDS, and every JWT ships user_role: null. Every write policy then denies
-- silently. Assert the claim's VALUE in tests, never just its presence.
create policy "auth admin reads roles" on public.user_roles
  for select to supabase_auth_admin using (true);

-- ── Live role check ---------------------------------------------------------
-- The JWT claim is a derived cache and goes stale for up to the token lifetime. Use
-- the claim for reads and UI; use this for destructive and privilege-escalating
-- policies, where an hour of stale authority is not acceptable.

create schema if not exists private;

create or replace function private.has_role(target public.app_role)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid()) and role = target
  );
$$;

revoke execute on function private.has_role from public, anon;
grant execute on function private.has_role to authenticated;
