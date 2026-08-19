import { createBrowserClient } from "@supabase/ssr";

/** Browser client. Already a singleton; safe to call repeatedly. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
  );
}
