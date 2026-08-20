# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Projects are findable.** There was no index: `/projects/[id]` held a project's whole
  version history and nothing anywhere linked to it, so the only route to an existing
  generation was remembering its id. `/projects` now lists every project with its
  generation count, spend and last run, with **search and paging done in the database**
  rather than by fetching everything and filtering in the page — a list that still
  renders while quietly getting slower is the kind of thing nobody notices until it is
  the slowest screen. The home page is a work list of recent generations instead of a
  greeting and one button, and the nav has a Projects link.
- **Creating a project, on its own page.** `/projects/new`, reached from a button beside
  the heading. It was briefly a form underneath the list, which is unreachable the
  moment the list is long. A rejected submission comes back with the reason **and with
  what was typed** — losing someone's input because a name collided is a worse failure
  than the collision.
- **Project names are unique** (migration `0010`), indexed on `lower(btrim(name))` so
  "Breezebox" and "breezebox " are the same name. The application normalises to match,
  but the constraint is the check: looking for an existing name and then inserting still
  races. On a collision the error names **the project that already exists**, not the
  string that was typed — those differ by exactly the case or spacing that caused it.

- **The review screen is now the CMS form.** It listed every field as a read-only line
  with a "not generated" badge beside the eight display markers in Hero alone, and
  rendered a repeating section's parallel arrays as raw JSON. It now mirrors
  `docs/cms-screenshots/advertorial.png` panel for panel: collapsible sections in CMS
  order, the same labels, a text input where the CMS has one and a textarea where it has
  one, review cards with Add and Remove, and the section's presence toggle in its
  header. Image fields are omitted entirely for now.
- **CRUD on generated copy.** A flagged section is meant to be fixed, and sending the
  operator to the CMS to do it means the violation list never clears and the next run
  has nothing to learn from. Sections are editable in place, save per section, and
  **are re-validated server-side on save** — by the same `validateSection` the worker
  uses, extracted to `lib/shared` so the two cannot drift. Fixing a missing `%` on a CTA
  moves it from `flagged` to `done` with its violations recomputed, not cleared.
- **`edited_at` / `edited_by` on `generation_sections`**, stamped by a database trigger
  from the session rather than accepted from the caller, so a column grant cannot be
  used to attribute an edit to somebody else. The worker writes under the secret key
  where `auth.uid()` is null, so a generated section stays unstamped and only a human
  edit sets them — "flagged by the validator" and "a person has been in here" are
  different states.
- **`displayKind` on manifest fields** (`toggle` / `image` / `relation`). A toggle, an
  image slot and a relation picker look nothing alike in the CMS, and rendering all
  three as an identical row is what made the screen unreadable. Declared rather than
  inferred from the key, which would be wrong the first time a field is renamed.
- Four more pgTAP tests, asserting that a viewer's update to a section **silently
  changes nothing** (a failing UPDATE policy matches zero rows rather than raising, so
  the assertion has to be about the data) and that an editor may fix a flagged section.

- **First real generations, end to end.** Everything below came out of running four of
  them; the pipeline had never called the Anthropic API before, and none of the defects
  it found were visible to review, to typecheck, or to 71 passing tests. The first run
  never finished at all. Same page, same source, same manifest each time:

  | Run | Change | Cost | Sections clean |
  |---|---|---|---|
  | 1 | as designed | — | **never finished** — a lint threw and the run wedged permanently |
  | 2 | crash contained, brief logged, source-first prefix | $0.6408 | 2 / 5 |
  | 3 | + explicit output contract | $0.5369 | 4 / 5 |
  | 4 | + `effort: medium` | **$0.2550** | 3 / 5 |

  Run 4 is 60% cheaper than run 2, and not a free win: at `medium` the model undershoots
  a long prose target where run 3 hit it, and one more section came back flagged. Which
  is the argument for effort being a setting rather than a constant.
- **Prompt-prefix invariant tests.** `buildMessages` moved to `lib/shared` and gained
  tests asserting the ordering the cost model depends on: source material before the
  brief, per-call instructions last, at most four breakpoints, and a byte-identical
  prefix between the brief call and a section call. A break in that prefix produces no
  error — only a bill — so it is now asserted rather than commented.
- **Pricing tests.** `costUsd` and the cache-price derivation moved to
  `lib/shared/pricing` and are covered, including the case that the three input token
  fields sum rather than one of them being the total.
- **A cache-inert diagnostic**, separate from an ordinary miss. A breakpoint below the
  model's minimum writes nothing, reads nothing, and reports nothing; the two failures
  are now distinguished in the logs because their fixes are opposite.
- **`scripts/dev-generate.ts`**: drives one real generation against local Supabase
  without a browser sign-in, so the pipeline can be exercised end to end.
- **An explicit per-section output contract.** The instruction used to be, in full,
  "Return a JSON object keyed by field key". Three of five sections then burned their
  entire retry budget on ambiguity rather than on bad writing: a scaffolded field came
  back as assembled HTML because the manifest displays the markup and nothing said code
  applies it, and a repeating section came back at three times its word target because
  `wordTarget` is a total across instances and the model read it per instance. The
  contract now states the JSON shape, the instance count, whether a target is a total or
  per item, and — for scaffolded fields — that any HTML tag in the output is a defect.
  It sits after the last cache breakpoint, so the detail is free.
- **Models are chosen from a dropdown, with their prices on the option.** They were
  free-text fields, where a typo is invisible: the run fails at the API, or worse
  succeeds on a model with no price entry and every figure on the cost screen is then
  quietly computed against the wrong rates. The schema now rejects any model without a
  published price, and the form explains why instead of throwing an error page.
- **"Output quality, and what it costs" on `/costs`.** Spend per model on its own
  invites the wrong conclusion, because the cheapest model measured here was also the
  one that produced nothing usable. Each model now reports clean-first-pass rate,
  sections still flagged, and cost per section beside its spend, and warns when more
  than a third of its sections never passed validation — pointing at retry burn and
  effort before suggesting a bigger model.
- **Per-section cost on the review screen.** A flagged section and what it cost to fail
  are one decision, and they were on two different screens. Each section header now
  carries its spend and attempt count, flagged when it took more than one attempt.
- **Reasoning effort as a fourth cost lever** (`settings.effort`, migration `0008`,
  editable on `/costs`). It dominates the other three: output tokens were 88% of a
  measured run's cost ($0.571 of $0.641), against $0.030 for every cached input token in
  it. The pipeline had never set it, and the provider default is not stable — the same
  section call measured 2,414 output tokens on one attempt and 14,820 on the next. It is
  omitted for models that reject it rather than sent blindly, since Haiku 4.5 returns
  400 for the parameter.
- **`make env-local`**: writes the running local Supabase credentials into `.env`. The
  setup guide asked for three values to be copied by hand, which is the one step that
  fails silently — the placeholders look plausible and this project pins the API to port
  55321 rather than Supabase's usual 54321, so a wrong value produces no error at all.

- **Cost controls as data rather than constants.** A single-row `settings` table holds
  the per-run call ceiling, the model behind each tier, and an advisory monthly budget,
  all editable by an admin on `/costs`. Manifests declare a section `tier`
  (`standard` / `fast`) and settings decide which model that means, so swapping in a
  newer fast model is one settings change rather than an edit to every manifest.
- **`/costs` screen.** Leads with cache hit rate and retry burn rather than raw spend,
  because both are invisible from outside and both cost multiples of a model swap.
  Also shows month-to-date against budget, median run cost, spend by model, and recent
  runs.
- Per-model pricing, recorded per call, so a price change cannot silently rewrite
  history and a tier change is visible rather than inferred.
- A top navigation bar, so the admin and cost screens are reachable rather than
  URL-only.
- GitHub Actions CI: verify, production build, pgTAP database tests, and a Docker
  image build, with concurrency cancellation and read-only permissions.
- 23 pgTAP tests covering RLS policies and database-enforced invariants, run against
  real Postgres with every migration applied.
- Working access management on `/admin`: grant, change role, and a single
  **Remove access** action performing all three off-boarding writes together.
- `Makefile` with a self-documenting target list.
- `make seed-dev`: creates a local admin account so the app is usable without a Google
  Cloud project. It goes through the real allowlist and role-provisioning path rather
  than bypassing it, and refuses to run against a non-local database.
- `docs/setup.md`: a production setup runbook covering every account, key and dashboard
  setting in dependency order, with a verification checklist and the silent failure
  modes worth knowing about.

### Fixed

- **The Retry button pointed at a route that was never written.** It POSTed to
  `/api/v1/generations/[id]/retry` — a 404 — and `generation.retry.requested` had no
  handler at all, so the only visible recovery path in the app did nothing. It is now a
  server action, and the generate function takes both events rather than growing a
  second copy of the pipeline. `attempt` moved into the idempotency key and is sent on
  both: without it a deliberate retry inside the 24-hour dedupe window is swallowed,
  which is what would have made the button look broken even once it existed.
- **A run whose event is lost sat at `queued` forever with no way out.** That is not
  `failed`, so the button was not even offered. Recovery is now available for anything
  unfinished, and the copy says what happened. Found the hard way, then fixed and
  verified against a genuinely stuck run.

- **Both auth hooks were disabled on the local stack.** Migration `0002` installs them
  and its own comments describe exactly what goes wrong without them, but
  `supabase/config.toml` had them commented out — so locally every JWT shipped
  `user_role: null` and the allowlist gate never ran. Login succeeded and then every
  admin screen and write policy denied, silently, which is how an account seeded as
  `admin` by `make seed-dev` turned out to have no role at all. Enabling them also makes
  the Phase 1 signup-rejection criterion testable without a Google client: an unlisted
  address is now refused with 403 and **no `auth.users` row is created**, and an
  allowlisted one carries `user_role: "admin"` in its token — both verified.
- **A lint crash could wedge a run permanently.** The model returned a scaffolded field
  whose items had no `copy` key; the scaffold lint dereferenced it and the `TypeError`
  escaped `validateSection`, which runs outside `step.run`. Inngest saw a 500, retried,
  replayed the memoized steps and threw again — a generation stuck in `generating`
  forever, after the copy had already been paid for. `lintField` documented "never
  throws" but nothing enforced it. Now two layers do: a runtime shape gate that turns
  malformed model output into feedback the model can act on, and a per-lint `try`/`catch`
  that turns a bug in our own code into a flagged section. Violations the model cannot
  act on no longer consume the retry budget.
- **The brief call was never cost-logged.** It is the most expensive call in a run — it
  carries the whole source material and writes the cache every later call reads — and
  it was missing from `generation_steps` entirely. `total_cost_usd` and every figure on
  `/costs` understated a run by its largest line item, and the cache-hit denominator
  treated the first *section* as the run's first call, hiding a real read behind an
  exclusion meant for the write.
- **Source material sat after the brief in the cache prefix**, and `<brief>` differs
  between the brief call and the section calls. Caching matches on exact prefix, so one
  difference at position 0 made the identical source material uncacheable across that
  boundary: the first section call was measured re-buying 11,696 input tokens it had
  already paid for. Source now leads, with its own breakpoint.
- **`selectorHint` never reached the model.** The extractor recovers an exact
  `{sectionId, fieldKey}` for most blocks from the CMS's own class names — 76 of 92 on
  a real page — and the brief instructions explicitly say to adopt it, but the payload
  serialised only `index`, `type` and `text`. Every word target in a run is derived from
  the resulting `blockMap`, so the one thing known for certain was being re-guessed.
- **The number extractor invented units out of prose.** `\d[\d,]*` accepted a trailing
  comma, letting the next word's opening letters parse as a unit: "In 1, when we..."
  was reported as the spec `1 Wh`, and "3 weeks" as `3 W`. Numbers now require a
  thousands separator to be followed by three digits, and an alphabetic unit must not be
  glued to more letters.
- **Dual-unit feedback described the wrong problem.** For
  "Works from up to 30 ft (9.1 m) away" the message was "30 ft needs a metric
  counterpart" — but one was present, just second. The model read a complaint that did
  not match what it saw and left the text unchanged through all three corrective
  attempts. It now distinguishes absent from imperial-first and shows the corrected
  ordering.
- **`make seed` could not work from a fresh clone.** Both seed scripts read
  `process.env` but nothing loaded `.env`; Next loads it for the app, but `tsx` is a
  bare Node process. They now share a loader with Next's precedence — real environment
  first, then `.env.local`, then `.env` — so CI, which exports real variables and has no
  `.env`, is unaffected.
- **`.env.example` shipped the wrong port.** `config.toml` pins the Supabase API to
  55321; the template said 54321, so a fresh clone copied a URL pointing at nothing.

### Changed

- **Standard tier moved to Claude Sonnet 5** (migration `0007`), which is both newer and
  cheaper than Sonnet 4.6: $2/$10 per MTok against $3/$15. The gain is smaller than it
  looks — Claude 4.7 and later use a tokenizer emitting roughly 30% more tokens for the
  same text, making the real-terms difference about 13% rather than 33% — and that
  caveat is now recorded next to the price table, because `/costs` compares models by
  spend and the token counts are not like for like.
- **The `fast` tier is off by default** on the advertorial template — for quality, with
  a cost caveat, and not for the reason first assumed. Measured on the same section
  across two runs: Haiku 4.5 cost $0.0207 over three attempts and was **flagged** every
  time, returning assembled HTML for the scaffolded field instead of the copy slots;
  Sonnet 5 cost $0.0442 over two attempts and came back clean. The fast tier was about
  twice as cheap and produced nothing usable. Output tokens dominate a call, and the
  fast model is both cheaper per token and far terser, so cache effects are second-order
  here — though real: the prompt cache is keyed per model, so an interleaved fast
  section pays a full cache write where a standard section pays a read ($0.0146 against
  $0.0030 for the same prefix), then breaks the standard model's chain for the next
  call. Haiku also needs 4,096 tokens before a breakpoint does anything, four times
  Sonnet's minimum, and rejects `output_config.effort` outright. The lever remains
  available for templates where the fast model can satisfy the field contract.
- **Settings split into a pure half and an I/O half**, matching pricing, prompt
  assembly and cost reporting. The schema, defaults and model/effort resolution moved to
  `lib/shared/settings` where tests can reach them; the Supabase reads and writes stayed
  in `lib/core/settings`. Every piece of logic in this codebase that ended up behind
  `server-only` has so far turned out to be both untested and wrong.
- A settings row that fails validation now logs why before falling back to defaults.
  Falling back is right; doing it silently means an operator's chosen settings are
  ignored with no indication.
- **`@anthropic-ai/sdk` upgraded from 0.71.2 to 0.120.0.** `output_config` existed only
  under `beta` in 0.71, and being 49 minor versions behind is its own liability. The
  surface in use is small — `messages.create` and a handful of types — and the upgrade
  needed no code changes.
- Cache write and read prices are **derived** from the base input price (1.25x and 0.1x)
  rather than transcribed per model, which is how the platform defines them.
- `max_tokens` raised from 8,000 to 16,000. It is a ceiling, not a reservation — only
  emitted tokens are billed — and the new tokenizer alone would have pushed the longest
  sections into `stop_reason: "max_tokens"`.

- Dockerfiles installed with `npm ci` against a lockfile the pnpm migration removed.
- RLS tests depended on Supabase's implicit default grants for `authenticated`, which
  differ between CLI versions — passing locally and failing in CI with a permission
  error raised before RLS is consulted. Migration `0005` states every grant explicitly,
  which is also tighter than the default: child tables are now read-only to clients.
- Seed scripts used top-level await, which tsx cannot emit under CJS.
- The Docker image installed with `npm ci` against a lockfile that no longer existed,
  and CI resolved Node from `engines.node: ">=22"` — a range, which `setup-node` cannot
  turn into a version. Pinned via `.nvmrc`.
- `sharp` was a declared dependency imported nowhere. It was also the one package whose
  pnpm-blocked build script actually mattered, so removing it fixed a latent runtime
  break and shrank the image.
- `typecheck` depended on route types that only exist after a build, so it passed
  locally and would fail on a clean CI checkout. It now runs `next typegen` first.
- Database tests assumed an empty database and collided with seeded templates. They now
  use fixture-only identifiers and pass against both a fresh and a working database.

### Changed

- Migrated from npm to pnpm, with the version pinned via `packageManager` so CI,
  Docker and contributors resolve identically.
- Local Supabase ports remapped to the 553xx range so the stack coexists with other
  local Supabase projects.
- Phase status is now tracked in the plan's phase section and mirrored in the README.

### Planned

- **Phase 2** — Browserless scrape hardening, source-derived density end to end.
- **Phase 2.5** — screenshot upload and vision transcription, with a human transcript
  confirmation gate before generation.
- **Phase 3** — the corrective retry loop against seeded bad outputs.
- **Phase 4** — Comparison, Interstitial and Reasons manifests.
- **Phase 5** — section regeneration, version chain, word-level diffs.

## [0.1.0] — 2026-08-19

Initial implementation: the foundation, the manifest system, and the deterministic
validation layer the rest of the pipeline depends on.

### Added

**Domain core** (`src/lib/shared`, framework-free and I/O-free)

- Zod template-manifest schema with cross-field refinements — scaffolded fields require
  line templates, a display field cannot be marked generated, and a field cannot link a
  product name it is forbidden to contain.
- Typed block substrate shared by every source type, with block-wise truncation so
  `raw_text` stays exactly the concatenation of its blocks.
- Numeric normalisation: number words, unit spellings, unicode minus signs, thousands
  separators, approximation markers, and units abutting digits. Applied identically to
  sources and outputs.
- Code-built section plan — the model supplies a block→field mapping, code computes
  every word target, item count, instance count and subunit count.
- Nine deterministic lints: word count, item count, bold rules, tokens, links,
  scaffolded markup, compliance, specifications, verbatim overlap.
- Unit conversion table with printed-precision tolerance, covering mass, length,
  volume and area.

**Pipeline** (`src/lib/inngest`, `src/lib/anthropic`, `src/lib/scrape`)

- Durable generation function: claim → scrape → brief → per-section generation with
  in-band validation → finalize. One memoized step per API call.
- Corrective retry loop, capped at two attempts, with violations quoted back. Validation
  never throws, so platform retries cannot fight the application loop.
- Two-breakpoint prompt caching over an append-only prefix, with byte-stable JSON
  serialization and per-call cache-hit accounting.
- `allowedSpecs` guard verifying every source-derived number against the raw text before
  the brief is persisted.
- Browserless scraping with a two-rung anti-bot ladder, bounded content-based waits,
  auto-scroll for lazy-loaded content, and a pinned viewport for reproducible density.
- HTML extraction that strips scripts before parsing — framework hydration payloads
  embed a second copy of every word — and flattens inline elements into their parent
  block.
- Per-call token and cost accounting in `generation_steps`.

**Data** (`supabase/migrations`)

- Full schema with typed identity keys, `timestamptz` throughout, CHECK constraints on
  every enum-like column, and indexes on all foreign keys and RLS-filtered columns.
- Database-assigned `version_num` and `manifest_snapshot`, so a concurrent insert cannot
  race and a client cannot choose the rules its own run is judged against.
- Owner immutability trigger; regenerate clones inherit the parent's manifest snapshot
  rather than the live template.
- Google OAuth allowlist enforced by a `before-user-created` hook, role provisioning
  trigger, and a custom access-token hook stamping the role claim.
- RLS on every table with role-gated mutation, `anon` grants revoked, and a
  column-scoped grant for transcript edits.

**Application** (`src/app`)

- Google sign-in, OAuth callback with open-redirect guard, and an unambiguous
  unauthorized page.
- Generation wizard supporting URL, pasted source, or notes-only input.
- Review screen with per-field word badges, inline violations, and copy buttons that
  respect each field's markdown handling.
- Version history and an access-management screen.
- Middleware session refresh, with all of `/api/` excluded so background callbacks are
  never redirected.

**Tooling**

- 52 tests covering the lints, normalisation, section planning and manifest schema.
- Strict TypeScript, Biome, multi-stage production Dockerfile, and a Compose stack for
  local development.

### Security

- Sign-in is rejected at the database before an account exists, rather than after.
- Scraped and transcribed content is treated as untrusted: delimited, JSON-encoded, and
  covered by an explicit system-prompt policy.
- Legal-URL tokens are prohibited in every generated field; the footer belongs to the
  CMS's attached disclaimers resource and is never written.
- The secret-key client is `server-only`, so a client-bundle import is a build error.
- A per-run call ceiling prevents a validation-loop bug from spending without bound.

[Unreleased]: https://github.com/OWNER/landerforge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/landerforge/releases/tag/v0.1.0
