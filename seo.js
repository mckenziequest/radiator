// seo.js — makes Radiator findable on Google.
//
// The app is a single-page app, so on its own every URL looks identical to a
// crawler. This module serves REAL, unique, server-rendered HTML for every
// building, management company, and neighborhood — proper <title>, meta
// description, canonical URL, structured data (JSON-LD), and crawlable internal
// links — then hands off to the same interactive app for humans. Plus a
// sitemap.xml and robots.txt so Google can discover all ~16k pages.

const fs = require('fs');
const path = require('path');

let DATA = { buildings: [], hoods: [], companies: [], generated: '' };
let byId = new Map(), byPg = new Map(), byHood = new Map();
// Named management firms + friendly building names — projected from radiator3.html
// (the single source of truth) into entity-manifest.json by build_deploy.mjs, so
// the server renders the same firm pages and building names the client shows.
let FIRMS = new Map();      // id -> { id, name, kind }
let NAMES = new Map();      // building address -> friendly name

// Release-data health. When SEO data is missing or malformed the server must
// NOT pretend entity SEO/404s are active: entity routes fail-closed (503) and
// /api/health reports unhealthy (see mountDegraded + status()).
let LOADED = false, LOAD_ERROR = null;
function status() { return { ok: LOADED, buildings: LOADED ? DATA.buildings.length : 0, error: LOAD_ERROR }; }

function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'seo-data.json'), 'utf8'));
  } catch (e) {
    LOAD_ERROR = 'seo-data.json missing or unreadable — run `node build_deploy.mjs build`';
    console.error('SEO data unavailable — entity routes will 503:', e.message);
    return false;
  }
  // Reject a malformed/empty snapshot — an empty file must not read as healthy.
  if (!raw || !Array.isArray(raw.buildings) || raw.buildings.length === 0 ||
      !Array.isArray(raw.hoods) || !Array.isArray(raw.companies)) {
    LOAD_ERROR = 'seo-data.json is malformed (missing or empty buildings/hoods/companies)';
    console.error('SEO data malformed — entity routes will 503.');
    return false;
  }
  DATA = raw;
  DATA.buildings.forEach(b => {
    byId.set(b.id, b);
    if (b.pg) { if (!byPg.has(b.pg)) byPg.set(b.pg, []); byPg.get(b.pg).push(b); }
    if (b.hood) { if (!byHood.has(b.hood)) byHood.set(b.hood, []); byHood.get(b.hood).push(b); }
  });
  try {
    const man = JSON.parse(fs.readFileSync(path.join(__dirname, 'entity-manifest.json'), 'utf8'));
    (man.firms || []).forEach(f => FIRMS.set(f.id, f));
    Object.keys(man.buildingNames || {}).forEach(addr => NAMES.set(addr, man.buildingNames[addr]));
  } catch (e) { console.error('entity-manifest.json missing — firm pages & name parity disabled:', e.message); }
  LOADED = true; LOAD_ERROR = null;
  return true;
}
// Friendly building name when we have one (parity with the client's nameOf()),
// otherwise the street address.
function nameOfBuilding(b) { return NAMES.get(b.addr) || b.addr; }

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
function scoreOf(b) { let s = 100 - Math.min(85, b.open * 2.5); if (b.open >= 3) s = Math.min(s, 80); return Math.max(3, Math.min(99, Math.round(s))); }
function gradeOf(s) { return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F'; }
function origin(req) { return (req.headers['x-forwarded-proto'] || 'https') + '://' + (req.headers.host || 'radiator-pkt6.onrender.com'); }

// --- Preview-mode noindex gate --------------------------------------------
// A non-production preview (e.g. radiator-preview.onrender.com) serves the same
// content as production and must NOT be indexed as duplicate content. Protection
// is OFF unless PREVIEW_MODE=1 is explicitly set, so production — which never
// sets it — is always indexable by construction. As defense-in-depth it ALSO
// refuses to activate on a known production host, so a mis-set PREVIEW_MODE on
// getradiator.com still cannot noindex production. Uses the SAME host source as
// origin() (req.headers.host, the external host Render passes through).
const PROD_HOSTS = new Set(['getradiator.com', 'www.getradiator.com', 'radiator-pkt6.onrender.com']);
const PREVIEW_ROBOTS = 'noindex, nofollow, noarchive';
// Normalize a Host header for comparison: trim, lowercase, drop an optional :port.
function normalizeHost(h) { return String(h == null ? '' : h).trim().toLowerCase().replace(/:\d+$/, ''); }
function isPreview(req) {
  if (process.env.PREVIEW_MODE !== '1') return false;                       // primary gate: explicit opt-in only
  return !PROD_HOSTS.has(normalizeHost(req && req.headers && req.headers.host)); // never activate on a production host
}

// Compose the full HTML doc: SEO head + a server-rendered content block + the app.
function shell(appBody, o) {
  const ld = o.jsonld ? `<script type="application/ld+json">${JSON.stringify(o.jsonld)}</script>` : '';
  const head = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.desc)}">
<link rel="canonical" href="${esc(o.canonical)}">
<meta name="theme-color" content="#F26B3A">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Radiator">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.desc)}">
<meta property="og:url" content="${esc(o.canonical)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.desc)}">${o.robots ? `\n<meta name="robots" content="${esc(o.robots)}">` : ''}
${ld}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%226%22 fill=%22%23F26B3A%22/%3E%3Cg fill=%22%23FFF8F2%22%3E%3Crect x=%226.1%22 y=%226.4%22 width=%222.5%22 height=%2211.2%22 rx=%221.25%22/%3E%3Crect x=%2210.75%22 y=%226.4%22 width=%222.5%22 height=%2211.2%22 rx=%221.25%22 opacity=%22.82%22/%3E%3Crect x=%2215.4%22 y=%226.4%22 width=%222.5%22 height=%2211.2%22 rx=%221.25%22 opacity=%22.6%22/%3E%3C/g%3E%3C/svg%3E">
<style>#ssr-content{max-width:760px;margin:0 auto;padding:40px 22px;font-family:-apple-system,system-ui,"Public Sans",sans-serif;color:#2A2320;line-height:1.6}#ssr-content h1{font-size:1.7rem;line-height:1.15;margin:0 0 10px}#ssr-content a{color:#C24634}#ssr-content .g{display:inline-block;font-weight:800;border-radius:8px;padding:2px 10px;background:#F3E7DC;margin-right:8px}#ssr-content ul{padding-left:18px}@media(prefers-color-scheme:dark){#ssr-content{color:#F5EDE6}#ssr-content .g{background:#332A25}}</style>`;
  return `<!doctype html>\n<html lang="en">\n<head>\n${head}\n</head>\n<body>\n<div id="ssr-content">${o.ssr}</div>\n${appBody}\n</body>\n</html>`;
}

function notFound(appBody, o, pth) {
  const canonical = o + (pth || '/'); // self-referential, never the homepage
  const ssr = `<h1>Page not found</h1>\n<p>We couldn't find that page on Radiator. The building, company, or link may have moved or never existed.</p>\n<p><a href="${o}/">Go to Radiator</a> · <a href="${o}/explore">Search Chicago buildings</a></p>`;
  // noindex so a bad URL is never indexed as a real page; jsonld null so no
  // entity structured data appears on a not-found response.
  return shell(appBody, { title: 'Page not found | Radiator', desc: 'That page could not be found on Radiator.', canonical, ssr, jsonld: null, robots: 'noindex, nofollow' });
}
// Non-entity SPA routes that always serve the app shell. Entity segments
// (building, firm, company, landlord, neighborhood) are intentionally NOT here:
// each has an explicit :id handler above that 200s a valid entity and 404s an
// invalid/missing one, so a bare or unknown entity path falls through to the
// catch-all and gets a real 404 instead of a soft 200 shell.
const KNOWN_ROUTES = new Set(['', 'explore', 'map', 'compare', 'neighborhoods', 'tools', 'pricing', 'saved', 'guide', 'profile', 'write', 'issue', 'terms', 'privacy', 'guidelines', 'directory', 'about', 'help']);
// Dynamic entity segments — these must never silently serve a 200 app shell.
const ENTITY_SEGS = new Set(['building', 'firm', 'company', 'landlord', 'neighborhood']);

// Fail-closed: when release SEO data is unavailable, entity routes return a
// real 503 (noindex, no fake entity metadata) instead of a soft 200 shell, and
// /api/health reports unhealthy. Static app routes still work.
function mountDegraded(app, getAppBody) {
  console.error('SEO pages DISABLED (data unavailable): ' + (LOAD_ERROR || 'unknown') + ' — entity routes return 503; /api/health is unhealthy.');
  const unavailable = (req, res) => {
    const o = origin(req);
    const ssr = `<h1>Temporarily unavailable</h1>\n<p>Building, company and neighborhood pages are briefly unavailable while records finish loading. Please try again shortly.</p>\n<p><a href="${o}/">Go to Radiator</a></p>`;
    res.status(503).set('Retry-After', '120').send(shell(getAppBody(), {
      title: 'Temporarily unavailable | Radiator', desc: 'This page is briefly unavailable.',
      canonical: o + (req.path || '/'), ssr, jsonld: null, robots: 'noindex, nofollow',
    }));
  };
  app.get(['/building/:id', '/building/:id/:slug', '/firm/:id', '/company/:pg', '/company/:pg/:slug',
    '/neighborhood/:slug', '/landlord/:pg', '/landlord/:pg/:slug'], unavailable);
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const seg = (req.path.split('/').filter(Boolean)[0] || '');
    if (ENTITY_SEGS.has(seg)) return unavailable(req, res);      // entity path → 503, never a 200 shell
    if (KNOWN_ROUTES.has(seg)) return next();                    // home/explore/etc. → static app shell
    return res.status(404).send(notFound(getAppBody(), origin(req), req.path)); // unknown top-level → real 404
  });
}

function mount(app, getAppBody) {
  const ok = load();
  if (!ok) { mountDegraded(app, getAppBody); return; }

  // ---- building page ----
  app.get(['/building/:id', '/building/:id/:slug'], (req, res, next) => {
    const b = byId.get(req.params.id);
    if (!b) return res.status(404).send(notFound(getAppBody(), origin(req), req.path));
    const o = origin(req);
    const canonical = o + '/building/' + b.id + '/' + slug(b.addr);
    // NOTE: the snapshot fields (b.open/b.fixed and any score/grade derived from
    // them) are a periodic build-time City-records snapshot that the hydrated
    // client replaces with a LIVE per-building lookup. They diverge (a snapshot
    // "0 open / grade A" building can be "3 open / grade B" live), so they are
    // deliberately NOT rendered in server HTML or JSON-LD — the SSR states only
    // stable facts (address, neighborhood, management, that City records exist)
    // and the live counts load on the page. Truthfulness over a richer snippet.
    const name = nameOfBuilding(b); // friendly name when seeded, else the address (matches the client)
    const named = name !== b.addr;
    const siblings = (byHood.get(b.hood) || []).filter(x => x.id !== b.id).slice(0, 8);
    const title = `${name}, ${b.hood} — reviews & city records | Radiator`;
    const desc = `${b.addr} in ${b.hood}, Chicago. See City of Chicago building-violation records, tenant reviews, rent history, transit and open maintenance issues for this building on Radiator — the current open and resolved counts load live on the page. Check it before you sign.`;
    const ssr = `<h1>${esc(name)}</h1>${named ? `\n<p>${esc(b.addr)}, ${esc(b.hood)}</p>` : ''}
<p>${esc(b.addr)} is a building in ${esc(b.hood)}, Chicago with building-code records on file with the City of Chicago (Building Violations dataset 22u3-xenr).</p>
<p>Open ${esc(b.addr)} on Radiator to see its <strong>current</strong> open and resolved City-violation counts — pulled live from the City of Chicago when the page loads — along with verified tenant reviews, rent &amp; fee history, transit and parking, and any open maintenance issues, and what renters say across Reddit, Google and Yelp, before you sign a lease.</p>
<p><a href="${o}/">Open ${esc(b.addr)} on Radiator →</a></p>
${b.pg ? `<p>Managed as part of <a href="${o}/company/${esc(b.pg)}">Chicago property group #${esc(b.pg)}</a>.</p>` : ''}
<p>More buildings in <a href="${o}/neighborhood/${slug(b.hood)}">${esc(b.hood)}</a>:</p>
<ul>${siblings.map(x => `<li><a href="${o}/building/${x.id}/${slug(x.addr)}">${esc(x.addr)}</a></li>`).join('')}</ul>
<p><a href="${o}/">Radiator — check any Chicago building before you sign</a></p>`;
    const jsonld = {
      '@context': 'https://schema.org', '@type': 'ApartmentComplex', name: name,
      address: { '@type': 'PostalAddress', streetAddress: b.addr, addressLocality: 'Chicago', addressRegion: 'IL', addressCountry: 'US' },
      url: canonical, areaServed: b.hood,
    };
    res.set('Cache-Control', 'public, max-age=600');
    res.send(shell(getAppBody(), { title, desc, canonical, jsonld, ssr, robots: isPreview(req) ? PREVIEW_ROBOTS : undefined }));
  });

  // ---- management-company / property-group page ----
  app.get(['/company/:pg', '/company/:pg/:slug'], (req, res, next) => {
    const bs = byPg.get(req.params.pg);
    if (!bs || !bs.length) return res.status(404).send(notFound(getAppBody(), origin(req), req.path));
    const o = origin(req);
    const canonical = o + '/company/' + req.params.pg;
    // Snapshot open-counts are omitted here for the same reason as the building
    // page (periodic snapshot diverges from the live per-building count).
    const hoods = [...new Set(bs.map(x => x.hood))].slice(0, 6);
    const title = `Chicago property group #${req.params.pg} — ${bs.length} buildings, landlord reviews | Radiator`;
    const desc = `A Chicago landlord/management portfolio of ${bs.length} buildings across ${hoods.length} neighborhood(s). See City of Chicago violation records, reviews and tenant experiences for every building on Radiator.`;
    const ssr = `<h1>Chicago property group #${esc(req.params.pg)}</h1>
<p><strong>${bs.length} buildings</strong> with City of Chicago building-code records · ${hoods.map(esc).join(', ')}.</p>
<p>Radiator groups these buildings under one management/ownership portfolio so you can see a landlord's whole track record — not just one address. Open any building for its current, live City-violation counts, look them up across Reddit, Google and Yelp, and read tenant reviews.</p>
<p><a href="${o}/">Open this portfolio on Radiator →</a></p>
<p>Buildings in this portfolio:</p>
<ul>${bs.slice(0, 40).map(x => `<li><a href="${o}/building/${x.id}/${slug(x.addr)}">${esc(x.addr)}</a>, ${esc(x.hood)}</li>`).join('')}</ul>`;
    const jsonld = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Chicago property group #' + req.params.pg, url: canonical, areaServed: 'Chicago, IL' };
    res.set('Cache-Control', 'public, max-age=600');
    res.send(shell(getAppBody(), { title, desc, canonical, jsonld, ssr, robots: isPreview(req) ? PREVIEW_ROBOTS : undefined }));
  });

  // ---- /landlord/:pg — obsolete alias. The canonical landlord URL is
  //      /company/:pg (every internal link uses that), so redirect a valid pg
  //      there deliberately; an unknown pg is a real 404. ----
  app.get(['/landlord/:pg', '/landlord/:pg/:slug'], (req, res) => {
    const bs = byPg.get(req.params.pg);
    if (!bs || !bs.length) return res.status(404).send(notFound(getAppBody(), origin(req), req.path));
    res.redirect(301, '/company/' + req.params.pg);
  });

  // ---- named management-firm page (SEED_COMPANIES via the manifest) ----
  app.get('/firm/:id', (req, res) => {
    const f = FIRMS.get(req.params.id);
    if (!f) return res.status(404).send(notFound(getAppBody(), origin(req), req.path));
    const o = origin(req);
    const canonical = o + '/firm/' + f.id;
    const title = `${f.name} — Chicago property management reviews | Radiator`;
    const desc = `What Chicago renters and the web say about ${f.name} — ${f.kind}. Reputation links, reviews, and tenant-tagged buildings on Radiator.`;
    const ssr = `<h1>${esc(f.name)}</h1>
<p>${esc(f.kind)} in Chicago. See what renters and the web say about ${esc(f.name)} — reviews across Google, Yelp and Reddit, and buildings tenants have tagged to this company — before you rent from them.</p>
<p><a href="${o}/">Open ${esc(f.name)} on Radiator →</a></p>
<p><a href="${o}/directory">Browse all Chicago management companies</a></p>`;
    const jsonld = { '@context': 'https://schema.org', '@type': 'Organization', name: f.name, url: canonical, areaServed: 'Chicago, IL' };
    res.set('Cache-Control', 'public, max-age=600');
    res.send(shell(getAppBody(), { title, desc, canonical, jsonld, ssr, robots: isPreview(req) ? PREVIEW_ROBOTS : undefined }));
  });

  // ---- neighborhood page ----
  app.get('/neighborhood/:slug', (req, res, next) => {
    const hood = DATA.hoods.find(h => slug(h) === req.params.slug);
    if (!hood) return res.status(404).send(notFound(getAppBody(), origin(req), req.path));
    const o = origin(req);
    const canonical = o + '/neighborhood/' + slug(hood);
    const bs = (byHood.get(hood) || []);
    const title = `${hood}, Chicago — apartment reviews & building records | Radiator`;
    const desc = `Check ${bs.length} ${hood} buildings on Radiator: real City of Chicago violation records, tenant reviews, rent history and transit. Find a good apartment in ${hood} before you sign.`;
    const ssr = `<h1>${esc(hood)}, Chicago apartments</h1>
<p>Radiator tracks <strong>${bs.length} buildings</strong> in ${esc(hood)} with their City of Chicago building-violation records and tenant reviews. Open any building for its current, live City-violation counts, and check it before you sign a lease.</p>
<p><a href="${o}/">Explore ${esc(hood)} on Radiator →</a></p>
<ul>${bs.slice(0, 60).map(x => `<li><a href="${o}/building/${x.id}/${slug(x.addr)}">${esc(x.addr)}</a></li>`).join('')}</ul>`;
    res.set('Cache-Control', 'public, max-age=600');
    res.send(shell(getAppBody(), { title, desc, canonical, jsonld: { '@context': 'https://schema.org', '@type': 'Place', name: hood + ', Chicago', url: canonical }, ssr, robots: isPreview(req) ? PREVIEW_ROBOTS : undefined }));
  });

  // ---- robots.txt ----
  // Crawling stays allowed in every mode so bots can fetch pages and SEE the
  // noindex directive (a Disallow would block the fetch and defeat noindex). On
  // a preview we simply do NOT advertise the sitemap; production is unchanged.
  app.get('/robots.txt', (req, res) => {
    const base = `User-agent: *\nAllow: /\n`;
    res.type('text/plain').send(isPreview(req) ? base : base + `\nSitemap: ${origin(req)}/sitemap.xml\n`);
  });

  // ---- sitemap.xml (cached after first build) ----
  let sitemapCache = null, sitemapHost = null;
  app.get('/sitemap.xml', (req, res) => {
    const o = origin(req);
    if (!sitemapCache || sitemapHost !== o) {
      const urls = [];
      const add = (u, pri) => urls.push(`<url><loc>${esc(u)}</loc>${pri ? `<priority>${pri}</priority>` : ''}</url>`);
      add(o + '/', '1.0');
      ['/explore', '/pricing', '/neighborhoods', '/map', '/tools'].forEach(p => add(o + p, '0.7'));
      DATA.hoods.forEach(h => add(o + '/neighborhood/' + slug(h), '0.6'));
      FIRMS.forEach(f => add(o + '/firm/' + f.id, '0.6'));
      DATA.companies.forEach(c => add(o + '/company/' + c.pg, '0.5'));
      DATA.buildings.forEach(b => add(o + '/building/' + b.id + '/' + slug(b.addr), '0.5'));
      sitemapCache = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
      sitemapHost = o;
    }
    res.type('application/xml').send(sitemapCache);
  });

  // Unknown top-level routes get a real 404 + not-found head so crawlers and the
  // client agree, instead of silently serving the homepage.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const seg = (req.path.split('/').filter(Boolean)[0] || '');
    if (KNOWN_ROUTES.has(seg)) return next(); // valid app route -> SPA (static/index)
    res.status(404).send(notFound(getAppBody(), origin(req), req.path));
  });

  console.log(`SEO pages live: ${DATA.buildings.length} buildings, ${DATA.companies.length} companies, ${DATA.hoods.length} neighborhoods + sitemap.`);
}

module.exports = { mount, status, isPreview, normalizeHost };
