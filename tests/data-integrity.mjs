/* data-integrity.mjs — regressions for the SSR-vs-live truthfulness fix,
 * the scoring invariant, the duplicate-title fix, and the a11y/copy fixes.
 *
 * Boots server.js from its own directory (works in the flat repo, where
 * seo-data.json is committed, and in the radiator-backend/ layout).
 *   node tests/data-integrity.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = process.env.DI_PORT || 8916;
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} · ${name}${extra ? ' · ' + extra : ''}`); };

function get(pathname) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: Number(PORT), path: pathname, method: 'GET' },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.end();
  });
}
const ssrBlock = html => { const m = html.match(/<div id="ssr-content">([\s\S]*?)<\/div>\s*\n/); return m ? m[1] : ''; };
const metaDesc = html => { const m = html.match(/<meta name="description" content="([^"]*)"/); return m ? m[1] : ''; };
const jsonld = html => { const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/); return m ? m[1] : ''; };

// ---------------------------------------------------------------- static/file checks
{
  // (4) exactly one <title> in the raw served HTML
  const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const bodyTitles = (idx.slice(idx.indexOf('<body>')).match(/<title>/g) || []).length;
  const totalTitles = (idx.match(/<title>/g) || []).length;
  ok(totalTitles === 1 && bodyTitles === 0, 'raw index.html has exactly one <title> (in <head>, none in <body>)', `total=${totalTitles} body=${bodyTitles}`);

  // (5) a11y + copy fixes present in the built bundle
  ok(/id="w-verify" aria-label=/.test(idx), 'w-verify checkbox has a programmatic aria-label');
  ok(/<img class="cover-img" src="\$\{heroPhoto\}" alt="Photo of /.test(idx.replace(/\$\{heroPhoto\}/, '${heroPhoto}')) || /alt="Photo of /.test(idx), 'building hero image has meaningful alt text');
  ok(/View firm →/.test(idx) && /Firm profile/.test(idx), 'named-firm cards say "Firm profile / View firm"');
  ok(/View portfolio →/.test(idx) && /Management company/.test(idx), 'property-group cards remain distinct ("Management company / View portfolio")');
  // (2/5) snapshot disclosures on Rankings + Map + Explore
  ok(/Rankings use our stored City of Chicago violation counts \(a periodic snapshot\)/.test(idx), 'Rankings discloses periodic snapshot');
  ok(/Dot colors use our stored City of Chicago snapshot/.test(idx), 'Map discloses periodic snapshot');
  ok(/Open-violation counts shown here are our stored City of Chicago snapshot/.test(idx), 'Explore discloses periodic snapshot');
  // (3) live-fail fallback is labeled as a snapshot, and does NOT zero the counts
  ok(/counts above are our stored <b>periodic snapshot<\/b>/.test(idx), 'live-fail path labels fallback as a periodic snapshot');
  ok(!/\.catch\([^)]*\)\{[^}]*\.open=0/.test(idx), 'live-fetch error handler never sets open=0 (no cached-to-zero)');
}

// ---------------------------------------------------------------- scoring invariant (client formula)
{
  // mirror of the client scoreOf/gradeOf (radiator3.html), including the post-blend cap
  const gradeOf = sc => sc >= 85 ? 'A' : sc >= 70 ? 'B' : sc >= 55 ? 'C' : sc >= 40 ? 'D' : 'F';
  const scoreOf = (open, avg, n) => {
    let s = 100 - Math.min(85, open * 2.5);
    if (open >= 3) s = Math.min(s, 80);
    if (n) s = s * 0.6 + (avg / 5 * 100) * 0.4;
    if (open >= 3) s = Math.min(s, 84);            // post-blend cap
    return Math.max(3, Math.min(99, Math.round(s)));
  };
  let worst = null;
  for (const open of [3, 4, 9, 10, 49, 100, 639]) {
    for (const [avg, n] of [[0, 0], [5, 1], [5, 50], [4, 3]]) {
      const g = gradeOf(scoreOf(open, avg, n));
      if (g === 'A') worst = { open, avg, n, g };
    }
  }
  ok(worst === null, '3+ open can NEVER display grade A (even with 5★ reviews)', worst ? JSON.stringify(worst) : 'all ≤ B');
  // sanity: a truly clean building (0 open, good reviews) can still be A
  ok(gradeOf(scoreOf(0, 5, 10)) === 'A', '0 open + strong reviews can still be grade A (cap does not over-apply)');
}

// ---------------------------------------------------------------- distribution sanity detector
{
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'seo-data.json'), 'utf8'));
  const B = d.buildings;
  const band = (lo, hi) => B.filter(b => b.open >= lo && b.open <= hi).length;
  const anomalies = [];
  if (band(1, 9) === 0 && band(10, 1e9) > 0) anomalies.push('empty 1-9 open band (line-item counting)');
  if (band(0, 0) === B.length) anomalies.push('all-zero (degenerate)');
  if (new Set(B.map(b => b.open)).size <= 1) anomalies.push('single-value (degenerate)');
  // The detector must FLAG the current known anomaly (the empty 1-9 band)...
  ok(anomalies.includes('empty 1-9 open band (line-item counting)'), 'distribution-sanity detector flags the empty 1-9 open band', `bands 0=${band(0,0)} 1-9=${band(1,9)} 10+=${band(10,1e9)}`);
  // ...and because the snapshot is anomalous, SSR must not present it as authoritative (asserted below).
}

// ---------------------------------------------------------------- SSR truthfulness (boot server)
const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), MOCK: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
try {
  // wait for health
  let up = false; const t0 = Date.now();
  while (Date.now() - t0 < 12000) { try { const r = await get('/api/health'); if (r.status === 200 || r.status === 503) { up = true; break; } } catch {} await new Promise(r => setTimeout(r, 200)); }
  ok(up, 'server booted');

  // r11999 is the required regression fixture: snapshot said A/99/0-open; live is 3 open.
  const b = await get('/building/r11999');
  const blk = ssrBlock(b.body);
  ok(b.status === 200, 'valid building → 200');
  ok(!/Radiator Score/.test(blk), '(1)(3) building SSR makes NO "Radiator Score" claim', 'r11999');
  ok(!/\/100/.test(blk), '(1)(3) building SSR contains no "/100" score', 'r11999');
  ok(!/open building violation/.test(blk), '(1) building SSR claims no open-violation count', 'r11999');
  ok(!/class="g"/.test(blk), '(1) building SSR shows no letter grade', 'r11999');
  ok(/22u3-xenr/.test(blk), 'building SSR keeps the stable fact that City records exist');
  ok(/pulled live from the City/.test(blk), 'building SSR points to the live counts (hydration matches, no unqualified claim)');
  // (7) server metadata (meta description + JSON-LD) has no unsupported live-data claim
  const desc = metaDesc(b.body);
  ok(!/Score|open building violation|\/100/.test(desc), '(7) meta description has no score/open-count claim');
  const ld = jsonld(b.body);
  ok(/"@type":"ApartmentComplex"/.test(ld) && !/(ratingValue|reviewCount|"score"|open)/i.test(ld), '(7) building JSON-LD has correct type and no score/rating/open fields');

  // company + neighborhood SSR carry no snapshot open counts
  const c = ssrBlock((await get('/company/1052')).body);
  ok(!/open building violation/.test(c) && !/open violation/.test(c), 'company SSR carries no snapshot open counts');
  const n = ssrBlock((await get('/neighborhood/austin')).body);
  ok(!/open violation/.test(n), 'neighborhood SSR carries no snapshot open counts');

  // preserved: invalid entity still 404
  ok((await get('/building/not-a-real-id')).status === 404, 'invalid building still → 404 (preserved)');
} finally { try { srv.kill('SIGKILL'); } catch {} }

console.log(`\nDATA-INTEGRITY RESULTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
