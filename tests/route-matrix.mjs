/* Route-matrix test — server HTTP behavior AND hydrated client behavior for every
   dynamic entity route. Run against a local server:
     MOCK=1 PORT=8899 node ../server.js &   then   BASE=http://localhost:8899 node tests/route-matrix.mjs
   Requires playwright (installed in the workspace). */
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:8899';
const EXE = process.env.PW_EXE || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let pass = 0, fail = 0;
const log = (ok, name, extra = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (extra ? (' · ' + extra) : '')); };

// ---- server-side probes (node fetch, no browser) ----
// decode the handful of HTML entities that appear in server-rendered <title>/<meta>
const dec = s => s == null ? s : s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
async function head(path) {
  const res = await fetch(BASE + path, { redirect: 'manual' });
  const html = (res.status >= 300 && res.status < 400) ? '' : await res.text();
  const pick = re => { const m = html.match(re); return m ? m[1] : null; };
  // count only the FIRST <head> title and only real ld+json <script> tags (the
  // client JS source mentions the string "application/ld+json", so a naive
  // substring match over-counts).
  const ldTags = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  return {
    status: res.status,
    location: res.headers.get('location'),
    title: dec(pick(/<title>([^<]*)<\/title>/)),
    titleCount: (html.match(/<title>/g) || []).length,
    canonical: dec(pick(/<link rel="canonical" href="([^"]*)"/)),
    robots: pick(/<meta name="robots" content="([^"]*)"/),
    jsonldCount: ldTags.length,
    hasOrgLd: ldTags.some(t => /"@type":\s*"Organization"/.test(t)),
    hasAptLd: ldTags.some(t => /"@type":\s*"ApartmentComplex"/.test(t)),
  };
}

// Valid entities → 200 with correct metadata
{
  const f = await head('/firm/fulton-grace');
  log(f.status === 200 && /Fulton Grace/.test(f.title) && f.canonical.endsWith('/firm/fulton-grace') && f.titleCount === 1 && f.jsonldCount === 1 && f.hasOrgLd && !f.robots,
    'server firm valid → 200, one title, firm canonical, Organization JSON-LD, indexable', JSON.stringify({ st: f.status, tc: f.titleCount, ld: f.jsonldCount, robots: f.robots }));

  const b = await head('/building/r7475/555-w-madison-st'); // Presidential Towers (seed-named)
  log(b.status === 200 && /Presidential Towers/.test(b.title) && b.titleCount === 1 && b.jsonldCount === 1 && b.hasAptLd,
    'server building (seed-named) → 200, friendly name in title, one JSON-LD', JSON.stringify({ title: b.title }));

  const c = await head('/company/1052');
  log(c.status === 200 && c.titleCount === 1 && c.jsonldCount === 1, 'server company valid → 200, one title/JSON-LD', 'st=' + c.status);

  const n = await head('/neighborhood/austin');
  log(n.status === 200 && n.titleCount === 1, 'server neighborhood valid → 200', 'st=' + n.status);

  const l = await head('/landlord/1052');
  log(l.status === 301 && /\/company\/1052$/.test(l.location || ''), 'server landlord valid → 301 to /company/:pg', 'loc=' + l.location);
}

// Invalid / missing / malformed → 404, noindex, no entity JSON-LD, self canonical
const badCases = [
  ['/firm/not-a-real-firm', 'firm invalid'],
  ['/firm/', 'firm missing id'],
  ['/landlord/not-a-real-landlord', 'landlord invalid'],
  ['/landlord/', 'landlord missing id'],
  ['/building/not-a-real-id', 'building invalid'],
  ['/building/', 'building missing id'],
  ['/company/not-a-real-id', 'company invalid'],
  ['/company/', 'company missing id'],
  ['/neighborhood/not-a-real-neighborhood', 'neighborhood invalid'],
  ['/firm/%00%27%22%3E%3Cscript%3E', 'firm malformed'],
  ['/building/r0%27%22%3E%3Cscript%3E', 'building malformed'],
  ['/totally-unknown-xyz', 'unknown top-level'],
];
for (const [path, label] of badCases) {
  const r = await head(path);
  const okStatus = r.status === 404;
  const noindex = /noindex/.test(r.robots || '');
  const noEntityLd = r.jsonldCount === 0 && !r.hasOrgLd && !r.hasAptLd;
  const selfCanon = !r.canonical || !/\/$/.test(new URL(r.canonical).pathname) || path === '/'; // not the homepage
  const notHome = !r.canonical || new URL(r.canonical).pathname !== '/';
  log(okStatus && noindex && noEntityLd && notHome, '404: ' + label, JSON.stringify({ st: r.status, robots: r.robots, ld: r.jsonldCount, canon: r.canonical && new URL(r.canonical).pathname }));
}

// ---- client-side hydration + server/client agreement ----
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await ctx.newPage();
const jsErrors = []; page.on('pageerror', e => jsErrors.push(e.message));
const snap = async (path) => {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(900);
  return page.evaluate(() => {
    const h1s = [...document.querySelectorAll('h1')].filter(h => { const s = getComputedStyle(h); const r = h.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && !h.classList.contains('sr-only') && r.width > 1 && r.height > 1; });
    return {
      view: (typeof nav !== 'undefined' ? nav.view : '?'),
      title: document.title, pathname: location.pathname,
      canonicalN: document.querySelectorAll('link[rel=canonical]').length,
      canonical: (document.querySelector('link[rel=canonical]') || {}).href || null,
      jsonldN: document.querySelectorAll('script[type="application/ld+json"]').length,
      robots: (document.querySelector('meta[name=robots]') || {}).content || null,
      visibleH1: h1s.length, h1text: (h1s[0] || {}).textContent || null,
    };
  });
};

// valid firm: client shows firm, one h1, one JSON-LD, title agrees with server
{
  const s = await head('/firm/fulton-grace');
  const c = await snap('/firm/fulton-grace');
  log(c.view === 'firm' && c.visibleH1 === 1 && c.jsonldN === 1 && c.canonicalN === 1 && c.title === s.title,
    'client firm valid: 1 visible h1, 1 JSON-LD, title agrees with server', JSON.stringify({ view: c.view, h1: c.visibleH1, ld: c.jsonldN, agree: c.title === s.title }));
}
// seed-named building: server/client title + canonical agreement
{
  const s = await head('/building/r7475/555-w-madison-st');
  const c = await snap('/building/r7475/555-w-madison-st');
  log(c.title === s.title && /Presidential Towers/.test(c.title), 'building (seed-named): client title == server title', JSON.stringify({ server: s.title, client: c.title }));
  log(c.canonical && s.canonical && new URL(c.canonical).pathname === new URL(s.canonical).pathname, 'building (seed-named): canonical agrees', c.canonical);
  log(c.visibleH1 === 1 && c.jsonldN === 1, 'building (seed-named): 1 visible h1, 1 JSON-LD', JSON.stringify({ h1: c.visibleH1, ld: c.jsonldN }));
}
// invalid entities: client not-found, noindex, self URL preserved, one h1, no entity JSON-LD kept
for (const [path, label] of [['/firm/not-a-real-firm', 'firm'], ['/company/999999', 'company'], ['/neighborhood/nope', 'neighborhood'], ['/building/', 'building missing']]) {
  const c = await snap(path);
  const notHome = c.canonical && new URL(c.canonical).pathname !== '/';
  log(c.view === 'notfound' && c.visibleH1 === 1 && /noindex/.test(c.robots || '') && notHome && c.pathname !== '/',
    'client invalid ' + label + ': notfound, noindex, self-URL, 1 h1', JSON.stringify({ view: c.view, robots: c.robots, url: c.pathname, canonPath: c.canonical && new URL(c.canonical).pathname }));
}
// nav Back/Forward restores metadata
{
  await snap('/firm/fulton-grace');
  await page.evaluate(() => tab('explore')); await page.waitForTimeout(500);
  await page.goBack(); await page.waitForTimeout(700);
  const back = await page.evaluate(() => ({ view: nav.view, title: document.title, ld: document.querySelectorAll('script[type="application/ld+json"]').length, canonN: document.querySelectorAll('link[rel=canonical]').length }));
  log(back.view === 'firm' && /Fulton Grace/.test(back.title) && back.ld === 1 && back.canonN === 1, 'Back restores firm metadata (1 JSON-LD, 1 canonical)', JSON.stringify(back));
}

console.log('\nJS errors during run: ' + jsErrors.length + (jsErrors.length ? (' :: ' + jsErrors.slice(0, 3).join(' | ')) : ''));
console.log('RESULTS: ' + pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail > 0 ? 1 : 0);
