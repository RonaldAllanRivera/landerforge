---
name: landerforge-implementation
description: Use when implementing, extending, or reviewing any part of the LanderForge advertorial copy generator — manifests, lints, the Inngest pipeline, prompt caching, scraping, auth/RLS, or the review screen. Carries the standing decisions and the traps that cost real debugging time.
---

# LanderForge implementation

The full specification is `docs/landerforge-plan.md`. This skill carries the decisions
that are easy to reverse by accident and the failure modes that are silent.

## Standing directives

These came from the project owner and override any inference from the code:

1. **International units, no exempt class.** Products sell well beyond the US. Every
   unit class gets metric-first dual units, **including area**: `372 m² (4,000 sq ft)`.
   Do not exempt area because the conversion table looks awkward — add the pair.
2. **No footer content is ever generated.** No CMS template exposes a footer or
   disclaimer field; disclaimers are a separate global resource attached to a page. No
   manifest declares a `legal` link policy, and the four legal-URL tokens never appear
   in generated copy.
3. **CMS screenshots are the field inventory.** `docs/cms-screenshots/` decides which
   fields exist. `docs/lander-samples/` are rendered pages — density and craft evidence
   only, never a field list. Where they disagree, the CMS wins.
4. **The product name is always `{{productName}}`.** Never a literal, in any field, on
   any template. `productNameFormat` chooses how the token renders; it never permits a
   literal.
5. **One plan document.** `docs/landerforge-plan.md`. Do not create a second copy or a
   versioned duplicate.

Out of scope by explicit decision: comment **replies** (the "Add Reply" sub-list), and
the **Simple Page** template until its CMS screen is captured.

## Invariants that fail silently if broken

**The word-count division of labour.** Extractor emits blocks → *code* counts words →
the model emits only a block→field mapping → *code* builds the section plan. The model
must never emit a number. `sectionPlan` is a code-built object.

**`raw_text` is exactly the concatenation of `blocks`.** Truncate block-wise, never
string-wise. A string cap leaves blocks holding content the text doesn't, so a
legitimate spec fails its own guard and kills the run over content that was really
there.

**The `allowedSpecs` guard runs before the brief is written.** If it ran after, a
failure would leave `brief` populated and the resume rule would send a retry straight
into generation on a brief that never passed it.

**Transcription and structuring are separate calls.** One call doing both means a
hallucinated spec lands in the transcript *and* in `allowedSpecs`, and the guard
validates the fabrication against itself.

**Validation never throws inside a step.** Return `{ output, violations }` and loop in
the function body. Throwing makes Inngest retry the call identically, without the
corrective feedback, fighting the application's own retry loop.

**Cache prefix is byte-stable and append-only.** Empty tools array; sorted-key JSON; no
timestamps, no per-run ids, nothing per-call before the last breakpoint. Assert
`cache_read_input_tokens > 0` from the second call onward — a miss is otherwise
invisible and simply costs several times more.

**Both auth hooks need a grant *and* an RLS policy.** `supabase_auth_admin` has no
default privileges on `public`. Miss the grant → every signup 500s. Miss the policy →
every JWT ships `user_role: null` while login still succeeds and every write policy
denies. Assert the claim's *value* in tests, never its presence.

**Grants are a separate gate from RLS.** Enabling RLS does not revoke the default `anon`
grants. But do **not** revoke DELETE from `authenticated` — admins are `authenticated`
too, so that would make the admin-delete policy permanently unsatisfiable.

**Middleware excludes all of `/api/`.** Inngest callbacks carry no session; redirecting
them to `/login` kills the pipeline in production with no error.

## Traps found the hard way

- **`in`, `m`, `l` are English words.** "1 in 3 customers" reads as an inch measurement
  to a naive matcher, tripping the dual-unit rule and voiding the rhetorical exemption.
- **Scripts must be stripped before extraction.** A Next.js RSC flight payload embeds a
  second copy of every word; miss it and all counts double.
- **Inline elements flatten into their parent block.** A block-per-anchor extractor
  turns "The current version of **Product** is nothing like…" into "The current version
  of is nothing like…".
- **Relative timestamps are not specs.** "11 hours ago" is a unit-bearing integer over
  ten. Without `specPolicy: "exempt"` the comments section fails on every run.
- **Rich-text fields in the CMS are internally scrolled.** Visible example content is a
  floor, not a length. Never source a word target from a CMS screenshot.
- **`markdownBold` describes the field, not the copy.** The generator emits `**`
  everywhere because the skim test is a property of the copy; on a WYSIWYG field the
  copy button strips them and the operator re-bolds with the toolbar.
- **Sidebar lists differ per template.** One stores FontAwesome scaffolding, another
  plain markdown. Take `lineTemplates` from the stored CMS value, never the rendered
  page.
- **`sq ft` is one unit, two tokens.** So are `fl oz` and `sq m`.

## Conventions

- `src/lib/shared/` imports nothing from `next/*`, `server-only`, or Node built-ins — it
  must stay bundleable by Metro for a future React Native client.
- Server actions are thin wrappers over `src/lib/core/` functions that **receive** a
  Supabase client rather than constructing one. That parameter is the seam.
- Manifests live in `manifests/*.json`; the repo is the source of truth. "DB edit, no
  deploy" means edit the file and re-run the seed.
- Field keys are section-local (`page_title`, never `hero.page_title`). Addresses
  compose as `sectionId.fieldKey` or `sectionId[i].fieldKey`.
- Run `npm run verify` (typecheck + lint + tests) before claiming anything works.

## Where things are

| Concern | Path |
|---|---|
| Specification | `docs/landerforge-plan.md` |
| CMS field inventory | `docs/cms-screenshots/` |
| Density evidence | `docs/lander-samples/` |
| Token list | `docs/tokens.txt` |
| Domain core | `src/lib/shared/` |
| The nine lints | `src/lib/shared/lints/` |
| Pipeline | `src/lib/inngest/functions/generate.ts` |
| Schema, hooks, RLS | `supabase/migrations/` |
