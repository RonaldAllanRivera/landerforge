import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  let next = searchParams.get("next") ?? "/";
  // Open-redirect guard.
  if (!next.startsWith("/")) next = "/";

  if (code) {
    const supabase = await createClient();
    // PKCE is hardcoded by @supabase/ssr and cannot be overridden.
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Vercel terminates TLS at the edge, so `origin` can resolve to an internal host.
      const forwardedHost = request.headers.get("x-forwarded-host");
      if (process.env.NODE_ENV === "development") return NextResponse.redirect(`${origin}${next}`);
      if (forwardedHost) return NextResponse.redirect(`https://${forwardedHost}${next}`);
      return NextResponse.redirect(`${origin}${next}`);
    }
  }
  return NextResponse.redirect(`${origin}/auth/auth-code-error`);
}
