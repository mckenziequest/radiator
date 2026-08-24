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
    result.website = (external.google && external.google.website) || null;
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

// If the building has an official website, its own hero/social image (og:image)
// is the best photo we can show — grab it server-side, best effort.
async function fetchOgImage(site) {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(site, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RadiatorBot/1.0; +https://getradiator.com)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(to);
    if (!r.ok || !/text\/html/i.test(r.headers.get('content-type') || '')) return null;
    const html = (await r.text()).slice(0, 400000);
    const m =
      html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["']/i);
    if (!m) return null;
    let u = m[1].trim().replace(/&amp;/g, '&');
    try { u = new URL(u, r.url || site).href; } catch (e) { return null; }
    if (!/^https:\/\//i.test(u)) return null;
    return u;
  } catch (e) { return null; }
}

// Build the ordered list of photo URLs for an address (relative /api paths).
async function buildPhotos(address, google) {
  const out = [];
  // 0) The property's OFFICIAL website photo, when a website exists — first.
  if (google && google.website) {
    const og = await fetchOgImage(google.website);
    if (og) out.push(og);
  }
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

// Server-side image cache: building covers now load on EVERY card & page view,
// so repeat requests must not re-hit Google (cost) or wait on it (speed).
const IMG_TTL = 7 * 24 * 3600 * 1000; // 7 days, matches the browser cache header
const IMG_MAX = 400;                  // ~40MB worst case at ~100KB/image
const imgCache = new Map();
function imgGet(k) {
  const e = imgCache.get(k);
  if (e && Date.now() - e.t < IMG_TTL) { imgCache.delete(k); imgCache.set(k, e); return e; } // LRU bump
  if (e) imgCache.delete(k);
  return null;
}
function imgSet(k, ct, buf) {
  if (!buf || buf.length > 2 * 1024 * 1024) return; // don't hoard huge images
  imgCache.set(k, { t: Date.now(), ct, buf });
  while (imgCache.size > IMG_MAX) imgCache.delete(imgCache.keys().next().value);
}
function sendImg(res, ct, buf) {
  res.set('Content-Type', ct || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=604800'); // 7 days
  res.end(buf);
}

// Proxy a single Google Place photo by reference. Streams the image; the key
// is applied here, server-side, and never reaches the client.
app.get('/api/photo', async (req, res) => {
  const ref = (req.query.ref || '').toString();
  if (!GKEY || !ref) return res.status(404).end();
  const hit = imgGet('p:' + ref);
  if (hit) return sendImg(res, hit.ct, hit.buf);
  try {
    const url =
      'https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=' +
      encodeURIComponent(ref) + '&key=' + GKEY;
    const r = await fetch(url); // follows the 302 to the actual image
    if (!r.ok) return res.status(502).end();
    const ct = r.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await r.arrayBuffer());
    imgSet('p:' + ref, ct, buf);
    sendImg(res, ct, buf);
  } catch (e) { res.status(502).end(); }
});

// Proxy a Street View Static image for an address. Same key-hiding pattern.
app.get('/api/streetview', async (req, res) => {
  const address = (req.query.address || '').toString().trim();
  if (!GKEY || !address) return res.status(404).end();
  const key = 'sv:' + address.toLowerCase();
  const hit = imgGet(key);
  if (hit) return hit.neg ? res.status(404).end() : sendImg(res, hit.ct, hit.buf);
  try {
    const loc = `${address.split(',')[0]}, Chicago, IL`;
    // Metadata first (free): without this, addresses with no coverage get Google's
    // gray "no imagery" placeholder instead of a clean 404 the frontend can hide.
    const meta = await (await fetch(
      'https://maps.googleapis.com/maps/api/streetview/metadata?location=' +
      encodeURIComponent(loc) + '&key=' + GKEY)).json();
    if (!meta || meta.status !== 'OK') {
      imgCache.set(key, { t: Date.now(), neg: true });
      return res.status(404).end();
    }
    const url =
      'https://maps.googleapis.com/maps/api/streetview?size=800x450&location=' +
      encodeURIComponent(loc) + '&fov=80&key=' + GKEY;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).end();
    const ct = r.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await r.arrayBuffer());
    imgSet(key, ct, buf);
    sendImg(res, ct, buf);
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
