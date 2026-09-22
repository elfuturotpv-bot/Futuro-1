#!/usr/bin/env node
'use strict';
/*
  Servidor del TPV Mercado (sin dependencias, Node 18 o superior).
  - Sirve la app (carpeta ./public) para instalarla en Android, PC o iPhone.
  - Sincroniza los equipos: POST /api/sync
  - Guarda los datos en ./data (un archivo por negocio).
  Variables opcionales: PORT (8080), DATA_DIR, PUBLIC_DIR, MAX_STORES (30), PAGE_SIZE (3000)
*/
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');

const PORT = +process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const MAX_STORES = +process.env.MAX_STORES || 30;
const PAGE = +process.env.PAGE_SIZE || 3000;
const BACKUPS = +process.env.BACKUPS || 14;   /* copias diarias que se conservan */
const MAX_BODY = 16 * 1024 * 1024;
fs.mkdirSync(DATA, { recursive: true });

/* cómo se fusiona cada colección */
const MODE = { products: 'lww', workers: 'lww', settings: 'lww', sales: 'sale', moves: 'add', shifts: 'add', audit: 'add' };

const stores = new Map();
const normKey = k => String(k || '').replace(/[\s-]/g, '').toUpperCase();
const storeId = key => crypto.createHash('sha256').update('tpv:' + key).digest('hex').slice(0, 32);
const fileOf = id => path.join(DATA, id + '.json');

function countStores() { try { return fs.readdirSync(DATA).filter(f => f.endsWith('.json')).length; } catch (e) { return 0; } }

function loadStore(id) {
  if (stores.has(id)) return stores.get(id);
  let st = null;
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
    st = { id, sid: j.sid, seq: j.seq || 0, recs: new Map(Object.entries(j.recs || {})), timer: null };
  } catch (e) { /* no existe o está dañado */ }
  if (st) stores.set(id, st);
  return st;
}
function createStore(id) {
  const st = { id, sid: crypto.randomBytes(8).toString('hex'), seq: 0, recs: new Map(), timer: null };
  stores.set(id, st); persist(st, true);
  return st;
}
function persist(st, now) {
  clearTimeout(st.timer);
  const write = () => {
    const tmp = fileOf(st.id) + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ sid: st.sid, seq: st.seq, recs: Object.fromEntries(st.recs) }));
      fs.renameSync(tmp, fileOf(st.id));
      backupDaily(st.id);
    } catch (e) { console.error('No se pudo guardar:', e.message); }
  };
  if (now) write(); else st.timer = setTimeout(write, 400);
}
const today = () => process.env.TPV_TODAY || new Date().toISOString().slice(0, 10);
function backupDaily(id) {
  try {
    const dir = path.join(DATA, 'backups'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, id + '-' + today() + '.json');
    if (!fs.existsSync(f)) {
      fs.copyFileSync(fileOf(id), f);
      const list = fs.readdirSync(dir).filter(n => n.startsWith(id + '-')).sort();
      while (list.length > BACKUPS) fs.unlinkSync(path.join(dir, list.shift()));
    }
  } catch (e) { console.error('No se pudo hacer la copia diaria:', e.message); }
}
function flushAll() { for (const st of stores.values()) if (st.timer) persist(st, true); }

function applyChanges(st, dev, changes) {
  let accepted = 0;
  for (const ch of changes) {
    if (!ch || !MODE[ch.c] || !ch.r || typeof ch.r.id !== 'string' || ch.r.id.length > 80) continue;
    const key = ch.c + ':' + ch.r.id, cur = st.recs.get(key);
    let ok = false;
    if (!cur) ok = true;
    else if (MODE[ch.c] === 'lww') ok = (+ch.r.u || 0) > (+cur.r.u || 0);
    else if (MODE[ch.c] === 'sale') ok = !!ch.r.void && !cur.r.void;
    if (ok) { st.recs.set(key, { c: ch.c, r: ch.r, seq: ++st.seq, by: dev }); accepted++; }
  }
  return accepted;
}
function changesSince(st, dev, since) {
  const list = [];
  for (const rec of st.recs.values()) if (rec.seq > since && rec.by !== dev) list.push(rec);
  list.sort((a, b) => a.seq - b.seq);
  const more = list.length > PAGE, page = more ? list.slice(0, PAGE) : list;
  return { changes: page.map(x => ({ c: x.c, r: x.r })), more, seq: more ? page[page.length - 1].seq : st.seq };
}

function lanIPs() {
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces()))
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  } catch (e) { /* sin permiso para leer las interfaces */ }
  return out;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-cache'
  }, headers || {}));
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function api(req, res, url) {
  if (url.pathname === '/api/ping') return json(res, 200, { ok: true, app: 'tpv-mercado', stores: countStores() });
  if (url.pathname === '/api/sync' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { ok: false, error: 'json' }); }
    const key = normKey(body.key), dev = String(body.dev || '').slice(0, 40);
    if (key.length < 8 || !dev) return json(res, 401, { ok: false, error: 'clave' });
    const id = storeId(key);
    let st = loadStore(id);
    if (!st) {
      if (countStores() >= MAX_STORES) return json(res, 403, { ok: false, error: 'limite' });
      st = createStore(id);
    }
    const n = Array.isArray(body.changes) ? applyChanges(st, dev, body.changes) : 0;
    if (n) persist(st);
    const out = changesSince(st, dev, +body.since || 0);
    return json(res, 200, { ok: true, sid: st.sid, seq: out.seq, more: out.more, changes: out.changes });
  }
  return json(res, 404, { ok: false });
}

function connectPage(req, res) {
  const host = String(req.headers.host || '');
  const ips = lanIPs().map(ip => 'http://' + ip + ':' + PORT);
  const list = (ips.length ? ips : ['(no se pudo detectar la IP: búscala en los ajustes del wifi de esta PC)']).map(u => '<li><b>' + u + '</b></li>').join('');
  const html = '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TPV Mercado - conectar</title>' +
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;color:#10263a}h1{font-size:22px}li{margin:6px 0;word-break:break-all}a.b{display:inline-block;background:#0f5a6e;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700;margin-top:8px}</style></head><body>' +
    '<h1>TPV Mercado: servidor activo</h1><p>Desde el teléfono (misma red wifi que esta PC) escribe en Chrome una de estas direcciones:</p><ul>' + list + '</ul>' +
    '<p>Datos guardados en la PC. Negocios registrados: ' + countStores() + '.</p><a class="b" href="/">Abrir el TPV</a>' +
    '<p style="color:#5a6b77;font-size:14px">Consultado desde: ' + host.replace(/[<>&"]/g, '') + '</p></body></html>';
  send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
}

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, 'Solicitud no válida'); }
  let file = path.normalize(path.join(PUB, rel));
  if (file !== PUB && !file.startsWith(PUB + path.sep)) return send(res, 403, 'Prohibido');
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch (e) { return send(res, 404, 'No encontrado'); }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'No encontrado');
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch(e => json(res, 500, { ok: false, error: String(e.message) }));
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido');
  if (url.pathname === '/conectar') return connectPage(req, res);
  serveStatic(req, res, url);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error('\n El puerto ' + PORT + ' ya está en uso (¿el TPV ya está abierto en otra ventana?).\n Ciérralo o usa otro puerto, por ejemplo: PORT=8081 node server.js\n');
  else console.error('\n No se pudo iniciar el servidor:', e.message, '\n');
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n ==========================================');
  console.log('  TPV Mercado - servidor en marcha (puerto ' + PORT + ')');
  console.log(' ==========================================\n');
  console.log(' En esta PC abre:            http://localhost:' + PORT);
  const ips = lanIPs();
  if (ips.length) for (const ip of ips) console.log(' En los teléfonos (mismo wifi): http://' + ip + ':' + PORT);
  else console.log(' En los teléfonos: usa la IP de esta PC (ajustes del wifi) con :' + PORT);
  console.log('\n Datos guardados en: ' + DATA);
  console.log(' Copias diarias en:  ' + path.join(DATA, 'backups'));
  console.log('\n Deja esta ventana abierta mientras se use el TPV.\n');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushAll(); process.exit(0); });
module.exports = { server };
