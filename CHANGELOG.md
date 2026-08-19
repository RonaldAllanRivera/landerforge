# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
