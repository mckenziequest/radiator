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

// --- CORS: the app is same-origin (page + API share a host), so same-origin
//     requests need NO CORS header and get none. Cross-origin access is opt-in
//     via an EXACT allowlist in CORS_ORIGIN (comma-separated origins). A literal
//     '*' is treated as INVALID/disabled — it is never reflected as
//     `Access-Control-Allow-Origin: *`, so a wildcard left in config can never
//     expose the write/admin endpoints to every origin. An untrusted origin
//     receives no permissive header; preflight (OPTIONS) follows the same rule.
function parseCorsAllowlist(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map(s => s.trim().replace(/\/+$/, '').toLowerCase()) // normalize: trim, strip trailing slash, lowercase
      .filter(o => o && o !== '*')                          // drop blanks and the wildcard
  );
}
const CORS_RAW = process.env.CORS_ORIGIN || '';
const CORS_WILDCARD = /(^|,)\s*\*\s*(,|$)/.test(CORS_RAW);
const CORS_ALLOW = parseCorsAllowlist(CORS_RAW);
if (CORS_WILDCARD) {
  // Non-secret warning only — no origin value, no secret.
  console.warn('CORS_ORIGIN contains "*", which is IGNORED for safety. Set explicit origins to allow cross-origin access, or leave it unset for same-origin only.');
}
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const norm = origin.replace(/\/+$/, '').toLowerCase();
    if (CORS_ALLOW.has(norm)) {
      res.set('Access-Control-Allow-Origin', origin); // echo the exact allowed origin, never '*'
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
      res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    }
    // Untrusted / unlisted origin → no Access-Control-* header at all.
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204); // preflight ends here; the header above (if any) governs it
  next();
});

// --- Preview noindex: on a NON-production host with PREVIEW_MODE=1, tell
//     crawlers not to index the preview (it duplicates production). This header
//     covers EVERY response — HTML, robots.txt, sitemap, API, static — and
//     entity HTML additionally carries a matching <meta name="robots"> (seo.js).
//     seo.isPreview() is a no-op unless PREVIEW_MODE=1, and refuses to fire on a
//     production host, so getradiator.com is never affected. ---
app.use((req, res, next) => {
  if (seo.isPreview(req)) res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
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
const VIOL_DATASET = '22u3-xenr';
// Real City endpoint. Overridable ONLY for deterministic tests (CHI_VIOL_BASE);
// unset in production, so it always uses the real Socrata dataset.
const VIOL_BASE = process.env.CHI_VIOL_BASE || ('https://data.cityofchicago.org/resource/' + VIOL_DATASET + '.json');
const VIOL_SOURCE = 'City of Chicago Building Violations (dataset ' + VIOL_DATASET + ')';
const DETAIL_LIMIT = 60; // only the newest N detail rows are shown; the EXACT totals come from a separate count query.

// Centralized status classifier. The whole dataset uses exactly three statuses
// today — OPEN, COMPLIED, NO ENTRY — but anything unrecognized is surfaced as
// 'unknown' rather than silently miscounted. Count totals and the detail-row
// badges both go through this, so they can never disagree.
function classifyStatus(s) {
  const t = String(s == null ? '' : s).trim().toUpperCase();
  if (t === 'OPEN' || t === 'CITED') return 'open';
  if (t === 'COMPLIED' || t === 'CLOSED') return 'resolved';
  if (t === 'NO ENTRY') return 'noEntry';
  return 'unknown';
}

// --- Address normalization to the City's exact fields --------------------
// The dataset stores street_number, street_direction (always N/S/E/W),
// street_name (FULL name, e.g. "GREEN BAY"; ordinals kept verbatim, e.g. "35TH")
// and street_type (AVE/ST/BLVD/PL/RD/DR/PKWY/CT/TER/HWY/LN/PLZ/WAY/EXPY, or absent).
// We match on ALL supplied components EXACTLY (no first-token prefix), so records
// for N vs S, E vs W, similar names, or different street types can never combine.
const DIR_MAP = { N: 'N', NORTH: 'N', S: 'S', SOUTH: 'S', E: 'E', EAST: 'E', W: 'W', WEST: 'W' };
const TYPE_MAP = { ST: 'ST', STREET: 'ST', AVE: 'AVE', AV: 'AVE', AVENUE: 'AVE', BLVD: 'BLVD', BOULEVARD: 'BLVD', RD: 'RD', ROAD: 'RD', DR: 'DR', DRIVE: 'DR', PL: 'PL', PLACE: 'PL', CT: 'CT', COURT: 'CT', PKWY: 'PKWY', PARKWAY: 'PKWY', HWY: 'HWY', HIGHWAY: 'HWY', TER: 'TER', TERRACE: 'TER', LN: 'LN', LANE: 'LN', PLZ: 'PLZ', PLAZA: 'PLZ', WAY: 'WAY', EXPY: 'EXPY', EXPRESSWAY: 'EXPY' };
const sq = v => String(v == null ? '' : v).replace(/'/g, "''"); // escape single quotes for SoQL
function parseAddress(raw) {
  let s = String(raw || '').toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+(STE|SUITE|UNIT|APT|APARTMENT|FL|FLOOR|RM|ROOM|#)\b.*$/, '').trim(); // drop unit/suite
  const m = s.match(/^(\d+)\s+(.+)$/);
  if (!m) return null;
  const number = m[1];
  let toks = m[2].split(' ').filter(Boolean);
  let dir = '';
  if (toks.length >= 2 && DIR_MAP[toks[0]] !== undefined) { dir = DIR_MAP[toks[0]]; toks = toks.slice(1); } // leading direction
  let type = '';
  if (toks.length >= 2 && TYPE_MAP[toks[toks.length - 1]] !== undefined) { type = TYPE_MAP[toks[toks.length - 1]]; toks = toks.slice(0, -1); } // trailing type
  const name = toks.join(' ').trim();
  if (!name) return null;
  return { number, dir, type, name };
}
function titleWord(w) { return /^\d/.test(w) ? w.replace(/(\d+)(ST|ND|RD|TH)$/i, (m, d, s) => d + s.toLowerCase()) : (w.charAt(0) + w.slice(1).toLowerCase()); }
function formatMatched(number, dir, name, type) { return [number, dir, name.split(' ').map(titleWord).join(' '), type ? titleWord(type) : ''].filter(Boolean).join(' '); }
// The base $where over number + FULL name only; the grouped aggregate over this
// reveals every (direction,type) combo so collisions can be detected.
function baseWhere(p) { return `street_number='${sq(p.number)}' AND upper(street_name)=upper('${sq(p.name)}')`; }
// The FINAL exact $where for a single accepted (direction,type) — used identically
// by both the count derivation and the detail query.
function acceptedWhere(p, dir, type) {
  const parts = [`street_number='${sq(p.number)}'`, `upper(street_name)=upper('${sq(p.name)}')`, `street_direction='${sq(dir)}'`];
  parts.push(type ? `street_type='${sq(type)}'` : 'street_type IS NULL');
  return parts.join(' AND ');
}
// Resolve the requested address to ONE unambiguous (direction,type) combo, or an
// ambiguous/none verdict. Never combines multiple combos.
function resolveMatch(p, combos) {
  const live = combos.filter(c => c.total > 0);
  if (!live.length) return { confidence: 'none', hasRecords: false };            // no violation records on file
  let cand = live.filter(c => (!p.dir || c.dir === p.dir) && (!p.type || c.type === p.type));
  if (cand.length === 1) return { confidence: (p.dir && p.type) ? 'exact' : 'normalized', accepted: cand[0], hasRecords: true };
  if (cand.length > 1) return { confidence: 'ambiguous', hasRecords: true };      // supplied constraints still leave >1 combo
  // cand === 0: the supplied direction/type matched no existing record for this number+name
  return { confidence: 'none', hasRecords: true, mismatch: true };
}
async function socrataJson(params, ms = 25000) {
  const r = await fetch(VIOL_BASE + '?' + params, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

app.get('/api/violations', async (req, res) => {
  const address = (req.query.address || '').toString().trim();
  if (!address) return res.status(400).json({ error: 'address required' });
  const key = address.toLowerCase();
  const hit = violCache.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return res.json(hit.v);

  const fetchedAt = new Date().toISOString();
  const nullOut = (extra) => ({ address, matchedAddress: null, open: null, resolved: null, noEntry: null, unclassified: {}, total: null, countsComplete: false, violations: [], count: 0, detailsReturned: 0, detailsTotal: null, detailsTruncated: false, fetchedAt, source: VIOL_SOURCE, ...extra });

  const p = parseAddress(address);
  if (!p) return res.json(nullOut({ matchConfidence: 'none', noMatch: true, message: 'That address could not be read.' }));

  // Aggregate over number + FULL name, grouped by (direction, type, status). This
  // exposes every collision (N/S, E/W, same name different type) AND gives exact
  // per-combo status counts in ONE query.
  let aggRows;
  try { aggRows = await socrataJson('$select=street_direction,street_type,violation_status,count(1) as n&$where=' + encodeURIComponent(baseWhere(p)) + '&$group=street_direction,street_type,violation_status'); }
  catch (e) { console.error('violations count failed:', e && e.message); return res.json(nullOut({ matchConfidence: null, error: 'lookup failed' })); } // keep snapshot; never zero

  const byCombo = new Map();
  for (const r of (Array.isArray(aggRows) ? aggRows : [])) {
    const dir = r.street_direction || '', type = r.street_type || '', st = r.violation_status, n = Number(r.n) || 0;
    const k = dir + '|' + type; if (!byCombo.has(k)) byCombo.set(k, { dir, type, statuses: {}, total: 0 });
    const cc = byCombo.get(k); cc.statuses[st] = (cc.statuses[st] || 0) + n; cc.total += n;
  }
  const combos = [...byCombo.values()];
  const match = resolveMatch(p, combos);

  // Ambiguous OR a supplied direction/type that matched nothing → do NOT combine,
  // do NOT count, do NOT overwrite the client's snapshot/score.
  if (match.confidence === 'ambiguous' || (match.confidence === 'none' && match.mismatch)) {
    const out = nullOut({ matchConfidence: match.confidence, message: match.confidence === 'ambiguous' ? 'Radiator could not confidently match this address to a single City of Chicago record.' : 'Radiator could not find this exact address in the City of Chicago records.' });
    violCache.set(key, { t: Date.now(), v: out }); return res.json(out);
  }

  // No records at all → the address has no City building-violation records on file
  // (a clean address). 0 is the EXACT truth here.
  if (match.confidence === 'none' && !match.hasRecords) {
    const out = { address, matchedAddress: formatMatched(p.number, p.dir, p.name, p.type) || null, matchConfidence: 'none', open: 0, resolved: 0, noEntry: 0, unclassified: {}, total: 0, countsComplete: true, violations: [], count: 0, detailsReturned: 0, detailsTotal: 0, detailsTruncated: false, fetchedAt, source: VIOL_SOURCE };
    violCache.set(key, { t: Date.now(), v: out }); return res.json(out);
  }

  // Accepted single combo (exact or normalized): exact counts from its statuses.
  const acc = match.accepted;
  const b = { open: 0, resolved: 0, noEntry: 0 }; const unclassified = {};
  for (const [st, n] of Object.entries(acc.statuses)) { const cls = classifyStatus(st); if (cls === 'unknown') unclassified[st] = (unclassified[st] || 0) + n; else b[cls] += n; }
  const total = b.open + b.resolved + b.noEntry + Object.values(unclassified).reduce((a, x) => a + x, 0);

  // DETAIL list uses the IDENTICAL accepted match (number + full name + dir + type).
  const d = await socrataJson('$select=id,violation_date,violation_status,violation_status_date,violation_code,violation_description,violation_ordinance,violation_inspector_comments,department_bureau&$where=' + encodeURIComponent(acceptedWhere(p, acc.dir, acc.type)) + '&$order=' + encodeURIComponent('violation_date DESC') + '&$limit=' + DETAIL_LIMIT)
    .then(rows => {
      const seen = new Set(); const list = [];
      for (const r of (Array.isArray(rows) ? rows : [])) {
        if (r.id != null) { if (seen.has(r.id)) continue; seen.add(r.id); }
        list.push({ id: r.id != null ? String(r.id) : null, date: (r.violation_date || '').slice(0, 10), status: r.violation_status || 'OPEN', statusDate: (r.violation_status_date || '').slice(0, 10) || null, code: r.violation_code || null, desc: r.violation_description || r.violation_ordinance || 'Building code violation', detail: r.violation_inspector_comments || r.violation_ordinance || '', dept: r.department_bureau || null });
      }
      return { ok: true, list };
    })
    .catch(e => ({ ok: false, error: String(e && e.message || e), list: [] }));

  const details = d.ok ? d.list : [];      // detail failure keeps the EXACT counts (countsComplete stays true)
  const detailsReturned = details.length;
  const out = {
    address, matchedAddress: formatMatched(p.number, acc.dir, p.name, acc.type),
    matchConfidence: match.confidence,      // 'exact' | 'normalized'
    open: b.open, resolved: b.resolved, noEntry: b.noEntry, unclassified,
    total, countsComplete: true,
    violations: details, count: detailsReturned,
    detailsReturned, detailsTotal: total, detailsTruncated: total > detailsReturned,
    fetchedAt, source: VIOL_SOURCE,
  };
  violCache.set(key, { t: Date.now(), v: out });
  res.json(out);
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
  const payments = (process.env.PAYMENTS_ENABLED === '1' && process.env.STRIPE_SECRET_KEY) ? 'ENABLED (PAYMENTS_ENABLED=1 + STRIPE_SECRET_KEY)' : 'disabled (needs PAYMENTS_ENABLED=1 + STRIPE_SECRET_KEY → /api/checkout 503)';
  const lease = process.env.LEASE_VERIFY === '1' ? 'ENABLED' : 'disabled (POST /api/verify → 503)';
  const moderation = (process.env.MODERATION_ENABLED === '1' && process.env.ADMIN_KEY) ? 'ENABLED (MODERATION_ENABLED=1 + ADMIN_KEY, header-only)' : 'disabled (needs MODERATION_ENABLED=1 + ADMIN_KEY → 503)';
  console.log(`  beta gates → payments: ${payments} · lease verification: ${lease} · moderation: ${moderation}`);
});
store.init()
  .then(() => console.log('Shared community store ready.'))
  .catch(e => console.error('Store init failed — community features degraded until the database is reachable:', e.message));
