export default function AuthCodeError() {
  return (
    <main>
      <h1>This account isn&apos;t authorized</h1>
      {/* No retry affordance: trying again will not help. An admin has to add the address. */}
      <p className="sub">
        Access is limited to a small allowlist. Ask an administrator to add your Google address,
        then sign in again.
      </p>
    </main>
  );
}
