# Production setup

A complete walkthrough, assuming no prior knowledge of any of these services. Follow it
top to bottom — the order matters, because several steps need a value produced by an
earlier one.

Budget about 90 minutes for a first run.

---

## What you are building

Six services, each doing one job:

| Service | Job | Cost |
|---|---|---|
| **GitHub** | Stores the code, runs the tests | Free |
| **Vercel** | Runs the web app | Free tier is enough to start |
| **Supabase** | Database, sign-in, live updates | Free tier works; **$25/mo strongly advised** |
| **Google Cloud** | Provides "Sign in with Google" | Free |
| **Anthropic** | Writes the copy | Pay per use, roughly $0.30–0.80 per page |
| **Inngest** | Runs generation jobs in the background | Free tier is enough |
| **Browserless** | Loads competitor pages for scraping | From ~$25/mo, or skip it at first |

**Realistic monthly cost:** about $25–55 plus per-page generation, depending on whether
you take paid Supabase and Browserless.

### One thing to decide now

Supabase's free tier **pauses your project after one week of inactivity**. For a tool
used in bursts that means coming back to a dead backend and a confusing error. If this
is anything more than an experiment, take the $25/month plan. Everything below works on
either.

---

## Before you start

Create accounts at each of these. Use the same email throughout — it keeps billing and
recovery simple.

- [github.com](https://github.com) — sign up
- [vercel.com](https://vercel.com) — **sign up with your GitHub account**
- [supabase.com](https://supabase.com) — sign up
- [console.cloud.google.com](https://console.cloud.google.com) — sign in with the Google
  account you want to administer the app with
- [console.anthropic.com](https://console.anthropic.com) — sign up, add a payment method
- [app.inngest.com](https://app.inngest.com) — **sign up with your GitHub account**
- [browserless.io](https://www.browserless.io) — optional at first, see Part 8

You will also need these on your own machine:

```bash
node --version     # need 22 or higher — nodejs.org
pnpm --version     # need 10 or higher — `npm install -g pnpm`
docker --version   # docker.com/products/docker-desktop
supabase --version # `npm install -g supabase`
git --version
```

**Keep a scratch file open.** You will collect about a dozen keys along the way, and
several are shown only once.

---

## Part 1 — Put the code on GitHub

1. Go to [github.com/new](https://github.com/new).
2. Name it `landerforge`. Choose **Private** unless you want it public as a portfolio
   piece.
3. Do **not** tick "Add a README" — the repository already has one.
4. Click **Create repository**.
5. In your terminal, from the project folder:

```bash
git remote add origin https://github.com/YOUR-USERNAME/landerforge.git
git branch -M main
git push -u origin main
```

Refresh the GitHub page — your code should be there, and the **Actions** tab should show
a workflow running. It may fail at the database job on this first run; that is expected
until Part 5 and it does not block anything.

---

## Part 2 — Create the Supabase project

Supabase is your database, your sign-in system, and the live-updates channel.

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
2. **Name:** `landerforge`
3. **Database Password:** click Generate, then **save it in your scratch file**. You need
   it in Part 5 and it cannot be retrieved later, only reset.
4. **Region:** pick the one closest to you.
5. **Create new project**, then wait 2–3 minutes.

### Collect three values

Open **Project Settings** (the gear icon).

From **General**:
- **Project ID** (also called the reference) — a 20-character string like
  `abcdefghijklmnopqrst`. Save it.

From **API Keys**:
- **Publishable key** — starts with `sb_publishable_`. Safe in a browser. Save it.
- **Secret key** — starts with `sb_secret_`. Click *Reveal*. Save it.

> **Use the new key format.** If you also see older keys labelled `anon` and
> `service_role` that look like long JWTs, ignore them — they are deprecated and there
> is no reason to start with them.

> **The secret key bypasses every security rule in the database.** It belongs only in
> Vercel's server environment. Never put it in a browser, a phone app, or a public repo.

Your project URL is `https://YOUR-PROJECT-ID.supabase.co`. Save that too.

---

## Part 3 — Create the Google sign-in credentials

This is the fiddliest part. Take it slowly.

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Click the project dropdown at the top → **New Project** → name it `landerforge` →
   **Create**. Make sure it is selected afterwards.

### 3a. Configure the consent screen

This is the "LanderForge wants to access your account" page users will see.

1. Search for **Google Auth Platform** (in older layouts, *APIs & Services → OAuth
   consent screen*).
2. Click **Get started**.
3. **App name:** `LanderForge`. **User support email:** your email.
4. **Audience:** choose **External**. (Choose *Internal* only if you have Google
   Workspace and every user has an address on your company domain.)
5. **Contact email:** your email. Agree to the policy and **Create**.

### 3b. Add the scopes

1. Go to **Data access** → **Add or remove scopes**.
2. Tick these three, and nothing more:
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `openid`
3. **Update**, then **Save**.

The app only needs to know who someone is. Requesting more would trigger a Google review
you do not need.

### 3c. Publish the app

1. Go to **Audience**.
2. If it says **Testing**, click **Publish app** and confirm.

> **Why this matters.** In *Testing* mode only email addresses you list as test users can
> sign in *at all*, and sessions expire after seven days. You will spend an afternoon
> debugging that. Publishing an app with only the three basic scopes needs no Google
> review and takes effect immediately.
>
> Publishing does **not** make your app open to the public — the allowlist in Part 12
> controls who can actually get in. Google will show an "unverified app" warning that
> users click past; that is normal for an internal tool.

### 3d. Create the credentials

1. Go to **Clients** → **Create client**.
2. **Application type:** Web application.
3. **Name:** `LanderForge Web`.
4. Under **Authorised redirect URIs**, click **Add URI** and paste exactly this, with
   your own project ID:

   ```
   https://YOUR-PROJECT-ID.supabase.co/auth/v1/callback
   ```

   This is Supabase's address, not your app's. That trips up almost everyone.

5. **Create**.
6. Copy the **Client ID** and **Client Secret** into your scratch file.

---

## Part 4 — Connect Google to Supabase

1. Back in the Supabase dashboard: **Authentication** → **Sign In / Providers**.
2. Find **Google**, enable it.
3. Paste in the **Client ID** and **Client Secret** from step 3d.
4. **Save**.

### Turn off every other way in

Still under **Sign In / Providers**, find **Email** and **disable** it — both password
sign-in and magic links.

> Google OAuth is the only door by design. Leaving email sign-up enabled means anyone
> who finds your URL can create an account, and the allowlist in Part 12 would not stop
> them, because it only guards the Google path.

---

## Part 5 — Set up the database

The database structure lives in the repository as migration files, so this is one
command rather than hours of clicking.

```bash
# Sign in to the Supabase CLI (opens a browser)
supabase login

# Point the local project at your hosted one
supabase link --project-ref YOUR-PROJECT-ID
# Paste the database password from Part 2 when asked

# Create every table, security rule and trigger
supabase db push
```

You should see the four migrations apply in order. If `db push` reports nothing to do,
check that `supabase link` picked the right project.

**Verify it worked.** In the dashboard, go to **Table Editor**. You should see
`allowed_emails`, `user_roles`, `templates`, `projects`, `sources`, `generations`,
`generation_sections`, `generation_steps`, `rules` and `client_config`.

---

## Part 6 — Enable the two authentication hooks

**Do not skip this.** These two settings are the most important in the whole guide, and
both fail *silently* when missed — the app appears to work while doing the wrong thing.

Go to **Authentication** → **Hooks**.

### Hook 1 — Before User Created

1. Find **Before User Created**, click to configure.
2. Type: **Postgres**.
3. Schema: `public`. Function: `hook_restrict_signup`.
4. Enable and save.

This is what rejects anyone not on your allowlist. It runs *before* the account exists,
so an unauthorised person never holds a valid session even for a moment.

### Hook 2 — Custom Access Token

1. Find **Customize Access Token (JWT) Claims**.
2. Type: **Postgres**.
3. Schema: `public`. Function: `custom_access_token_hook`.
4. Enable and save.

This stamps each user's role into their session token.

### Why these fail silently

- **Miss hook 1** and anyone with a Google account can sign in. Nothing warns you.
- **Miss hook 2** and every user signs in successfully but with *no role*. Every button
  appears to work and every save quietly does nothing, because the database rejects
  writes from a user with no role. This looks like a bug in the app and is not.

Part 14 checks both.

---

## Part 7 — Get an Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com).
2. **Settings → Billing** → add a payment method and buy some starting credit ($20 is
   plenty for a lot of testing).
3. **Settings → Limits** → set a monthly spend limit. Start at **$50**.
4. **API Keys** → **Create Key** → name it `landerforge-production`.
5. Copy it — it starts with `sk-ant-` and is shown **only once**. Save it.

> **Set the spend limit.** The app has its own per-run ceiling, but a limit here is the
> backstop that a bug in the app cannot bypass.

---

## Part 8 — Get a Browserless token (optional at first)

Browserless loads competitor pages so the app can read them. **You can skip this and add
it later** — without it, the URL option simply fails and you use the "paste the source
text" box instead. Everything else works.

1. Go to [browserless.io](https://www.browserless.io) → sign up.
2. From the dashboard, copy your **API token**.
3. Note your region's endpoint, e.g. `wss://production-sfo.browserless.io` (San
   Francisco) or `wss://production-lon.browserless.io` (London). Pick the one nearest
   your Vercel region.

---

## Part 9 — Set up Inngest

Inngest runs generation in the background, so a page that takes two minutes to write does
not need a browser tab held open, and a crash halfway through resumes rather than
restarting.

1. Go to [app.inngest.com](https://app.inngest.com) and sign in with GitHub.
2. Create an environment if prompted — **Production**.
3. Go to **Manage → Event Keys** → copy the key. Save it.
4. Go to **Manage → Signing Key** → copy it. Save it.

You will connect your deployed app in Part 11, after it has a URL.

---

## Part 10 — Deploy to Vercel

1. Go to [vercel.com/new](https://vercel.com/new).
2. **Import** your `landerforge` repository.
3. Leave the framework preset as **Next.js** and the build settings alone.
4. Expand **Environment Variables** and add all seven, exactly as named:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://YOUR-PROJECT-ID.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | your `sb_publishable_…` key |
| `SUPABASE_SECRET_KEY` | your `sb_secret_…` key |
| `ANTHROPIC_API_KEY` | your `sk-ant-…` key |
| `INNGEST_EVENT_KEY` | from Part 9 |
| `INNGEST_SIGNING_KEY` | from Part 9 |
| `BROWSERLESS_TOKEN` | from Part 8, or leave blank for now |
| `BROWSERLESS_URL` | e.g. `wss://production-sfo.browserless.io` |

> `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` do not appear anywhere in the app's
> source — the Inngest library reads them from the environment itself. They are required
> even though nothing seems to reference them.

> Only the two names starting with `NEXT_PUBLIC_` reach the browser. That prefix is
> exactly what makes a value public, which is why the secret key must never be given one.

5. Click **Deploy** and wait two or three minutes.
6. Copy your production URL — something like `https://landerforge-xyz.vercel.app`.

---

## Part 11 — Wire the deployed URL back into everything

Three services need to know where your app actually lives. This can only happen now,
because the URL did not exist until Part 10.

### 11a. Tell Supabase which URLs are legitimate

**Authentication → URL Configuration**:

- **Site URL:** `https://your-app.vercel.app`
- **Redirect URLs** → add both:
  - `https://your-app.vercel.app/**`
  - `http://localhost:3000/**` (so local development still works)

Without this, signing in redirects to a blank page or an error.

### 11b. Connect Inngest to your app

The easy way — in Inngest, go to **Apps → Sync new app**, choose the **Vercel**
integration, authorise it, and select your project. From then on every deployment syncs
automatically.

The manual way — **Apps → Sync new app → Sync manually**, and enter:

```
https://your-app.vercel.app/api/inngest
```

Either way, you should end up with an app named `landerforge` showing one function,
`generate-lander`. If the sync fails, the app is not deployed or the signing key does
not match.

### 11c. Redeploy

In Vercel, **Deployments → ⋯ → Redeploy** on the latest one, so the app picks up any
environment variables added after the first build.

---

## Part 12 — Create your own admin account

**This is the step everyone gets stuck on.** The allowlist is empty and the hook rejects
everyone not on it — including you. So you cannot sign in to add yourself. You have to
add yourself directly to the database first.

1. In Supabase, open **SQL Editor** → **New query**.
2. Paste this, replacing the email with your own Google address:

```sql
insert into public.allowed_emails (email, role, note)
values ('you@gmail.com', 'admin', 'Initial administrator');
```

3. Click **Run**.
4. Go to `https://your-app.vercel.app`, click **Continue with Google**, and sign in with
   **that exact address**.
5. Click through Google's "unverified app" warning — expected, as explained in 3c.

You should land on the app's home page showing your email and the role `admin`.

**If you see "This account isn't authorized",** the address you signed in with does not
match the one in the table. Check for typos and for a different Google account being
signed in. Emails are compared in lower case.

### Adding everyone else

From now on use the app: go to `/admin`, enter their Google address, choose a role, and
click **Add to allowlist**. They can then sign in themselves.

| Role | Can do |
|---|---|
| `admin` | Everything, including managing access and deleting |
| `editor` | Create and edit generations |
| `viewer` | Read only |

**Removing someone** — use the **Remove access** button on `/admin`. It deletes the
allowlist entry, the role, and the account together. Do not just delete the allowlist row
by hand in the database: the signup hook only runs at *signup*, so an existing user
would keep signing in indefinitely.

---

## Part 13 — Load the templates

The app needs its template definitions in the database. From your project folder:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT-ID.supabase.co \
SUPABASE_SECRET_KEY=sb_secret_your_key \
pnpm run seed
```

You should see `seeded advertorial_v1 (6 sections)`.

Re-run this whenever a manifest in `manifests/` changes. It updates in place rather than
duplicating.

---

## Part 14 — Verify it actually works

Do all six. Each one checks something that can fail quietly.

**1. Sign-in works.** Open your app in a private window. You should be sent to `/login`,
and Google sign-in should return you to the home page.

**2. The allowlist blocks strangers.** In the same private window, try signing in with a
*different* Google account that is not on the allowlist. You must land on "This account
isn't authorized". If it lets them in, **hook 1 from Part 6 is not enabled** — fix that
before going further.

**3. Your role is really there.** In Supabase, run:

```sql
select u.email, r.role
from auth.users u
left join public.user_roles r on r.user_id = u.id;
```

Your email must show `admin`. If `role` is empty, **hook 2 from Part 6 is not enabled**,
or you signed in before enabling it — delete the user in **Authentication → Users** and
sign in again.

**4. Background jobs are connected.** In Inngest, the `landerforge` app should be listed
with the `generate-lander` function. If not, redo 11b.

**5. A generation runs end to end.** In the app, create a project, then go to `/new`,
pick the Advertorial template, leave the URL blank, write a sentence of notes, and
Generate. You should be taken to a review screen where sections fill in as they finish.

**6. Prompt caching is working.** After that first run, in Supabase run:

```sql
select step, attempt, cache_read_input_tokens, cost_usd
from public.generation_steps
order by id;
```

From the second row onward, `cache_read_input_tokens` must be **greater than zero**. If
every row is zero, caching is broken and you are paying several times more than
necessary — see Troubleshooting.

---

## Ongoing operation

### Watching cost

```sql
-- Cost per generation, most recent first
select id, version_num, status, total_cost_usd, created_at
from public.generations
order by created_at desc limit 20;

-- This month's total
select round(sum(cost_usd), 2) as usd
from public.generation_steps
where created_at >= date_trunc('month', now());
```

A healthy page costs roughly $0.30–0.80. Consistently higher usually means caching has
broken.

### Deploying changes

Push to `main` and Vercel deploys automatically. GitHub Actions runs the tests on every
push; a red tick means something broke.

Database changes need one extra command:

```bash
supabase db push
```

### Backups

Paid Supabase plans take daily backups automatically. On the free tier, take your own
periodically:

```bash
supabase db dump -f backup-$(date +%Y-%m-%d).sql
```

### Rotating a key

If a key is ever exposed: create the replacement first, update it in Vercel, redeploy,
*then* revoke the old one. Doing it the other way round takes the app down.

### Keeping a free project awake

Free Supabase projects pause after a week of inactivity. Either upgrade, or set up a
weekly cron (`cron-job.org` is free) that requests your app's home page.

---

## Troubleshooting

### "This account isn't authorized" for someone who should have access

Their address is not in `allowed_emails`, or it differs from the one they signed in with.
Check:

```sql
select email, role from public.allowed_emails;
```

### Everyone can sign in, including people you never added

Hook 1 is not enabled. Part 6. Then remove any accounts that got in via
**Authentication → Users**.

### Buttons do nothing, saves silently fail

Almost always hook 2 not being enabled, so users have no role. Run the query from check 3
in Part 14. If a user's role is empty, delete their account and have them sign in again
after enabling the hook.

### Every signup fails with a server error

The opposite problem: the hook is enabled but the database has not granted it permission.
Re-run `supabase db push` — migration `0002` sets up the required grants.

### Generation starts but never finishes

1. Inngest → **Runs**, and look for a failed run with its error.
2. Check the app is synced (Part 11b).
3. Confirm `ANTHROPIC_API_KEY` is set in Vercel and has credit.

### Nothing at all happens when you click Generate

Inngest cannot reach your app. Verify `https://your-app.vercel.app/api/inngest` returns a
page rather than redirecting to `/login`, and re-sync in Inngest.

### The review screen never updates

Live updates are not arriving. Confirm you signed in properly (updates are permission
checked), and that the tables are published:

```sql
select tablename from pg_publication_tables
where pubname = 'supabase_realtime';
```

`generations` and `generation_sections` must both be listed. If not, re-run
`supabase db push`.

### Cache reads are always zero

Something varying is being sent on every request, so nothing can be reused. This is a
code problem rather than a configuration one — see the caching section of
[landerforge-plan.md](landerforge-plan.md).

### Scraping a URL always fails

Confirm `BROWSERLESS_TOKEN` and `BROWSERLESS_URL` are set, and that the token has credit.
Some sites block automated visitors regardless; use the paste-the-text box for those.

---

## Quick reference

| What | Where |
|---|---|
| The app | `https://your-app.vercel.app` |
| Database & sign-in | [supabase.com/dashboard](https://supabase.com/dashboard) |
| Background jobs | [app.inngest.com](https://app.inngest.com) |
| Deployments & logs | [vercel.com/dashboard](https://vercel.com/dashboard) |
| API spend | [console.anthropic.com](https://console.anthropic.com) |
| Google sign-in config | [console.cloud.google.com](https://console.cloud.google.com) |

**Add a user:** `/admin` in the app.
**Remove a user:** `/admin` → Remove access. Never by hand in the database.
**Deploy code:** `git push`.
**Deploy database changes:** `supabase db push`.
