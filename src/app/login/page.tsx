"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Google is the only production sign-in method, because no other provider is enabled
 * in the Supabase dashboard. Membership is an allowlist an admin curates.
 *
 * The password form below appears only against a local Supabase, so the app is usable
 * on your own machine without setting up a Google Cloud project first. It is not a
 * bypass: the account it signs in was created by `make seed-dev`, which had to add
 * itself to the allowlist to exist at all.
 */
export default function Login() {
  const isLocal = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function signInWithGoogle() {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) setError(error.message);
  }

  async function signInLocally(formData: FormData) {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: String(formData.get("email")),
      password: String(formData.get("password")),
    });
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <main>
      <h1>LanderForge</h1>
      <p className="sub">Sign in with the Google account that was allowlisted for you.</p>

      <button type="button" onClick={signInWithGoogle}>
        Continue with Google
      </button>

      {isLocal && (
        <form action={signInLocally} className="card" style={{ marginTop: "2rem" }}>
          <p className="muted">Local development only — created by `make seed-dev`.</p>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" defaultValue="dev@localhost.test" />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" defaultValue="devpassword123" />
          <p />
          <button type="submit" className="ghost">
            Sign in locally
          </button>
        </form>
      )}

      {error && <p className="violation">{error}</p>}
    </main>
  );
}
