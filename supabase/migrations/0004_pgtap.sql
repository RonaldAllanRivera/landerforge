-- pgTAP, for the policy tests in supabase/tests/.
--
-- Enabled by migration rather than a dashboard click so `supabase db reset` produces
-- a database the suite can run against, on any machine and in CI.
--
-- The impersonation helpers deliberately live INSIDE each test's transaction rather
-- than here: a function that writes request.jwt.claims would let any signed-in user
-- forge a role, so it must never exist outside a transaction that rolls back.
create extension if not exists pgtap with schema extensions;
