/* release-check.mjs — clean-release validator.
 *
 * Runs the deterministic build, verifies all required generated data exists and
 * is in sync, then boots the server and asserts the full routing / metadata /
 * safety-gate contract — PLUS fail-closed behavior when SEO data is missing or
 * malformed. Designed to run from a clean tracked-only export (needs no
 * untracked file): it GENERATES seo-data.json itself via build_deploy.mjs.
 *
 *   node radiator-backend/tests/release-check.mjs      # from repo root
 * or  npm run release-check  (radiator-backend/package.json)
 *
 * Uses only Node built-ins (child_process + global fetch) — no browser.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');            // repo root (has build_deploy.mjs)
const BACKEND = path.resolve(ROOT, 'radiator-backend');
const SEO_DATA = path.join(BACKEND, 'seo-data.json');
const PORT = process.env.RC_PORT || '8896';
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} · ${name}${extra ? ' · ' + extra : ''}`); };

function sh(cmd, args, cwd) { return spawnSync(cmd, args, { cwd, encoding: 'utf8' }); }
async function waitHealth(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(BASE + '/api/health'); if (r.status === 200 || r.status === 503) return true; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
function startServer(extraEnv = {}) {
  const child = spawn('node', ['server.js'], { cwd: BACKEND, env: { ...process.env, PORT, MOCK: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  return child;
}
function stop(child) { try { child.kill('SIGKILL'); } catch {} }
async function get(p) { const r = await fetch(BASE + p, { redirect: 'manual' }); const body = (r.status >= 300 && r.status < 400) ? '' : await r.text(); return { status: r.status, body, loc: r.headers.get('location') }; }
async function post(p, obj) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) }); return { status: r.status }; }

// ---------------------------------------------------------------- build + sync
{
  const b = sh('node', ['build_deploy.mjs', 'build'], ROOT);
  ok(b.status === 0, 'build_deploy.mjs build succeeds', 'exit=' + b.status);
  ok(fs.existsSync(SEO_DATA), 'required generated data exists (seo-data.json)');
  const v = sh('node', ['build_deploy.mjs', 'verify'], ROOT);
  ok(v.status === 0 && /IN SYNC/.test(v.stdout) && /MANIFEST IN SYNC/.test(v.stdout) && /SEO-DATA IN SYNC/.test(v.stdout),
    'template, entity manifest and SEO data are synchronized', 'exit=' + v.status);
}

// ---------------------------------------------------------------- healthy boot
{
  const srv = startServer();
  const up = await waitHealth();
  ok(up, 'server starts and answers /api/health');
  const h = await get('/api/health');
  let hj = {}; try { hj = JSON.parse(h.body); } catch {}
  ok(h.status === 200 && hj.ok === true && hj.seo === 'enabled', '/api/health reports healthy (SEO enabled)', 'buildings=' + hj.seoBuildings);

  const vb = await get('/building/r0/1900-n-austin-ave');
  ok(vb.status === 200 && /"@type":"ApartmentComplex"/.test(vb.body), 'valid building → 200 with entity metadata');
  ok((await get('/building/not-a-real-id')).status === 404, 'invalid building → 404');
  ok((await get('/building/')).status === 404, 'missing building id → 404');

  const vf = await get('/firm/fulton-grace');
  ok(vf.status === 200 && /"@type":"Organization"/.test(vf.body) && /Fulton Grace/.test(vf.body), 'valid firm → 200 with Organization metadata');
  ok((await get('/firm/not-a-real-firm')).status === 404, 'invalid firm → 404');
  ok((await get('/firm/')).status === 404, 'missing firm id → 404');

  ok((await get('/company/1052')).status === 200, 'valid company → 200');
  ok((await get('/company/not-a-real-id')).status === 404, 'invalid company → 404');
  ok((await get('/neighborhood/austin')).status === 200, 'valid neighborhood → 200');
  ok((await get('/neighborhood/not-a-real-neighborhood')).status === 404, 'invalid neighborhood → 404');
  ok((await get('/totally-unknown-xyz')).status === 404, 'unknown top-level → 404');

  const land = await get('/landlord/1052');
  ok(land.status === 301 && /\/company\/1052$/.test(land.loc || ''), 'landlord alias → 301 to /company/:pg');

  ok((await post('/api/checkout', { plan: 'renter' })).status === 503, 'payment endpoint → 503');
  ok((await post('/api/verify', { rid: 'x', b: 'r0', proof: 'data:image/png;base64,AA' })).status === 503, 'lease-verification endpoint → 503');
  ok((await get('/api/verify/queue')).status === 503, 'moderator queue → 503');

  const feed = await get('/api/community');
  ok(!/"proof"\s*:/.test(feed.body), 'no private lease data in logged-out API');
  stop(srv);
  await new Promise(r => setTimeout(r, 400));
}

// ---------------------------------------------------------- degraded: MISSING
{
  const tmp = SEO_DATA + '.bak';
  fs.renameSync(SEO_DATA, tmp);
  const srv = startServer();
  await waitHealth();
  const h = await get('/api/health'); let hj = {}; try { hj = JSON.parse(h.body); } catch {}
  ok(h.status === 503 && hj.ok === false && hj.seo === 'unavailable', 'MISSING SEO data → /api/health 503 unhealthy');
  ok((await get('/building/r0/x')).status === 503, 'MISSING → valid-looking building route 503 (not a 200 shell)');
  ok((await get('/building/nope')).status === 503, 'MISSING → invalid building route 503 (not a 200 shell)');
  ok((await get('/firm/fulton-grace')).status === 503, 'MISSING → firm route 503');
  ok((await get('/totally-unknown-xyz')).status === 404, 'MISSING → unknown top-level still 404 (no soft-404)');
  ok((await get('/')).status === 200, 'MISSING → homepage still serves (static)');
  stop(srv); await new Promise(r => setTimeout(r, 400));
  fs.renameSync(tmp, SEO_DATA);
}

// -------------------------------------------------------- degraded: MALFORMED
{
  const good = fs.readFileSync(SEO_DATA, 'utf8');
  fs.writeFileSync(SEO_DATA, '{"buildings":[]}'); // parses but empty → must be rejected
  const srv = startServer();
  await waitHealth();
  const h = await get('/api/health'); let hj = {}; try { hj = JSON.parse(h.body); } catch {}
  ok(h.status === 503 && hj.ok === false, 'MALFORMED SEO data → /api/health 503 unhealthy');
  ok((await get('/building/r0/x')).status === 503, 'MALFORMED → building route 503 (not a 200 shell)');
  stop(srv); await new Promise(r => setTimeout(r, 400));
  fs.writeFileSync(SEO_DATA, good); // restore the valid generated data
}

console.log(`\nRELEASE-CHECK RESULTS: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
