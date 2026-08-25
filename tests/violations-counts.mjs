/* violations-counts.mjs — deterministic tests for exact City counts AND precise
 * address matching (no cross-counting of N/S, E/W, similar names, or street
 * types). Boots a LOCAL mock of the Socrata dataset (via CHI_VIOL_BASE) that
 * models per-(direction,type) combos, plus the real server.js. No live data.
 *   node tests/violations-counts.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP_PORT = process.env.VC_PORT || 8922;
const MOCK_PORT = process.env.VC_MOCK_PORT || 8923;
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} · ${name}${extra ? ' · ' + extra : ''}`); };

// Fixtures keyed by "NUMBER|NAME" → { combos:[{dir,type,statuses:{OPEN,COMPLIED,'NO ENTRY',...}}], flags }
const C = (dir, type, statuses) => ({ dir, type, statuses });
const FIX = {
  '100|STATE': { combos: [C('N', 'ST', { OPEN: 5 }), C('S', 'ST', { OPEN: 7 })] },      // N/S collision, same type
  '100|35TH': { combos: [C('E', 'ST', { OPEN: 3 }), C('W', 'ST', { OPEN: 4 })] },        // E/W collision
  '100|GREEN BAY': { combos: [C('S', 'AVE', { OPEN: 2, COMPLIED: 1 })] },                // similar-name (vs GREENWOOD)
  '100|GREENWOOD': { combos: [C('S', 'AVE', { OPEN: 9 })] },
  '100|GREEN VALLEY': { combos: [C('N', 'AVE', { OPEN: 8 })] },                          // shares first token GREEN
  '200|MICHIGAN': { combos: [C('S', 'AVE', { OPEN: 10 }), C('S', 'BLVD', { OPEN: 20 })] },// same num/name, diff type
  '300|TESTUNIT': { combos: [C('S', 'AVE', { OPEN: 4, COMPLIED: 1 })] },                 // suite/unit stripping
  '400|SPELLED': { combos: [C('N', 'AVE', { OPEN: 6 })] },                               // direction/type spelled out
  '500|SOLO': { combos: [C('W', 'ST', { OPEN: 6 })] },                                   // request omits direction → normalized
  '600|NOTYPE': { combos: [C('N', '', { OPEN: 8 })] },                                   // City row has NO street_type
  '700|MULTI': { combos: [C('N', 'ST', { OPEN: 1 }), C('S', 'AVE', { OPEN: 2 })] },       // multiple fallback candidates
  '800|ONLYNORTH': { combos: [C('N', 'ST', { OPEN: 5 })] },                              // request S but only N exists → mismatch
  '900|BIG': { combos: [C('S', 'AVE', { OPEN: 639, COMPLIED: 60 })] },                    // >60 total (exact 639, capped detail)
  '910|MIX': { combos: [C('N', 'ST', { OPEN: 10, COMPLIED: 20, 'NO ENTRY': 2, PENDING: 3 })] }, // no-entry + unknown
  '920|AGGFAIL': { aggFail: true },
  '930|DETAILFAIL': { combos: [C('N', 'ST', { OPEN: 5, COMPLIED: 5 })], detailFail: true },
  '940|DUP': { combos: [C('N', 'ST', { OPEN: 3 })], dupDetail: true },
  '950|RATELIMIT': { rateLimit: true },
};

const statusRows = (statuses) => Object.entries(statuses).map(([s, n]) => ({ status: s, n }));
const mock = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url);
  const num = (url.match(/street_number='(\d+)'/) || [])[1] || '';
  const name = (url.match(/upper\(street_name\)=upper\('([^']*)'\)/) || [])[1] || '';
  const f = FIX[num + '|' + name] || { combos: [] };
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (f.rateLimit) return send(429, { error: 'rate limited' });
  const isAgg = /group=street_direction,street_type,violation_status/.test(url);
  if (isAgg) {
    if (f.aggFail) return send(500, { error: 'agg fail' });
    const rows = [];
    for (const c of (f.combos || [])) for (const [s, n] of Object.entries(c.statuses)) rows.push({ street_direction: c.dir, ...(c.type ? { street_type: c.type } : {}), violation_status: s, n: String(n) });
    return send(200, rows);
  }
  // detail query: parse the accepted (dir,type) from the where
  if (f.detailFail) return send(500, { error: 'detail fail' });
  const dir = (url.match(/street_direction='([NSEW])'/) || [])[1] || '';
  const typeM = url.match(/street_type='([^']*)'/); const typeNull = /street_type IS NULL/.test(url);
  const type = typeNull ? '' : (typeM ? typeM[1] : '');
  const combo = (f.combos || []).find(c => c.dir === dir && (c.type || '') === type);
  let out = [];
  if (combo) { let i = 0; for (const [s, n] of Object.entries(combo.statuses)) for (let k = 0; k < n && out.length < 60; k++) out.push({ id: 'v' + (i++), violation_date: '2025-01-01', violation_status: s, violation_description: 'v', department_bureau: 'CONS' }); }
  if (f.dupDetail && out.length) out = [out[0], out[0], ...out]; // inject duplicate ids
  send(200, out.slice(0, 60 + (f.dupDetail ? 2 : 0)));
});

const get = (p) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: +APP_PORT, path: p }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve(JSON.parse(b || '{}'))); }).on('error', reject); });
const q = (addr) => '/api/violations?address=' + encodeURIComponent(addr);

let app;
try {
  await new Promise(r => mock.listen(MOCK_PORT, r));
  app = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(APP_PORT), MOCK: '1', CHI_VIOL_BASE: `http://127.0.0.1:${MOCK_PORT}/x.json`, CACHE_HOURS: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
  let up = false; const t0 = Date.now();
  while (Date.now() - t0 < 12000) { try { await get('/api/health'); up = true; break; } catch { await new Promise(r => setTimeout(r, 200)); } }
  ok(up, 'app + mock City server booted');

  // --- collisions: must not cross-count ---
  let n = await get(q('100 N STATE ST')); ok(n.matchConfidence === 'exact' && n.open === 5, 'N STATE ≠ S STATE — 100 N STATE ST → 5 (not 12)', 'open=' + n.open);
  let s = await get(q('100 S STATE ST')); ok(s.matchConfidence === 'exact' && s.open === 7, '100 S STATE ST → 7 (not 12)', 'open=' + s.open);
  let e = await get(q('100 E 35TH ST')); ok(e.open === 3 && e.matchConfidence === 'exact', 'E 35TH ≠ W 35TH — 100 E 35TH ST → 3', 'open=' + e.open);
  let w = await get(q('100 W 35TH ST')); ok(w.open === 4, '100 W 35TH ST → 4', 'open=' + w.open);
  let gb = await get(q('100 S GREEN BAY AVE')); ok(gb.open === 2 && gb.countsComplete, 'GREEN BAY ≠ GREENWOOD (exact name) — 100 S GREEN BAY AVE → 2 (not 9/8)', 'open=' + gb.open);
  let gv = await get(q('100 N GREEN VALLEY AVE')); ok(gv.open === 8, 'multiword sharing first token distinguished — GREEN VALLEY → 8', 'open=' + gv.open);
  let ma = await get(q('200 S MICHIGAN AVE')); ok(ma.open === 10 && ma.matchConfidence === 'exact', 'same num/name, diff type — MICHIGAN AVE → 10 (not 30)', 'open=' + ma.open);
  let mb = await get(q('200 S MICHIGAN BLVD')); ok(mb.open === 20, 'MICHIGAN BLVD → 20', 'open=' + mb.open);
  let mAmb = await get(q('200 S MICHIGAN')); ok(mAmb.matchConfidence === 'ambiguous' && mAmb.open === null && mAmb.countsComplete === false, 'no type given + 2 types → ambiguous, counts null', JSON.stringify({ c: mAmb.matchConfidence, o: mAmb.open }));

  // --- normalization ---
  let unit = await get(q('300 S TESTUNIT AVE STE 5')); ok(unit.open === 4 && unit.matchConfidence === 'exact', 'suite/unit stripped — matches exact', 'open=' + unit.open);
  let sp1 = await get(q('400 NORTH SPELLED AVENUE')); let sp2 = await get(q('  400   n   spelled   ave '));
  ok(sp1.open === 6 && sp2.open === 6 && sp1.matchedAddress === sp2.matchedAddress, 'direction/type spelled-out == abbreviated == mixed-case/whitespace', sp1.matchedAddress);

  // --- fallback when a component is omitted / missing in City data ---
  let solo = await get(q('500 SOLO ST')); ok(solo.matchConfidence === 'normalized' && solo.open === 6 && /500 W Solo St/.test(solo.matchedAddress), 'omitted direction + single combo → normalized match', solo.matchedAddress);
  let notype = await get(q('600 N NOTYPE')); ok(notype.matchConfidence === 'normalized' && notype.open === 8, 'City row missing street_type → matched (IS NULL)', 'open=' + notype.open);
  let multi = await get(q('700 MULTI')); ok(multi.matchConfidence === 'ambiguous' && multi.open === null, 'multiple fallback candidates → ambiguous (never combined)', JSON.stringify({ c: multi.matchConfidence, o: multi.open }));
  let mism = await get(q('800 S ONLYNORTH ST')); ok(mism.matchConfidence === 'none' && mism.open === null && mism.countsComplete === false, 'supplied direction not in City data → none, counts null', JSON.stringify({ c: mism.matchConfidence, o: mism.open }));

  // --- exact counts vs the 60-row cap ---
  let big = await get(q('900 S BIG AVE')); ok(big.countsComplete && big.open === 639 && big.total === 699 && big.detailsReturned === 60 && big.detailsTruncated && big.detailsTotal === 699, '>60 total → exact 639 open, detail truncated 60/699', JSON.stringify({ o: big.open, dr: big.detailsReturned, dt: big.detailsTotal }));
  let mix = await get(q('910 N MIX ST')); ok(mix.open === 10 && mix.resolved === 20 && mix.noEntry === 2 && mix.unclassified.PENDING === 3 && (mix.open + mix.resolved + mix.noEntry + 3) === mix.total, 'mixed open/resolved/no-entry + unknown surfaced; reconciles with total', JSON.stringify({ o: mix.open, r: mix.resolved, ne: mix.noEntry, u: mix.unclassified, t: mix.total }));

  // --- failure handling ---
  let df = await get(q('930 N DETAILFAIL ST')); ok(df.countsComplete === true && df.open === 5 && df.resolved === 5 && df.violations.length === 0, 'detail-fail keeps EXACT counts (countsComplete true, empty details)', 'open=' + df.open);
  let af = await get(q('920 N AGGFAIL ST')); ok(af.countsComplete === false && af.open === null && af.error, 'aggregate-fail → counts null, error (never zeros, keeps snapshot)', JSON.stringify({ c: af.countsComplete, o: af.open }));
  let dup = await get(q('940 N DUP ST')); ok(dup.detailsReturned === 3 && dup.open === 3, 'duplicate detail ids deduped', 'returned=' + dup.detailsReturned);
  let rl = await get(q('950 N RATELIMIT ST')); ok(rl.countsComplete === false && rl.open === null && rl.error, 'rate-limit → null counts (never zero)', 'open=' + rl.open);

  // --- clean vs unparseable ---
  let clean = await get(q('999 N EMPTY ST')); ok(clean.countsComplete === true && clean.open === 0 && clean.total === 0 && clean.matchConfidence === 'none', 'address with no City records → exact 0 (clean), not null', JSON.stringify({ o: clean.open, c: clean.matchConfidence }));
  let bad = await get(q('gibberish')); ok(bad.countsComplete === false && bad.open === null && bad.noMatch, 'unparseable address → null counts, noMatch');
} finally { try { app && app.kill('SIGKILL'); } catch {} mock.close(); }

console.log(`\nVIOLATIONS-COUNTS RESULTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
