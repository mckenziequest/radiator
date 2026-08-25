/* gates.mjs — proves the free-beta safety gates are enforced SERVER-SIDE.
 *   Payments:   PAYMENTS_ENABLED=1 AND STRIPE_SECRET_KEY (both, or off)
 *   Moderation: MODERATION_ENABLED=1 AND ADMIN_KEY (both) + header-only auth
 *   CORS:       exact allowlist; literal '*' never becomes a wildcard header
 * Boots server.js in-process (child) with different env combos and checks HTTP
 * behavior. No real Stripe call is ever made (we only read /api/payments/status
 * on the enabled path; we never POST /api/checkout with a live-looking key).
 *   node tests/gates.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} · ${name}${extra ? ' · ' + extra : ''}`); };

let PORT = 8940;
function boot(env) {
  const port = PORT++;
  const logs = [];
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, MOCK: '1', PORT: String(port), DATABASE_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', d => logs.push(String(d)));
  srv.stderr.on('data', d => logs.push(String(d)));
  return { srv, port, logs };
}
function health(port) { return new Promise(res => { const r = http.request({ host: '127.0.0.1', port, path: '/api/health' }, x => { x.resume(); res(true); }); r.on('error', () => res(false)); r.end(); }); }
async function waitUp(port) { const t0 = Date.now(); while (Date.now() - t0 < 12000) { if (await health(port)) return true; await new Promise(r => setTimeout(r, 150)); } return false; }
async function req(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, acao: res.headers.get('access-control-allow-origin') };
}

async function withServer(env, fn) {
  const { srv, port, logs } = boot(env);
  try { const up = await waitUp(port); if (!up) throw new Error('server did not boot'); await fn(port, logs); }
  finally { try { srv.kill('SIGKILL'); } catch {} }
}

try {
  // ---------------- PAYMENTS ----------------
  await withServer({}, async (port) => {
    const s = await req(port, '/api/payments/status');
    const c = await req(port, '/api/checkout', { method: 'POST', body: { plan: 'pass' } });
    ok(s.json && s.json.enabled === false, 'payments neither → status disabled', JSON.stringify(s.json));
    ok(c.status === 503, 'payments neither → POST /api/checkout 503', 'status=' + c.status);
  });
  await withServer({ STRIPE_SECRET_KEY: 'sk_test_dummy_secret_only' }, async (port) => {
    const s = await req(port, '/api/payments/status');
    const c = await req(port, '/api/checkout', { method: 'POST', body: { plan: 'pass' } });
    ok(s.json && s.json.enabled === false, 'payments SECRET only → disabled', JSON.stringify(s.json));
    ok(c.status === 503, 'payments SECRET only → checkout 503', 'status=' + c.status);
  });
  await withServer({ PAYMENTS_ENABLED: '1' }, async (port) => {
    const s = await req(port, '/api/payments/status');
    const c = await req(port, '/api/checkout', { method: 'POST', body: { plan: 'pass' } });
    ok(s.json && s.json.enabled === false, 'payments FLAG only → disabled', JSON.stringify(s.json));
    ok(c.status === 503, 'payments FLAG only → checkout 503', 'status=' + c.status);
  });
  await withServer({ PAYMENTS_ENABLED: '1', STRIPE_SECRET_KEY: 'sk_test_dummy_both_enabled' }, async (port) => {
    const s = await req(port, '/api/payments/status'); // do NOT POST checkout (would hit Stripe network)
    ok(s.json && s.json.enabled === true, 'payments BOTH → enabled code path (Stripe initialized, no network call made)', JSON.stringify(s.json));
  });

  // ---------------- MODERATION ----------------
  const ADMIN = 'test-admin-key-8f3a90cd-secret';
  await withServer({}, async (port) => {
    const q = await req(port, '/api/verify/queue');
    ok(q.status === 503, 'moderation neither → queue 503', 'status=' + q.status);
  });
  await withServer({ ADMIN_KEY: ADMIN }, async (port) => {
    const q = await req(port, '/api/verify/queue', { headers: { 'X-Admin-Key': ADMIN } });
    ok(q.status === 503, 'moderation KEY only (no flag) → queue 503 even with correct header', 'status=' + q.status);
  });
  await withServer({ MODERATION_ENABLED: '1' }, async (port) => {
    const q = await req(port, '/api/verify/queue');
    ok(q.status === 503, 'moderation FLAG only (no key) → queue 503', 'status=' + q.status);
  });
  await withServer({ MODERATION_ENABLED: '1', ADMIN_KEY: ADMIN }, async (port, logs) => {
    const good = await req(port, '/api/verify/queue', { headers: { 'X-Admin-Key': ADMIN } });
    ok(good.status === 200, 'moderation BOTH + correct X-Admin-Key header → authorized (200)', 'status=' + good.status);
    const bad = await req(port, '/api/verify/queue', { headers: { 'X-Admin-Key': 'wrong-key' } });
    ok(bad.status === 403, 'moderation wrong header → 403', 'status=' + bad.status);
    const qs = await req(port, '/api/verify/queue?key=' + encodeURIComponent(ADMIN));
    ok(qs.status === 403, 'moderation query-string key → rejected (403, header-only)', 'status=' + qs.status);
    const bodyKey = await req(port, '/api/verify/approve', { method: 'POST', body: { key: ADMIN, rid: 'x', b: 'r0' } });
    ok(bodyKey.status === 403, 'moderation request-body key → rejected (403, header-only)', 'status=' + bodyKey.status);
    await new Promise(r => setTimeout(r, 150));
    const joined = logs.join('');
    ok(!joined.includes(ADMIN), 'moderation: the admin key never appears in server logs');
  });

  // ---------------- CORS ----------------
  const OTHER = 'https://evil.example';
  const ALLOWED = 'https://app.radiator.test';
  await withServer({}, async (port) => {
    const same = await req(port, '/api/health'); // no Origin header = same-origin style
    ok(same.status === 200 && !same.acao, 'CORS unset → same-origin works, no ACAO header', 'acao=' + same.acao);
    const cross = await req(port, '/api/health', { headers: { Origin: OTHER } });
    ok(!cross.acao, 'CORS unset → cross origin gets no ACAO', 'acao=' + cross.acao);
  });
  await withServer({ CORS_ORIGIN: '*' }, async (port) => {
    const cross = await req(port, '/api/health', { headers: { Origin: OTHER } });
    ok(cross.acao !== '*' && !cross.acao, 'CORS "*" → NEVER emits a wildcard ACAO header', 'acao=' + cross.acao);
    const same = await req(port, '/api/health');
    ok(same.status === 200, 'CORS "*" → same-origin still works', 'status=' + same.status);
  });
  await withServer({ CORS_ORIGIN: ALLOWED + ',https://second.test' }, async (port) => {
    const good = await req(port, '/api/health', { headers: { Origin: ALLOWED } });
    ok(good.acao === ALLOWED, 'CORS allowlist → listed origin echoed exactly', 'acao=' + good.acao);
    const bad = await req(port, '/api/health', { headers: { Origin: OTHER } });
    ok(!bad.acao, 'CORS allowlist → unlisted origin gets no ACAO', 'acao=' + bad.acao);
    const pfGood = await req(port, '/api/reviews', { method: 'OPTIONS', headers: { Origin: ALLOWED } });
    ok(pfGood.status === 204 && pfGood.acao === ALLOWED, 'CORS preflight (OPTIONS) from listed origin → 204 + ACAO', 'status=' + pfGood.status + ' acao=' + pfGood.acao);
    const pfBad = await req(port, '/api/reviews', { method: 'OPTIONS', headers: { Origin: OTHER } });
    ok(pfBad.status === 204 && !pfBad.acao, 'CORS preflight from unlisted origin → 204 + no ACAO', 'status=' + pfBad.status + ' acao=' + pfBad.acao);
  });
} catch (e) {
  console.error('gates.mjs error:', e && e.message);
  fail++;
}

console.log(`\nGATES RESULTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
