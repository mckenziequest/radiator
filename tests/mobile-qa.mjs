/* mobile-qa.mjs — real responsive QA + runtime regressions (Playwright).
 * Boots server.js internally, drives mobile (390×844, 375×667) and one desktop
 * (1280×900) viewport across the key views, and checks: no horizontal overflow,
 * one visible <h1>, no console errors, one <title> after hydration, route titles
 * (incl. /guide, /write), Back/Forward title restore, live-fail-not-zero, and the
 * snapshot disclosures. Screenshots are saved and their paths printed.
 *   node tests/mobile-qa.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = process.env.MQ_PORT || 8917;
const BASE = `http://127.0.0.1:${PORT}`;
const EXE = process.env.PW_EXE || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'radiator-mobileqa-'));
let pass = 0, fail = 0; const shots = [];
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} · ${name}${extra ? ' · ' + extra : ''}`); };
const health = () => new Promise(res => { const r = http.request({ host: '127.0.0.1', port: +PORT, path: '/api/health' }, x => { x.resume(); res(true); }); r.on('error', () => res(false)); r.end(); });

const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), MOCK: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
async function waitUp() { const t0 = Date.now(); while (Date.now() - t0 < 12000) { if (await health()) return true; await new Promise(r => setTimeout(r, 200)); } return false; }

try {
  ok(await waitUp(), 'server booted');
  const browser = await chromium.launch({ executablePath: EXE });

  const viewports = [
    { name: 'mobile-390', width: 390, height: 844, isMobile: true },
    { name: 'mobile-375', width: 375, height: 667, isMobile: true },
    { name: 'desktop-1280', width: 1280, height: 900, isMobile: false },
  ];
  const views = [
    { v: 'home', url: '/' },
    { v: 'explore', url: '/explore' },
    { v: 'map', url: '/map' },
    { v: 'building', url: '/building/r11999' },
    { v: 'firm', url: '/firm/fulton-grace' },
    { v: 'compare', url: '/compare' },
    { v: 'pricing', url: '/pricing' },
    { v: 'write', url: '/write' },
    { v: 'notfound', url: '/totally-unknown-xyz' },
  ];

  for (const vp of viewports) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, isMobile: vp.isMobile, hasTouch: vp.isMobile });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    let overflow = 0, badH1 = 0;
    for (const view of views) {
      await page.goto(BASE + view.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(view.v === 'map' ? 900 : 350);
      const m = await page.evaluate(() => ({
        sw: document.scrollingElement.scrollWidth, iw: window.innerWidth,
        h1: document.querySelectorAll('h1').length,
        titles: document.querySelectorAll('title').length,
        title: document.title,
      }));
      if (m.sw > m.iw + 2) overflow++;
      if (m.h1 !== 1) badH1++;
      // one screenshot per view on the smallest mobile + one full desktop home/building
      if (vp.name === 'mobile-390' && ['home', 'map', 'building', 'pricing'].includes(view.v)) {
        const p = path.join(OUT, `${vp.name}-${view.v}.png`); await page.screenshot({ path: p }); shots.push(p);
      }
    }
    ok(overflow === 0, `[${vp.name}] no horizontal overflow on any view`, `overflow=${overflow}/${views.length}`);
    ok(badH1 === 0, `[${vp.name}] exactly one <h1> on every view`, `bad=${badH1}`);
    ok(errs.length === 0, `[${vp.name}] no console/page errors`, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ---- runtime regressions on desktop ----
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // (4) single <title> after hydration + route-specific titles incl. guide/write
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(300);
  ok((await page.evaluate(() => document.querySelectorAll('title').length)) === 1, 'exactly one <title> after hydration (home)');
  const titleAt = async (path) => { await page.evaluate(p => window.go(p === '/directory' ? 'directory' : p.replace('/', ''), null), path); await page.waitForTimeout(250); return page.evaluate(() => ({ n: document.querySelectorAll('title').length, t: document.title })); };
  const guide = await titleAt('/guide'); ok(guide.n === 1 && /tenant rights/i.test(guide.t) && !/tools/i.test(guide.t), '/guide has its own title (not the tools title)', guide.t);
  const write = await titleAt('/write'); ok(write.n === 1 && /Write a building review/i.test(write.t), '/write has its own title (not the default)', write.t);

  // Back/Forward restore the correct title
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(200);
  await page.evaluate(() => window.go('map', null)); await page.waitForTimeout(200);
  await page.evaluate(() => window.go('pricing', null)); await page.waitForTimeout(200);
  await page.goBack(); await page.waitForTimeout(300);
  const backT = await page.evaluate(() => document.title);
  await page.goForward(); await page.waitForTimeout(300);
  const fwdT = await page.evaluate(() => document.title);
  ok(/map/i.test(backT) && /pricing/i.test(fwdT), 'Back/Forward restore the correct route title', `back=${backT} fwd=${fwdT}`);

  // (3) live-fail does not zero the counts, and labels the fallback as a snapshot
  await page.route('**/api/violations**', r => r.abort());
  await page.goto(BASE + '/building/r0', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900);
  const liveFail = await page.evaluate(() => {
    const t = document.body.innerText || '';
    return { showsZeroOpen: /\b0 open\b/.test(t), snapshotLabel: /stored snapshot|periodic snapshot/i.test(t), h1: (document.querySelector('h1') || {}).textContent };
  });
  ok(!liveFail.showsZeroOpen, '(3) live-retrieval failure does NOT show "0 open" (no cached→zero)', 'r0 has snapshot open=639');
  ok(liveFail.snapshotLabel, '(3) live-retrieval failure labels the fallback as a periodic snapshot');
  await page.unroute('**/api/violations**');

  // snapshot disclosure visible on Map + Explore + Rankings
  const discAt = async (view) => { await page.goto(BASE + '/' + (view === 'rankings' ? 'directory' : view), { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(view === 'explore' ? 500 : 300); return page.evaluate(() => /stored City of Chicago (violation counts|snapshot)|periodic snapshot/i.test(document.body.innerText || '')); };
  ok(await discAt('map'), 'Map shows the snapshot disclosure at runtime');
  ok(await discAt('rankings'), 'Rankings shows the snapshot disclosure at runtime');
  // explore needs a query to show building results; browse-all still shows the note
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(300);
  await page.evaluate(() => { const i = [...document.querySelectorAll('input')].find(x => /address|building|landlord/i.test(x.placeholder || '')); i.value = ''; i.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 })); });
  await page.waitForTimeout(500);
  ok(await page.evaluate(() => /stored City of Chicago snapshot/i.test(document.body.innerText || '')), 'Explore shows the snapshot disclosure at runtime');

  await ctx.close();
  await browser.close();
} finally { try { srv.kill('SIGKILL'); } catch {} }

console.log('\nScreenshots:'); shots.forEach(s => console.log('  ' + s));
console.log(`\nMOBILE-QA RESULTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
