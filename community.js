// community.js — the shared-content API (reviews, issues, Q&A, names, photos).
//
// Mounts on the same Express app as the aggregation API. Every write is
// sanitized (PII stripped, sized, rate-limited) before it is stored, so the
// public store stays safe by construction.

const store = require('./store');

// ---- lightweight per-IP rate limiter (in-memory; fine for a single instance) ----
const hits = new Map();
function rateLimited(ip, max = 40, windowMs = 60000) {
  const now = Date.now();
  const e = hits.get(ip) || { t: now, n: 0 };
  if (now - e.t > windowMs) { e.t = now; e.n = 0; }
  e.n++; hits.set(ip, e);
  return e.n > max;
}

// ---- sanitization ----
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function clean(s, max = 4000) {
  if (typeof s !== 'string') return '';
  return s.replace(EMAIL, '[removed]').replace(PHONE, '[removed]').slice(0, max).trim();
}
function plain(s, max = 40) { return typeof s === 'string' ? s.replace(/[^\w :/.-]/g, '').slice(0, max).trim() : ''; } // dates/labels: no PII-strip
function num(v, lo, hi) { const n = Number(v); if (!isFinite(n)) return null; return Math.max(lo, Math.min(hi, n)); }
function id(v) { return String(v || '').replace(/[^\w:.-]/g, '').slice(0, 80); }
function bid(v) { return String(v || '').replace(/[^\w-]/g, '').slice(0, 40); }
// photos are data: URLs; cap size hard so the store can't be flooded
function photoList(arr, maxN = 8, maxLen = 900000) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(p => typeof p === 'string' && /^data:image\//.test(p) && p.length < maxLen).slice(0, maxN);
}

function mount(app) {
  app.use((req, res, next) => { // JSON body (photos can be big)
    res.set('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const guard = (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip').split(',')[0];
    if (rateLimited(ip)) { res.status(429).json({ error: 'Slow down a moment and try again.' }); return true; }
    return false;
  };

  // Pull all shared content (optionally only what changed since ?since=<ms>)
  app.get('/api/community', async (req, res) => {
    try { res.json(await store.getAll(req.query.since)); }
    catch (e) { console.error(e); res.status(500).json({ error: 'store read failed' }); }
  });

  // Post a tenant review
  app.post('/api/reviews', async (req, res) => {
    if (guard(req, res)) return;
    const b = req.body || {};
    if (!bid(b.b) || !clean(b.body)) return res.status(400).json({ error: 'A building and some review text are required.' });
    const rv = {
      id: id(b.id) || ('rv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      b: bid(b.b), ts: Date.now(), src: 'radiator', shared: true,
      author: clean(b.author, 40) || 'Verified tenant',
      overall: num(b.overall, 1, 5) || 3,
      title: clean(b.title, 140),
      body: clean(b.body, 4000),
      wish: clean(b.wish, 1200),
      sub: (b.sub && typeof b.sub === 'object') ? b.sub : {},
      would: typeof b.would === 'boolean' ? b.would : null,
      rent: b.rent ? num(b.rent, 0, 20000) : null,
      beds: b.beds != null ? String(b.beds).slice(0, 12) : null,
      moveIn: plain(b.moveIn, 12), moveOut: plain(b.moveOut, 12),
      unit2: (b.unit2 && typeof b.unit2 === 'object') ? b.unit2 : null,
      photos: photoList(b.photos),
      helpful: 0,
      verified: !!b.verified,
      // Badge state: current/former, self-confirmed checkbox, and whether a
      // tenancy proof is awaiting moderator review. `verified` is only ever set
      // true by the moderation flow, never by the client here.
      status: b.status === 'former' ? 'former' : 'current',
      selfConfirmed: !!b.selfConfirmed,
      verifyPending: !!b.verifyPending,
    };
    try { await store.putItem('review', rv); res.json({ ok: true, item: rv }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'save failed' }); }
  });

  // Post a maintenance issue
  app.post('/api/issues', async (req, res) => {
    if (guard(req, res)) return;
    const b = req.body || {};
    if (!bid(b.b) || !clean(b.title)) return res.status(400).json({ error: 'A building and a title are required.' });
    const it = {
      id: id(b.id) || ('is_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      b: bid(b.b), ts: Date.now(), shared: true,
      cat: clean(b.cat, 40) || 'Other', title: clean(b.title, 160), desc: clean(b.desc, 2000),
      date: plain(b.date, 12) || new Date().toISOString().slice(0, 10),
      status: b.status === 'resolved' ? 'resolved' : 'open',
      resolvedDate: b.status === "resolved" ? (plain(b.resolvedDate, 12) || new Date().toISOString().slice(0, 10)) : null,
      by: clean(b.by, 40) || 'A tenant', photos: photoList(b.photos),
    };
    try { await store.putItem('issue', it); res.json({ ok: true, item: it }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'save failed' }); }
  });

  // Ask / answer neighbor Q&A
  app.post('/api/qa', async (req, res) => {
    if (guard(req, res)) return;
    const b = req.body || {};
    if (!bid(b.b) || !clean(b.q)) return res.status(400).json({ error: 'A building and a question are required.' });
    const q = {
      id: id(b.id) || ('qa_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      b: bid(b.b), ts: Date.now(), shared: true,
      q: clean(b.q, 500), a: clean(b.a, 1500), by: clean(b.by, 40) || 'A neighbor',
    };
    try { await store.putItem('qa', q); res.json({ ok: true, item: q }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'save failed' }); }
  });

  // Landlord / management right-of-reply on a review (public, marked unverified)
  app.post('/api/replies', async (req, res) => {
    if (guard(req, res)) return;
    const b = req.body || {};
    if (!id(b.rid) || !clean(b.text)) return res.status(400).json({ error: 'A review and a reply are required.' });
    const rp = {
      id: id(b.id) || ('rp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      b: bid(b.b), rid: id(b.rid), ts: Date.now(), shared: true, role: 'management',
      by: clean(b.by, 60) || 'Property management',
      text: clean(b.text, 2000),
    };
    try { await store.putItem('reply', rp); res.json({ ok: true, item: rp }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'save failed' }); }
  });

  // ---- Verified-tenant flow (private tenancy proof + moderation) ----
  // A data: URL (image or PDF) of a lease, capped hard so the store can't flood.
  function proofOK(s, maxLen = 2200000) {
    return typeof s === 'string' && /^data:(image\/|application\/pdf)/.test(s) && s.length < maxLen;
  }
  // Admin gate for the moderation endpoints. Key comes from env, compared to a
  // header / query / body value. If unset, moderation is simply unavailable.
  function admin(req, res) {
    if (!process.env.ADMIN_KEY) { res.status(503).json({ error: 'Moderation is not configured yet.' }); return false; }
    const k = String(req.headers['x-admin-key'] || (req.query && req.query.key) || (req.body && req.body.key) || '');
    if (k !== process.env.ADMIN_KEY) { res.status(403).json({ error: 'Invalid moderator key.' }); return false; }
    return true;
  }

  // Tenant submits a redacted lease to request a ✓ Verified badge on their review.
  app.post('/api/verify', async (req, res) => {
    if (guard(req, res)) return;
    const b = req.body || {};
    if (!id(b.rid) || !bid(b.b) || !proofOK(b.proof)) {
      return res.status(400).json({ error: 'A review, a building, and a lease image/PDF are required.' });
    }
    const item = {
      id: 'vf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      rid: id(b.rid), b: bid(b.b), ts: Date.now(),
      status: b.status === 'former' ? 'former' : 'current',
      by: clean(b.by, 60) || 'A tenant',
      note: clean(b.note, 300),
      proof: b.proof,                    // private; never returned by getAll
      ptype: b.ptype === 'pdf' ? 'pdf' : 'img',
    };
    try {
      await store.putItem('verify', item);
      // flip the public review to "pending" so the badge reads correctly for all
      const rv = await store.getItem(item.rid);
      if (rv) { rv.verifyPending = true; await store.putItem('review', rv); }
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'save failed' }); }
  });

  // Moderator: list pending proofs (includes the lease image — admin only).
  app.get('/api/verify/queue', async (req, res) => {
    if (!admin(req, res)) return;
    try { res.json({ ok: true, items: await store.listVerify() }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'queue read failed' }); }
  });

  // Moderator: approve — mark the review ✓ Verified, then DELETE the proof.
  app.post('/api/verify/approve', async (req, res) => {
    if (!admin(req, res)) return;
    const vId = id((req.body || {}).id);
    if (!vId) return res.status(400).json({ error: 'verification id required' });
    try {
      const v = await store.getItem(vId);
      if (!v) return res.status(404).json({ error: 'not found (already handled?)' });
      await store.setReviewVerified(v.rid, v.status);
      await store.deleteItem(vId);        // erase the lease once the decision is made
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'approve failed' }); }
  });

  // Moderator: reject — clear pending on the review, then DELETE the proof.
  app.post('/api/verify/reject', async (req, res) => {
    if (!admin(req, res)) return;
    const vId = id((req.body || {}).id);
    if (!vId) return res.status(400).json({ error: 'verification id required' });
    try {
      const v = await store.getItem(vId);
      if (v) {
        const rv = await store.getItem(v.rid);
        if (rv) { rv.verifyPending = false; await store.putItem('review', rv); }
        await store.deleteItem(vId);
      }
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'reject failed' }); }
  });

  // Name a MANAGEMENT COMPANY (keyed by property group, e.g. "pg651637").
  // Building names are fixed (seeded) and cannot be changed by anyone — only
  // property-group / management-company keys are accepted here.
  app.post('/api/names', async (req, res) => {
    if (guard(req, res)) return;
    const b = req.body || {};
    const key = bid(b.b);
    if (!/^pg\w+/.test(key)) return res.status(403).json({ error: 'Building names are fixed and cannot be renamed.' });
    if (!clean(b.name)) return res.status(400).json({ error: 'A company name is required.' });
    try { const it = await store.setName(key, clean(b.name, 80), clean(b.by, 40)); res.json({ ok: true, item: it }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'save failed' }); }
  });

  // Add a building photo
  app.post('/api/photos', async (req, res) => {
    if (guard(req, res)) return;
    const b = req.body || {};
    const ph = photoList([b.photo], 1)[0];
    if (!bid(b.b) || !ph) return res.status(400).json({ error: 'A building and an image are required.' });
    const p = { id: id(b.id) || ('ph_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)), b: bid(b.b), ts: Date.now(), url: ph, by: clean(b.by, 40) };
    try { await store.putItem('photo', p); res.json({ ok: true, item: p }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'save failed' }); }
  });

  // Helpful vote
  app.post('/api/helpful', async (req, res) => {
    if (guard(req, res)) return;
    const rid = id((req.body || {}).id);
    if (!rid) return res.status(400).json({ error: 'review id required' });
    try { res.json({ ok: true, n: await store.incHelpful(rid) }); }
    catch (e) { res.status(500).json({ error: 'failed' }); }
  });

  // Email signup (launch alerts / lead capture)
  app.post('/api/signup', async (req, res) => {
    if (guard(req, res)) return;
    const b = req.body || {};
    const email = String(b.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
    try { await store.addSignup(email, b.ctx, b.b); res.json({ ok: true }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'save failed' }); }
  });

  // Report content for moderation
  app.post('/api/reports', async (req, res) => {
    if (guard(req, res)) return;
    const b = req.body || {};
    try { await store.addReport(clean(b.kind, 20), id(b.ref), clean(b.reason, 500)); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: 'failed' }); }
  });
}

module.exports = { mount };
