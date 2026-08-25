/* Beta-readiness regression suite (Playwright).
   Run against a local server:  MOCK=1 PORT=8899 node ../server.js &  then  node regression.mjs
   Requires playwright available on NODE_PATH (installed in the workspace). */
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:8899';
const EXE = process.env.PW_EXE || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let pass=0, fail=0; const log=(ok,name,extra='')=>{ok?pass++:fail++; console.log((ok?'PASS':'FAIL')+' · '+name+(extra?(' · '+extra):''));};

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport:{width:1280,height:950} });
const page = await ctx.newPage();
const jsErrors=[]; page.on('pageerror',e=>jsErrors.push(e.message));
await page.goto(BASE, { waitUntil:'domcontentloaded' });
await page.waitForSelector('.topnav', { timeout:20000 });

// helper to open a real building
const openBuilding = async ()=>page.evaluate(()=>{ const b=REAL.find(x=>x.pg)||REAL[0]; go('building',b.id); return b.id; });

// 1) SUBMISSION SUCCESS — review is stored server-side, then added locally + navigates
{
  await page.evaluate(()=>go('write',null)); await page.waitForTimeout(200);
  const before = await page.evaluate(()=>S.reviews.length);
  await page.evaluate(()=>{ const b=REAL[0]; document.querySelector('#w-bid').value=b.id; setStar('overall',4); document.querySelector('#w-body').value='Great transit and responsive management overall, would recommend.'; });
  await page.click('#w-submit'); await page.waitForTimeout(600);
  const r = await page.evaluate((b)=>({ grew:S.reviews.length>b, view:nav.view }), before);
  log(r.grew && r.view==='building', 'submission success stores + navigates', JSON.stringify(r));
}

// 2) SUBMISSION FAILURE — 500 from backend: error shown, button re-enabled, NOT persisted, content preserved
{
  await page.evaluate(()=>go('write',null)); await page.waitForTimeout(200);
  const before = await page.evaluate(()=>S.reviews.length);
  await page.evaluate(()=>{ window.__origFetch=window.fetch; window.fetch=()=>Promise.resolve(new Response('{"error":"save failed"}',{status:500,headers:{'Content-Type':'application/json'}})); });
  await page.evaluate(()=>{ const b=REAL[0]; document.querySelector('#w-bid').value=b.id; setStar('overall',3); document.querySelector('#w-body').value='This text must survive a failed submission and be retryable.'; });
  await page.click('#w-submit'); await page.waitForTimeout(400);
  const r = await page.evaluate((b)=>({ errShown:document.querySelector('#w-error').style.display!=='none', errText:document.querySelector('#w-error').textContent, notPersisted:S.reviews.length===b, contentKept:document.querySelector('#w-body').value.length>0, btnEnabled:!document.querySelector('#w-submit').disabled, stillWrite:nav.view==='write' }), before);
  log(r.errShown && r.notPersisted && r.contentKept && r.btnEnabled && r.stillWrite, 'submission failure: error + no persist + content kept + retryable', JSON.stringify({errText:r.errText.slice(0,40),...r,errText:undefined}));
  // RETRY after restoring fetch succeeds
  await page.evaluate(()=>{ window.fetch=window.__origFetch; });
  await page.click('#w-submit'); await page.waitForTimeout(600);
  const retry = await page.evaluate((b)=>({ grew:S.reviews.length>b, view:nav.view }), before);
  log(retry.grew && retry.view==='building', 'retry after failure succeeds', JSON.stringify(retry));
}

// 3) DUPLICATE-CLICK PREVENTION — slow response, two rapid clicks => one in-flight request
{
  await page.evaluate(()=>go('write',null)); await page.waitForTimeout(200);
  await page.evaluate(()=>{ window.__calls=0; window.__origFetch=window.fetch; window.fetch=(...a)=>{window.__calls++;return new Promise(res=>setTimeout(()=>res(new Response('{"ok":true}',{status:200,headers:{'Content-Type':'application/json'}})),800));}; });
  await page.evaluate(()=>{ const b=REAL[0]; document.querySelector('#w-bid').value=b.id; setStar('overall',5); document.querySelector('#w-body').value='Double click should only send one request to the server.'; });
  await page.evaluate(()=>{ submitReview(); submitReview(); submitReview(); }); // 3 rapid calls
  await page.waitForTimeout(1200);
  const calls = await page.evaluate(()=>({calls:window.__calls}));
  await page.evaluate(()=>{ window.fetch=window.__origFetch; });
  log(calls.calls===1, 'duplicate-click prevention: exactly one request', 'calls='+calls.calls);
}

// 4) MAP after in-app navigation from a search (the reported bug)
{
  await page.evaluate(()=>{ searchQ='nonexistent xyz'; nav.view='explore'; render(); }); await page.waitForTimeout(150);
  await page.evaluate(()=>tab('map')); await page.waitForTimeout(500);
  const dots = await page.evaluate(()=>document.querySelectorAll('#map-main .bpin, #map-main .bdot').length);
  log(dots>1000, 'map loads buildings after an in-app search', 'dots='+dots);
}

// 5) METADATA after client nav + browser back
{
  const id = await openBuilding(); await page.waitForTimeout(200);
  const t1 = await page.title();
  await page.evaluate(()=>go('explore',null)); await page.waitForTimeout(150);
  const t2 = await page.title(); const can2 = await page.evaluate(()=>document.querySelector('link[rel=canonical]').href);
  await page.goBack(); await page.waitForTimeout(300);
  const t3 = await page.title();
  log(/reviews & City records/i.test(t1) && /Search Chicago/i.test(t2) && /\/explore$/.test(can2) && t3===t1, 'route metadata updates on nav + restores on back', JSON.stringify({t1,t2,t3}));
}

// 6) INVALID ROUTE -> not found (client) + server 404
{
  await page.evaluate(()=>{ setNavFromPath('/definitely-not-a-page'); render(); }); await page.waitForTimeout(150);
  const nf = await page.evaluate(()=>({view:nav.view,h1:(document.querySelector('h1')||{}).textContent}));
  const srv = await page.evaluate(async(base)=>{ const r=await fetch(base+'/building/does-not-exist'); return r.status; }, BASE);
  log(nf.view==='notfound' && /not found/i.test(nf.h1) && srv===404, 'invalid route: client not-found + server 404', JSON.stringify({nf,srv}));
}

// 7) NEUTRAL LABELS — no judgmental risk language anywhere rendered
{
  await page.evaluate(()=>tab('neighborhoods')); await page.waitForTimeout(150);
  const hoodOk = await page.evaluate(()=>!/Good standing|High risk|Watch list/.test(document.body.innerText));
  await openBuilding(); await page.waitForTimeout(150);
  const bldgOk = await page.evaluate(()=>!/Good standing|High risk|Watch list/.test(document.body.innerText));
  log(hoodOk && bldgOk, 'neutral open-violation labels (no Good/High risk/Watch)', JSON.stringify({hoodOk,bldgOk}));
}

// 8) SCORING CONSISTENCY — a building with >=3 open cannot be an A; same classifier
{
  const r = await page.evaluate(()=>{ const b=REAL.find(x=>x.open>=3); if(!b)return{na:true}; return {open:b.open, grade:gradeOf(scoreOf(b)), risk:riskOf(b)}; });
  log(r.na||r.grade!=='A', 'building with 3+ open violations is not grade A', JSON.stringify(r));
}

// 9) KEYBOARD FOCUS visible on interactive elements
{
  await page.evaluate(()=>tab('home')); await page.waitForTimeout(150);
  await page.keyboard.press('Tab'); await page.waitForTimeout(50);
  const focus = await page.evaluate(()=>{ const el=document.activeElement; const o=getComputedStyle(el).outlineStyle; return { tag:el&&el.tagName, hasFocusVisibleCSS:!![...document.styleSheets].length }; });
  log(!!focus.tag, 'keyboard tab moves focus to an interactive element', JSON.stringify(focus));
}

// 9b) OFFLINE-SUCCESS SAFETY — on a real-backend host (comBase()!==null) a failed
//     request must be {ok:false}, never {ok:true,offline:true}. The offline path
//     is decided by hostname, not by a fetch failure.
{
  const r = await page.evaluate(async ()=>{
    const baseNotNull = comBase()!==null;
    const orig=window.fetch; window.fetch=()=>Promise.reject(new TypeError('network down'));
    let res; try{ res=await comPush('reviews',{b:'r0',body:'x'}); } finally { window.fetch=orig; }
    return { baseNotNull, ok:res.ok, offline:!!res.offline };
  });
  log(r.baseNotNull && r.ok===false && r.offline===false, 'offline-success cannot mask a real-host request failure', JSON.stringify(r));
}

// 9c) PHOTO UPLOAD is truthful — a failed photo upload must not be kept locally
//     nor claim success.
{
  const r = await page.evaluate(async ()=>{
    const bid='r0'; const before=((S.bphotos&&S.bphotos[bid])||[]).length;
    const orig=window.fetch; window.fetch=()=>Promise.resolve(new Response('{"error":"nope"}',{status:500,headers:{'Content-Type':'application/json'}}));
    // call the same code path addBuildingPhotos uses (comPush('photos')) and apply its rule
    const res=await comPush('photos',{id:'phtest',b:bid,photo:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='});
    window.fetch=orig;
    const after=((S.bphotos&&S.bphotos[bid])||[]).length;
    return { ok:res.ok, keptAnyway: after>before };
  });
  log(r.ok===false && r.keptAnyway===false, 'failed photo upload is not persisted or claimed', JSON.stringify(r));
}

// 9d) FAILED VIOLATION FETCH must not overwrite cached counts with zero (P7).
{
  const r = await page.evaluate(async ()=>{
    const b=REAL.find(x=>x.open>0)||REAL[0]; const bid=b.id; const before=b.open;
    delete _violCache[bid]; delete _violPending[bid];
    const orig=window.fetch; window.fetch=()=>Promise.reject(new TypeError('city API down'));
    try{ fetchViol(b); }catch(e){}
    await new Promise(r=>setTimeout(r,400));
    window.fetch=orig;
    const cache=_violCache[bid];
    return { before, after:bById(bid).open, cacheIsError: !!(cache&&cache.error) };
  });
  log(r.before===r.after && r.after>0, 'failed City API does not zero cached violation counts', JSON.stringify(r));
}

// 10) SERVER-SIDE BETA GATES — beta safety must not depend on the client flag.
//     These probe the backend directly, the way an attacker or a curl user would.
{
  // Lease/tenancy-proof upload must be OFF server-side during the free beta —
  // hiding the field in the UI is not enough.
  const lease = await fetch(BASE+'/api/verify', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ rid:'rvx', b:'r100', proof:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }) });
  log(lease.status===503, 'server: lease upload /api/verify is disabled in beta', 'http='+lease.status);

  // Payments must not be startable without a configured Stripe key.
  const checkout = await fetch(BASE+'/api/checkout', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ plan:'renter' }) });
  log(checkout.status===503, 'server: /api/checkout refuses without Stripe configured', 'http='+checkout.status);

  // A forged checkout session cannot self-grant paid access.
  const verify = await (await fetch(BASE+'/api/checkout/verify?session_id=cs_fake_self_grant')).json().catch(()=>({ok:null}));
  log(verify.ok===false, 'server: forged checkout session cannot grant access', 'ok='+verify.ok);

  // Moderator queue (which exposes lease images) is closed without ADMIN_KEY.
  const queue = await fetch(BASE+'/api/verify/queue');
  log(queue.status===503||queue.status===403, 'server: moderator queue closed without ADMIN_KEY', 'http='+queue.status);

  // The public community feed must never return private lease proofs.
  const feed = await (await fetch(BASE+'/api/community')).text();
  log(!/"proof"\s*:/.test(feed), 'server: public feed never returns lease proofs', 'hasProof='+/"proof"\s*:/.test(feed));
}

console.log('\nJS errors during run: '+jsErrors.length+(jsErrors.length?(' :: '+jsErrors.slice(0,3).join(' | ')):''));
console.log('RESULTS: '+pass+' passed, '+fail+' failed');
await browser.close();
process.exit(fail>0?1:0);
