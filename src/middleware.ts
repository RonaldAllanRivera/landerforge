import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /**
     * Excludes ALL of /api/. Inngest's callbacks carry no session and would be
     * redirected, silently killing the pipeline in production — and the same trap
     * catches any future Bearer-token client, which would receive an HTML login page
     * with a 200 status and fail as a JSON parse error.
     */
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
