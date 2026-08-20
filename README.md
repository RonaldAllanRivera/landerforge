# LanderForge

Generates tokenized advertorial copy for a headless CMS, constrained so the output is
publishable without editing.

The interesting problem here isn't asking a model for marketing copy — it's making the
result *trustworthy*. A landing page carries claims, prices and specifications. Get a
number wrong and you've published a false advertisement. So the model is boxed in on
three sides: it may only use numbers extracted from a verified source, every piece of
output is checked by deterministic code before a human sees it, and anything the check
rejects is sent back with the specific violations quoted.

```
URL ──► scrape ──► typed blocks ──┐
paste ─────────────────────────────┼──► brief (LLM) ──► per-section generation ──► review
screenshot ──► transcribe ─────────┘         │                    │
                                             │                    ▼
                                     allowedSpecs         9 deterministic lints
                                     (guarded)                    │
                                                    ┌─────────────┴──────────────┐
                                                  pass                     fail → retry
                                                    │                    with violations
                                                    ▼                      (max 2)
                                              generation_sections
```

## What makes it non-trivial

**Numbers cannot be invented.** A brief pass extracts every numeric claim from the
source into an `allowedSpecs` whitelist, and deterministic code then verifies that each
one *literally appears in the source text* before generation begins. Any number in the
output that doesn't resolve against that whitelist is a violation. The guard runs before
the brief is persisted — if it ran after, a retry would resume on an unverified brief
and the mechanism would silently stop working.

**Language models can't count, so they aren't asked to.** Density matching — making
generated copy match a source page's length section by section — is split so each side
does what it's good at. The extractor emits typed blocks, *code* counts the words, the
model emits only a mapping of block → field, and code builds the word targets. The model
never emits a number.

**One substrate for every input.** URL scrapes, pasted text and transcribed screenshots
all produce the identical typed block array, so density behaves the same regardless of
where the source came from. `raw_text` is defined as the concatenation of those blocks,
and truncation drops whole blocks rather than cutting the string — otherwise the blocks
would hold content the text doesn't, and a legitimate spec would fail its own guard.

**Validation is code, not a second model.** Nine lints cover word counts, item counts,
bold rules, token usage, links, scaffolded markup, compliance, specifications and
verbatim overlap. They're pure functions over strings with no I/O, which is why they're
the most heavily tested part of the system.

## The unit problem

A representative example of the kind of care the domain needs.

These products sell internationally, so copy must carry metric-first dual units:
`372 m² (4,000 sq ft)`. That interacts badly with the specification check unless several
things are handled together.

- `sq ft` is two tokens but one unit. So are `fl oz` and `sq m`.
- `in`, `m` and `l` are also ordinary English words. "1 in 3 customers" is stock
  advertorial phrasing, and a naive matcher reads the `1` as bearing the imperial unit
  `in` — tripping the dual-unit rule *and* voiding the rhetorical-number exemption. A
  word-ambiguous abbreviation counts as a unit only when what follows isn't a word or
  digit.
- The converted figure has to be a legal specification, or every measurement fails.
  Conversions are recomputed and compared at the *printed precision*: 2 oz → 56.699 g
  rounds to `57 g`, and 130 ml → 4.396 fl oz rounds to `4.4 fl oz`. A naive ±0.5%
  tolerance would reject the first.
- Sources and outputs are normalised through the *same* pass. A page that writes "weighs
  just two ounces" must match a `{ value: 2, unit: "oz" }` specification, so number
  words, unit spellings, unicode minus signs, thousands separators and trailing `+` all
  fold before comparison — on both sides. Normalising one side only is what makes a
  checker reject copy that faithfully reproduces its source.

The normalised view is kept *parallel* to the literal text: only the unit, specification
and overlap lints read it. Word counts and character limits read what the operator will
actually paste, because "twenty-five percent" collapsing to "25%" would let a field pass
a limit the clipboard text blows past.

## Architecture

| Concern | Choice | Why |
|---|---|---|
| Templates | JSON manifests, Zod-validated on read | Field definitions are data. A word-count change is a file edit, not a deploy. |
| Orchestration | Inngest, one `step.run` per API call | Only memoized steps survive a crash. A failure at section 12 must not re-run the scrape or re-bill eleven calls. |
| Validation | Pure functions, no I/O | Testable in milliseconds, reusable in a React Native client. |
| Auth | Google OAuth, DB-enforced allowlist | The gate runs *before* the user row exists, so an unauthorized account never holds a session. |
| Authorization | RLS, with role in a JWT claim | The database is the boundary; no rule lives only in application code. |
| Prompt caching | Three breakpoints on an append-only prefix | Cuts the dominant input cost by roughly an order of magnitude. Measured: 11,696 uncached tokens on the first section call became 4,173 by fixing the block ORDER alone. |

### Prompt caching is a design constraint, not an optimization

Each section call resends the brief and every previously generated section, so by the
last section the run is re-billing nearly the whole page. Three cache breakpoints fix
that — the system prefix, the source material, and one moving along the completed
sections — but only if the prefix is byte-identical and strictly append-only.

That has consequences throughout: the tools array stays empty (a per-section tool
definition would change the very front of the prefix and make every call a full miss),
JSON is serialized with sorted keys, and nothing per-call may appear before the last
breakpoint. The same rule rules out a per-section structured-output schema, for exactly
the same reason. `generation_steps` records `cache_read_input_tokens` on every call,
because a silent cache miss is invisible otherwise and simply costs several times more.

Caching matches on **exact prefix**, which makes this an ordering property rather than a
setting — and ordering bugs are silent. The source material is byte-identical on every
call in a run, but it sat *after* the brief, whose contents differ between the brief
call and the section calls; that one difference made the whole block uncacheable across
the boundary and cost 11,696 tokens on the first section alone. Nothing failed. The
ordering is now asserted in `tests/prompt.test.ts`, and the model-specific minimum
prefix length is recorded too, because a breakpoint below it is ignored with no error
and no usage fields — 4,096 tokens on Haiku against 1,024 on Sonnet.

### Durability

The pipeline is a sequence of memoized steps, which forces some non-obvious rules:

- Validation runs as **plain code inside** the step. Throwing on a copy violation would
  make the platform retry the call identically, *without* the corrective feedback,
  fighting the application's own retry loop.
- Each corrective attempt is its own step with a deterministic id, so replay is stable.
- Steps return metadata, never generated copy — a step's return value is persisted into
  run state and replayed on every later step.
- Retry is a **separate event**. Idempotency keys dedupe for 24 hours, so re-firing the
  original event would be silently swallowed and the button would appear dead.

### Authorization

Sign-in is Google OAuth only. A `before-user-created` database hook rejects any address
not on an allowlist, before the user row exists — checking afterwards would leave a
window in which an unauthorized person holds a valid session.

Roles (`admin` / `editor` / `viewer`) live in a table and are stamped into the JWT by a
custom access-token hook, so policies read a claim rather than running a subquery per
row. Destructive policies use a live lookup instead, because a claim is stale for up to
the token's lifetime and revocation shouldn't be.

Two details that fail silently if missed, and are therefore asserted in the migrations:
`supabase_auth_admin` has no default privileges on `public`, so each hook needs both a
grant *and* an RLS policy — miss the grant and every signup 500s; miss the policy and
every JWT ships a null role while login still succeeds. And grants are a separate gate
from policies: enabling RLS doesn't revoke the default `anon` grants.

## Stack

Next.js 15 (App Router, RSC) · TypeScript strict · Supabase (Postgres, Auth, Realtime,
RLS) · Inngest · Anthropic API · Playwright via Browserless · Zod · Vitest · pgTAP · Biome

## Running it

Requires Node 22+, pnpm 10+, Docker, and the Supabase CLI.

For **production** — hosted Supabase, Google sign-in, Vercel, background jobs — follow
[docs/setup.md](docs/setup.md), which walks through every account and setting in order.

```bash
cp .env.example .env   # fill in the keys
make install           # pnpm install --frozen-lockfile
make db-start          # postgres, auth, realtime, studio
make db-reset          # applies migrations in supabase/migrations/
make seed              # upserts manifests/ into the templates table
make dev               # app on :3000, Inngest dev server on :8288
```

`make` on its own lists every target.

Or in containers — `supabase start` still provides the database, since reimplementing
that stack by hand would drift from what production runs:

```bash
docker compose up
```

```bash
make verify    # typecheck + lint + unit tests — what CI runs
make test      # 52 unit tests, ~0.5s
make test-db   # 23 pgTAP policy and invariant tests against real Postgres
```

The database tests matter more than their count suggests: RLS policies are the only
security boundary here and they fail *permissively* when wrong, so each one asserts a
denial. They cover a viewer who owns the row (the case that catches a policy gating on
ownership instead of role) and a user whose JWT carries a null role (the state a
mis-granted auth hook produces, where login still succeeds).

### Configuration that isn't obvious

- Google OAuth client id and secret go in the **Supabase dashboard**, not in `.env`.
- Disable email/password and magic links; the allowlist hook only guards signup.
- Register both auth hooks and add the tables to the `supabase_realtime` publication —
  `supabase db reset` handles all of this.
- The Next middleware matcher excludes all of `/api/`. Without that, Inngest's
  unauthenticated callbacks get redirected to `/login` and the pipeline silently never
  runs in production.

## Layout

```
src/lib/shared/      pure domain logic — no framework imports, no I/O
  ├── manifest.ts      template schema (Zod)
  ├── blocks.ts        the typed block substrate
  ├── normalize.ts     numeric/unit normalisation
  ├── section-plan.ts  code-built density targets
  ├── prompt.ts        cache-aware message assembly
  ├── pricing.ts       per-model prices and cost arithmetic
  └── lints/           the nine validators
src/lib/anthropic/   the SDK client (everything pure lives in shared/)
src/lib/scrape/      Browserless connection, HTML → blocks
src/lib/core/        transport-agnostic operations
src/lib/inngest/     the durable pipeline
src/app/             App Router routes and server actions
supabase/migrations/ schema, auth hooks, RLS
manifests/           template definitions (repo is the source of truth)
docs/                the implementation plan and CMS references
```

`src/lib/shared/` deliberately imports nothing from `next/*`, `server-only` or Node
built-ins. A single stray import there would make the whole validation layer
unbundleable for a React Native client, and reimplementing the linters mobile-side is
how two clients start disagreeing about what valid output is.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation, manifests, validation, pipeline, review screen | **Shipped** |
| 2 | Scraping + density matching | Not started |
| 2.5 | Screenshot upload + vision transcription | Not started |
| 3 | Validation loop | Validators shipped; corrective-loop fixtures outstanding |
| 4 | Comparison, Interstitial, Reasons manifests | Not started |
| 5 | Section regeneration, version chain, diffs | Schema ready, UI not started |

Phase definitions and acceptance criteria live in
[docs/landerforge-plan.md](docs/landerforge-plan.md) — the single specification
document. [CHANGELOG.md](CHANGELOG.md) records what each release actually contained.

Two Phase 1 acceptance criteria are written but not yet exercised: the cache-hit
assertion and the signup rejection both need live credentials.
