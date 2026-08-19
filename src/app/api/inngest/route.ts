import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { generate } from "@/lib/inngest/functions/generate";

/**
 * Each step executes inside one function invocation, so the longest single step — a
 * section call, or a Browserless load — must fit inside this budget.
 */
export const maxDuration = 300;
/** CDP websockets and the Anthropic SDK need Node, not edge. */
export const runtime = "nodejs";

// serve() verifies request signatures when INNGEST_SIGNING_KEY is set. The Next
// middleware matcher excludes all of /api/, or these callbacks would be redirected to
// /login and the pipeline would silently never run in production.
export const { GET, POST, PUT } = serve({ client: inngest, functions: [generate] });
