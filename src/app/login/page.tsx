"use client";

import { createClient } from "@/lib/supabase/client";

/**
 * One button, because no other method is enabled. Email/password and magic links stay
 * off in the Supabase dashboard; membership is an allowlist an admin curates.
 */
export default function Login() {
  async function signIn() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  return (
    <main>
      <h1>LanderForge</h1>
      <p className="sub">Sign in with the Google account that was allowlisted for you.</p>
      <button type="button" onClick={signIn}>
        Continue with Google
      </button>
    </main>
  );
}
