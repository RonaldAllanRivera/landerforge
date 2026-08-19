import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server client — created fresh per request, never hoisted to a module singleton:
 * it configures a fetch call around *this* request's cookies.
 *
 * Only getAll/setAll. get/set/remove are the deprecated shape and cause auth loops.
 */
export async function createClient() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll(list) {
          try {
            for (const { name, value, options } of list) store.set(name, value, options);
          } catch {
            // Called from a Server Component, which cannot write cookies. The
            // middleware refresh covers it.
          }
        },
      },
    },
  );
}

/** Never getSession() on the server: it does not revalidate and cookies are client-writable. */
export async function requireUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return null;
  return {
    id: data.claims.sub as string,
    email: (data.claims.email as string | undefined) ?? null,
    role: (data.claims.user_role as string | null) ?? null,
  };
}

export type Actor = NonNullable<Awaited<ReturnType<typeof requireUser>>>;

export function canGenerate(actor: Actor | null): actor is Actor {
  return actor !== null && (actor.role === "admin" || actor.role === "editor");
}
