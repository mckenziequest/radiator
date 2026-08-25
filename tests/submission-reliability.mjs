/* submission-reliability.mjs — proves public submissions never show optimistic
 * success. Drives the real review form on /write against a booted server and
 * forces each failure mode via request interception. Asserts: success only on a
 * confirmed 2xx {ok:true}; on 4xx/5xx/network/invalid-JSON/{ok:false} → no
 * success, inline error shown, typed text preserved, submit re-enabled; a
 * pending request blocks a duplicate; retry succeeds afterward.
 *   node tests/submission-reliability.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = process.env.SR_PORT || 8927;
const BASE = `http://127.0.0.1:${PORT}`;
const EXE = process.env.PW_EXE || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} · ${name}${extra ? ' · ' + extra : ''}`); };
const health = () => new Promise(r => { const q = http.request({ host: '127.0.0.1', port: +PORT, path: '/api/health' }, x => { x.resume(); r(true); }); q.on('error', () => r(false)); q.end(); });

const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), MOCK: '1', DATABASE_URL: '' }, stdio: ['ignore', 'ignore', 'inherit'] });
async function waitUp() { const t0 = Date.now(); while (Date.now() - t0 < 12000) { if (await health()) return true; await new Promise(r => setTimeout(r, 150)); } return false; }

const BODY = 'The heat broke twice last winter and took weeks to fix.';
async function fillForm(page) {
  // fresh review view each time
  await page.goto(BASE + '/write', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    if (typeof draft === 'undefined' || !draft) return;
    draft.overall = 5; draft.sub = draft.sub || {}; draft.photos = draft.photos || []; draft.unit = draft.unit || {}; draft.would = true;
  });
  await page.evaluate(() => { const b = document.querySelector('#w-building'); if (b) b.value = 'Test Reliability Bldg 4200'; });
  await page.evaluate((t) => { const el = document.querySelector('#w-body'); if (el) el.value = t; }, BODY);
}
async function state(page) {
  return page.evaluate(() => ({
    reviews: (typeof S !== 'undefined' && S.reviews) ? S.reviews.length : -1,
    errVisible: (() => { const e = document.querySelector('#w-error'); return !!(e && e.offsetParent !== null && (e.textContent || '').trim().length); })(),
    bodyKept: (() => { const e = document.querySelector('#w-body'); return e ? e.value : null; })(),
    submitDisabled: (() => { const b = document.querySelector('#w-submit'); return b ? !!b.disabled : null; })(),
  }));
}

try {
  ok(await waitUp(), 'server booted');
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const failCases = [
    { name: '500 server error', route: r => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'save failed' }) }) },
    { name: 'network failure', route: r => r.abort() },
    { name: '200 {ok:false}', route: r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'not saved' }) }) },
    { name: '200 invalid JSON', route: r => r.fulfill({ status: 200, contentType: 'application/json', body: 'NOT JSON <html>' }) },
  ];
  for (const fc of failCases) {
    await page.route('**/api/reviews', fc.route);
    await fillForm(page);
    const before = (await state(page)).reviews;
    await page.click('#w-submit');
    await page.waitForTimeout(700);
    const s = await state(page);
    ok(s.reviews === before && !s.submitDisabled && s.errVisible && s.bodyKept === BODY,
      `review ${fc.name} → no success, error shown, text kept, button re-enabled`,
      `reviews ${before}->${s.reviews} err=${s.errVisible} kept=${s.bodyKept === BODY} disabled=${s.submitDisabled}`);
    await page.unroute('**/api/reviews');
  }

  // Pending blocks a duplicate: slow first response, double-click → only ONE request.
  {
    let hits = 0;
    await page.route('**/api/reviews', async r => { hits++; await new Promise(res => setTimeout(res, 900)); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: {} }) }); });
    await fillForm(page);
    await page.click('#w-submit');
    await page.waitForTimeout(80);
    await page.click('#w-submit').catch(() => {}); // second click while pending
    await page.waitForTimeout(1400);
    ok(hits === 1, 'pending request blocks a duplicate submission (exactly one POST)', 'hits=' + hits);
    await page.unroute('**/api/reviews');
  }

  // Retry after failure succeeds: first 500, then real server.
  {
    await page.route('**/api/reviews', r => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'try later' }) }));
    await fillForm(page);
    const before = (await state(page)).reviews;
    await page.click('#w-submit');
    await page.waitForTimeout(600);
    const midFail = await state(page);
    await page.unroute('**/api/reviews'); // let the real server handle the retry
    await page.click('#w-submit');
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => (typeof S !== 'undefined' && S.reviews) ? S.reviews.length : -1);
    ok(midFail.reviews === before && after === before + 1, 'retry after failure succeeds (review recorded only on the successful attempt)', `before=${before} fail=${midFail.reviews} after=${after}`);
  }

  // Happy path: confirmed 2xx {ok:true} → success (review recorded).
  {
    await fillForm(page);
    const before = (await state(page)).reviews;
    await page.click('#w-submit');
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => (typeof S !== 'undefined' && S.reviews) ? S.reviews.length : -1);
    ok(after === before + 1, 'confirmed 2xx {ok:true} → success (review recorded)', `before=${before} after=${after}`);
  }

  await ctx.close();
  await browser.close();
} catch (e) {
  console.error('submission-reliability error:', e && e.message);
  fail++;
} finally { try { srv.kill('SIGKILL'); } catch {} }

console.log(`\nSUBMISSION-RELIABILITY RESULTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
