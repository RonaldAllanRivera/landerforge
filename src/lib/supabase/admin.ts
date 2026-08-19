import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Secret-key client. Bypasses RLS — but only when the request carries no user access
 * token, so this must be constructed bare rather than derived from a request-scoped
 * client.
 *
 * `server-only` makes any client-bundle import a build error.
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.SUPABASE_SECRET_KEY as string,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
