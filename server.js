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

// --- CORS: the app is same-origin (page + API share a host), so no CORS header
//     is needed by default. Advertise it ONLY when an origin is explicitly
//     configured — an UNSET CORS_ORIGIN means same-origin, never '*'. ---
const ALLOW = process.env.CORS_ORIGIN || '';
app.use((req, res, next) => {
  if (ALLOW) {
    res.set('Access-Control-Allow-Origin', ALLOW);
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
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
  // Release-data health: if SEO data is missing/malformed, entity SEO and 404s
  // are NOT active, so report unhealthy (503) rather than a green {ok:true}.
  const seoState = (typeof seo.status === 'function') ? seo.status() : { ok: true, buildings: 0, error: null };
  res.status(seoState.ok ? 200 : 503).json({
    ok: seoState.ok,
    seo: seoState.ok ? 'enabled' : 'unavailable',
    seoBuildings: seoState.buildings,
    ...(seoState.error ? { seoError: seoState.error } : {}),
    mock: process.env.MOCK === '1',
    google: !!process.env.GOOGLE_PLACES_KEY || process.env.MOCK === '1',
    yelp: !!process.env.YELP_API_KEY || process.env.MOCK === '1',
    reddit: !!process.env.REDDIT_CLIENT_ID || process.env.MOCK === '1',
    cached: cache.size,
  });
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

    // Photos: a Street View of the actual building (guaranteed for almost every
    // address) plus any Google listing photos — all proxied so the key stays
    // server-side. Computed once and cached alongside the ratings.
    if (external.photos === undefined) {
      external.photos = await buildPhotos(address, external.google);
      cacheSet(cacheKey, external);
    }

    const result = combine(address, sources);
    result.photos = external.photos || [];
    result.cached = !!cached;
    res.json(result);
  } catch (err) {
    console.error('aggregate error:', err);
    res.status(502).json({ error: 'aggregation failed', detail: String(err && err.message || err) });
  }
});

// ============================================================================
// Photos — Street View of the building + Google listing photos, proxied so the
// Google API key is NEVER sent to the browser.
// ============================================================================
const GKEY = process.env.GOOGLE_PLACES_KEY;

// Build the ordered list of photo URLs for an address (relative /api paths).
async function buildPhotos(address, google) {
  const out = [];
  // 1) Street View of the exact building — real, recognizable, near-universal.
  if (GKEY) {
    try {
      const loc = `${String(address).split(',')[0]}, Chicago, IL`;
      const metaUrl =
        'https://maps.googleapis.com/maps/api/streetview/metadata?size=800x450&location=' +
        encodeURIComponent(loc) + '&key=' + GKEY;
      const meta = await (await fetch(metaUrl)).json();
      if (meta && meta.status === 'OK') {
        out.push('/api/streetview?address=' + encodeURIComponent(address));
      }
    } catch (e) { /* street view optional */ }
  }
  // 2) Google listing photos (interiors, amenities, exteriors uploaded by users).
  const refs = (google && google.photoRefs) || [];
  for (const ref of refs.slice(0, 5)) {
    out.push('/api/photo?ref=' + encodeURIComponent(ref));
  }
  return out;
}

// Proxy a single Google Place photo by reference. Streams the image; the key
// is applied here, server-side, and never reaches the client.
app.get('/api/photo', async (req, res) => {
  const ref = (req.query.ref || '').toString();
  if (!GKEY || !ref) return res.status(404).end();
  try {
    const url =
      'https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=' +
      encodeURIComponent(ref) + '&key=' + GKEY;
    const r = await fetch(url); // follows the 302 to the actual image
    if (!r.ok) return res.status(502).end();
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=604800'); // 7 days
    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf);
  } catch (e) { res.status(502).end(); }
});

// Proxy a Street View Static image for an address. Same key-hiding pattern.
app.get('/api/streetview', async (req, res) => {
  const address = (req.query.address || '').toString().trim();
  if (!GKEY || !address) return res.status(404).end();
  try {
    const loc = `${address.split(',')[0]}, Chicago, IL`;
    const url =
      'https://maps.googleapis.com/maps/api/streetview?size=800x450&location=' +
      encodeURIComponent(loc) + '&fov=80&key=' + GKEY;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).end();
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=604800');
    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf);
  } catch (e) { res.status(502).end(); }
});

// ============================================================================
// Past violations — real City of Chicago building-violation records for an
// address, from the open-data portal (dataset 22u3-xenr). Cached 12h.
// ============================================================================
const violCache = new Map();
app.get('/api/violations', async (req, res) => {
  const address = (req.query.address || '').toString().trim();
  if (!address) return res.status(400).json({ error: 'address required' });
  const key = address.toLowerCase();
  const hit = violCache.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return res.json(hit.v);

  // Parse "540 N STATE St" -> number 540, name STATE (dataset stores name w/o type/dir).
  const m = address.match(/^\s*(\d+)\s+([NSEW])?\s*(.+?)\s*$/i);
  if (!m) return res.json({ violations: [], count: 0 });
  const num = m[1];
  // strip a leading direction + trailing street-type words for a forgiving match
  let core = m[3].replace(/\b(st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ct|court|pl|place|ln|lane|ter|terrace|pkwy|parkway|way|sq|square)\b\.?/gi, '').trim();
  const nameLike = core.split(/\s+/)[0] || core; // first token of the street name
  try {
    const soql =
      "$where=" + encodeURIComponent(`street_number='${num}' AND upper(street_name) like upper('${nameLike.replace(/'/g, "''")}%')`) +
      "&$order=" + encodeURIComponent('violation_date DESC') +
      "&$limit=60";
    const url = 'https://data.cityofchicago.org/resource/22u3-xenr.json?' + soql;
    const rows = await (await fetch(url, { headers: { 'Accept': 'application/json' } })).json();
    const list = (Array.isArray(rows) ? rows : []).map((r) => ({
      date: (r.violation_date || '').slice(0, 10),
      status: r.violation_status || 'OPEN',
      statusDate: (r.violation_status_date || '').slice(0, 10) || null,
      code: r.violation_code || null,
      desc: r.violation_description || r.violation_ordinance || 'Building code violation',
      detail: r.violation_inspector_comments || r.violation_ordinance || '',
      dept: r.department_bureau || null,
    }));
    const open = list.filter((v) => !/COMPLIED|NO ENTRY|CLOSED/i.test(v.status)).length;
    const out = { address, count: list.length, open, resolved: list.length - open, violations: list };
    violCache.set(key, { t: Date.now(), v: out });
    res.json(out);
  } catch (e) {
    console.error('violations fetch failed:', e.message);
    res.json({ violations: [], count: 0, error: 'lookup failed' });
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
  // The app template carries a leading <title> at the top of its body; strip it so
  // an SEO page (which supplies its own per-page <title> in the head) has exactly one.
  APP_BODY = (m ? m[1] : full).replace(/^\s*<title>[\s\S]*?<\/title>\s*/i, '');
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
  // Non-secret beta-safety summary — confirms at a glance that the free-beta gates
  // are the SERVER's, not a client flag. Never logs any secret VALUE, only on/off.
  const payments = process.env.STRIPE_SECRET_KEY ? 'ENABLED (Stripe key set)' : 'disabled';
  const lease = process.env.LEASE_VERIFY === '1' ? 'ENABLED' : 'disabled (POST /api/verify → 503)';
  const moderation = process.env.ADMIN_KEY ? 'admin-only (ADMIN_KEY set)' : 'disabled (no ADMIN_KEY → 503)';
  console.log(`  beta gates → payments: ${payments} · lease verification: ${lease} · moderation: ${moderation}`);
});
store.init()
  .then(() => console.log('Shared community store ready.'))
  .catch(e => console.error('Store init failed — community features degraded until the database is reachable:', e.message));
