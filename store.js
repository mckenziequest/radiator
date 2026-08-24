// store.js — Radiator shared community store.
//
// Holds the content that must be the SAME for every visitor: tenant reviews,
// maintenance issues, neighbor Q&A, building names, building photos, and the
// helpful/report signals on them. This is what makes reviews actually shared
// across everyone instead of living on one person's device.
//
// Two backends, same interface:
//   • Postgres  — when DATABASE_URL is set (production, e.g. Render/Supabase/Neon).
//   • JSON file — when it is not (local dev + testing). Stored at data/community.json.
//
// Everything is content-addressed by a stable `id` the client generates, so
// re-posting the same item is idempotent (no duplicates).

const fs = require('fs');
const path = require('path');

const HAS_PG = !!process.env.DATABASE_URL;
const KINDS = ['review', 'issue', 'qa', 'name', 'photo'];

let pg = null;
if (HAS_PG) {
  const { Pool } = require('pg');
  pg = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

// ---------- JSON-file fallback ----------
const FILE = path.join(__dirname, 'data', 'community.json');
let mem = null;
function loadFile() {
  if (mem) return mem;
  try {
    mem = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    mem = { items: {}, helpful: {}, reports: [] };
  }
  return mem;
}
let saveTimer = null;
function saveFile() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(mem));
    } catch (e) { console.error('store save failed', e.message); }
  }, 250);
}

// ---------- init ----------
async function init() {
  if (!HAS_PG) { loadFile(); return; }
  await pg.query(`
    CREATE TABLE IF NOT EXISTS items (
      id       TEXT PRIMARY KEY,
      kind     TEXT NOT NULL,
      building TEXT,
      data     JSONB NOT NULL,
      ts       BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS items_building_idx ON items (building);
    CREATE INDEX IF NOT EXISTS items_ts_idx ON items (ts);
    CREATE TABLE IF NOT EXISTS helpful (
      review_id TEXT PRIMARY KEY,
      n         INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reports (
      id     TEXT PRIMARY KEY,
      kind   TEXT,
      ref    TEXT,
      reason TEXT,
      ts     BIGINT
    );
  `);
}

// ---------- writes ----------
// Upsert one content item. `id` stable → idempotent. Returns the stored item.
async function putItem(kind, item) {
  if (!KINDS.includes(kind)) throw new Error('bad kind');
  const id = String(item.id);
  const building = item.b != null ? String(item.b) : null;
  const ts = Number(item.ts) || Date.now();
  const rec = { id, kind, building, data: item, ts };
  if (HAS_PG) {
    await pg.query(
      `INSERT INTO items (id, kind, building, data, ts)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, ts = EXCLUDED.ts, building = EXCLUDED.building`,
      [id, kind, building, JSON.stringify(item), ts]
    );
  } else {
    loadFile().items[id] = rec;
    saveFile();
  }
  return item;
}

// A 'name' is one-per-building: use a deterministic id so latest wins.
async function setName(building, name, by) {
  const id = 'name:' + building;
  return putItem('name', { id, b: String(building), name: String(name), by: by || 'A neighbor', ts: Date.now() });
}

async function incHelpful(reviewId) {
  const id = String(reviewId);
  if (HAS_PG) {
    const r = await pg.query(
      `INSERT INTO helpful (review_id, n) VALUES ($1,1)
       ON CONFLICT (review_id) DO UPDATE SET n = helpful.n + 1 RETURNING n`, [id]);
    return r.rows[0].n;
  }
  const m = loadFile();
  m.helpful[id] = (m.helpful[id] || 0) + 1;
  saveFile();
  return m.helpful[id];
}

async function addReport(kind, ref, reason) {
  const rec = { id: 'rep_' + Math.random().toString(36).slice(2) + Date.now().toString(36), kind, ref, reason: String(reason || '').slice(0, 500), ts: Date.now() };
  if (HAS_PG) {
    await pg.query(`INSERT INTO reports (id, kind, ref, reason, ts) VALUES ($1,$2,$3,$4,$5)`,
      [rec.id, kind, ref, rec.reason, rec.ts]);
  } else {
    loadFile().reports.push(rec);
    saveFile();
  }
  return rec;
}

// ---------- reads ----------
// Everything the client needs to render shared content, optionally only what
// changed since `since` (ms epoch) for cheap polling.
async function getAll(since) {
  const s = Number(since) || 0;
  let items = [], helpful = {};
  if (HAS_PG) {
    const r = await pg.query(`SELECT data, kind, ts FROM items WHERE ts > $1 ORDER BY ts ASC`, [s]);
    items = r.rows.map(row => ({ ...row.data, _kind: row.kind }));
    const h = await pg.query(`SELECT review_id, n FROM helpful`);
    h.rows.forEach(row => { helpful[row.review_id] = row.n; });
  } else {
    const m = loadFile();
    items = Object.values(m.items).filter(r => r.ts > s).sort((a, b) => a.ts - b.ts)
      .map(r => ({ ...r.data, _kind: r.kind }));
    helpful = m.helpful;
  }
  const out = { reviews: [], issues: [], qa: [], names: {}, photos: [], helpful, now: Date.now() };
  for (const it of items) {
    if (it._kind === 'review') out.reviews.push(strip(it));
    else if (it._kind === 'issue') out.issues.push(strip(it));
    else if (it._kind === 'qa') out.qa.push(strip(it));
    else if (it._kind === 'photo') out.photos.push(strip(it));
    else if (it._kind === 'name') out.names[it.b] = it.name;
  }
  return out;
}
function strip(o) { const c = { ...o }; delete c._kind; return c; }

async function stats() {
  if (HAS_PG) {
    const r = await pg.query(`SELECT kind, COUNT(*)::int c FROM items GROUP BY kind`);
    const o = {}; r.rows.forEach(x => o[x.kind] = x.c); return o;
  }
  const m = loadFile(); const o = {};
  Object.values(m.items).forEach(r => o[r.kind] = (o[r.kind] || 0) + 1);
  return o;
}

module.exports = { init, putItem, setName, incHelpful, addReport, getAll, stats, HAS_PG };
