# Getting Radiator live — the click-by-click

You do **not** need to be technical, and you do **not** need to pay anything to go
live. This puts the whole app — with tenant reviews **shared across every visitor** —
on the internet at a free web address like `https://radiator.onrender.com`.

The only thing money ever buys is a *prettier* address (a custom domain). That's
optional and comes later. See "Add your own domain" at the bottom.

---

## What you need first (all free)

1. A **GitHub** account — free. github.com → Sign up.
2. A **Render** account — free. render.com → Get Started → "Sign in with GitHub".

That's it. No credit card for the free tier.

---

## Step 1 — Put this folder on GitHub (5 min)

The easiest way, no command line:

1. On github.com, click **New repository**. Name it `radiator`. Leave it Public. Create.
2. On the new repo's page, click **uploading an existing file**.
3. Drag in **everything inside this `radiator-backend` folder** (server.js, package.json,
   the `public` and `providers` folders, render.yaml, etc.). Do **not** upload the
   `node_modules` folder — GitHub rebuilds it for you.
4. Click **Commit changes**.

## Step 2 — Deploy on Render (3 min, one click)

1. In Render, click **New +** → **Blueprint**.
2. Connect your GitHub and pick the `radiator` repo.
3. Render reads `render.yaml`, and shows it will create **a web service + a free
   Postgres database**. Click **Apply**.
4. It asks for a few optional keys (Google / Yelp / Reddit). **Leave them blank** —
   the site launches fine without them. Click through.
5. Wait ~2–3 minutes for the first build. When it's done, Render shows your live URL:
   **`https://radiator-xxxx.onrender.com`**.

**That URL is your live product.** Open it, write a review, then open it on your phone —
the review is there. It's shared for everyone now, because it lives in the database.

## Step 3 (optional, later) — switch on outside reviews

Google / Yelp / Reddit ratings stay off until you add free API keys:

- **Google Places:** console.cloud.google.com → create a project → enable "Places API" →
  Credentials → create an API key.
- **Yelp Fusion:** fusion.yelp.com → create an app → copy the API key.
- **Reddit:** reddit.com/prefs/apps → create a "script" app → copy the id + secret.

In Render → your service → **Environment** → add `GOOGLE_PLACES_KEY`, `YELP_API_KEY`,
`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`. Save — it redeploys itself.

---

## Add your own domain (this is the ONLY paid step, ~$12/year)

Only when you want `getradiator.com` instead of the `onrender.com` address:

1. Buy the domain at **Namecheap** or **Cloudflare** (~$12/yr).
2. In Render → your service → **Settings → Custom Domains** → add your domain.
3. Render shows you the exact DNS records. Paste them at your registrar. Done in minutes.

---

## Good to know about the free tier

- The free web service **sleeps after 15 min of no traffic** and takes ~30 sec to wake
  on the next visit. Fine for early days; upgrade to the ~$7/mo "Starter" plan to keep
  it always-on once you have steady traffic.
- The free Postgres database is **free for 90 days**, then Render asks you to pick a plan.
  Two ways to stay at $0 past that: move to a free-forever Postgres at **Supabase** or
  **Neon** (create a database there, copy its connection string, and paste it as
  `DATABASE_URL` in Render). Same app, just a different database — no code changes.

## Run it on your own computer first (optional)

```
npm install
npm run dev          # mock mode, no keys, data saved to data/community.json
# open http://localhost:8787
```
