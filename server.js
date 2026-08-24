// server.js — Radiator review-aggregation API.
//
// Exposes:
//   GET /api/health
//   GET /api/building?address=1600+N+Damen+Ave   (optionally &radiatorRating=4.2&radiatorCount=3)
//
// Pulls Google Places + Yelp Fusion reviews for the address, optionally folds
// in Radiator's own tenant reviews (passed by the caller), and returns a single
// combined score + unified review list. Results are cached to respect API rate
// limits and cost.
//
// Run:  MOCK=1 node server.js         (no keys needed, canned data)
//       node server.js                (needs GOOGLE_PLACES_KEY + YELP_API_KEY)

const express = require('express');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const { getGoogle } = require('./providers/google');
const { getYelp } = require('./providers/yelp');
const { getReddit } = require('./providers/reddit');
const { combine } = require('./aggregate');
const store = require('./store');
const community = require('./community');
const seo = require('./seo');
const payments = require('./payments');

const app = express();
app.use(compression()); // gzip every response — cuts the ~1MB app page to a fraction over the wire
app.use(express.json({ limit: '12mb' })); // room for base64 photos
const PORT = process.env.PORT || 8787;
const TTL_MS = (Number(process.env.CACHE_HOURS) || 12) * 3600 * 1000;

// --- CORS (so the Radiator frontend on your domain can call this) ---
const ALLOW = process.env.CORS_ORIGIN || '*';
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ALLOW);
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- tiny in-memory cache (swap for Redis in production) ---
const cache = new Map();
function cacheGet(k) {
  const e = cache.get(k);
  if (e && Date.now() - e.t < TTL_MS) return e.v;
  if (e) cache.delete(k);
  return null;
}
function cacheSet(k, v) {
  cache.set(k, { t: Date.now(), v });
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mock: process.env.MOCK === '1',
    google: !!process.env.GOOGLE_PLACES_KEY || process.env.MOCK === '1',
    yelp: !!process.env.YELP_API_KEY || process.env.MOCK === '1',
    reddit: !!process.env.REDDIT_CLIENT_ID || process.env.MOCK === '1',
    cached: cache.size,
  });
});

// --- TEMP DIAGNOSTIC: surface exactly what Google Text Search returns (no key leaked) ---
app.get('/api/debug/google', async (req, res) => {
  const address = (req.query.address || '').toString().trim() || '540 N State St';
  const KEY = process.env.GOOGLE_PLACES_KEY;
  if (!KEY) return res.json({ error: 'no GOOGLE_PLACES_KEY set' });
  const query = (req.query.q || '').toString().trim() || `${address}, Chicago, IL`;
  const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json?query=' + encodeURIComponent(query) + '&key=' + KEY;
  try {
    const json = await (await fetch(url)).json();
    const results = json.results || [];
    res.json({
      query,
      status: json.status,
      error_message: json.error_message || null,
      resultCount: results.length,
      first5: results.slice(0, 5).map(r => ({
        name: r.name, rating: r.rating, user_ratings_total: r.user_ratings_total,
        formatted_address: r.formatted_address, types: (r.types || []).slice(0, 3),
      })),
    });
  } catch (e) {
    res.json({ query, fetchError: e.message });
  }
});

app.get('/api/building', async (req, res) => {
  const address = (req.query.address || '').toString().trim();
  if (!address) return res.status(400).json({ error: 'address query param required' });

  const cacheKey = address.toLowerCase();
  const cached = cacheGet(cacheKey);
  const sources = [];

  // Optional: caller can pass Radiator's own aggregate so it's blended in.
  const rRating = parseFloat(req.query.radiatorRating);
  const rCount = parseInt(req.query.radiatorCount, 10);
  if (rRating > 0 && rCount > 0) {
    sources.push({ source: 'radiator', rating: rRating, count: rCount, url: null, reviews: [] });
  }

  try {
    let external;
    if (cached) {
      external = cached; // {google, yelp, reddit} already fetched
    } else {
      const [g, y, r] = await Promise.allSettled([getGoogle(address), getYelp(address), getReddit(address)]);
      external = {
        google: g.status === 'fulfilled' ? g.value : null,
        yelp: y.status === 'fulfilled' ? y.value : null,
        reddit: r.status === 'fulfilled' ? r.value : null,
      };
      cacheSet(cacheKey, external);
    }
    if (external.google) sources.push(external.google);
    if (external.yelp) sources.push(external.yelp);
    if (external.reddit) sources.push(external.reddit);

    const result = combine(address, sources);
    result.cached = !!cached;
    res.json(result);
  } catch (err) {
    console.error('aggregate error:', err);
    res.status(502).json({ error: 'aggregation failed', detail: String(err && err.message || err) });
  }
});

// ---- shared community content (reviews, issues, Q&A, names, photos) ----
community.mount(app);

// ---- Stripe payments (dormant until STRIPE_SECRET_KEY is set) ----
payments.mount(app);

// ---- serve the Radiator web app itself, so ONE deploy runs everything ----
const PUBLIC = path.join(__dirname, 'public');

// Extract the app body once so SEO routes can wrap it with a per-page <head>.
let APP_BODY = '';
try {
  const full = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const m = full.match(/<body>([\s\S]*)<\/body>/i);
  APP_BODY = m ? m[1] : full;
} catch (e) { console.error('could not read app body for SEO:', e.message); }

// Crawlable, server-rendered pages for every building / company / neighborhood,
// + sitemap.xml + robots.txt. Mounted BEFORE static so these win over index.html.
seo.mount(app, () => APP_BODY);

// No long-lived HTML cache: the app is one file that gets redeployed, so browsers
// must revalidate (cheap 304s via etag) and pick up new versions immediately.
app.use(express.static(PUBLIC, { maxAge: 0, etag: true, extensions: ['html'] }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC, 'index.html'), err => { if (err) next(); });
});

// Always start serving — the app (city records, the site, local fallback) must
// stay up even if the shared database is briefly unreachable. The community
// store initializes in the background; if it fails, those routes degrade
// gracefully (the frontend falls back to per-device data) instead of the whole
// site going down.
app.listen(PORT, () => {
  console.log(`Radiator app + API on :${PORT}  (mock=${process.env.MOCK === '1'}, store=${store.HAS_PG ? 'postgres' : 'json-file'})`);
});
store.init()
  .then(() => console.log('Shared community store ready.'))
  .catch(e => console.error('Store init failed — community features degraded until the database is reachable:', e.message));
