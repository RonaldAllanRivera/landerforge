# LanderForge — Implementation Plan

> Build spec for Claude Code. Reference material lives in `docs/`: `cms-screenshots/` (the authoritative field inventory), `lander-samples/` (rendered pages, for density and craft only), and `tokens.txt`. This is the only plan document — there is no second copy.
>
> The CMS screenshots are the source of truth for **template structure** (which sections exist, which fields they contain, what each field is called):
> `docs/cms-screenshots/` holds `templates.png` (picker), `advertorial.png`, `comparison.png`, `Interstitial.png`, `reasons.png`. Study them before writing the manifests in Phase 1 — and see "What the tool generates, and what it does not": a field that is not in these screenshots is not generated.
>
> The screenshots are **not** the source of truth for word counts or content shape — see "Density and format come from the source URL" below.
>
> `tokens.txt` is the authoritative token list. It is reproduced verbatim in "Allowed tokens" and must not drift from that file.
>
> `docs/lander-samples/*.png` are **rendered public landers**, not CMS screens. They are source-material fixtures and density evidence — never a field inventory. Where they and the CMS screenshots disagree about what exists, the CMS screenshots win.

## What this is

An internal tool for generating tokenized advertorial/lander copy for a LogicHub CMS. The user picks a template, pastes a competitor/source URL, adds optional special notes, and gets back per-field copy that mirrors the CMS section structure — same style and word density as the source, but stronger (per the copy rules below). Output is copied field-by-field into the CMS manually. No CMS API integration. No Custom HTML template support.

## Stack

- **Next.js 15** (App Router, TypeScript, RSC where sensible) on **Vercel**
- **Supabase** (Postgres + Auth + Realtime) with `@supabase/ssr`. Google OAuth only, restricted to allowlisted Gmail addresses, with `admin`/`editor`/`viewer` roles. RLS on every table.
- **Anthropic API**, model `claude-sonnet-4-6`, with **prompt caching** on a strictly append-only prefix. Two deliberate per-step overrides: screenshot transcription runs on a high-resolution-tier model (Opus 5 or Sonnet 5) because Sonnet 4.6 is standard-tier and would downscale page captures into illegibility, and the injection classifier on transcripts runs on `claude-haiku-4-5`.
- **Playwright via Browserless.io** (`playwright-core` over CDP) for scraping — do NOT bundle full Playwright into Vercel functions
- **Inngest** for background job orchestration (generation runs are 10–15 sequential API calls)
- **Zod** for all schemas — template manifests, API payloads, model structured outputs
- Tailwind + shadcn/ui for the frontend. Dark theme to match the CMS.

## What the tool generates, and what it does not

**The manifest is exactly the CMS's editable fields — nothing more.** The four CMS screenshots in `docs/cms-screenshots/` are the authoritative field inventory. If a piece of text appears on a rendered lander but has no field in the CMS edit screen, it is **platform chrome** and the tool never writes it.

That rule settles several things at once:

- **No footer content is generated**, and the CMS confirms why: reading all four edit screens end to end, **not one exposes a footer or disclaimer field**. Disclaimers are a separate global resource — `CMS → Disclaimers` in the left nav — *attached* to a page, never authored in its field stack. So they get no manifest entry, no word target, and no generation. They still exist as `disclaimer` blocks during *extraction*, because a scraped page contains them and they must not pollute density or the overlap lint; they simply have no counterpart on the output side.
- **Consequently no manifest declares a `legal` link policy**, and the four legal-URL tokens never appear in generated copy. They live in the attached Disclaimers resource. (`reasons.png`'s section nav shows a "Footer" entry with no visible panel — confirm in the live CMS before Phase 4 whether that hides a field; nothing in the captures suggests it does.)
- The **author bio** is the same shape of thing: it renders on the public page but comes from the Authors resource, selected by a dropdown. Not editable here, so not generated.
- The same applies to the as-seen-on logo row, guarantee badges, star ratings, and anything else the platform renders identically on every page.
- Where a rendered lander and a CMS screenshot disagree about what exists, **the CMS screenshot wins.** The rendered samples in `docs/lander-samples/` are for measuring density and studying craft, not for enumerating fields.

**The product name is always `{{productName}}`.** Never a literal, in any field, on any template — not in headlines, not in testimonials, not in the SEO title. The token exists so one page can serve many brands, and a single hardcoded occurrence silently breaks that for the whole page. The lint enforces it against the project's alias list, and `productNameFormat` never permits a literal: where a field names the product, it is always the token. `productNameFormat` chooses how that token renders — `bold` or `plain` — and `none` means the field does not name the product at all.

## Core architecture principle

**Templates are data, not code.** Each template is a JSON "field manifest" stored in Supabase describing sections → fields → constraints. Three consumers read the same manifest:

1. The **generator** (what to write, per-field constraints)
2. The **validator** (deterministic post-generation checks)
3. The **UI** (renders the review screen + copy buttons from it)

Changing a bold rule or a fallback word count = DB edit, no deploy.

**Manifests are versioned by snapshot.** Every generation copies the manifest it ran against into `generations.manifest_snapshot`. The review screen, copy buttons, and validator read the snapshot, never the live template row — otherwise editing a manifest silently re-judges and re-renders every historical generation against rules it was never written for.

**Manifest source of truth is the repo.** Manifest JSON lives in `manifests/*.json`, Zod-validated, seeded by idempotent upsert on `templates.slug`. "DB edit, no deploy" means edit the file and re-run the seed — still no deploy, but the manifests survive losing the database and get code review. If you do hand-edit a manifest in the Supabase table editor, run the documented export step to pull it back into the repo.

### Density and format come from the source URL

**Decision:** when a source URL was scraped successfully, the source dictates length and shape. The manifest's numbers are fallbacks for the no-source path only.

| Signal | With a source URL | Without one |
|---|---|---|
| Words per field | `sectionPlan[].fields[key].wordTarget` (a range, tolerance baked in) | Manifest `fallbackWordTarget` |
| Repeated-section count (reviews, reasons, competitors) | `sectionPlan[].instanceCount`, derived from the source and clamped to the manifest's `repeat` range | Manifest `repeat` minimum |
| List item counts within a field | `sectionPlan[].fields[key].itemCount` | Manifest `fallbackItemCount` |
| Subunits inside one rich-text field | `sectionPlan[].fields[key].subunitCount` + per-part ranges | Manifest `fallbackSubunits` |
| Whether an optional section appears | `sectionPlan[].present` | Manifest `defaultPresent` |

Three counts, deliberately distinct because conflating them is the easy mistake: `instanceCount` is how many times a repeating **CMS field group** appears (five reviews); `fields[key].itemCount` is how many **lines** a list field contains (a three-bullet pros list); `fields[key].subunitCount` is how many **internal units** live inside one rich-text blob (seven reasons in a single body field — explicitly *not* a repeat; see `fallbackSubunits` below). A reviews section can need all three at once, so they cannot share one number.

#### One density substrate for every source type

Every source — scraped, pasted, or transcribed — produces the **same typed block array** into `sources.blocks`, and `raw_text` is defined as its concatenation. This is what stops density behaving differently depending on where the source came from:

```ts
{ blocks: [ { type: "heading" | "paragraph" | "list_item" | "quote"
                    | "testimonial" | "table_row" | "cta" | "disclaimer",
              level?: number,        // headings only
              variant?: string,      // testimonial: inline_quote | review_card | comment
              cells?: string[],      // table_row only
              isHeader?: boolean,    // table_row only
              parentIndex?: number,  // nesting: a comment's reply points at the comment
              selectorHint?: { sectionId: string, fieldKey: string },  // same-platform
                               // no instance ordinal: blockMap owns instance identity,
                               // and Step 1 infers it from hint order (name, text,
                               // name, text… is unambiguously two review instances)
              text: string } ] }     // always the flat rendering; raw_text is its concat
```

Four fields beyond the obvious, each forced by something in the real pages:

- **`cells` / `isHeader`** — the comparison tables measured 12×4 and 8×5, with tri-state markers plus short labels. Reconstructing an N-column table from concatenated row text is lossy, and the generator otherwise has no way to be told "5 columns, 7 feature rows".
- **`variant`** — one flat `testimonial` type cannot distinguish the three shapes these pages actually use: inline blockquotes with an em-dash byline, structured review cards with avatar and stars, and threaded comments with initials and a timestamp. Step 1 shouldn't have to re-derive that from context.
- **`parentIndex`** — comment replies are real (one page has six comments and one nested reply, another has six and none). Extraction needs to record that a reply block belongs to comment 3, which a flat array cannot say. But **nesting stops at extraction**: a reply is flattened into `optional: true` *fields on the parent comment*, not modelled as a nested repeating section. The CMS does have a real "Add Reply" sub-list with four controls, so the flattening declares **four** fields, not two — `reply_author`, `reply_text`, `reply_time_ago` (`specPolicy: "exempt"`), and `reply_verified_buyer` (`display`) — and all four carry `optional` together. The flag matters: without it the five reply-less comments on the measured page each back-fill from the manifest, and the generator gets pushed into inventing five replies, which the compliance rules forbid outright. The observed maximum is one reply per comment; if that ever stops being true, this is the decision to revisit. That keeps `blockMap`'s `instanceIndex` a scalar, keeps the output shape flat, and keeps `sectionId[index].fieldKey` sufficient to address every violation and every copy button. The observed data is shallow — at most one reply per comment — so a second level of repetition would be machinery with no user.
- **`text` stays authoritative** even when `cells` is populated, so `raw_text` remains exactly the concatenation of blocks.

The division of labour is fixed, and the reason is that language models cannot count reliably while code cannot read a page:

1. **Extractor** (Step 0's readability pass, the paste handler, or the screenshot transcription) emits blocks. Mechanical on the scrape and paste paths; a verbatim vision call on the screenshot path.
2. **Code** counts words per block. Never the model.
3. **Step 1** emits a `blockMap` — which block index belongs to which template `sectionId`, which repeated instance, and which field. Pure judgment, which is what the model is for.
4. **Code** builds `sectionPlan` from the two: sum the mapped blocks per field and store `wordTarget: [round(sum × 0.9), round(sum × 1.1)]`; count mapped `list_item` blocks for `itemCount`; count distinct `instanceIndex` values for `instanceCount`; count distinct `subunitIndex` values for `subunitCount`; and sum per `part` to build `fields[key].parts: Record<string, [number, number]>` the same ±10% way. `subunitIndex` and `part` are identifiers the model assigns, not counts it computes, so they sit inside its remit.

`wordTarget` is a **`[number, number]` range with the ±10% already baked in** — the same shape as `fallbackWordTarget`, so both paths hit the identical check and the validator simply asks whether the count falls inside the range. Do not apply a further ±10% on top; that would widen the band to roughly ±21%.

So `sectionPlan` as the validator consumes it is a **code-built object, not a model output**. Word counts never appear inside `raw_text` either — annotating them into the text would make those digits false positives for the `allowedSpecs` guard, which searches `raw_text` for spec numbers.

**Every writer of `blocks` truncates block-wise**, never string-wise: Step 0's readability pass, the paste handler, the transcription function, and the transcript-confirmation save all drop whole trailing blocks until the concatenation fits 200 KB, set `raw_text_truncated`, and persist only the retained blocks. A string cap would leave `blocks` holding content `raw_text` does not, so Step 1 would read a spec from past the cut and the guard would fail to find it — killing the run over content that was genuinely there.

The paste path is the weak one: pasted text has no reliable structure, so its handler splits on blank lines and types everything `paragraph` unless a line is obviously a heading. Density from a pasted source is therefore coarser, and the plan accepts that rather than pretending otherwise.

One caveat specific to screenshots: a capture may be partial where a scrape is whole, so a short transcript can produce density targets that undercount the real page. The `ocr` provenance on the review screen is the cue to sanity-check the targets rather than trust them blindly.

Brief targets are per-field ranges, exactly like the manifest fallbacks, so both paths run the identical check. Precedence is absolute and per field: if `sectionPlan[].fields[key]` exists, it wins; if it is absent, the manifest fallback applies. If the two disagree by more than 2×, still use the brief but write a `density_divergence` entry to `generations.run_notes` so an implausible scrape is visible rather than silent.

This makes the source→template mapping load-bearing, and it is an LLM judgment, not a deterministic one: scraped sections have headings, not `sectionId`s. Step 1 emits `blockMap`; code builds `sectionPlan` from it, keyed by template `sectionId`. The validator only ever reads the resulting numbers.

### Manifest shape (Zod it)

```ts
type FieldType =
  | "text"          // single-line plain text
  | "textarea"      // multi-line plain text
  | "markdown"      // CMS renders markdown
  | "scaffolded"    // repeated lines wrapping copy in fixed markup — see lineTemplates
  | "number"
  | "display";      // NOT generated — a position marker so the review screen
                    // mirrors the CMS top-to-bottom (toggles, image slots, selects)

type TokenCategory = "tracking" | "content" | "date" | "visitor" | "legal" | "conditional";

interface TemplateField {
  key: string;              // SECTION-LOCAL, e.g. "page_title" — never "hero.page_title".
                            // Fully-qualified addresses are composed as sectionId.key.
  label: string;            // matches the CMS field label in the screenshot
  type: FieldType;
  generate: boolean;        // false for type "display"; the review screen shows
                            // the field and its intended setting, generates nothing
  optional?: boolean;       // may be absent on any given instance — a comment's reply.
                            // An absent optional field is skipped by every lint and
                            // never falls back to a manifest word target; it is also
                            // omitted from the section's output-schema `required` list.

  // Fallbacks — used ONLY when the brief has no entry for this field
  fallbackWordTarget?: [number, number];
  fallbackItemCount?: number;
  charLimit?: number;       // hard CMS limit, always enforced regardless of source

  markdownBold: boolean;    // does the CMS parse markdown in this field? see below
  productNameFormat: "bold" | "plain" | "none";
  linkPolicy: "none" | "product_name" | "free_anchor";

  allowedTokens?: {         // optional narrowing; see "Allowed tokens" for the default
    categories?: TokenCategory[];
    tokens?: string[];      // exact tokens, additive to categories
  };

  lineTemplates?: Record<string, string>; // required when type === "scaffolded"
  specPolicy?: "exempt";    // skip lint 8 for this field — timestamps, relative times

  fallbackSubunits?: {      // internal composition of one rich-text field — FALLBACK
    count: [number, number];             // only; the source wins when there is one
    parts: Record<string, [number, number]>;   // partName -> word range, in join order
    join?: string;                       // separator, default "\n\n"
  };

  voice: "second_person" | "brand_we" | "reviewer" | "expert";
  notes?: string;           // free-text guidance injected into the generation prompt
}

interface TemplateSection {
  id: string;
  label: string;
  presenceToggleLabel?: string;  // the CMS renders a toggle in the section HEADER
                                 // ("Show section", "Mobile Sticky CTA"). Bind a
                                 // presence toggle to sectionPlan[].present; a
                                 // rendering-variant toggle is display-only.
  repeat?: [number, number]; // e.g. reviews: [3, 8] — actual count comes from the brief
  defaultPresent: boolean;
  fields: TemplateField[];
}

interface TemplateManifest {
  slug: "advertorial_v1" | "comparison_v1" | "interstitial_v1" | "reasons_v1" | "simple_page";
  name: string;
  sections: TemplateSection[];
  selectors?: Record<string, string>;  // CSS selector -> "sectionId.fieldKey", for
                                       // same-platform sources. Data, not code, so a
                                       // CMS markup change is a manifest edit.
}
```

**`productNameFormat`** — checked against every occurrence of `{{productName}}` in the field, independent of `linkPolicy`:

- `bold` — every occurrence wrapped in `**…**`. Invalid on a `markdownBold: false` field; reject at manifest-validation time.
- `plain` — every occurrence bare, with no `**`, regardless of `markdownBold`.
- `none` — `{{productName}}` must not appear in this field at all.

**`markdownBold` describes the CMS field, not the copy.** The generator emits `**…**` in every field, because the skim-test rule ("a reader who reads only the bold text gets the complete argument") is a property of the copy and cannot be switched off per field. What differs is what happens downstream:

- `true` — a markdown field, like the advertorial Outro. The CMS parses the markers, so the copy button copies them verbatim.
- `false` — a WYSIWYG field, like the advertorial Body, where pasted asterisks would show literally. The review screen **renders** the bold so the operator can see what to emphasize, and the copy button **strips the `**`** so the paste is clean; the operator re-applies bold with the CMS toolbar. The markers are working annotations, not output.

**Infer the flag from the screenshot rather than testing every field in the CMS**, using two signals that are visible in `advertorial.png`: a field whose label ends in `(markdown)` — Outro, Benefits List — is `true`; a field rendered with a rich-text toolbar, or one whose example content shows *rendered* bold rather than asterisks, is `false`. Where neither signal is present, default to `false`: the failure is asymmetric. Guessing `false` on a markdown field costs the operator one redundant toolbar action; guessing `true` on a WYSIWYG field ships literal asterisks onto a live page. Treat any field the CMS later proves wrong as a one-line manifest edit, not a schema problem.

Markdown links are *not* stripped even on `markdownBold: false` fields — the `{{clickURL}}` token has to survive the paste for the operator to apply the link with the toolbar.

`productNameFormat` governs **how the token renders**, never whether a literal is allowed — a literal never is. Whether the product name may be linked is `linkPolicy`'s business and nothing else's — that separation is the reason the two knobs exist, and mixing a no-link clause into `plain` would make `plain` + `product_name` unsatisfiable.

**`linkPolicy`** — defines the complete set of permitted markdown links in the field. There is no global link rule; the field's policy is the whole rule:

- `none` — no markdown links at all.
- `product_name` — exactly one link shape is allowed: anchor is `{{productName}}` rendered per this field's `productNameFormat`, target is `{{clickURL}}`. With `productNameFormat: "bold"` that is `[**{{productName}}**]({{clickURL}})`; with `"plain"` it is `[{{productName}}]({{clickURL}})`. Both are legal — the bolding is `productNameFormat`'s call, the link is this policy's.
- `free_anchor` — any anchor text, target must be `{{clickURL}}`. This is what the advertorial Outro needs: `[grab yours now at {{discountValue}}% off]({{clickURL}})`.

Zod refinements reject a manifest that pairs `linkPolicy: "product_name"` with `productNameFormat: "none"`, or whose `allowedTokens` excludes a token its `linkPolicy` requires.

**Scaffolded fields.** The model never writes markup. A `scaffolded` field's output is `{ items: [{ variant, copy }] }`, where `variant` is constrained by the output schema to the keys of `lineTemplates` and `copy` is plain text with no newlines and no braces **except tokens this field's `allowedTokens` permits** — production's benefits list contains `{{discountValue}}% Discounted today`, so a blanket no-braces rule would forbid reproducing the real page. Code assembles each line by substituting `copy` into the chosen template, so the markup is correct by construction rather than by a byte-for-byte retry loop. The advertorial sidebar benefits list declares:

```json
"lineTemplates": {
  "positive": "- <span class=\"fa-li positive\"><i class=\"fa-solid fa-circle-check\"></i></span> {copy}",
  "negative": "- <span class=\"fa-li negative\"><i class=\"fa-solid fa-circle-check\"></i></span> {copy}"
}
```

Note the `negative` variant taken from production: the class changes but the icon stays `fa-circle-check`. `fa-circle-xmark` appears nowhere on the live pages, and the fourth sidebar bullet on both measured landers is a `negative`-classed check ("Only available online"). Take the markup from the **stored CMS value**, not the rendered page — the rendered page only tells you `fa-circle-xmark` is never used.

Word counts and `charLimit` for scaffolded fields are measured over the `copy` slots only — otherwise the markup swamps the density target. Item count is `items.length`.

**`subunits`: repetition inside one field, which is not the same thing as `repeat`.** Verified against the real pages: the CMS stores each major content area as a *single* rich-text field. The reasons template's body is one ~1,100-word blob holding all seven heading + body + quote units plus inline images, a bullet list and a whole comparison table; the advertorial's body is one blob of 868 words on one page and 1,328 on another, spanning ~50 paragraphs and 9 subheadings.

So the seven reasons are **not** a `repeat` section. Modelling them that way would give the operator seven copy buttons for a field the CMS accepts as one paste. `repeat` is for genuinely repeated *CMS field groups* — Reviews, with its "Add Review" button. `subunits` is for internal rhythm inside one field:

```json
"fallbackSubunits": { "count": [6, 8],
                      "parts": { "heading": [10, 17], "body": [40, 90], "quote": [24, 54] } }
```

**Like every other manifest number, these are fallbacks.** When a source exists, code derives `sectionPlan[].fields[key].subunitCount` and per-part word ranges from the blocks mapped to that field — a source with four reasons produces four, not the manifest's six-to-eight. Forcing the manifest count against a source-derived `wordTarget` would put two constraints on one field that can be mutually unsatisfiable.

The generator produces the subunits as an array; code joins them with `join` (default a blank line) into the single field value before validation, so the copy button still emits one blob. Lint 1 checks each part against its range and lint 2 checks the subunit count, both falling back to the manifest — otherwise this would be a quantitative constraint that reaches the prompt with nothing enforcing it, which the plan forbids everywhere else.

**Constraints do not go in the output schema.** Structured outputs do not enforce string length, numeric range, or array cardinality — the SDK strips those keywords and validates them client-side, which turns a `charLimit` into a confusing null parse rather than a constraint the model ever saw. Derive a deliberately loose schema for the API (structure, types, `required`, `additionalProperties: false`) and convey every quantitative constraint as prompt text, enforced by the Step 3 validator.

### Output shape

`generation_sections.output` is per section. Field keys are section-local, so the section row supplies the prefix:

```ts
// non-repeating section (sectionId "hero")
{ "page_title": "…", "summary": "…" }

// repeating section (sectionId "reviews", repeat: [3, 8])
{ "items": [ { "reviewer_name": "…", "review_text": "…" }, … ] }

// a scaffolded field inside any section
{ "benefits_list": { "items": [ { "variant": "positive", "copy": "…" }, … ] } }
```

**Field addressing is one convention everywhere** — `sectionId.fieldKey` for a plain field, `sectionId[index].fieldKey` inside a repeating section. Manifest `key` values are section-local (`page_title`), so composing an address never doubles the prefix. The `violations` map, the review screen, and the copy buttons all index by this address.

## What the CMS screens actually contain

All four edit screens were read end to end before this plan was finalised. Findings that shape manifest authoring:

**Section order follows the rendered panel order, not the nav.** Both disagree on every template — `reasons.png`'s left nav reads Hero, Content, CTA, Social Proof, Comments, Sidebar, while the panels render Hero, Content, Social Proof, Comments, Sidebar, CTA. An operator scrolling the review screen beside the CMS is matching *panels*. Author manifests in panel order.

**Roughly a third of every screen is non-generated.** On `reasons_v1`, 16 of 43 controls are image slots, selects, or toggles — and they are *interleaved* with copy fields rather than clustered, so `display` entries are what keep the top-to-bottom walk aligned. Section-level toggles sit in the panel **header**, which is why `presenceToggleLabel` exists; note that "Show section" binds to presence while "Mobile Sticky CTA" is a rendering variant and is display-only.

**Rich-text fields are internally scrolled**, so the visible example content is a floor, not the field's length. Do not source a `wordTarget` from a screenshot of a `Body` field — that is exactly what the source-derived density path is for.

**No character counters or maxlength hints appear anywhere**, so no `charLimit` can be sourced from these captures. Leave it unset rather than guessing.

**The two sidebar lists are not the same kind of field**, despite looking identical when rendered: the advertorial's "Benefits List (markdown)" stores FontAwesome `<span>` scaffolding and is `scaffolded`; the reasons' "Features List (markdown)" stores plain markdown bullets and is `markdown`. `lineTemplates` is per-template — copy the markup from the actual stored value, never infer it from the rendered page.

**Tokens turn up in places a naive manifest would restrict.** `{{discountValue}}` appears inside two user *comments* on the live reasons page, and `reasons`' Sidebar Title is nothing but the bare `{{productName}}` token. So do not narrow the content category on testimonial or comment fields, and expect at least one field whose entire value is a single token.

**One CMS quirk to carry forward:** `comparison_v1` draws price copy from a separate Pricing tab, so a field like "Pay Only {{priceDiscounted}}" renders blank until that tab is filled. That is outside this tool's scope, but the review screen should say so rather than let an operator paste something that silently renders empty.

## Validated against the real landers

Eight live pages — two per template — were fetched and analysed before this plan was finalised. They are LogicHub's own output, which makes them exact ground truth rather than approximations. What they settled:

**Confirmed.** All eight are fully server-rendered Next.js; every word is in the initial HTML, so the `domcontentloaded` + content-signal wait is right and `networkidle` would have been pointless. Bot protection is **user-agent filtering only** — a default fetcher UA gets a hard 403, a normal desktop Chrome UA gets 200 on the identical URL, with no challenge, no cloaking, no JS gate. Rung 1 of the anti-bot ladder therefore clears every one of these pages provided it sends a realistic UA, which the plan already requires for density reproducibility; the metered stealth-and-residential rung is for genuine third parties.

**Density from source is not a nicety.** Two instances of the *same* template differ enormously: body copy 868 vs 1,328 words (+53%), reviews averaging 82 words across three instances vs 22 words across five (3.7×), H1 13 vs 18 words, comparison tables 12×4 vs 8×5. Manifest fallbacks alone would have been wrong on nearly every field.

**Measured fallbacks**, for authoring manifests before any scrape exists — advertorial: H1 13–18 w, summary 38–41 w, body 868–1,328 w, outro 53–55 w, sidebar title 7–11 w, review body 19–87 w. No disclaimer figure appears here on purpose: the footer is not generated, so it has no fallback to author. Reasons: H1 16–17 w, intro 97–125 w, reason heading 10–17 w, reason body 40–90 w, reason quote 24–54 w, social card 21–40 w, comment 20–43 w, CTA intro 37–52 w.

**Tokens confirmed against production.** React interpolation boundaries expose which values are real variables: `#1 BEST IN <!-- -->2026` is `{{currentYear}}`, `50<!-- -->% OFF` is `{{discountValue}}` followed by a hardcoded `%`, `["90","-Day Money Back Guarantee"]` is `{{guaranteeDays}}`. Every CTA on a page targets one host (`clk.<domain>/action/1`, 9–23 anchors per page), so a single repeated `{{clickURL}}` literal is right. Exactly four footer legal links match the four legal tokens, each with the token as target and a plain word as visible text — confirming that legal tokens appear only as link targets.

**Three divergences to expect rather than fix.** Impressum renders unconditionally on the live pages and points at the same URL as Contact — but it lives in the attached Disclaimers resource, so it is never this tool's output and the divergence cannot reach generated copy. The guarantee renders Title Case and unhyphenated — "90-Day Money Back Guarantee" — so the guarantee lint must be **case-insensitive and accept both "money back" and "money-back"**, keeping only the requirement that the number is the token. And a product name may have two spellings in one page ("Pest Pulse Pro Solar" in the body, "PestPulsePro Solar" in the title), so the literal-name lint matches against a list of **project aliases** — spaced, unspaced, and domain forms — not one string.

**One live bug worth knowing about**, found while reading these pages: on `buyvermixpulsepro.com` the `{{productName}}` field is unset, so the floating CTA title renders empty and the footer reads "authorized reseller/retailer of ." while the body hardcodes the product name 17 times. A `{{productName}}`-is-empty check belongs in the CMS, not this tool — but it is exactly the failure mode the token rules exist to prevent.

**Normalization must also handle the numeric formats these pages actually use**, none of which the original spec covered: trailing `+` (`50,000+`), leading `~` (`~400`), en-dash ranges (`$1,500–$4,000+`), U+2212 MINUS SIGN rather than hyphen (`−6 to +3`), `X to Y` ranges spanning two values, times (`8am`, `5pm`, `00:00:00`), and units abutting digits (`18W`, `6000mAh`). Decide `00:00:00` explicitly — as three bare zeroes it is neither rhetorical nor a year and would otherwise demand an `allowedSpecs` match.

## Database schema

Conventions: `timestamptz` (never bare `timestamp`) defaulting to `now()`, `text` (never `varchar(n)`), and `id bigint generated always as identity primary key` **except where a natural key is shown** (`allowed_emails` keys on `email`). A `moddatetime` trigger goes on every table that declares `updated_at`; append-only tables declare only `created_at` and get no trigger.

```sql
-- Auth: see "Authentication" below for the hooks that populate these
allowed_emails (
  email text primary key,             -- full Gmail address, lowercased
  role public.app_role not null default 'editor',   -- role granted at first sign-in
  note text, invited_by uuid references auth.users,
  created_at timestamptz)

user_roles (
  id, user_id uuid not null references auth.users on delete cascade,
  role public.app_role not null,      -- enum: admin | editor | viewer
  unique (user_id, role))             -- plus a unique index on (user_id) alone

templates (
  id, slug text unique, name text, manifest jsonb,
  created_at timestamptz, updated_at timestamptz)

projects (
  id, owner_id uuid not null references auth.users,
  name text, product_name text,
  product_name_aliases text[],          -- spaced/unspaced/domain forms; the literal-name
                                        -- lint matches all of them, not just product_name
  niche text, notes text,
  created_at timestamptz, updated_at timestamptz)

sources (
  id, project_id bigint references projects,
  source_type text not null check (source_type in ('url','paste','screenshot')),
  url text, url_normalized text,        -- tracking params stripped, for reuse lookup
  scraped_at timestamptz,
  status text not null check (status in ('pending','ok','blocked','failed','manual')),
                                        -- url: set by the scrape ladder. paste: 'manual'.
                                        -- screenshot: inserted 'pending', then set 'ok'
                                        -- by the transcription function, or 'failed'.
  raw_text text,                        -- concatenation of blocks, truncated
                                        -- BLOCK-wise (never string-wise) to 200 KB
  raw_text_origin text not null check (raw_text_origin in ('extracted','pasted','ocr')),
  raw_text_truncated boolean default false,
  transcript_confirmed_at timestamptz,  -- required before generation when origin='ocr'
  raw_html_path text,                   -- gzipped original in Supabase Storage
  blocks jsonb,                         -- typed block array; the density substrate.
                                        -- Written by whichever extractor produced this
                                        -- source (Step 0, paste, or transcription), then
                                        -- editable by the operator on the ocr path only,
                                        -- via the transcript-confirmation column grant,
                                        -- which re-derives raw_text and counts on save.
                                        -- raw_text is always its concatenation.
                                        -- Never written by Step 1.
  created_at timestamptz)

source_screenshots (                    -- ordered pages of one screenshot source
  id, source_id bigint references sources on delete cascade,
  position integer not null,            -- reading order, 1-based
  original_path text,                   -- as uploaded; nulled after transcription
  derivative_path text,                 -- sharp-validated downscale; kept for review
  width integer, height integer, bytes integer,   -- of the derivative once it exists
  created_at timestamptz,
  unique (source_id, position))

generations (
  id,
  owner_id uuid not null default auth.uid()      -- default + INSERT policy's with check,
    references auth.users,                       -- so the invariant holds for any client;
                                                 -- the worker never inserts this row
  project_id bigint references projects,
  template_id bigint references templates,
  source_id bigint references sources,  -- nullable
  manifest_snapshot jsonb not null,     -- the manifest this run was generated against
  version_num integer not null,
  parent_id bigint references generations,
  special_notes text,
  brief jsonb,                          -- Step 1 output: blockMap + the code-built
                                        -- sectionPlan + allowedSpecs + upgrade plan.
                                        -- Per-generation, never on the source row.
  status text not null check (status in
    ('queued','scraping','briefing','generating','done','failed')),
  error_message text,
  run_notes jsonb,                      -- run-level findings that aren't per-field
  retry_count integer not null default 0,
  total_cost_usd numeric,
  created_at timestamptz, updated_at timestamptz,
  unique (project_id, version_num))

generation_sections (
  id,
  generation_id bigint references generations on delete cascade,
  section_id text,
  output jsonb,                         -- this section only
  status text not null check (status in ('pending','done','flagged')),
  violations jsonb,                     -- Violation[] keyed by field address
  created_at timestamptz, updated_at timestamptz,
  unique (generation_id, section_id))

generation_steps (                      -- required, not optional: the only debugging
  id,                                   -- surface when copy quality drifts
  generation_id bigint references generations on delete cascade,
  step text, section_id text, attempt integer,
  prompt jsonb, response jsonb,
  model text, stop_reason text,
  input_tokens integer, output_tokens integer,
  cache_creation_input_tokens integer, cache_read_input_tokens integer,
  latency_ms integer, cost_usd numeric,
  created_at timestamptz)

client_config (                       -- single row; read by web and mobile clients
  id, supported_runtime_versions text[],  -- expo fingerprint hashes still accepted
  latest_apk_url text,
  updated_at timestamptz)

rules (
  id, scope text check (scope in ('global','project')),
  project_id bigint references projects,
  body text, active boolean default true,
  created_at timestamptz, updated_at timestamptz,
  check ((scope = 'global' and project_id is null)
      or (scope = 'project' and project_id is not null)))
```

`run_notes` holds everything the validator finds that isn't attributable to one field. Note kinds, and who writes each: `no_source` and `source_blocked` (Step 0), `spec_conflict` (Step 1, contradictory source specs) and `spec_guard_failed` (Step 1, `allowedSpecs` failed the deterministic guard twice), `density_divergence` (Step 3), `budget_exceeded` (the spend guard). The review screen renders it as a run-level notes panel above the sections, and Phase 2's acceptance criteria read it.

Index every foreign key — Postgres does not do it for you:
`sources(project_id)`, `generations(project_id)`, `generations(template_id)`, `generations(source_id)`, `generations(parent_id)`, `generation_sections(generation_id)`, `generation_steps(generation_id)`, `rules(project_id)`. Index the ownership columns too — `projects(owner_id)` and `generations(owner_id)` — since RLS policies filter on them and an unindexed policy column forces a sequential scan on every query. No GIN indexes — nothing queries inside the jsonb.

**Never `select *` on `sources`** — `raw_text` is up to 200 KB and `blocks` holds a second copy of the same text, so a careless list query drags nearly half a megabyte per row.

Migrations are Supabase CLI migration files committed to the repo and applied with `supabase db push`.

### Authentication — Google OAuth only, allowlisted Gmail accounts

Sign-in is Google OAuth and nothing else. Email/password and magic links stay disabled in the Supabase dashboard. Only Gmail addresses on an explicit allowlist may create an account.

**Packages.** `@supabase/supabase-js` + `@supabase/ssr`. Do **not** install `@supabase/auth-helpers-nextjs` — it is deprecated and `@supabase/ssr` ships a runtime warning if it detects it. Three client factories, each created fresh per request (never a module-level singleton on the server, since each request carries different cookies):

| File | Factory | Key |
|---|---|---|
| `lib/supabase/client.ts` | `createBrowserClient` | publishable |
| `lib/supabase/server.ts` | `createServerClient`, `async` — `await cookies()` | publishable |
| `middleware.ts` | `createServerClient` over `request.cookies` | publishable |
| `lib/supabase/admin.ts` | `createClient`, `import "server-only"` | **secret** |

Cookie handling has two non-obvious requirements. Use **only** `getAll`/`setAll` — `get`/`set`/`remove` are the deprecated shape and Supabase warns they cause auth loops in production. And `setAll` now takes a **second `headers` argument** that must be applied to the response: it carries `Cache-Control: private, no-store` and friends, and without it a CDN — Vercel's edge explicitly included — can cache a response carrying auth cookies and serve one user's session to another. Most tutorials predate this parameter.

PKCE needs no configuration; `@supabase/ssr` hardcodes `flowType: "pkce"` and it cannot be overridden. `app/auth/callback/route.ts` calls `exchangeCodeForSession(code)`, guards the `next` param with `next.startsWith('/')` against open redirects, and branches on `x-forwarded-host` because Vercel terminates TLS at the edge and `origin` can otherwise resolve to an internal host. Build `/auth/auth-code-error` too — every rejected sign-in lands there.

**Server-side, read the user with `getClaims()`** (verifies the signature against the JWKS) or `getUser()`. **Never `getSession()` in server code** — it doesn't revalidate the token and cookies are client-writable.

Google Cloud Console setup: an OAuth consent screen, and an authorized redirect URI pointing at the Supabase project's callback (`https://<ref>.supabase.co/auth/v1/callback`), with the resulting client ID and secret entered in the Supabase dashboard — not in this app's env. Add the local dev URL to Supabase's redirect allowlist separately.

**Note on Next.js 16:** `middleware.ts` is renamed to `proxy.ts` (exporting `proxy()`, defaulting to the Node runtime), with a codemod provided. This plan targets Next 15, so `middleware.ts` is correct — but expect docs and tutorials to be split on the vocabulary.

#### The allowlist

`hd` (Google's hosted-domain hint) is a Workspace feature and does not constrain consumer `@gmail.com` accounts, so it cannot be the gate here. Neither can a client-side check — Google will happily mint a Supabase user for any account that completes consent, and anything that rejects *after* the fact leaves a window where an unauthorized person holds a valid session.

Enforce it in the database with the **Before User Created** auth hook, which runs before the `auth.users` row exists and can reject outright. It takes one `jsonb` and returns one: `'{}'::jsonb` allows, and `{"error": {"http_code": 403, "message": "…"}}` rejects. The hook looks the lowercased email up in `public.allowed_emails`. Match **full addresses, not the domain** — a `gmail.com` domain rule would admit all of Google.

`supabase_auth_admin` has **no** default privileges on `public` — it is neither `anon` nor `authenticated`, so Supabase's default grants don't reach it. Both gates must be opened, and they fail in different ways:

```sql
grant usage on schema public to supabase_auth_admin;
grant select on table public.allowed_emails to supabase_auth_admin;
grant execute on function public.hook_restrict_signup to supabase_auth_admin;
revoke execute on function public.hook_restrict_signup from authenticated, anon, public;

create policy "auth admin reads allowlist" on public.allowed_emails
  for select to supabase_auth_admin using (true);
```

Miss the **grant** and the hook raises `permission denied`, Auth returns a 500, and *every* signup fails including allowlisted ones. Miss the **policy** and RLS returns zero rows with no error, so every signup is rejected as unlisted. Neither failure mode names its own cause.

**The hook fires only at signup, never on subsequent logins.** Removing someone from `allowed_emails` therefore does *not* lock them out. Off-boarding is one admin action performing three writes: delete the allowlist row, delete the `user_roles` row, and delete the `auth.users` row (or `auth.admin.signOut` their sessions). Wiring them together is the point — doing two of three leaves a working account.

#### Roles

```sql
create type public.app_role as enum ('admin', 'editor', 'viewer');

create table public.user_roles (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  unique (user_id, role));

-- one role per person: the access-token hook does `select role into …`,
-- which would otherwise pick an arbitrary row
create unique index user_roles_one_per_user on public.user_roles (user_id);
```

- **`admin`** — one person. Manages the allowlist, assigns roles, edits `rules` and templates, may delete anything.
- **`editor`** — generates copy. Creates generations they own, and may update, retry, and regenerate **any** generation; reads everyone's; cannot delete. Mutation is gated on role, not ownership — see the RLS section for why.
- **`viewer`** — read-only. Nobody has it on day one; it exists because adding an enum value later is more friction than declaring it now.

**Provisioning: the allowlist row carries the role, and a trigger applies it.** The before-user-created hook cannot create the `user_roles` row — it runs before `auth.users` exists, and `user_roles.user_id` is a NOT NULL foreign key to it. Without a provisioning step every admitted user would land with no role row and a null claim, unable to do anything. So an `after insert on auth.users` trigger (`security definer`, `set search_path = ''`) looks the new user's lowercased email up in `allowed_emails` and inserts the matching `user_roles` row. It runs before the first access-token hook, so the very first JWT already carries the right claim. Changing someone's role afterwards is an `/admin` write to `user_roles`; `allowed_emails.role` only sets the initial value.

The `user_roles` table is the source of truth. A **Custom Access Token Hook** stamps the role into the JWT as a top-level `user_role` claim so policies can read it without a per-row subquery.

It needs the same grant set as the signup hook, for the same reason — and here the failure is entirely silent:

```sql
grant usage on schema public to supabase_auth_admin;
grant all on table public.user_roles to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;

create policy "auth admin reads roles" on public.user_roles
  for select to supabase_auth_admin using (true);
```

Without that policy the hook's `select role into …` returns no rows, the `else` branch stamps `null`, **login succeeds**, and every JWT ships `user_role: null`. Every write policy then denies, `/admin` can never promote anyone, and a naive Phase 1 check that "the JWT carries a `user_role` claim" passes vacuously. Assert the claim's *value*, not its presence.

Two rules for the hook body: `jsonb_set` into `event->'claims'` rather than building a fresh object (Supabase validates that `iss`, `aud`, `exp`, `sub`, `role`, `session_id` and the rest survive, and authentication fails if they don't), and keep the `else` branch stamping `'null'` so the claim is present-but-null rather than absent.

**Never use `user_metadata` for authorization.** It is user-writable via `auth.update()`, and with Google OAuth it is also where the provider's profile blob lands. `app_metadata` is safe and would work, but a table gives role assignments a foreign key, an enum constraint, and normal auditability.

**Role changes are not instant on claim-based policies** — the JWT carries the old role for up to its 1-hour lifetime, and the hook re-stamps on refresh. So: use the fast claim for reads and UI, and a live `security definer` subquery (`private.has_role('admin')`, `set search_path = ''`) for **destructive and privilege-escalating** policies — DELETE, and anything touching `user_roles` or `allowed_emails` — where an hour of stale authority is not acceptable. Genuine revocation means killing the session, and even then an issued JWT stays cryptographically valid until `exp`.

#### RLS, grants, and ownership

**Only `projects` and `generations` carry `owner_id`** (indexed). Child rows — `sources`, `generation_sections`, `generation_steps` — inherit access through their parent and have no owner column of their own; the worker writes them under the secret key, so they need no client-side write path at all.

Shared visibility with role-gated mutation, written as **one policy per command** so they compose as permissive ORs:

```sql
create policy "read all"       on public.generations for select to authenticated
  using ( true );
create policy "editors insert" on public.generations for insert to authenticated
  with check ( owner_id = (select auth.uid())
               and (select auth.jwt() ->> 'user_role') in ('admin','editor') );
create policy "editors update" on public.generations for update to authenticated
  using ( (select auth.jwt() ->> 'user_role') in ('admin','editor') );
  -- no with check: the condition reads no row data, so Postgres applying `using`
  -- as the row check is exactly equivalent. See the owner_id note below.
create policy "admin delete"   on public.generations for delete to authenticated
  using ( (select private.has_role('admin')) );
```

Note the UPDATE policy gates on **role, not ownership**. Gating on ownership alone leaves a demoted editor with permanent write access to every row they already own — indefinitely, not for the one-hour JWT window, because the policy would never consult the role at all. Editors may retry and regenerate any generation, which suits a small shared team and keeps the review screen's buttons honest for every run it will show. (The alternative — owner-only mutation — needs the Retry and Regenerate buttons hidden for non-owners, because the server action's conditional update would otherwise match zero rows and the button would just appear dead.)

The other tables:

| Table | Policy |
|---|---|
| `projects` | read all; insert/update `admin`/`editor`; delete `admin` |
| `generation_sections`, `generation_steps` | `select` via parent — `exists (select 1 from public.generations g where g.id = generation_id)`; no client write grant, the worker owns them |
| `sources`, `source_screenshots` | `select` via the project — `exists (select 1 from public.projects p where p.id = project_id)` for `sources` (it has `project_id`; it is `generations` that points at *it* via `source_id`), and via `sources` for `source_screenshots`. One client write: an UPDATE policy on `sources` for `admin`/`editor` scoped by a **column-level grant covering `blocks`, `raw_text`, `raw_text_truncated`, and `transcript_confirmed_at` only**, so correcting and confirming a transcript need no endpoint. Inserts come from the server action's admin client |
| `storage.objects` in the screenshot bucket | insert/select for `admin`/`editor`, scoped by path prefix to a project they can read. A **separate private bucket** from the scraped-HTML archive: mixing them means one over-permissive policy exposes both |
| `templates`, `rules`, `client_config` | read to `authenticated`; write gated on `private.has_role('admin')` |
| `allowed_emails`, `user_roles` | all client access gated on `private.has_role('admin')` (live check, not the claim), plus the `select to supabase_auth_admin` policies the hooks need |

**Three child-table writes that aren't the worker's**, all happening before any generation exists, so no worker is running yet to do them. The wizard's server action, through the admin client after its role check, creates: a **URL** source (`source_type = 'url'`, `url`/`url_normalized`, `status = 'pending'`) — or points `source_id` at a reusable one under the re-scrape policy, which the action owns because it owns the "re-scrape now" checkbox; a **paste** source with `status = 'manual'`; or a **screenshot** source plus its `source_screenshots` rows. A user-scoped insert would be denied in all three cases.

The worker never creates a source. Step 0 reads the referenced row's `url` and fills it in — which is also why the event needs to carry nothing but the generation id. The **image upload itself** is the exception to the exception: it goes direct from the browser to Storage under RLS, because a route handler cannot carry the bytes (see "Screenshot transcription").

`generation_steps`, cost included, is readable by anyone who can read the parent generation. The review screen shows run cost and cache-hit rate to whoever is looking at it, and Phase 1's acceptance criterion depends on that being visible, so cost is not an admin-only concern.

Four things are load-bearing there, each a documented footgun:

- **`(select …)` wrapping** on every `auth.uid()` / `auth.jwt()` call. Unwrapped, the function re-evaluates per candidate row; Supabase measures the degradation at 95%+.
- **`to authenticated`** on every policy, so the expression never runs for anonymous traffic.
- **`owner_id` needs a trigger, not a `with check`.** Now that UPDATE is gated on role rather than ownership, mirroring `using` into `with check` buys nothing — Postgres already applies the `using` expression as the row check when `with check` is omitted, and neither clause constrains what `owner_id` becomes. If ownership should be immutable after insert (it should — it's what "whose run is this" means on the history screen), enforce it with a `before update` trigger that raises when `new.owner_id <> old.owner_id`. Keep writing `with check` on policies whose condition *does* reference row data, where the two clauses genuinely differ.
- **Grants are a separate gate from policies.** Supabase grants `select, insert, update, delete` to `anon` and `authenticated` by default on `public` tables, and adding policies does not take those back. This app has no legitimate anonymous access at all, so revoke it explicitly: `revoke all on all tables in schema public from anon;` plus matching `alter default privileges`.

  **Do not also revoke DELETE from `authenticated`.** Admins are not a separate Postgres role — PostgREST does `set role authenticated` for every signed-in user, admin included — so revoking it would make the `admin delete` policy permanently unsatisfiable and admin deletes would fail with `42501` before RLS is ever consulted. The policy is the lock; the grant just has to be open enough for it to run.

#### The Inngest worker

The worker holds the secret key and bypasses RLS — with two consequences that cause real bugs:

- **The bypass is conditional.** A secret-key client that carries a user access token runs under *that user's* policies instead of bypassing. Construct a bare client inside the job; never reuse or forward the request-scoped `@supabase/ssr` client.
- **`auth.uid()` is NULL under the service role.** The worker never inserts an owner-bearing row — the server action creates `generations` before the event fires, and the worker only updates it and writes child rows. Keep it that way: if a future step ever needs the worker to insert one, the user id has to travel in the event payload and the event definition must be extended to carry it. `not null` on the column makes a mistake here loud rather than silent.

Nothing constrains the worker — no JWT, no policies. Any invariant that genuinely matters must also exist as a `check` constraint or trigger, since those are the only rules both the browser path and the worker path share.

**API keys:** use the current `sb_publishable_…` and `sb_secret_…` formats. The legacy JWT-shaped `anon` / `service_role` keys are deprecated at the end of 2026 — no reason to adopt them in a project starting now.

`INNGEST_EVENT_KEY`, `ANTHROPIC_API_KEY`, `BROWSERLESS_TOKEN`, and the Supabase secret key are server-only and must never appear in client code.

### Realtime

- Add `generations` and `generation_sections` to the `supabase_realtime` publication in the migration. Postgres Changes does not fire for tables outside it.
- Postgres Changes is gated by the subscriber's SELECT policy — the policy above must exist or streaming silently delivers nothing.
- **Subscribe to both tables.** `generation_sections` carries per-section progress; `generations` filtered to `id=eq.<id>` carries the run-level transitions — `status`, `error_message`, `run_notes`, `total_cost_usd`. A run that fails during the scrape or the brief writes no section rows at all, so without the `generations` subscription the `failed` state never reaches the UI and the review screen spins forever.
- **Treat every payload as a signal and refetch; never read content out of it.** Change payloads cap at 1,024 KB, and oversized events are not dropped — they are delivered with every field over 64 bytes stripped out. A row carrying `manifest_snapshot` and `brief` is nowhere near that cap today, but the failure mode is silent truncation rather than an error, so the refetch rule is what makes it safe rather than the row being small.

## Generation pipeline (Inngest function)

Triggers: `generation.requested { generationId }` for a fresh run, `generation.retry.requested { generationId, attempt }` to resume a failed one, and `generation.section.requested { generationId, sectionId, feedback }` for a single-section regenerate. A fourth function, `source.transcribe.requested { sourceId }`, runs *outside* the generation lifecycle — see "Screenshot transcription" below. Generation events carry only ids; the transcription event carries only a `sourceId`, and the worker reads the storage paths from `source_screenshots`.

Function config:

- **Idempotency.** `idempotency: "event.data.generationId"` on the fresh-run function. Inngest delivers at-least-once and the wizard is double-submittable. Be aware the window is **24 hours** — which is exactly why retry is a separate event: re-firing `generation.requested` for the same id would be silently swallowed for a day. The retry function keys on `string(event.data.generationId) + "-" + string(event.data.attempt)`, where `attempt` comes from the database, not the client: the Retry server action runs `update generations set retry_count = retry_count + 1 where id = $1 and status = 'failed' returning retry_count` and sends that value. A client-supplied constant would make the second press of Retry produce a duplicate key and be swallowed for 24 hours — no error, no status change, a button that just appears dead. The conditional update also gives the button the same claim semantics the pipeline's first step uses.
- **Concurrency.** A bare `concurrency: { limit: 1 }` is scoped to one function, so three functions with it get three independent queues and a regenerate can still run alongside a full run. To actually serialize them, all three declare the *same* object: `concurrency: { scope: "account", key: '"landerforge-generation"', limit: 1 }`. Account and env scopes require an explicit `key`, and that shared key is what makes it one virtual queue.

  **`key` and `idempotency` are CEL expressions, not literal strings.** A bare `landerforge-generation` parses as identifier arithmetic over undefined names, not as text — a constant key must be quoted *inside* the expression, hence the `'"…"'` nesting above. Same typing rule for the retry key: `generationId` is a `bigint` and `attempt` an integer, so both need `string()` before concatenation.
- **`onFailure`** writes `status = 'failed'` plus `error_message`, so the terminal state reaches the UI over the `generations` subscription.

**Every stage below is a `step.run` with a deterministic ID.** Only code inside `step.run` is memoized and durably retried; anything outside re-executes on every invocation, so a failure at section 12 would otherwise re-run the scrape and re-bill every prior API call.

**Steps persist their output and return metadata only.** Scraped text and generated copy are written to Supabase inside the step; the return value is small — IDs, statuses, and the violation list the retry loop needs to build corrective feedback. Returning generated copy would accumulate the whole page in Inngest's memoized run state and re-serialize it at every checkpoint.

The serve route is `app/api/inngest/route.ts` with `export const maxDuration` set to the plan ceiling and `export const runtime = 'nodejs'` (CDP websockets and the Anthropic SDK need Node, not edge). Inngest's checkpointing `maxRuntime` sits slightly below `maxDuration`. The Next.js middleware matcher **must exclude all of `/api/`** (see the auth surface section), or Supabase auth middleware blocks Inngest's callbacks and the pipeline silently never runs in production. `serve()` verifies request signatures when `INNGEST_SIGNING_KEY` is set; deployment fails loudly without it.

First step is a conditional claim: `update generations set status='scraping' where id=$1 and status in ('queued','failed')`. No row matched means the run is already in flight — abort with `NonRetriableError`. The `failed` case is what lets a retry re-enter; a claim restricted to `queued` would make the Retry button unreachable.

**Resuming.** A retry re-enters the **same** generation row — it does not create a child — so it reuses its own `source_id`, `brief`, and `manifest_snapshot`. It skips Step 1 when `brief` is populated, and skips the source stage when the **referenced `sources` row** has a non-null `raw_text` (plus, for `raw_text_origin = 'ocr'`, a non-null `transcript_confirmed_at`). Keying that predicate on the source row rather than on `generations.source_id` matters: a screenshot source is created by the wizard *before* the run is queued, so an FK-based test would be true from the first invocation and a retry would sail past an unfinished transcription into an empty brief. It then skips every section that already has a `generation_sections` row with `status = 'done'` and regenerates only the rest. Inngest step memoization is per-run and does not carry across, so the completed-section rows in Postgres are the resume state.

### Step 0 — Scrape (if URL provided)

`step.run('scrape')`. The `sources` row already exists — the wizard created it — so this step reads its `url`, runs the ladder, and writes back `blocks`, `raw_text`, `status`, and `scraped_at`. It skips entirely when `source_type` is not `'url'`. Connect to Browserless via CDP and extract **text only**:

- Navigate with `domcontentloaded`, then wait on a concrete content signal (h1 visible, or body text length over a threshold) with a hard cap of 10–15s. Do **not** use `networkidle` — Playwright's own docs discourage it, and advertorial landers keep the network permanently busy with pixels, chat widgets, and long-polling.
- Scroll to the bottom in steps with short settles, to fire lazy-loaded below-fold content. Testimonial blocks are routinely lazy-loaded and are exactly what the brief needs.
- Pin a fixed desktop viewport and UA (e.g. 1366×900) so density measurements are reproducible between scrapes.
- **Emit selector hints when the source is same-platform.** Verified against the eight real landers: LogicHub renders each page inside `<div class="tpl-{slug}">` — the literal manifest slug — with per-field class names (`adv-title`, `adv-summary`, `adv-content`, `adv-review-item > adv-review-name / adv-review-text`, `adv-sidebar-benefits`…; note `adv-disclaimers` is deliberately **not** hinted — no manifest has a disclaimer field). When that root class is present and its slug matches a known manifest, look each block's element up in the manifest's `selectors` map and attach a `selectorHint` to it.

  This is a **hint, not a mapping**. Step 0 still does no semantic structuring — no testimonial pairing, no spec extraction, no price parsing — and Step 1 still owns `blockMap`; the hint just means the model is confirming a near-certain answer instead of guessing. Keeping the class→field table in the manifest as data (`selectors?: Record<string, string>` mapping a CSS selector to `sectionId.fieldKey`) means a CMS markup change is a manifest edit rather than a code change, which is the same principle the rest of the manifest rests on. Absent the marker — the genuine-competitor case — blocks carry no hints and Step 1 works as it always does.
- Readability-style extraction into the **typed block array** defined under "One density substrate" — same shape the screenshot path produces — with nav/footer/script/hidden elements stripped.
- **Flatten inline elements** — `a`, `strong`, `em`, `span`, `b`, `i` — into the parent block's text; never emit one as its own block. This is load-bearing three ways, and it fails loudly on these pages if missed: the product name is an inline `<a …><strong>NAME</strong></a>` mid-paragraph (ten of them inside one field), so a block-per-anchor extractor produces "The current version of is nothing like traditional glasses". It also protects per-block word counts and keeps `raw_text` grammatical for lint 9 and the `allowedSpecs` guard. The same rule binds the paste and screenshot handlers.
- **Strip `<script>` before extracting, not after.** On this stack that is correctness, not tidiness: the Next.js RSC flight payload embeds a second, JSON-escaped copy of every heading, paragraph, testimonial and disclaimer — ~43 KB on one measured page. Miss it and every word count doubles, `instanceCount` doubles, and lint 9 compares output against a duplicated corpus.
- Also capture `<title>`, `og:title`, and `meta[name=description]` as leading blocks. They are real fields with real targets — one measured page has an 8-word SEO title quite distinct from its 17-word H1 — and body-only extraction would leave them silently on manifest fallbacks forever.
- Block order is **DOM order, which is not always visual order**: the sidebar `<aside>` follows `</main>`, so its blocks land after the comments even though a reader sees them at the top. Say so in the Step 1 prompt — a late run of blocks can legitimately map to an early `sectionId`. Store it as `sources.blocks` and its concatenation as `raw_text`. Word counts are derived by code from the blocks and are never written into the text.

Truncate block-wise per the substrate rule, and keep the gzipped original HTML in Storage so extraction bugs are debuggable.
- Close the browser in a `finally` — leaked sessions count against the Browserless concurrent-session cap.

**Step 0 does no structuring.** No testimonial pairing, no spec extraction, no price parsing. Landers are page-builder output with no schema.org, specs written in prose ("weighs just two ounces") or baked into images, and a dozen testimonial layouts; heuristics miss enough of it to break the anti-fabrication mechanism downstream. Step 1 is already an LLM structured-output pass over this content — the structuring belongs there.

Budget and retries: 15s navigation timeout inside a ~30–45s step budget, exactly one retry for transient errors (timeout, connection reset), and `NonRetriableError` for permanent ones (DNS failure, 4xx, detected bot challenge). Inngest retries a throwing step four times by default, which would otherwise cost four Browserless sessions before the fallback runs.

Anti-bot ladder, because competitor and affiliate landers are mostly bot-protected and often cloaked against non-human traffic. **Both rungs must speak the same protocol.** The stack commits to `playwright-core` over CDP, so both use CDP endpoints and `chromium.connectOverCDP()` — note that `/chromium/playwright` is the Playwright-native route (`chromium.connect()`, Playwright's own browser-server protocol), and one client cannot fall back between the two:

1. `wss://…/chromium?token=…`
2. `wss://…/chromium/stealth?token=…&proxy=residential&proxyCountry=us` — the purpose-hardened stealth browser plus residential proxy, metered in plan units per MB. (A `stealth=true` query param also exists on v2; the dedicated route is the choice here, not the only syntax.) One v2 behavior worth knowing while writing this: unknown query parameters return a 4xx rather than being ignored as in v1, so a stale flag surfaces as a hard connection error rather than a silently weakened session.
3. Give up and set `sources.status = 'blocked'`, distinct from `'failed'`. A blocked source tells the user a manual paste is the workaround; the wizard offers a **paste-the-source-text** field that creates a source with `status = 'manual'`, which rescues density matching entirely when scraping is impossible.

On any non-`ok` outcome **of a `source_type = 'url'` source**, continue without a source (notes-only) and write a `no_source` entry — or `source_blocked` when the ladder ended in `sources.status = 'blocked'` — to `generations.run_notes`. By the time a generation runs, paste and screenshot sources are already `manual` or `ok` — a screenshot source is `pending` only between upload and transcription, which happens before the generation row exists — so neither enters this branch.

**Re-scrape policy** (URL sources only): normalize the URL (strip `utm_*`, `gclid`, `fbclid`) before lookup. Reuse an existing source in the same project if `scraped_at` is fresher than 24h; otherwise scrape into a **new** source row — never overwrite, since old generations must keep pointing at the snapshot they were built from. The wizard has a "re-scrape now" checkbox. Section regeneration always reuses the parent generation's `source_id`. Paste and screenshot sources are never reused or re-run: a new upload is always a new `sources` row.

### Screenshot transcription — a separate Inngest function, before any generation

**URL is the normal path; this is the exception.** Most runs will supply a URL and go through Step 0's HTML scrape, which is cheaper, faster, and more accurate than reading pixels. Screenshots cover the cases scraping can't reach — a page behind a login, a bot-blocked lander, a design that only exists as a mockup, or a competitor page you have as an image and not a link.

When it *is* used, it must produce everything the scrape would have: the content, the layout, and the word counts. It transcribes into `raw_text` and feeds Step 1 exactly as scraped text does, so nothing downstream knows or cares which path the source came from. Because it is the rarer path, optimize it for correctness over cost — a slower, higher-resolution transcription is the right trade when the alternative is no source at all.

Two different artifact classes get uploaded here and they must not be confused:

| | Example | Purpose |
|---|---|---|
| **Rendered lander** | `advertorial-sample.png` | Source material — content, layout, density. This is the URL substitute. |
| **CMS admin page** | `advertorial.png` | Authoring a *manifest* — field names, labels, section order. Not source content. |

The pipeline described below is the first. Manifest authoring from a CMS screenshot uses the same transcription machinery but its output is read by a human writing a manifest JSON file, not fed to Step 1 — which is how Simple Page's manifest gets written, since that template has no screenshot in the repo.

**The real inputs are all over the hard limit.** Measured from the four rendered samples in `docs/lander-samples/`: 1862×8891, 1862×10811, 1862×13049, and 1862×18310 — every one exceeds the 8000 px per-side ceiling and would be rejected outright as a single image. Sliced at 1988 px with 100 px overlap they need 5, 6, 7 and 10 blocks respectively, all comfortably inside the 20-block limit, so each page transcribes in one request at roughly 24k–48k visual tokens. 

**This is not a step inside the generation run.** The transcript has to be confirmed by a human before generation starts, so it runs as its own function on `source.transcribe.requested { sourceId }`, fired by the wizard when the uploads land — before a `generations` row exists at all. It takes the same `concurrency` object as the other three functions and an idempotency key on `sourceId`. The generation pipeline is untouched: by the time `generation.requested` fires, `sources.raw_text` is already populated and Step 0 skips a non-URL source.

**Slicing is mandatory, not an optimization.** Anthropic rejects any image over 8000 px on a side outright, and three of the four CMS screenshots in this repo already exceed it — `reasons.png` at 1862×9259, `comparison.png` at 1862×11662, `Interstitial.png` at 1862×16760. Worse is what happens to the ones that *are* accepted: the API downscales to fit a visual-token budget, and **taller images get crushed harder**, so a full-page capture arrives as an unreadable smear. A 1366×4000 image reaches a standard-tier model at 535×1568 — 16 px body copy rendered at 6.3 px. There is no error and no warning; you get a fluent, confident, entirely invented transcript. A suspiciously *low* image token count is the symptom.

So the transcription step:

- **Runs on a high-resolution-tier model** (Opus 5 or Sonnet 5 — 2576 px / 4784 visual tokens), not on `claude-sonnet-4-6`, which is standard tier at 1568 px and is the weakest available option for exactly this job. This is a per-step model override, not a change to the pipeline default.
- **Slices tall captures to the maximal no-resize geometry** so the server downscales nothing: at native 1862 px width, 1988 px tall slices land just inside the high-res token cap. Overlap slices by ~100 px so no line of text is cut in half. Label each block `Image 1:`, `Image 2:` … in reading order, and **put images before text** in the message.
- **Keeps each request to ≤20 image blocks** — past 20, a stricter per-image rule applies and anything over 2000 px on a side is rejected with a "many-image requests" error. At 1988 px slices, `Interstitial.png` needs 9 blocks; a longer page needs batching across calls with the transcripts concatenated in order.

Order-of-magnitude cost: roughly $0.07–0.21 per full page on Opus 5, less on Sonnet 5.

**Transcription and structuring must be two separate calls, and this is load-bearing.** The anti-fabrication guard works by checking that every `origin: "source"` number literally appears in `raw_text`. That holds only because `raw_text` is mechanically extracted. If one call both transcribes and structures, a hallucinated "32% more absorption" lands in the transcript *and* in `allowedSpecs`, and the guard validates the fabrication against itself — it doesn't fail, it silently stops being a guard.

So: a minimal, tool-less call whose only job is verbatim extraction, instructed to transcribe rather than interpret and explicitly forbidden from inferring, completing, or rounding numbers.

**Its output is the typed block array** defined under "One density substrate", not flat text — because layout is half of what this path has to recover, and because every other source type produces the same shape. Emitting blocks is still transcription rather than interpretation: block type and reading order are visible facts about the page. What stays out of this call is any judgment about what the blocks *mean*, which is Step 1's `blockMap`.

The blocks go to `sources.blocks` and their concatenation to `raw_text`, with `raw_text_origin = 'ocr'`. Code counts the words. Then Step 1 and the guard run unchanged.

Because ground truth is machine-read on this path, the review screen shows the transcript with its `ocr` provenance and **requires the user to confirm it before generation proceeds**. This path only — a scraped or pasted source needs no confirmation.

**Treat the transcript as untrusted input, harder than scraped text.** Anthropic names "OCR text extracted from a user-uploaded image" as untrusted content, and the platform's screenshot injection classifier covers only the computer-use tool — a plain image block in `messages.create` gets none of it. Deliver it to Step 1 **in a `tool_result` block**, JSON-encoded so an attacker cannot close a delimiter and break into instruction context, with an untrusted-content policy in the system prompt. The envelope carries the **indexed block array**, not flat text, because `blockMap` keys on block position and a `text` string has none:

```json
{"source":"ocr_of_user_uploaded_screenshot",
 "blocks":[{"index":0,"type":"heading","text":"…"}, …]}
```

The scrape path wraps the identical indexed array in the same envelope with its own `source` value, so Step 1's input shape is one thing on every path. Screen it first with a cheap `claude-haiku-4-5` classifier returning a structured boolean, and branch in code. Note the limit of re-encoding: it destroys steganographic and adversarial-perturbation payloads and the OCR round-trip kills zero-width and bidi tricks, but **plainly rendered text survives untouched** — and that is the variant a hostile page would actually use. Do not put your own instructions inside the `tool_result`; the model may discount them as injected.

**Upload path.** Direct from the browser to Supabase Storage under RLS, then POST only the resulting object path. Uploading through a route handler is not an option: Vercel caps function request bodies at 4.5 MB and Server Actions at 1 MB by default, and the four real samples run 4.05–10.10 MB, the largest already exceeding that 4.5 MB cap outright. Private bucket, `allowedMimeTypes` restricted to PNG/JPEG/WebP — treat that list as a UX guardrail only, because Supabase validates the *client-declared* content type and never inspects bytes.

Set `fileSizeLimit` to **25 MB**, not 10: `comparison-sample.png` is already 10.10 MB and a 10 MB cap would reject a real, valid input on day one. 25 MB stays under the free tier's 50 MB ceiling with room for larger captures. Note this does *not* collide with Anthropic's 10 MB per-image limit, because the original is never sent — only the sliced derivatives are, and each slice is a fraction of that. Storage pressure is about concurrent uploads rather than cumulative volume, since originals are deleted as soon as the transcript lands. Display uses `createSignedUrl(path, 300)`; never `getPublicUrl` on a private bucket, which returns a valid-looking URL that just fails at fetch.

**Validate and re-encode in the worker before the model ever sees it**, with `sharp`: `limitInputPixels: 50_000_000` and `failOn: 'truncated'` (a 12 KB PNG can decode to 25000×25000 — pixel count, not file size, is what OOMs a serverless function; the largest real sample here is 34.1 MP, so 50 M leaves headroom without being the 268 M default), sniff the real format from `metadata().format` and reject anything that isn't PNG/JPEG/WebP, `.rotate()` to apply EXIF orientation before stripping metadata (a sideways image transcribes badly, and EXIF carries GPS). **Reject SVG at every layer** — Anthropic doesn't accept it, and Storage serving an SVG under its declared content type is stored XSS.

The Inngest event carries `{ sourceId }` and nothing else — never the image, never its base64, never a path. The worker selects `source_screenshots` ordered by `position` and reads `original_path` from each row, which is also what makes a multi-page source expressible at all. Event payloads cap at 256 KiB on the free tier, and a step's return value is persisted into run state and replayed on every later step, so download, re-encode, slice, transcribe, and return only the text — all inside one step.

The function's terminal write sets `raw_text`, `raw_text_origin = 'ocr'`, and `sources.status` to `'ok'`, or to `'failed'` when transcription permanently fails.

**One object lifecycle, stated once**, because three plausible readings of it would each break something. The wizard inserts each `source_screenshots` row with `original_path` set to what the browser uploaded. The worker validates and re-encodes it with `sharp`, writes the result as `derivative_path` with its dimensions, then deletes the original object and nulls `original_path`. The review screen signs `derivative_path` — never the original, which by then is gone. Retention matters because the free tier is 1 GB, roughly 400 full-page PNGs, with no automatic eviction; hitting the cap fails uploads.

### Step 1 — Analysis pass (one API call)

`step.run('brief')`. Input: `sources.blocks` (indexed, so the model can reference them by position) + special notes + project info + the manifest's section list. Structured output → the **brief**, written to `generations.brief` — never to the source row. A brief depends on this run's manifest section list and special notes, while a source is reused across runs for 24h, so parking it on `sources` would let two generations against one source overwrite each other. Step 1 reads `blocks` and never writes them. The code-built `sectionPlan` is persisted inside `generations.brief` alongside `blockMap`, which is how Step 3 and the review screen's word-count badges read it in later steps and later requests:

- Structure recovered from the source: `h1`, testimonials as name/body pairs, prices, and every numeric spec. **Not word counts** — those are code's job, from the blocks.
- Angle, awareness stage, primary claim, near-miss/problem-agitation narrative if present
- **`blockMap`** — the source→template mapping, and the only place Step 1 touches density:

  ```ts
  { blockMap: { [blockIndex: number]: { sectionId: string,
                                        instanceIndex?: number,   // repeating sections
                                        fieldKey: string,
                                        subunitIndex?: number,    // subunit fields
                                        part?: string } },        // e.g. heading|body|quote
    sections: [ { sectionId, present: boolean, formatNotes: string } ] }
  ```

  The model says which block belongs where; **it emits no numbers at all** — `instanceIndex` is an identifier, not a count. Code then builds the `sectionPlan` the validator consumes, per "One density substrate" above. A field no block maps to falls back to its manifest values — unless it is `optional`, which is simply absent.

  Where blocks carry a `selectorHint` (same-platform sources), the prompt instructs the model to adopt it unless it is plainly wrong, and to say so in `formatNotes` when it overrides one. Step 1 always runs regardless — `allowedSpecs`, the angle, and the upgrade plan come from nowhere else, and skipping it would empty the anti-fabrication guard.

- **`allowedSpecs[]`** — the ONLY numbers the generator may use:

  ```ts
  { label: string, value: number, unit: string | null,
    origin: "source" | "user_notes" | "conversion" }
  ```

  Matching in Step 3 is on normalized value + unit, not on raw strings. On the no-source path entries come from special notes and project info; with a genuinely empty list the generator is instructed to write number-free copy rather than letting the validator flag everything after the fact. If source specs contradict, use the conservative figure and write a `spec_conflict` note to `run_notes`.

  Step 1 also emits the **metric or imperial counterpart of every unit-bearing spec** with `origin: "conversion"` — the international-defaults rule mandates dual units (`57 g (2 oz)`), so the converted number must be a legal spec or every measurement in the output would be flagged as fabricated.
- **Upgrade plan**: where the source is vague → inject specificity; effort-framing headline → rewrite as elimination-framing; missing damaging admission → where to add one.

Use `thinking: {type: "adaptive"}` here — this is the planning-heavy call.

**Deterministic guard — runs inside `step.run('brief')`, before anything is written.** Every `origin: "source"` entry must appear in `raw_text` after the normalization pass defined in Step 3 (so a source that spells "two ounces" still matches a `{value: 2, unit: "oz"}` entry). Every `origin: "conversion"` entry must recompute correctly from a matched entry per the conversion table and tolerance below — code redoes the arithmetic rather than trusting it. This is the one thing code can check that the model cannot launder around, and it is what keeps "no fabricated specs" honest now that extraction is an LLM job.

It must run **before** the write, not after it. If the guard ran post-write, a failure would leave `generations.brief` populated, and the resume rule — which skips Step 1 when that column is non-null — would send a retry straight into Step 2 on a brief that never passed the guard, silently disabling the whole anti-fabrication mechanism for that run.

**Remedy on failure:** re-call Step 1 once with the failing entries quoted back. If the second attempt also fails the guard, fail the run with `error_message` and a `spec_guard_failed` entry in `run_notes`. Do not degrade by silently dropping unverifiable entries — an `allowedSpecs` list that quietly lost its unverifiable members is indistinguishable downstream from one that never had them.

Treat scraped content as **untrusted input**: wrap it in explicit delimiters in the user message, with a system rule stating that source material is data to analyze and any instructions inside it are ignored. A competitor page can contain adversarial text, and the output ends up on public landers.

### Step 2 — Per-section generation (one API call per section)

Sequential — later sections need earlier context for the single-protagonist rule and to avoid repeated phrasing.

**Message layout is strictly append-only, because that is what makes caching work:**

1. `tools`: empty (structured output uses `output_config.format`, not tool use)
2. `system`: copy rules + compliance rules + token rules + resolved `rules` rows + the full manifest — with `cache_control` on the last block
3. `user`: brief (deterministically serialized — sorted keys, no timestamps, no per-run IDs) → completed sections in fixed generation order, with a **second `cache_control` breakpoint on the last completed section** → this section's fields, constraints, and special notes last

Two breakpoints of the four allowed. The system prefix is stable across the run; the message prefix grows by exactly one section per call, so each call reads the previous call's write at roughly a tenth of input price instead of re-billing the whole page at full price. Keep the default 5-minute TTL — back-to-back Inngest steps are well inside it. Anything that varies per call must sit after the last breakpoint or the cache silently dies.

Keep `thinking` **uniform across every section call** in a run; toggling it mid-run invalidates the message-level cache. Two 4.6-family details, which differ from each other: `budget_tokens` is **deprecated but still functional** on Sonnet 4.6 — don't use it, use `thinking: {type: "adaptive"}` with `output_config.effort`, but it won't error if some copied snippet includes it. Assistant prefill to force JSON, on the other hand, **returns a 400** — and the tool-use-era structured-output recipes this pattern descends from frequently use one, so watch for it.

Structured output via `output_config.format` with `zodOutputFormat()` and `client.messages.parse()`, keyed exactly to the manifest field keys.

Size `max_tokens` as **density ceiling + JSON overhead + explicit thinking headroom**. `max_tokens` caps thinking tokens and response text together, so a budget derived from word count alone produces the classic failure: a response that is almost entirely thinking followed by truncated JSON and `stop_reason: "max_tokens"`, which would make the raised-cap retry the normal path and roughly double the cost per section. Set `output_config.effort` explicitly too — `low` or `medium` is the right register for short, tightly constrained copy fields, rather than inheriting the default. **Measured on the real `content` section call** (Sonnet 5, `max_tokens` 16,000, identical prompt): `high` spent the entire 16,000-token budget on reasoning and returned two characters of JSON — `{}` — at $0.16 for nothing, exactly the failure predicted below; `medium` produced 2,746 output tokens and 5,543 characters of on-target copy; `low` produced 1,568 and 4,529, still inside the word target. Inheriting the default is the real hazard, because it is not stable: the same call measured 2,673 output tokens in one run and 14,963 in another. Explicit effort is what makes per-section cost predictable. On `stop_reason: "max_tokens"` retry once with a raised cap; this is **not** a validation failure and must not consume the Step 3 retry budget. On `stop_reason: "refusal"` flag the section immediately without retrying.

Write each section into `generation_sections` as an upsert on `(generation_id, section_id)` so a step re-run overwrites rather than duplicating. Never allocate a version number inside a retryable step.

### Step 3 — Deterministic validation (code, not LLM), per section

Runs as plain code **inside** the section's step. It writes `generation_sections` and the step returns `{ sectionId, status, violations }` — never the copy itself. It must never throw on a validation failure: Inngest would retry the step identically, without the corrective feedback, fighting the retry loop below.

#### Normalization pass

One canonical pass, applied identically to generated output, `raw_text`, and `allowedSpecs` before any comparison. Applying it to only one side is what makes a spec check flag copy that faithfully reproduces its source.

**It produces a parallel comparison view; it never replaces the field value.** Only lints 7, 8, and 9 and the Step 1 `allowedSpecs` guard read the normalized view. Lints 1–6 read the **literal** field value the copy button will emit — otherwise "twenty-five percent" collapsing to "25%" would let a field pass a `charLimit` that the actual clipboard text blows past by fifteen characters, and word counts would shift wherever a multi-word number became one token.

- **Number words → digits** for an enumerated set: zero–twenty, the tens, hundred/thousand, and hyphenated compounds ("twenty-five" → 25). Ordinals ("first") and vague quantifiers ("a dozen", "a couple", "half", "thousands of", "hundreds of") are explicitly **out of scope** and are never treated as numbers — the real pages lean on those heavily.
- **Numeric decorations**, all observed on the live landers: strip a trailing `+` (`50,000+`) and a leading `~` (`~400`) while recording that the value was approximate; normalize U+2212 MINUS SIGN to `-` (`−6 to +3`); split en-dash and "X to Y" ranges into two values (`$1,500–$4,000+`, `$600 to $2,400`), since a range is two specs and matching it as one string fails. Times (`8am`, `5pm`, `00:00:00`) are not specs — exempt them the way years are exempt.
- **Unit words → canonical abbreviations** via a fixed table: `ounce(s)`→`oz`, `gram(s)`→`g`, `pound(s)`→`lb`, `second(s)`→`sec`, `minute(s)`→`min`, `hour(s)`→`h`, `percent`→`%`, `dollar(s)`→`$`, and so on. Without this, Step 0's own example — "weighs just two ounces" — normalizes to "2 oz" on one side and stays prose on the other.

- **Thousands separators are stripped**, so `1,284` is a 4-digit integer. Both digit-length rules honor this — lint 8's year exemption because it reads the normalized view anyway, and the token lint's year rule because its 4-digit detection must tolerate separators even though it otherwise reads the literal value. Otherwise `1,950 happy customers` slips through both: exempted as a year by one, invisible to the other.

The canonical unit list is abbreviations post-normalization: `g kg mg oz lb ml l cl cm mm m in ft mAh Wh W diopter h hr min sec day(s) % $ € £`, plus the multi-word `fl oz`, `sq ft`, and `sq m`, which tokenize the same way. Units frequently abut the digit with no space on real pages — `18W`, `6000mAh` — so tokenize on the boundary, not on whitespace.

**Area is not exempt — it gets dual units like everything else.** These products sell outside the US, so "up to 4,000 sq ft" alone is unreadable to most of the market; it must render as `372 m² (4,000 sq ft)`. The earlier temptation is to exempt area because the conversion table lacked a pair — the correct fix is to add the pair. The **imperial subset** lint 7 keys on is `oz`, `fl oz`, `lb`, `in`, `ft`, and `sq ft`.

**Area units have one canonical form and several input spellings.** Copy *renders* `m²` because that is what a reader expects; normalization folds `m²`, `sq m`, `square metre(s)`, `square meter(s)` to the canonical `sq m`, and `ft²`, `sqft`, `square foot`, `square feet` to `sq ft`. Both sides of every comparison therefore land on the same token, so the mandated `372 m² (4,000 sq ft)` matches its own conversion pair instead of failing lint 7 on a spelling mismatch.

**Three of these are also ordinary English words** — `in`, `m`, `l` — and the collision is not hypothetical: "1 in 3 customers" is stock advertorial phrasing, and a naive matcher reads it as the number 1 bearing the imperial unit `in`, which trips lint 7 (demanding a metric counterpart) and voids lint 8's rhetorical exemption for the `1`, flagging legitimate copy twice over. Rule: a word-ambiguous abbreviation counts as a unit **only** when what follows it is not another word or digit — so `2 in` before a comma or clause end is a measurement, `1 in 3` is not. Inch values should normalize from `inch`/`inches`/`in.`/`"` where possible so the bare form is the rare case.

**Conversion table** — the only pairs Step 1 emits counterparts for, with fixed factors so the validator's recomputation is reproducible:

| Pair | Factor |
|---|---|
| oz ↔ g (avoirdupois) | 1 oz = 28.349523125 g |
| lb ↔ kg | 1 lb = 0.45359237 kg |
| in ↔ cm | 1 in = 2.54 cm |
| ft ↔ m | 1 ft = 0.3048 m |
| fl oz ↔ ml (**US** fluid ounce) | 1 fl oz = 29.5735295625 ml |
| sq ft ↔ sq m | 1 sq ft = 0.09290304 sq m |

US fluid ounces, stated explicitly: the imperial fl oz would make the plan's own `130 ml / 4.4 fl oz` example wrong (it computes to 4.575).

**Tolerance:** a converted number is correct if recomputing it from its counterpart and rounding to the printed precision yields the printed value. That is the rule that makes both mandated examples pass — 2 oz → 56.699 g rounds to `57 g` at zero decimals, and 130 ml → 4.396 fl oz rounds to `4.4` at one decimal — where a naive relative tolerance under about 1% would fail the first one.

#### Lint categories

1. **Word count** must fall inside `sectionPlan[].fields[key].wordTarget`, falling back to `fallbackWordTarget`. Both are ranges with tolerance already baked in — do not add a further margin. `charLimit` always applies. Scaffolded fields count `copy` slots only. A field with subunits has each part additionally checked against its own range, falling back to `fallbackSubunits.parts`.
2. **Item counts** vs `sectionPlan[].instanceCount` for repeating sections, `fields[key].itemCount` for lists, and `fields[key].subunitCount` for subunit fields — falling back to the `repeat` minimum, `fallbackItemCount`, and `fallbackSubunits.count` respectively.
3. **Bold rules**: max one `**…**` per sentence; punctuation outside bold. This applies to **every** field including `markdownBold: false` ones — see below for why bold markers are expected there rather than banned.
4. **Token lint** — see the rules under "Allowed tokens" below.
5. **Link lint**: read the field's `linkPolicy` and check the links against exactly that policy — there is no global permitted-target set. No bare URLs anywhere, in any field. This doubles as the injection guard.
6. **Scaffold lint**: for `scaffolded` fields, `variant` must be a key of `lineTemplates`; `copy` must contain no newlines, and no braces other than permitted tokens, which are validated exactly as in any other field. The markup itself needs no checking — code assembles it.
7. **Compliance lint**: banned-pattern list (absolute efficacy claims — "eliminates", "guaranteed to stop/cure", "100% effective"); US-state testimonial locations; fabricated scarcity ("only N left"). Two sub-rules need mechanical definitions, since this lint is code:
   - **Dual units.** Every number bearing a unit from the imperial subset must be preceded, *within the same sentence*, by a number bearing its metric counterpart from the conversion table. `57 g (2 oz)` passes; a bare `2 oz`, or a `57 g` two sentences away, does not.
   - **"Clinically proven"** is flagged unless the phrase occurs verbatim in normalized `raw_text`. The original rule said "without source support," which asks code to make a judgment it cannot make; source-support nuance beyond this belongs in the prompt-side compliance rules, not here.
8. **Spec check.** **Every number in the output must resolve against `allowedSpecs[]` unless an exemption applies.** That sentence is the algorithm; the bullets below only enumerate the exemptions and clarify how matching works. Exemptions are evaluated first — which the old "counts under 10 in rhetorical use" wording could not express:

   *Exemptions:*
   - A bare integer 1–9 **not** adjacent to a unit or currency token (rhetorical: "3 simple steps").
   - A 4-digit integer in 1900–2100 not adjacent to a unit token — treated as a year. Exempt from the spec check, but see the token lint: a hardcoded year is a *token* violation unless it came from `allowedSpecs`.
   - A percentage immediately bound to `{{discountValue}}`.
   - Any field whose manifest entry sets **`specPolicy: "exempt"`**. This exists because of a case the other exemptions miss entirely: comment and review timestamps read "11 hours ago", "15 hours ago", "2 days ago" — unit-bearing integers of 10 or more, so they demand an `allowedSpecs` match that a generated timestamp can never have. Without the flag the comments section fails, consumes both retries, and is flagged on **every** generation. Set it on timestamp fields, and only there.

   *Everything else requires a match*, including a bare integer of 10 or more with no unit — a review count like "487 verified reviews" is exactly the kind of number this system exists to stop being invented. Matching is on normalized value + unit. A number also matches if it is a **correct unit conversion** of a matched entry per the table and tolerance above, which is what makes the mandated dual-unit format legal.

9. **Verbatim-overlap check** (skipped when there is no source): flag any run of ≥12 consecutive words shared with `raw_text` after whitespace and case normalization. This is the deterministic guard behind the risk note — output is transformative rewriting, never lifted copy. **Exclude `disclaimer` blocks from the comparison corpus**, since the tool never generates footer content and roughly 15–19% of a scraped page is platform-global boilerplate that would otherwise dominate the overlap signal.

**On failure**: retry that section with the specific violations quoted back as corrective feedback, as a **new step** — `step.run('generate-{sectionId}-attempt-{n}')` — so step IDs stay deterministic across replay. Max 2 corrective retries, then mark the section `flagged` with its violation list and continue. Never silently accept a failing section. This counter is separate from transport retries and from the `max_tokens` retry.

Violations are stored keyed by the field address defined in "Output shape" — `sectionId.fieldKey`, or `sectionId[index].fieldKey` inside a repeating section — each carrying lint category, message, and offending excerpt. The review screen derives inline flags and badge colors from this.

### Step 4 — Finalize

Status → `done`. Roll `generation_steps` costs up into `total_cost_usd` and finalize `run_notes`.

### Error layering

Three retry mechanisms exist and their relationship must stay explicit:

| Layer | Handles | Config |
|---|---|---|
| Anthropic SDK | 429, 529, 5xx, connection errors | explicit `maxRetries`; catch typed errors, never string-match |
| Inngest step | anything thrown out of a step | default retries; `NonRetriableError` for 400s, missing rows, malformed manifests, permanent scrape failures |
| Step 3 loop | copy-rule violations | max 2, in-band, never throws |

Cache interaction worth knowing: the ephemeral cache TTL is 5 minutes, refreshed on each hit, with writes at 1.25× and reads at ~0.1×. A long retry backoff exceeds the TTL and silently converts every read back into a write, so don't set generous backoffs on the section steps.

**Spend guard:** a hard per-generation ceiling on total API calls, checked before each call; exceeding it fails the run with `error_message = 'budget exceeded'` and a `budget_exceeded` entry in `run_notes` recording the call count and cost at the cutoff.

## The rules (embed these verbatim in the cached system prompt)

### Allowed tokens

Authoritative list, mirrored from `tokens.txt`. **Exact, case-sensitive matches only** — note that content tokens are camelCase while the four legal URLs are snake_case, which a model will try to normalize. Any `{{…}}` not on this list is a violation.

| Category | Tokens |
|---|---|
| Tracking | `{{clickURL}}` |
| Content | `{{productName}}` `{{discountValue}}` `{{priceRegular}}` `{{priceDiscounted}}` `{{guaranteeDays}}` |
| Date | `{{currentDate}}` `{{currentYear}}` |
| Visitor | `{{visitorCountryCode}}` |
| Legal | `{{terms_url}}` `{{privacy_url}}` `{{contact_url}}` `{{impressum_url}}` |
| Conditional | `{{if:country=XX}}` `{{elif:country=XX}}` `{{else}}` `{{endif}}` |

The two `country=XX` rows are **patterns, not literals** — `XX` stands for a country code. The lint matches them as `\{\{if:country=([A-Z]{2})\}\}` and `\{\{elif:country=([A-Z]{2})\}\}`, and a literal `XX` in output is itself a violation. Treating the whole table as an exact-match set would flag every real conditional (`{{if:country=DE}}` isn't in the set) while passing the placeholder.

Token lint rules:

- Only tokens from this list; flag any unknown `{{…}}`, and flag any case variant (`{{clickurl}}`, `{{TermsUrl}}`) as unknown rather than silently accepting it.
- **Default token scope per field:** every category except **legal**, and no manifest field opts in, because no CMS field carries legal links. Narrow further with `allowedTokens` where it helps — `{{clickURL}}` out of testimonials, for instance. Do **not** narrow the *content* category on testimonial or comment fields: the live pages put `{{discountValue}}` inside user comments. `allowedTokens` intersects with `linkPolicy` and `productNameFormat`; it never overrides them, and a manifest whose whitelist excludes a token its policy requires is rejected at validation time.
- `productNameFormat` enforcement, spelled out: `bold` — every `{{productName}}` wrapped in `**…**`; `plain` — every occurrence bare of `**`, regardless of `markdownBold`; `none` — the token must not appear in the field. Linking is not this lint's concern; lint 5 owns it.
- `{{discountValue}}` must be followed by a hardcoded `%`.
- No hardcoded prices, discount figures, or guarantee durations — must use tokens.
- **No hardcoded years** — a 4-digit integer in 1900–2100 must be `{{currentYear}}` unless the value is in `allowedSpecs` (a founding year quoted from the source is legitimate). The spec check exempts years; this is where they are actually policed. Calendar dates are **unconditionally** banned in favor of `{{currentDate}}` — `allowedSpecs` entries are `{value, unit}` and cannot represent a date, so there is no legitimate exception. Detection is a month-name list plus common numeric date patterns; anything subtler is left to the prompt rules.
- Guarantee phrasing: the number must be `{{guaranteeDays}}`, and the wording is matched **case-insensitively accepting both "money back" and "money-back"** — production renders "90-Day Money Back Guarantee", which a literal-string check would reject.
- **The literal product name must never appear outside `{{productName}}`** — matched case-insensitively against `projects.product_name` *and every entry of* `projects.product_name_aliases` (spaced, unspaced, and domain forms). This is the single most likely token mistake and it is trivially checkable, but only against the alias list: one real page renders "Pest Pulse Pro Solar" in the body and "PestPulsePro Solar" in its title, and a single-column check catches just one of them.
- `{{visitorCountryCode}}` renders a bare code like `DE`. It is for conditional logic, not prose — flag it appearing in running text.
- **Legal-URL tokens are out of scope for every generated field** — flag any occurrence. They belong to the attached Disclaimers resource, which this tool never writes.
- Conditional blocks must be **balanced, correctly ordered, and contained within a single field value**: every `{{if:country=…}}` has a matching `{{endif}}` in the same field; `{{elif}}` and `{{else}}` appear only between them; `{{else}}` at most once and last. No nesting. A block opened in one field and closed in another is undecidable, so it is a violation in both.
- The captured code must be a real ISO 3166-1 alpha-2 value, uppercase.

### Copy craft

- Headlines carry benefit WITH stakes/tension. Elimination-framing beats effort-framing ("Never Scrub Your Grill By Hand Again" > "Powers Through Burnt-On Grill Grime"). **Length comes from the source density target, not a fixed word cap** — the measured advertorial H1 runs 13–18 words across the rendered landers, so any global "≤8 words" rule would contradict the template it is meant to describe. Where a field genuinely has a tight cap (CTA buttons, mobile CTA), express it as that field's `charLimit`.
- Specificity beats vagueness ("in under 10 seconds", not "in seconds"). Reason-why copy throughout.
- **Skim test**: a reader who reads ONLY the bold text must get the complete sales argument.
- Bold only mechanism reveals, hard USPs (specs), and payoff imagery — never connective tissue.
- Damaging admissions are a conversion technique, not a hedge (frame a limitation as a helpful usage instruction).
- Preserve or inject a near-miss / problem-agitation narrative (3–4 sentences, one protagonist per story, anonymous third-person if the layout has no named narrator).
- Testimonials: generic full names, varied use cases, 1–2 in desperation/last-resort framing. Editorially elevate source testimonials; never invent specifics the source doesn't support.
- Authority quotes: generically-titled expert personas ("Certified Running Coach") — never credential-specific titles ("FEMA-Certified").
- "Meet the product" sections use brand "we" voice; everything else is direct second-person "you/your".
- Guarantee framed as active risk reversal ("try it free for {{guaranteeDays}} days"), not legal boilerplate.

### Compliance hard lines (refusal points, not softening targets)

- No absolute efficacy claims, pseudo-scientific mechanisms, or disease-scare hooks
- No fabricated specs — every number must come from `allowedSpecs[]`
- No fabricated testimonials or manufactured social proof
- Safety-adjacent angles: imply the danger of the problem; never claim the product prevents accidents/injury
- Qualified language is the standard: "helps," "designed to," "up to"
- Source testimonials are **unverified claims** and get the same compliance lint as generated copy — elevating a fabricated upstream testimonial inherits its problem

### International defaults (all pages are global)

- Metric-first dual units, **including area**: `57 g (2 oz)`, `130 ml / 4.4 fl oz`, `372 m² (4,000 sq ft)`. These products are sold well beyond the US; an imperial-only figure is unreadable to most of the audience, so there is no exempt unit class.
- No US-centric seasonal references, no US-state testimonial locations, no US-only shipping language
- Testimonial locations: country-level, internationally spread
- Impressum belongs to the attached Disclaimers resource, not to generated copy. Where a country-conditional *is* generated, `{{if:country=DE}}…{{endif}}` is the shape.

## Cost controls

Four levers, exposed as data rather than constants so tuning them is a form submission
rather than a deploy. The fourth — reasoning effort — was added after the first complete
run, because it turned out to dominate the other three: output tokens were 88% of that
run's cost ($0.571 of $0.641), against $0.030 for every cached input token in it.

### Measured, not estimated

Numbers below come from real runs against a real lander, not from arithmetic. The
published estimate before any run was ~$0.24 a page; the first actual run cost more
than that on a single section, for reasons none of which were visible in review.

| What | Measured |
|---|---|
| System block (rules + advertorial manifest) | 3,876 tokens on Sonnet 5, 2,569 on Haiku 4.5 |
| Cache read on the first section call | 3,871 tokens — the design works |
| First section's uncached input, source-after-brief | 11,696 tokens |
| First section's uncached input, source-first | 4,173 tokens (**−64%**) |
| The brief call, previously unlogged entirely | $0.083 |
| One section that exhausted its retries | $0.37 across three attempts |
| One `fast`-tier section (cache write, no read) | $0.0143, against $0.0031 for the standard tier |

Four runs of the same page, same source, same manifest:

| Run | Change | Cost | Sections clean |
|---|---|---|---|
| 1 | as designed | — | **never finished** — a lint threw and the run wedged permanently |
| 2 | crash contained, brief logged, source-first prefix | $0.6408 | 2 / 5 |
| 3 | + explicit output contract | $0.5369 | 4 / 5 |
| 4 | + `effort: medium` | **$0.2550** | 3 / 5 |

Run 4 is 60% cheaper than run 2 and lands about where the original per-page estimate
sat. It is not a free win: at `medium` the model undershoots a long prose target (637
words against 757–925) where run 3 hit it, and one more section came back flagged. That
is precisely why effort is a setting rather than a constant — the right point on that
curve is a judgment about this template, discoverable only by running it.

Four lessons worth keeping:

**A validator that throws is worse than one that is wrong.** The first run never
finished: a lint dereferenced a key the model had not supplied, and because validation
runs outside `step.run` the exception became a 500. Inngest retried, replayed the
memoized steps and threw again, forever, on copy that had already been paid for. The
"never throws" rule was in a comment and nowhere else.



**The cache is an ordering property, not a setting.** Caching matches on exact prefix,
so a single block that differs early makes everything after it uncacheable no matter
how stable that content is. `<brief>` differs between the brief call and the section
calls; putting the identical source material after it cost 11,696 tokens on the first
section alone. The ordering rule is now asserted in `tests/prompt.test.ts`, because it
produces no error when broken — only a bill.

**Tiering is a quality decision, not a cost one — and the first read of the data was
wrong.** On the same section: the fast model cost $0.0207 over three attempts and was
flagged every time, returning assembled HTML for a scaffolded field instead of the copy
slots; the standard model cost $0.0442 over two attempts and came back clean. The fast
tier was about twice as cheap and worth nothing. Output tokens dominate a call's cost,
and the fast model is both cheaper per token and much terser, so the cache effects are
second-order — real, but not the headline. They are worth knowing anyway: the prompt
cache is keyed per model, so an interleaved fast section pays a full cache write where a
standard section pays a read ($0.0146 against $0.0030 for the same prefix) and then
breaks the standard model's chain for the following call, and Haiku needs 4,096 tokens
before a breakpoint does anything at all.

**Retry burn is a feedback-quality problem, not a model problem.** The section that
spent $0.37 failed on the same violation three times because the message described the
wrong defect — it reported a missing metric counterpart on text that already had one,
just in the wrong order. Two other violations quoted fragments (`1, wh`, `3 w`) that
came from a number-extraction bug, not from the copy. Unactionable feedback does not
merely fail to fix a problem; it buys the identical failure again at full price.

### Where the settings live

A single-row `settings` table, admin-only, read on every run:

| Setting | Default | What it does |
|---|---|---|
| `max_calls_per_run` | 60 | Hard ceiling on API calls in one generation. The backstop against a validation loop that never converges. |
| `standard_model` | `claude-sonnet-5` | Model for prose-heavy sections. |
| `fast_model` | `claude-haiku-4-5` | Model for short, tightly constrained sections. **Unused by default** — it could not satisfy the scaffolded-field contract; see *Tiering is a quality decision*. |
| `effort` | `medium` | Reasoning effort. **The largest lever** — output tokens were 88% of the first complete run's cost, and the same call measured 2,414 output tokens on one attempt and 11,128 on the next while the default was inherited. Ignored for models that do not support it. |
| `monthly_budget_usd` | null | Advisory. Surfaced on the cost screen; does not block. |

A single row is enforced with `check (id = 1)` rather than left to convention, because a
second row would silently shadow the first depending on read order.

### Manifests choose a tier, settings choose the model

`TemplateSection` gains `tier?: "standard" | "fast"`, defaulting to `standard`.

The indirection is deliberate. A manifest says *this section is cheap to write*; the
settings say *which model is currently the cheap one*. Swapping in a newer fast model is
then one settings change rather than an edit to every manifest — and manifests stay
descriptions of the content rather than of the vendor's model line-up.

Tier is per **section**, not per field, because a model is chosen per API call and a call
generates a whole section. In practice this lines up: the CTA section is entirely short
strings, the Content section is a thousand words of prose.

**Cache interaction, worth knowing before tuning.** The prompt cache is keyed per model,
so mixing tiers within a run means each model maintains its own cached prefix and each
pays one cache write for the system prompt. Interleaving also means a section's cached
message prefix is shorter than it would be in a single-model run. Neither is severe, but
it does mean the saving from moving a section to `fast` is smaller than the raw price
difference suggests. Measure it on the cost screen rather than assuming.

### The cost screen

`/costs`, readable by anyone who can read a generation. This is what makes the other two
levers actionable — without it, tuning is guesswork.

It shows:

- **Month to date**, against `monthly_budget_usd` if one is set.
- **Cost per generation**, most recent first, so an outlier is obvious.
- **Cache hit rate**, as the share of calls after the first in each run with
  `cache_read_input_tokens > 0`. A number well under 100% means something varying has
  crept into the prefix, and the plan's caching design has quietly stopped working —
  which costs several times more and is otherwise invisible.
- **Retry burn**: sections whose `attempt` regularly exceeds 0. A section that always
  needs two corrective passes is a prompt or manifest problem, and fixing it is worth
  more than any model swap.
- **Spend by model**, so the effect of a tier change is visible rather than inferred.

### Order of operations when costs look high

1. Check the cache hit rate first. A broken cache costs more than any other lever saves.
2. Then retry burn. A section failing validation every run is paying triple.
3. Only then move sections to `fast`, and confirm on this screen that it helped.

## Frontend (7 screens)

### The auth surface — sign in (`/login`) and admin (`/admin`)

`/login` is one "Continue with Google" button calling `signInWithOAuth({ provider: 'google', options: { redirectTo } })`. No other method is offered because no other method is enabled. Rejected sign-ins — anyone not on the allowlist — land on `/auth/auth-code-error` with a plain "this account isn't authorized" message and no retry affordance; the copy should not imply that trying again will help.

Middleware refreshes the session and redirects unauthenticated requests to `/login`. Its matcher **must exclude all of `/api/`** — Inngest's callbacks carry no session and would be redirected, silently killing the pipeline in production, and the same trap catches any future `Bearer`-token client. Route handlers authenticate themselves with `getClaims()` and return JSON rather than redirecting. Also exclude `/auth/*` and static assets.

`/admin` is `admin`-only and does the user management the allowlist implies: list allowed emails with the role each will get, add an address, change someone's role, and a single **Remove access** action that performs all three off-boarding writes together — allowlist row, `user_roles` row, and the `auth.users` row or session kill. Splitting those into separate buttons is how a removed user keeps working access, so they are deliberately one action.

Route protection is defense in depth, not the control: middleware redirects, server actions re-check with `getClaims()`, and RLS denies independently. The role read in React only hides affordances — the JWT is decoded client-side and fully under the user's control, so no mutation may trust it.

### 1. New generation wizard (`/new`)

Template picker (5 templates from `templates.png`) → project select-or-create → **one of three source inputs**: a URL (with a "re-scrape now" checkbox), pasted source text, or uploaded screenshots (multiple, drag-to-reorder, since reading order is what the transcript follows) → special notes textarea → Generate. All three are optional; with none, generation runs from notes alone.

Screenshots upload direct to Storage as they're selected, with a client-side size check for instant feedback only — the bucket's server-side limit is the actual control. On the screenshot path the wizard creates the source, fires `source.transcribe.requested`, and routes to the confirmation screen; **Generate stays disabled until `sources.transcript_confirmed_at` is set.**

A **server action** verifies the session with `getClaims()` and rejects anyone who isn't `admin` or `editor`, validates the payload with Zod, inserts the `generations` row as `queued` with `owner_id` set to the caller, sends `generation.requested`, then redirects. The row must exist before the event fires, since the event carries only the generation id.

**`version_num` and `manifest_snapshot` are assigned by a `before insert` trigger on `generations`, not by the caller.** It always sets `version_num = coalesce(max(version_num), 0) + 1` for the project, and it **branches on `parent_id`** for the snapshot:

- `parent_id is null` (a fresh run) — copy `manifest_snapshot` from `templates.manifest` for the referenced `template_id`.
- `parent_id is not null` (a regenerate clone) — copy `manifest_snapshot` **and `source_id` from the parent row**, never from the live template.

The branch is not optional. A clone stamped with the current template would be judged and rendered against a manifest its copied-over sections were never written for the moment anyone edits that template — precisely the failure the snapshot mechanism exists to prevent, and one nothing would surface. Either way the caller's value is ignored. The server action retries once on a `23505` unique violation.

Both have to live in the database rather than in application code. Projects are shared, so two editors generating into the same project would otherwise read the same max and the second insert would surface a raw duplicate-key error. And `manifest_snapshot` decides which rules a run is judged against — if the client supplies it, an editor picks their own grading criteria, and no policy or constraint would notice. Putting both in a trigger is also what lets a future mobile client insert the row directly under RLS without reintroducing either hole. The same trigger handles the regenerate clone's increment. The button disables on submit.

### 1b. Transcript confirmation (`/sources/[id]/transcript`)

Only on the screenshot path, and it creates no generation — it gates one. Shows the transcript beside the signed `derivative_path` images in reading order, with the `ocr` provenance stated plainly and any classifier flag surfaced.

**Edit blocks, not flat text** — one field per block, with its type shown and changeable. A plain-text editor would desync the two artifacts the moment anyone fixed a word: `raw_text` would no longer be the concatenation of `blocks`, and the word counts code derives would still come from the uncorrected version. That failure is silent and lands directly on density. Saving re-derives `raw_text` and the per-block counts from the edited blocks, so the invariant holds by construction.

Saving and confirming are both direct RLS writes through a column-scoped grant on `sources` covering `blocks`, `raw_text`, `raw_text_truncated`, and `transcript_confirmed_at` — no endpoint. Confirming returns to the wizard with Generate enabled.

A corrected transcript is still valid ground truth for the `allowedSpecs` guard, because the guard runs in Step 1, after confirmation — the operator is fixing what the page said, not choosing which numbers are permitted. That is the whole point of the gate: the machine-read baseline the anti-fabrication mechanism depends on gets a human look before anything is generated from it.

### 2. Generation / review screen (`/generations/[id]`)

- Renders sections **from `manifest_snapshot`**, in CMS order, mirroring the screenshots' section labels — so copying into LogicHub is a top-to-bottom walk. `display` fields render as position markers with their intended setting, so toggles and image slots don't desynchronize the walk.
- RSC fetches the initial state (`params` is async in Next 15) and hands it to a client component that subscribes to **both** `generation_sections` (section progress) and `generations` filtered to this id (status, `error_message`, `run_notes`, cost), refetching on event rather than reading the payload.
- A **run notes panel** above the sections renders `run_notes` — source blocked or absent, density divergences, spec conflicts — so run-level findings are visible rather than buried.
- Per field: the copy with bold **rendered** (never shown as raw asterisks), a word-count badge (green in range / red out, against the brief's target), validation flags inline from `violations`, and a **Copy button that respects `markdownBold`** — on `markdownBold: false` fields it strips `**` before writing to the clipboard, so the operator pastes clean text and re-applies bold with the CMS toolbar using the rendered version on screen as the guide. Markdown links survive the strip. Scaffolded fields copy with their assembled markup intact.
- Per section: "Regenerate section" with an optional feedback textarea.
- Flagged sections visibly marked with the violation list.
- **Failed runs** show which step failed, the `error_message`, and a "Retry run" button that fires `generation.retry.requested { generationId, attempt }` — a distinct event with its own idempotency key, because re-firing the original event would be deduplicated for 24h. The handler re-claims the `failed` row and regenerates only the sections that aren't already `done`.
- Run cost and cache-hit rate displayed from `generation_steps`.

### 4. Costs (`/costs`)

Month-to-date spend, per-generation cost, cache hit rate, retry burn, and spend by
model. Admins additionally get the settings form described under "Cost controls".

### 3. Version history (`/projects/[id]`)

Generation list with version chain. Diff view between any two versions (per-field, word-level diff), matching repeated-section instances by index and rendering adds/removes as whole-item changes. Changed/unchanged badge per section so it's obvious what to re-paste into the CMS.

### Versioning model

One model, stated once:

- A **full run** creates a root generation with `version_num = max + 1` for the project.
- **Regenerating a section** clones the parent into a **new** `generations` row (`parent_id` → parent, `version_num` incremented atomically as above), copies every untouched section's `generation_sections` row, and fires `generation.section.requested { generationId, sectionId, feedback }`. Its handler runs only Steps 2–3 for that one section, reusing the parent's `source_id` and `manifest_snapshot`. The clone's `owner_id` is the **requesting user**, not the parent's owner — an editor regenerating a colleague's run owns the new version. The section copy is done by the worker under the secret key, since `generation_sections` has no client write path.
- Nothing is ever mutated in place. The diff view compares two rows.

## Phases + acceptance criteria

**Status at a glance.** This section is the single source of truth for what is built.
Update the marker when a phase lands; the CHANGELOG records the detail.

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation + Advertorial V1 end-to-end | **Shipped** (`v0.1.0`) |
| 2 | Scraping + density matching | Not started |
| 2.5 | Screenshot upload + transcription | Not started |
| 3 | Validation loop | **Validators shipped and exercised live**, corrective-loop fixtures outstanding |
| 4 | Remaining manifests | Not started |
| 5 | Versioning + diffs | Schema ready, UI not started |

**Phase 1 is fully verified.** The cache-hit criterion held against a live key: the
first section call of a real run read 3,871 tokens from cache, matching the measured
system-block size, and a later call read 15,501. The signup rejection turned out not to
need a Google client at all — it needed the auth hooks switched on in
`supabase/config.toml`, which they were not, so locally every JWT had shipped
`user_role: null` and the allowlist had never run. With them enabled, an unlisted
address is refused with 403 and no `auth.users` row is created, and an allowlisted one
carries `user_role: "admin"` in its token. Both asserted on values, not presence.

Phase 3 is further along than "validators shipped" implied. The nine lints are covered by
127 unit tests, and the corrective loop has now been exercised against live model output
rather than fixtures — which is how three of them were found to be reporting the wrong
thing. A section that fails now fails on real copy faults (verbatim lifting, a hardcoded
date, an item-count miss) and is flagged with actionable text, which is the intended end
state. What remains is a seeded bad-output fixture so the loop is regression-tested
without spending an API call.


### Phase 1 — Foundation + Advertorial V1 end-to-end · **Shipped**

- Supabase schema migrated with RLS on every table and `anon` grants revoked; Google OAuth wired with email/password and magic links disabled; the before-user-created and custom-access-token hooks installed; repo-based manifests + seed script
- **Author the Advertorial V1 manifest from `advertorial.png`**: every field key, label, type, `markdownBold`, `productNameFormat`, `linkPolicy`, `voice`, `lineTemplates` where the CMS field carries markup, and `display` entries for the toggles/images so the review screen mirrors the page. **Field inventory comes from the CMS capture; fallback word counts come from the "Measured fallbacks" list** (taken from the rendered landers), never from the capture's visible example content — rich-text fields there are internally scrolled, so what you can see is a floor rather than the field's length. Fallbacks apply on the no-source path only.
- Wizard (no URL yet) → Inngest generation (brief from notes only + per-section calls) → review screen with streaming + copy buttons
- ✅ Accept: pick Advertorial V1, enter product notes, get a full page with valid tokens, copy any field with correct bold handling
- ✅ Accept: `cache_read_input_tokens > 0` on calls 2..N of a run, visible in `generation_steps`. A zero means a silent cache invalidator and the caching design is not working.
- ✅ Accept, auth: a Google account **not** on the allowlist is rejected at signup and never gets an `auth.users` row; an allowlisted account signs in and its JWT carries `user_role` equal to the role its `allowed_emails` row specified (assert the value — a null claim means the access-token hook is missing its grants); a `viewer` is denied a generation by RLS even when the request is forged past the UI and even on a row they own; `/api/inngest` is reachable without a session while every app route is not
- ✅ Accept, off-boarding: **Remove access** on `/admin` revokes the allowlist row, the role, and the account together, and the removed user cannot sign in again

### Phase 2 — Scraping + density matching · Not started

- Browserless scrape step emitting the typed block array, Step 1 `blockMap` + the code-built `sectionPlan`, `allowedSpecs` with the appears-in-`raw_text` guard
- ✅ Accept: given a live lander URL, output matches source section density ±10% and uses only source-derived numbers
- ✅ Accept: a Cloudflare-protected URL degrades to `status = 'blocked'` and the paste-source fallback produces an equivalent run
- ✅ Accept: simulated Browserless outage mid-run completes source-less, with a `no_source` entry in `run_notes` rendered on the review screen

### Phase 2.5 — Screenshot upload + transcription · Not started

- Private Storage bucket with policies, direct-to-storage upload, `sharp` validation and re-encode, slicing, the tool-less block-transcription call on a high-res-tier model, code-side word counting, transcript confirmation UI
- ✅ Accept: all four `*-sample.png` files (8891–18310 px tall, up to 10.1 MB — every one over the 8000 px hard limit) upload, slice, and transcribe end to end in a single request each; no transcript is truncated and block order matches the page
- ✅ Accept: `comparison-sample.png` at 10.10 MB is **accepted** by the bucket — the limit is 25 MB, and a 10 MB cap would have rejected a real input
- ✅ Accept: the transcript feeds Step 1 and the `allowedSpecs` guard runs against it unchanged, with `raw_text_origin = 'ocr'` surfaced on the review screen
- ✅ Accept: density targets derived from a transcribed `advertorial-sample.png` land within ±10% of hand-counted word totals for three named sections — the check that "words number" actually works, and the one most likely to fail quietly
- ✅ Accept: generation is blocked until the transcript is confirmed
- ✅ Accept: a screenshot with an embedded instruction ("ignore previous instructions and…") is flagged by the classifier and does not steer the brief
- ✅ Accept: an SVG renamed to `.png`, and a decompression-bomb PNG, are both rejected by the worker's `sharp` validation rather than by the bucket's MIME list
- ✅ Accept: **Simple Page's manifest is authored from a transcribed screenshot**, closing the last open question

### Phase 3 — Validation loop · Validators shipped

- The normalization pass + all nine lint categories + retry-with-feedback + flagging
- ✅ Accept: seeded bad outputs are all caught and retries fix or flag — hardcoded price, double-bold sentence, `{{discountValue}}` without `%`, fabricated spec, spelled-out fabricated spec ("weighs just two ounces" with no matching entry), literal product name outside the token, hardcoded year, unbalanced `{{if}}`, literal `XX` country code, case-variant token, link violating the field's `linkPolicy`, unknown scaffold variant, and a ≥12-word verbatim lift from `raw_text`
- ✅ Accept: legitimate output is **not** flagged — `57 g (2 oz)` passes via the conversion rule, "3 simple steps" passes as rhetorical, and a source spelling "two ounces" matches a `{value: 2, unit: "oz"}` spec
- ✅ Accept: a 529 injected on one section call retries at the transport layer and the run completes without consuming the validation retry budget

### Phase 4 — Remaining manifests · Not started

- Comparison V1 (`comparison.png` — Winner block + Competitors #2–#5 with pros/cons/scores/review counts + scorecard), Interstitial V1 (`Interstitial.png`), Reasons V1 (`reasons.png` — numbered reasons + social proof + threaded comments with replies). **Simple Page is not here** — Phase 2.5 authors it from a transcribed capture.
- ✅ Accept: all 5 templates generate end-to-end and their review screens visually correspond to the CMS screenshots section-for-section — Simple Page against the capture Phase 2.5 transcribed

### Phase 5 — Versioning + diffs · Schema ready

- Regenerate-section flow, version chain, diff view, changed-section badges
- ✅ Accept: regenerate one section → new generation row created, diff shows only that section changed

## Testing

Small, but not zero — the two most testable things in the system are the validators (pure functions over strings) and the Zod schemas.

- **RLS policy tests are the exception to "no E2E".** Policies are the only security boundary here and they fail silently and permissively when wrong. Write a test per policy running as an `editor`, a `viewer`, and a non-owner — asserting the **denials**, not just the allows. Two cases specifically: a **viewer who owns the row** (the case that catches a policy gating on ownership instead of role), and a user whose JWT carries `user_role: null` (the state a mis-granted access-token hook produces). Seeing a button disappear is not evidence.
- Unit tests per lint category, using the Phase 3 seeded bad cases plus passing cases as fixtures
- Zod round-trip tests over all five manifest files; manifests are Zod-validated on read at runtime, so a bad DB edit fails loudly instead of breaking generation mysteriously
- A schema test per section output shape
- No E2E — manual phase acceptance covers it for a single-user tool

## Mobile (Android, later) — and what that means for the web build today

A React Native companion app is planned but not built here. No Play Store, no App Store: a self-signed APK, downloaded and sideloaded. The point of this section is the handful of decisions that are free today and expensive to retrofit.

### One correction to the free-forever assumption

The $25 Play registration is not the only gate any more. **Android developer verification** requires the package name to be registered by a verified developer. The **30 September 2026** phase covers apps installed through the seven participating app stores in Brazil, Indonesia, Singapore and Thailand — which does not touch this plan, since the only distribution path here is a direct APK download. The date that actually constrains you is the **2027 global rollout**, which extends verification to all installs on certified devices, sideloading included.

After that an unregistered package can only be installed through an "advanced flow": Developer Mode, an anti-coercion check, a reboot, and a 24-hour wait, after which installs from unverified developers are permitted for 7 days or indefinitely with a warning. It is a one-time per-device unlock rather than a per-install tax — but it is still something you'd have to walk every teammate through.

The escape is free: a **Limited Distribution** account (from August 2026) needs a Google account with 2SV and a payments profile, no fee and no government ID, and covers **20 authorized devices**. For an allowlisted handful of Gmail accounts that is ample. Register it, and register the package name — and freeze the `applicationId` (e.g. `dev.landerforge.app`) before you do, since that string is what gets registered. ADB installs stay exempt permanently, so your own dev loop is unaffected either way.

### The build and distribution path

- **Expo with local builds.** The managed/bare split is gone — all Expo projects use Continuous Native Generation, so `npx expo prebuild` writes `android/` and you can drop to Gradle whenever. `./gradlew :app:assembleRelease` builds locally and free, with no EAS quota involved.
- **Build an APK, not an AAB.** `bundleRelease` is the default in most tutorials and produces an `.aab`, which cannot be installed on a device at all — it is a Play-only upload format. Watch the output path: `outputs/apk/release/`.
- **Signing is the trap.** Expo's generated `android/app/build.gradle` ships `release { signingConfig signingConfigs.debug }` with only a code comment as warning, so a release build is signed with the universally-known debug key and installs perfectly — nothing surfaces the mistake. Configure a real `signingConfigs.release` before the first APK leaves your machine, and verify with `apksigner verify --print-certs`. Switching keys later forces every user to uninstall first. Because `prebuild --clean` regenerates that file, express the signing config as a config plugin or commit `android/` and stop using `--clean`.
- **Back up the keystore.** Self-signing means the keystore is the only thing that can ever update the app on an existing install. Losing it means a new package name.
- **Host on GitHub Releases**, not `public/` on Vercel — free, versioned, a stable `releases/latest/download/…` URL, and a JSON API you can use as the version-check backend. A binary in `public/` bloats every deployment.
- Users grant "install unknown apps" once per source (Chrome deep-links straight to the setting). Play Protect will show a warning card, not a block, for an app requesting only `INTERNET`.

### Updates, which is the real cost of having no store

`expo-updates` works with locally built binaries, and **EAS Update's free tier is 1,000 monthly active users** — vastly more than this needs. Use it; self-hosting the update protocol is a documented fallback, not a plan.

OTA covers JavaScript, styling, copy, and layout. It cannot change native code, native dependencies, permissions, or the Expo SDK. Set `runtimeVersion: { policy: "fingerprint" }` so adding a native module automatically forks the runtime version — with the `appVersion` policy you have to remember, and forgetting means shipping JS that calls a module the installed APK lacks, which crashes every device on next launch with **no store rollback and no way to reach them**.

So plan two channels: OTA for the 95% case, and for native changes a **blocking upgrade screen**.

That gate must be **set membership, not a comparison**. Under the fingerprint policy `Updates.runtimeVersion` is an opaque content hash, and hashes have no ordering — a `minSupportedRuntimeVersion` with a `>=` cannot be computed, and an implementer will either string-compare two hex digests (fires arbitrarily) or fall back to equality (forces an upgrade on every build whose fingerprint moved, including OTA-compatible ones). So `client_config.supported_runtime_versions` is an **array of still-accepted fingerprints**, and the app blocks when its own runtime version is not in it, linking out to the GitHub Release. If you'd rather have an ordered check, key it on `Application.nativeBuildVersion`, which the fingerprint policy doesn't touch — but pick one and say so.

Do not build in-app self-updating — that needs `REQUEST_INSTALL_PACKAGES` in your own manifest, which is exactly the permission pattern that gets installs blocked.

### Mobile sign-in: use the browser flow, not native Google Sign-In

Two options, and self-signing makes the choice easy:

| | Google Cloud setup | Fits self-signing? |
|---|---|---|
| **(a) `signInWithOAuth` + `expo-web-browser`** | **Nothing new** — Google's only redirect URI is the Supabase callback already registered for the web client | Yes; Google never sees the package name or a SHA-1 |
| (b) `@react-native-google-signin` + `signInWithIdToken` | An Android OAuth client per package-name + SHA-1 pair, for **both** debug and release keystores, plus the web client | Workable but adds two registrations and a classic `DEVELOPER_ERROR` failure mode on the one build that's hard to debug |

Take (a). The only additions are `scheme: "landerforge"` in `app.json` and `landerforge://**` in Supabase's Additional Redirect URLs. PKCE is handled by `exchangeCodeForSession`, the same call the web callback route makes.

The client is plain `@supabase/supabase-js` — `@supabase/ssr` is cookie-marshalling for server rendering and does not apply. Config: `storage: AsyncStorage`, `autoRefreshToken: true`, `persistSession: true`, `detectSessionInUrl: false`, and **`lock: processLock`** (RN has no Web Locks API; without it concurrent refreshes race). Wire an `AppState` listener to `startAutoRefresh`/`stopAutoRefresh` — Android freezes timers in the background, so a socket that survives backgrounding comes back with a stale JWT and Realtime silently starves.

Everything server-side works unchanged: the before-user-created allowlist hook, the role trigger, the access-token hook, and every RLS policy apply identically, because both flows land in the same `auth.users`. If you ever do go native, the requirement that actually bites is registration, not identity: **every Android client ID (debug and release SHA-1) must be added to Supabase's Google provider "Authorized Client IDs"**, and native sign-in generally also needs "Skip nonce checks" — miss either and `signInWithIdToken` fails. Google's `sub` is globally unique per account and stable across OAuth clients and Cloud projects, so a second project would not fork someone into two accounts.

The `sb_publishable_` key ships in the APK safely; RLS is the boundary. Nothing else does — an APK is a zip.

### Decisions to make now

These cost nothing today and are the difference between a weekend of mobile work and a month:

1. **RLS is the whole authorization story — no rule may live only in a server action.** This is already the design; the commitment is to hold it for every table added between now and mobile. Retrofitting isn't writing policies later, it's auditing every mutation by hand to find which ones were quietly checking something RLS never knew about.
2. **Server actions are thin wrappers over transport-agnostic core functions.** `lib/core/create-generation.ts` exports `createGeneration(db, actor, input)` — it **receives** a Supabase client rather than constructing one, and contains no `cookies()`, `redirect()`, or `revalidatePath()`. That parameter is the actual seam; adding it later means touching every core function and call site at once.
3. **`lib/shared/` holds all Zod schemas and pure validators, and imports nothing from `next/*`, `server-only`, or Node built-ins.** Metro is not webpack: one stray `next/headers` in a schema's transitive graph makes the whole validation layer unbundleable for RN, and the alternative — reimplementing the linters mobile-side — is how two clients start disagreeing about what valid output is.
4. **Widen the middleware matcher exclusion from `/api/inngest` to all of `/api/`**, and reserve `app/api/v1/*`. Each route handler authenticates itself with `getClaims()` and returns JSON, never a redirect. This is the same failure already documented for Inngest, but worse for mobile: a `Bearer` request redirected to `/login` returns HTML with a 200 and surfaces as a JSON parse error.
5. **Never call a server action from a non-browser client.** Next rotates action IDs at least every 14 days regardless of source changes, so a pinned client breaks on an unrelated deploy.
6. **The mobile API is seven endpoints, and the list is closed:** four Inngest event sends (create, retry, regenerate, transcribe — the event key is server-only), the `/admin` off-boarding write (secret key + `auth.admin`), the manual-paste `sources` insert (fold into the create endpoint's contract), and the screenshot-source create that writes `sources` plus its `source_screenshots` rows. That last one cannot fold into create-generation, because the confirmation gate requires the source to exist and be confirmed *before* a generation row is made. **Transcript correction and confirmation** are deliberately not endpoints: give `sources` a narrow client UPDATE policy for `admin`/`editor` with a column-level grant covering `blocks`, `raw_text`, `raw_text_truncated`, and `transcript_confirmed_at` only, so both stay direct RLS writes. *Everything else* — all reads, all Realtime, projects and rules CRUD, and the image upload itself (direct to Storage) — is direct `supabase-js` under RLS. Keeping this list accurate as tables are added is the discipline that stops reads drifting behind route handlers "for consistency".
7. **All live run state travels as rows over Realtime**, never as a server-action return value or an RSC payload. The web UI should use the same path so it stays exercised — state that rides back in an action response has no mobile equivalent, and the gap only shows up when the mobile review screen appears to hang.
8. **Ship the `client_config` read before the first APK** — the table is in the schema above, carrying `supported_runtime_versions[]` and `latest_apk_url`, readable by `authenticated` and writable only by `admin`. Have the web app read it too so the path stays exercised. An APK that shipped without knowing to check this can never be told to start checking, which is precisely the population a forced upgrade is for. Because the row carries the download URL the upgrade screen sends people to, an editor- or viewer-writable version of it would be a distribution hole, not just a config bug.
9. **Push client-derivable invariants into the schema** — already done above for the three that matter: `owner_id` gets `default auth.uid()` plus the INSERT policy's `with check` and an immutability trigger, and `version_num` and `manifest_snapshot` are assigned by a `before insert` trigger rather than by the caller. Once RN inserts rows directly, an invariant living only in a server action is an invariant with a hole, and RLS won't catch it because it was never asked to.

Realistically the mobile app is for monitoring runs and reviewing copy. The paste-into-LogicHub workflow stays on desktop, since the CMS is a desktop web app.

One operational note: **free Supabase projects pause after a week of inactivity**, which a sporadically-used companion app will hit and report as a generic network error. Keep the project warm with a scheduled trivial query and give the client a distinct "backend unavailable" state.

## Env vars

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY   # sb_publishable_… — browser
SUPABASE_SECRET_KEY                    # sb_secret_…      — server only
ANTHROPIC_API_KEY
BROWSERLESS_URL / BROWSERLESS_TOKEN
INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY
```

The Google OAuth client ID and secret are **not** app env vars — they go into the Supabase dashboard's Google provider settings, and Supabase handles the exchange.

## Non-goals (do not build)

- Custom HTML template (manual work, out of scope)
- LogicHub API integration / auto-publish
- Teams, organizations, billing, self-serve signup. The tool is multi-user with roles, but membership is an allowlist the admin curates by hand — there is no invitation email, no org hierarchy, and no per-team data partition.
- **iOS.** Testing on a physical iPhone beyond seven days requires the $99/year Apple Developer Program, which is the whole reason this is Android-first. The React Native codebase shouldn't go out of its way to preclude it, but nothing here targets it.
- The React Native app itself, in this phase — see "Mobile (Android, later)" for the decisions being made now to keep it cheap.
- Image **generation**, and any handling of images as page *content* — image slots appear as `display` fields so the CMS walk stays aligned, and nothing selects, edits, or produces artwork. Screenshots are accepted as **source material to transcribe**: the original upload is deleted once the transcript is stored, and a downscaled derivative is retained so the review screen can show what was read. That is the only image path.

## Risk notes

The core loop scrapes competitor landers and produces copy matching their structure and density. Worth stating knowingly: output is transformative rewriting, never verbatim reuse — Step 3's lint category 9 enforces it by flagging any ≥12-word run shared with `raw_text`. Scraping stays single-page and on-demand, never crawling. Source testimonials are treated as unverified claims subject to the full compliance lint.

## Open questions

Two things to settle before the phases that depend on them. **Resolved:** `{{priceRegular}}` and `{{priceDiscounted}}` render with a currency symbol, so the "no hardcoded prices" rule is satisfiable on global pages and no copy ever needs a literal `$`. And per-field `markdownBold` will not be confirmed against the live CMS — see the inference rule in the manifest section instead.

1. ~~**Confirm `claude-sonnet-4-6` supports structured outputs**~~ — **RESOLVED, and superseded.** `client.models.retrieve` reports `structured_outputs.supported: true` on Sonnet 4.6, Sonnet 5, Opus 5 and Haiku 4.5, so no fallback is needed. The pipeline has since moved to `claude-sonnet-5` anyway, which is both newer and cheaper ($2/$10 per MTok against $3/$15; about 13% cheaper in real terms once its ~30% larger token counts are accounted for).

   Adopting structured outputs is now a **design** question rather than a capability one, because of an interaction the docs flag: changing `output_config.format` invalidates the prompt cache for that thread. A per-section schema would therefore change the cached prefix on every call — precisely the trap already documented for `tools`, and the most expensive mistake available in this codebase. Any adoption must use a schema that is byte-stable for the whole run, e.g. `{"fields": [{"key": ..., "value": ...}]}` rather than one object shape per section, and must be verified against `cache_read_input_tokens` before being kept.
2. **Simple Page** has no CMS capture yet. Phase 2.5 owns authoring its manifest and can transcribe the capture once it exists, so the only real blocker is somebody taking the screenshot. If Phase 2.5 slips, define the manifest inline here instead.
