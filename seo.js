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

function load() {
  try {
    DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'seo-data.json'), 'utf8'));
  } catch (e) { console.error('seo-data.json missing — SEO pages disabled:', e.message); return false; }
  DATA.buildings.forEach(b => {
    byId.set(b.id, b);
    if (b.pg) { if (!byPg.has(b.pg)) byPg.set(b.pg, []); byPg.get(b.pg).push(b); }
    if (b.hood) { if (!byHood.has(b.hood)) byHood.set(b.hood, []); byHood.get(b.hood).push(b); }
  });
  return true;
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
function scoreOf(b) { let s = 100 - Math.min(74, b.open * 1.5) + Math.min(6, b.fixed * 0.15); return Math.max(3, Math.min(99, Math.round(s))); }
function gradeOf(s) { return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F'; }
function origin(req) { return (req.headers['x-forwarded-proto'] || 'https') + '://' + (req.headers.host || 'radiator-pkt6.onrender.com'); }

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
<meta name="twitter:description" content="${esc(o.desc)}">
${ld}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%226%22 fill=%22%23F26B3A%22/%3E%3Cg fill=%22%23FFF8F2%22%3E%3Crect x=%226.1%22 y=%226.4%22 width=%222.5%22 height=%2211.2%22 rx=%221.25%22/%3E%3Crect x=%2210.75%22 y=%226.4%22 width=%222.5%22 height=%2211.2%22 rx=%221.25%22 opacity=%22.82%22/%3E%3Crect x=%2215.4%22 y=%226.4%22 width=%222.5%22 height=%2211.2%22 rx=%221.25%22 opacity=%22.6%22/%3E%3C/g%3E%3C/svg%3E">
<style>#ssr-content{max-width:760px;margin:0 auto;padding:40px 22px;font-family:-apple-system,system-ui,"Public Sans",sans-serif;color:#2A2320;line-height:1.6}#ssr-content h1{font-size:1.7rem;line-height:1.15;margin:0 0 10px}#ssr-content a{color:#C24634}#ssr-content .g{display:inline-block;font-weight:800;border-radius:8px;padding:2px 10px;background:#F3E7DC;margin-right:8px}#ssr-content ul{padding-left:18px}@media(prefers-color-scheme:dark){#ssr-content{color:#F5EDE6}#ssr-content .g{background:#332A25}}</style>`;
  return `<!doctype html>\n<html lang="en">\n<head>\n${head}\n</head>\n<body>\n<div id="ssr-content">${o.ssr}</div>\n${appBody}\n</body>\n</html>`;
}

function mount(app, getAppBody) {
  const ok = load();
  if (!ok) return;

  // ---- building page ----
  app.get(['/building/:id', '/building/:id/:slug'], (req, res, next) => {
    const b = byId.get(req.params.id);
    if (!b) return next();
    const o = origin(req);
    const canonical = o + '/building/' + b.id + '/' + slug(b.addr);
    const sc = scoreOf(b), g = gradeOf(sc);
    const siblings = (byHood.get(b.hood) || []).filter(x => x.id !== b.id).slice(0, 8);
    const title = `${b.addr}, ${b.hood} — reviews & city records | Radiator`;
    const desc = `${b.addr} in ${b.hood}, Chicago: Radiator Score ${sc}/100 (${g}). ${b.open} open building violations, ${b.fixed} resolved on file with the City of Chicago. See tenant reviews, rent history, transit and maintenance issues before you sign.`;
    const ssr = `<h1>${esc(b.addr)}, ${esc(b.hood)}</h1>
<p><span class="g">${g}</span> Radiator Score <strong>${sc}/100</strong> — built from real City of Chicago records${b.open ? ' and tenant reviews' : ''}.</p>
<p>This ${esc(b.hood)} building has <strong>${b.open} open building violation${b.open === 1 ? '' : 's'}</strong> and <strong>${b.fixed} resolved</strong> on file with the City of Chicago. On Radiator you can read verified tenant reviews, rent &amp; fee history, transit and parking, and any open maintenance issues for ${esc(b.addr)} — and see what renters say about it across Reddit, Google and Yelp — before you sign a lease.</p>
<p><a href="${o}/">Open ${esc(b.addr)} on Radiator →</a></p>
${b.pg ? `<p>Managed as part of <a href="${o}/company/${esc(b.pg)}">Chicago property group #${esc(b.pg)}</a>.</p>` : ''}
<p>More buildings in <a href="${o}/neighborhood/${slug(b.hood)}">${esc(b.hood)}</a>:</p>
<ul>${siblings.map(x => `<li><a href="${o}/building/${x.id}/${slug(x.addr)}">${esc(x.addr)}</a> — ${x.open} open violation${x.open === 1 ? '' : 's'}</li>`).join('')}</ul>
<p><a href="${o}/">Radiator — check any Chicago building before you sign</a></p>`;
    const jsonld = {
      '@context': 'https://schema.org', '@type': 'ApartmentComplex', name: b.addr,
      address: { '@type': 'PostalAddress', streetAddress: b.addr, addressLocality: 'Chicago', addressRegion: 'IL', addressCountry: 'US' },
      url: canonical, areaServed: b.hood,
    };
    res.set('Cache-Control', 'public, max-age=600');
    res.send(shell(getAppBody(), { title, desc, canonical, jsonld, ssr }));
  });

  // ---- management-company / property-group page ----
  app.get(['/company/:pg', '/company/:pg/:slug'], (req, res, next) => {
    const bs = byPg.get(req.params.pg);
    if (!bs || !bs.length) return next();
    const o = origin(req);
    const canonical = o + '/company/' + req.params.pg;
    const totOpen = bs.reduce((a, x) => a + x.open, 0);
    const hoods = [...new Set(bs.map(x => x.hood))].slice(0, 6);
    const title = `Chicago property group #${req.params.pg} — ${bs.length} buildings, landlord reviews | Radiator`;
    const desc = `A Chicago landlord/management portfolio of ${bs.length} buildings with ${totOpen} open building violations across ${hoods.length} neighborhood(s). See reviews, violation history and tenant experiences for every building on Radiator.`;
    const ssr = `<h1>Chicago property group #${esc(req.params.pg)}</h1>
<p><strong>${bs.length} buildings</strong> · <strong>${totOpen} open building violations</strong> on file with the City of Chicago · ${hoods.map(esc).join(', ')}.</p>
<p>Radiator groups these buildings under one management/ownership portfolio so you can see a landlord's whole track record — not just one address. Look them up across Reddit, Google and Yelp, and read tenant reviews for each building.</p>
<p><a href="${o}/">Open this portfolio on Radiator →</a></p>
<p>Buildings in this portfolio:</p>
<ul>${bs.slice(0, 40).map(x => `<li><a href="${o}/building/${x.id}/${slug(x.addr)}">${esc(x.addr)}</a>, ${esc(x.hood)} — ${x.open} open violation${x.open === 1 ? '' : 's'}</li>`).join('')}</ul>`;
    const jsonld = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Chicago property group #' + req.params.pg, url: canonical, areaServed: 'Chicago, IL' };
    res.set('Cache-Control', 'public, max-age=600');
    res.send(shell(getAppBody(), { title, desc, canonical, jsonld, ssr }));
  });

  // ---- neighborhood page ----
  app.get('/neighborhood/:slug', (req, res, next) => {
    const hood = DATA.hoods.find(h => slug(h) === req.params.slug);
    if (!hood) return next();
    const o = origin(req);
    const canonical = o + '/neighborhood/' + slug(hood);
    const bs = (byHood.get(hood) || []);
    const title = `${hood}, Chicago — apartment reviews & building records | Radiator`;
    const desc = `Check ${bs.length} ${hood} buildings on Radiator: real City of Chicago violation records, tenant reviews, rent history and transit. Find a good apartment in ${hood} before you sign.`;
    const ssr = `<h1>${esc(hood)}, Chicago apartments</h1>
<p>Radiator tracks <strong>${bs.length} buildings</strong> in ${esc(hood)} with their real City of Chicago violation records and tenant reviews. Check any building before you sign a lease.</p>
<p><a href="${o}/">Explore ${esc(hood)} on Radiator →</a></p>
<ul>${bs.slice(0, 60).map(x => `<li><a href="${o}/building/${x.id}/${slug(x.addr)}">${esc(x.addr)}</a> — ${x.open} open violation${x.open === 1 ? '' : 's'}</li>`).join('')}</ul>`;
    res.set('Cache-Control', 'public, max-age=600');
    res.send(shell(getAppBody(), { title, desc, canonical, jsonld: { '@context': 'https://schema.org', '@type': 'Place', name: hood + ', Chicago', url: canonical }, ssr }));
  });

  // ---- robots.txt ----
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\n\nSitemap: ${origin(req)}/sitemap.xml\n`);
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
      DATA.companies.forEach(c => add(o + '/company/' + c.pg, '0.5'));
      DATA.buildings.forEach(b => add(o + '/building/' + b.id + '/' + slug(b.addr), '0.5'));
      sitemapCache = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
      sitemapHost = o;
    }
    res.type('application/xml').send(sitemapCache);
  });

  console.log(`SEO pages live: ${DATA.buildings.length} buildings, ${DATA.companies.length} companies, ${DATA.hoods.length} neighborhoods + sitemap.`);
}

module.exports = { mount };
