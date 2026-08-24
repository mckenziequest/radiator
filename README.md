# Radiator — Review Aggregation Backend

This is the service that pulls **real reviews from Google and Yelp** and merges
them with Radiator's own tenant reviews into **one combined score per Chicago
building**. It's the piece that makes "all review portals in one place" real.

## Why this is a separate backend (and not inside the app)

Two hard constraints force this to run on a server, not in the browser:

1. **Google and Yelp require secret API keys.** Those keys must never ship in
   front-end code — anyone could steal them and run up your bill. They live here,
   server-side, only.
2. **Google's and Yelp's review data is only available through their official
   APIs.** Scraping their sites is against their terms. This service uses the
   sanctioned endpoints.

The Radiator front-end calls **this** service; this service calls Google/Yelp.

```
 Radiator front-end  ──►  radiator-backend  ──►  Google Places API
 (your domain)              (this service)   └►  Yelp Fusion API
```

## What you get

`GET /api/building?address=1600+N+Damen+Ave&radiatorRating=4.5&radiatorCount=3`

```json
{
  "address": "1600 N Damen Ave",
  "combinedRating": 3.9,
  "totalReviews": 175,
  "sourceCount": 3,
  "confidence": "high",
  "breakdown": [
    { "source": "radiator", "rating": 4.5, "count": 3 },
    { "source": "google",   "rating": 4.1, "count": 128, "url": "..." },
    { "source": "yelp",     "rating": 3.5, "count": 44,  "url": "..." }
  ],
  "reviews": [ { "source": "google", "author": "...", "rating": 5, "text": "...", "time": ... }, ... ]
}
```

The **combined rating is volume-weighted** (a building with 128 Google reviews at
4.1 counts more than one with 3), using a sub-linear dampening so a single huge
source doesn't completely bury a smaller one.

## Run it

```bash
npm install

# No keys? Try it with canned data first:
npm run dev            # MOCK=1, serves fake Google/Yelp data on :8787

# Real data (needs keys — see below):
export GOOGLE_PLACES_KEY=xxxx
export YELP_API_KEY=xxxx
npm start
```

Then: `curl "http://localhost:8787/api/building?address=1600 N Damen Ave"`

Run the aggregation unit tests: `npm test`

## Getting the API keys

**Google Places API**
1. Google Cloud Console → create a project → enable **Places API**.
2. Create an API key, restrict it to the Places API (and to your server IP).
3. Set `GOOGLE_PLACES_KEY`.
Billing is required, but there's a monthly free tier. Place Details + Find Place
cost per call — the built-in cache keeps this low.

**Reddit API** (free)
1. https://www.reddit.com/prefs/apps → create an app (type: script or web app).
2. Copy the client id (under the app name) and secret. Set `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and a descriptive `REDDIT_USER_AGENT` (Reddit requires it). Reddit is discussion, not star ratings — it shows up as readable **mentions** with upvotes and a rough sentiment tag, and does not change the numeric star score.

**Yelp Fusion API**
1. https://www.yelp.com/developers → create an app → copy the **API Key**.
2. Set `YELP_API_KEY`.
Free tier is generous (thousands of calls/day).

## Deploy

Any Node host works. Zero-config options:
- **Render / Railway / Fly.io**: point at this folder, set the two env vars, deploy.
- **Vercel / Netlify functions**: wrap `server.js`'s handler as a function.

Set `CORS_ORIGIN` to your Radiator front-end's domain (defaults to `*`), and
`CACHE_HOURS` to control freshness (default 12).

## Connect it to Radiator

Open the Radiator app → **Profile → Connect review sources** → paste this
service's URL (e.g. `https://your-app.onrender.com`). Open any building and its
Google/Yelp reviews load into the "Reviews from everywhere" section with a live
combined score.

> Note: this works when you host the Radiator front-end on **your own domain**.
> The claude.ai-hosted preview blocks all outside network calls for security, so
> there it will keep showing the "connect" placeholder — that's expected.

## Honest limits (important)

- **Google Places returns at most 5 review snippets** per place. Yelp Fusion
  returns at most **3 review excerpts** (and the text is truncated by Yelp).
  Their **aggregate rating and total review count are complete** — so the
  combined *score* is accurate; you just can't display the full text of every
  review. That's a platform limitation, not a bug.
- **Matching a specific residential address to a Yelp business is imperfect** —
  Yelp indexes property-management companies and larger complexes, not every
  address. When nothing matches, the building simply shows Google + Radiator.
- Add more sources (ApartmentRatings, Facebook, Rent.) by writing another file in
  `providers/` that returns the same `{source, rating, count, url, reviews}`
  shape and pushing it into the `sources` array in `server.js`.

## Files

- `server.js` — Express API + caching + CORS
- `providers/google.js` — Google Places integration (+ mock)
- `providers/yelp.js` — Yelp Fusion integration (+ mock)
- `aggregate.js` — pure combine/scoring logic
- `test.js` — unit tests for the aggregation
