const http        = require('http');
const https       = require('https');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const crypto      = require('crypto');
const bcrypt      = require('bcryptjs');
const Database    = require('better-sqlite3');
const bambu       = require('./bambu');

const BROWSER_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// GET Bambu API avec token
function curlGet(url, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { ...BROWSER_HEADERS, 'Authorization': `Bearer ${token}` },
      timeout: 15000,
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (data.trimStart().startsWith('<')) return reject(new Error('Bloqué par Cloudflare'));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Réponse inattendue : ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// POST Bambu API
function curlPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/json',
        'Origin': 'https://bambulab.com',
        'Referer': 'https://bambulab.com/fr/sign-in',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (data.trimStart().startsWith('<')) return reject(new Error('Bloqué par Cloudflare'));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Réponse inattendue : ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

const PORT     = process.env.PORT || 3000;
const DATA_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : __dirname;
const DB_FILE  = process.env.DB_PATH || path.join(__dirname, 'stock.db');
const HTML_FILE     = path.join(__dirname, 'index.html');
const LANDING_FILE  = path.join(__dirname, 'landing.html');

// ── BASE DE DONNÉES ───────────────────────────────────────────────────────
const db = new Database(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    "desc"    TEXT,
    filament  TEXT,
    color     TEXT,
    colorName TEXT,
    qty       INTEGER DEFAULT 0,
    threshold INTEGER DEFAULT 3,
    photo     TEXT,
    createdAt TEXT,
    updatedAt TEXT
  );
  CREATE TABLE IF NOT EXISTS history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id   TEXT NOT NULL,
    item_name TEXT NOT NULL,
    action    TEXT NOT NULL,
    detail    TEXT,
    ts        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

// ── MIGRATIONS ────────────────────────────────────────────────────────────
function addColumnIfMissing(table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) {
    if (!e.message.includes('duplicate column name')) {
      console.error(`  [Migration] Erreur ALTER TABLE ${table}.${col} :`, e.message);
    }
  }
}
addColumnIfMissing('items', 'category', 'TEXT');
addColumnIfMissing('items', 'trackStock', 'INTEGER DEFAULT 1');
addColumnIfMissing('items', 'variants', 'TEXT');
addColumnIfMissing('items', 'parts', 'TEXT');
addColumnIfMissing('items', 'assembledQty', 'INTEGER DEFAULT 0');
addColumnIfMissing('items', 'assembledItems', 'TEXT');

// Migrer les anciens items (qty/color/colorName) vers le format variants JSON
db.exec(`
  UPDATE items
  SET variants = json_array(json_object(
    'color',     COALESCE(color, '#888888'),
    'colorName', COALESCE(colorName, ''),
    'qty',       COALESCE(qty, 0)
  ))
  WHERE variants IS NULL;
`);

// Index pour les requêtes d'historique par item
db.exec('CREATE INDEX IF NOT EXISTS idx_history_item_id ON history(item_id);');

// Table catégories
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    createdAt TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

// Table impressions Bambu à valider
db.exec(`
  CREATE TABLE IF NOT EXISTS print_jobs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_serial TEXT NOT NULL,
    printer_name   TEXT,
    file_name      TEXT,
    filament_color TEXT,
    filament_type  TEXT,
    total_layers   INTEGER,
    status         TEXT DEFAULT 'pending',
    ts             TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);
addColumnIfMissing('print_jobs', 'thumbnail', 'TEXT');
addColumnIfMissing('print_jobs', 'weight',    'REAL');
addColumnIfMissing('print_jobs', 'duration',  'INTEGER');

// ── TABLES MULTI-TENANT ───────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name          TEXT,
    plan          TEXT DEFAULT 'beta',
    bambu_token   TEXT,
    bambu_printers TEXT DEFAULT '[]',
    bambu_email   TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);

// Migrations multi-tenant
addColumnIfMissing('items',      'user_id', 'TEXT');
addColumnIfMissing('categories', 'user_id', 'TEXT');
addColumnIfMissing('print_jobs', 'user_id', 'TEXT');
addColumnIfMissing('history',    'user_id', 'TEXT');

// ── DOSSIER UPLOADS ───────────────────────────────────────────────────────
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Télécharge une image distante et la stocke dans /uploads/, retourne le chemin local ou null
function downloadToUploads(remoteUrl) {
  if (!remoteUrl || remoteUrl.startsWith('/')) return Promise.resolve(remoteUrl || null);
  return new Promise(resolve => {
    const rawExt = (remoteUrl.split('?')[0].split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const ext = ['jpg','jpeg','png','webp','gif'].includes(rawExt) ? (rawExt === 'jpeg' ? 'jpg' : rawExt) : 'jpg';
    const filename = `thumb_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const filepath  = path.join(UPLOADS_DIR, filename);
    const doDownload = (downloadUrl, redirects = 0) => {
      if (redirects > 5) { resolve(null); return; }
      const parsed = new URL(downloadUrl);
      const mod = parsed.protocol === 'https:' ? https : http;
      mod.get(downloadUrl, { timeout: 20000 }, res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          return doDownload(res.headers.location, redirects + 1);
        }
        const out = fs.createWriteStream(filepath);
        res.pipe(out);
        out.on('finish', () => {
          out.close();
          if (!fs.existsSync(filepath) || fs.statSync(filepath).size < 100) {
            try { fs.unlinkSync(filepath); } catch {}
            resolve(null);
          } else {
            resolve(`/uploads/${filename}`);
          }
        });
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    };
    doDownload(remoteUrl);
  });
}

// Migration : convertir les photos base64 existantes en fichiers
(function migratePhotos() {
  const rows = db.prepare('SELECT id, photo FROM items WHERE photo LIKE :prefix').all({ prefix: 'data:image%' });
  for (const row of rows) {
    try {
      const m = row.photo.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!m) continue;
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const filename = `photo_${row.id}.${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(m[2], 'base64'));
      db.prepare('UPDATE items SET photo = :url WHERE id = :id').run({ url: `/uploads/${filename}`, id: row.id });
      console.log(`  Migration photo: ${row.id} → ${filename}`);
    } catch (e) { console.error(`  Erreur migration photo ${row.id}:`, e.message); }
  }
  if (rows.length) console.log(`  ${rows.length} photo(s) migrée(s) en fichiers.`);
})();

// Migration : convertir les photos base64 stockées dans parts[].photo en fichiers
(function migratePartPhotos() {
  const rows = db.prepare("SELECT id, name, parts FROM items WHERE parts LIKE '%data:image%'").all();
  let migrated = 0;
  for (const row of rows) {
    try {
      let parts = JSON.parse(row.parts);
      if (typeof parts === 'string') parts = JSON.parse(parts);
      if (!Array.isArray(parts)) continue;
      let changed = false;
      for (const part of parts) {
        if (!part.photo || !part.photo.startsWith('data:image')) continue;
        const m = part.photo.match(/^data:image\/(\w+);base64,(.+)$/s);
        if (!m) continue;
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const filename = `photo_part_${row.id}_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(m[2], 'base64'));
        part.photo = `/uploads/${filename}`;
        changed = true;
        migrated++;
        console.log(`  Migration photo pièce: "${part.name}" (item ${row.id}) → ${filename}`);
      }
      if (changed) {
        db.prepare('UPDATE items SET parts = :parts WHERE id = :id')
          .run({ parts: JSON.stringify(parts), id: row.id });
      }
    } catch (e) { console.error(`  Erreur migration photo pièce ${row.id}:`, e.message); }
  }
  if (migrated) console.log(`  ${migrated} photo(s) de pièces migrées en fichiers.`);
})();

// Cache HTML — chargé une seule fois au démarrage (pm2 restart à chaque déploiement)
let htmlCache     = fs.readFileSync(HTML_FILE, 'utf8');
let landingCache  = fs.readFileSync(LANDING_FILE, 'utf8');

// Nettoyage des fichiers orphelins dans /uploads (pas référencés en BDD)
(function cleanOrphanUploads() {
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    if (!files.length) return;
    const referenced = new Set();
    db.prepare("SELECT photo FROM items WHERE photo LIKE '/uploads/%'").all()
      .forEach(r => referenced.add(path.basename(r.photo)));
    db.prepare("SELECT thumbnail FROM print_jobs WHERE thumbnail LIKE '/uploads/%'").all()
      .forEach(r => referenced.add(path.basename(r.thumbnail)));
    db.prepare("SELECT parts FROM items WHERE parts LIKE '%/uploads/%'").all().forEach(r => {
      try {
        const parts = safeParseJson(r.parts);
        parts.forEach(p => {
          if (p.photo && p.photo.startsWith('/uploads/')) referenced.add(path.basename(p.photo));
        });
      } catch {}
    });
    const orphans = files.filter(f => !referenced.has(f));
    for (const f of orphans) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); console.log(`  Orphelin supprimé: ${f}`); }
      catch (e) { console.warn(`  Impossible de supprimer orphelin ${f}:`, e.message); }
    }
    if (orphans.length) console.log(`  ${orphans.length} fichier(s) orphelin(s) supprimé(s).`);
  } catch (e) { console.warn('  [cleanOrphanUploads]', e.message); }
})();

// ── IP LOCALE ─────────────────────────────────────────────────────────────
function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

// ── ICÔNE SVG ─────────────────────────────────────────────────────────────
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="80" fill="#0f0f13"/>
  <g transform="translate(256,256)" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M0,-130 L-120,-65 L0,0 L120,-65 Z" fill="#6c47ff" opacity="0.4"/>
    <path d="M0,-130 L-120,-65 L0,0 L120,-65 Z" stroke="#6c47ff" stroke-width="14"/>
    <path d="M-120,-65 L-120,65 L0,130 L0,0 Z" stroke="#6c47ff" stroke-width="14"/>
    <path d="M120,-65 L120,65 L0,130 L0,0 Z" stroke="#6c47ff" stroke-width="14"/>
  </g>
</svg>`;

// ── MANIFEST PWA ──────────────────────────────────────────────────────────
const MANIFEST = JSON.stringify({
  name: 'BambuStock | Gestion du stock',
  short_name: 'BambuStock',
  description: 'Gestion du stock impression 3D',
  start_url: '/app',
  display: 'standalone',
  background_color: '#0f0f13',
  theme_color: '#6c47ff',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }
  ]
});

// ── UTILITAIRES ───────────────────────────────────────────────────────────
function parseBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((res, rej) => {
    let raw = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        return rej(new Error('Corps trop volumineux (max 10 Mo)'));
      }
      raw += c;
    });
    req.on('end', () => { try { res(JSON.parse(raw)); } catch { rej(new Error('JSON invalide')); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function logHistory(itemId, itemName, action, detail = null) {
  db.prepare('INSERT INTO history (item_id, item_name, action, detail) VALUES (:itemId,:itemName,:action,:detail)')
    .run({ itemId, itemName, action, detail: detail ? JSON.stringify(detail) : null });
}

// Parse robuste JSON (gère simple et double encodage héritage)
function safeParseJson(raw, fallback = []) {
  try {
    let v = JSON.parse(raw || JSON.stringify(fallback));
    if (typeof v === 'string') v = JSON.parse(v); // double-encodage héritage
    return v ?? fallback;
  } catch { return fallback; }
}

// Calcule la quantité totale à partir du JSON variants
function totalQty(variantsJson) {
  try {
    const v = JSON.parse(variantsJson || '[]');
    return v.reduce((s, x) => s + (x.qty || 0), 0);
  } catch { return 0; }
}

// Normalise une couleur Bambu (RRGGBB, #RRGGBB, RRGGBBAA, #RRGGBBAA) → '#RRGGBB'
function normColor(c) {
  if (!c) return null;
  const hex = c.replace(/^#/, '');
  if (hex.length >= 6 && /^[0-9a-fA-F]{6,8}$/.test(hex)) return '#' + hex.slice(0, 6).toUpperCase();
  return null;
}

// Vérifie si un token JWT Bambu est expiré
function isTokenExpired(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (!payload.exp) return false;
    return Date.now() / 1000 > payload.exp;
  } catch { return false; }
}

// ── SESSION HELPERS ───────────────────────────────────────────────────────
function getSessionUser(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)bs_session=([^;]+)/);
  if (!m) return null;
  return db.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>datetime('now')"
  ).get(m[1]) || null;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `bs_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*3600}`);
}

function nanoid() {
  return crypto.randomBytes(10).toString('base64url').slice(0, 14);
}

// ── SERVER-SENT EVENTS (per-user) ─────────────────────────────────────────
const sseByUser   = new Map(); // userId → Set<res>
const bambuByUser = new Map(); // userId → { status, client? }

function broadcast(userId, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const clients = sseByUser.get(userId) || new Set();
  for (const c of clients) { try { c.write(msg); } catch { clients.delete(c); } }
}

function getBambuStatus(userId) {
  return (bambuByUser.get(userId) || {}).status || 'disconnected';
}

function onStateChange(userId, status) {
  bambuByUser.set(userId, { ...(bambuByUser.get(userId) || {}), status });
  broadcast(userId, 'bambu-status', { status });
}

// ── BAMBU CALLBACKS ───────────────────────────────────────────────────────

// Enrichit un job MQTT depuis l'historique Bambu (thumbnail, filament, poids…)
async function enrichJobFromHistory(userId, jobId, fileName) {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const token = user?.bambu_token;
    if (!token) return;
    const d = await curlGet(
      'https://api.bambulab.com/v1/user-service/my/tasks?deviceId=&limit=20&offset=0',
      token,
    );
    const tasks = d.hits || d.data?.hits || d.tasks || [];
    const clean = s => (s || '').replace(/\.gcode\.3mf$|\.gcode$|\.3mf$/i, '').trim().toLowerCase();
    const fn = clean(fileName);
    const task = tasks.find(t => {
      const n = clean(t.designTitle || t.title || t.name || t.subtaskName || '');
      return n === fn || n.includes(fn) || fn.includes(n);
    });
    if (!task) { console.log(`  [Bambu] Enrichissement : tâche "${fileName}" non trouvée dans l'historique`); return; }

    const filaments = Array.isArray(task.filamentUsed) ? task.filamentUsed
                    : Array.isArray(task.filamentList)  ? task.filamentList : [];
    const rawColor = filaments[0]?.color || filaments[0]?.colorCode || task.filamentColor || null;
    const fc = normColor(rawColor);
    const rawTypes = filaments.map(f => f.type || f.materialName || f.name).filter(Boolean);
    const ft = ([...new Set(rawTypes)].join(' · ') || task.filamentType || task.materialName || null);
    const remoteThumb = task.cover || task.thumbnail || null;
    const th = await downloadToUploads(remoteThumb);
    const wt = task.weight || null;
    const du = task.costTime || null;

    db.prepare(`
      UPDATE print_jobs SET
        filament_color = COALESCE(filament_color, :fc),
        filament_type  = COALESCE(filament_type,  :ft),
        thumbnail      = COALESCE(thumbnail,       :th),
        weight         = COALESCE(weight,          :wt),
        duration       = COALESCE(duration,        :du)
      WHERE id = :id
    `).run({ fc, ft, th, wt, du, id: jobId });

    const updated = db.prepare('SELECT * FROM print_jobs WHERE id = :id').get({ id: jobId });
    broadcast(userId, 'print-update', { ...updated, source: 'mqtt' });
    console.log(`  [Bambu] Job enrichi depuis l'historique : ${fileName}`);
  } catch(e) {
    console.warn(`  [Bambu] Enrichissement impossible : ${e.message}`);
  }
}

function onPrintCompleteForUser(userId, job) {
  // Règle 1 : déjà dans la queue en attente → inutile d'en ajouter un autre
  const alreadyPending = db.prepare(`
    SELECT id FROM print_jobs
    WHERE printer_serial=:ps AND file_name=:fn AND status='pending' AND user_id=:uid
  `).get({ ps: job.printerSerial, fn: job.fileName, uid: userId });
  if (alreadyPending) {
    console.log(`  [Bambu] Doublon ignoré : ${job.fileName} (déjà en attente)`);
    return;
  }
  // Règle 2 : reçu il y a moins de 10 min (Bambu renvoie souvent FINISH plusieurs fois)
  const justReceived = db.prepare(`
    SELECT id FROM print_jobs
    WHERE printer_serial=:ps AND file_name=:fn AND user_id=:uid
      AND ts > datetime('now','-10 minutes')
  `).get({ ps: job.printerSerial, fn: job.fileName, uid: userId });
  if (justReceived) {
    console.log(`  [Bambu] Doublon ignoré : ${job.fileName} (reçu il y a moins de 10 min)`);
    return;
  }
  console.log(`  [Bambu] Impression terminée : ${job.fileName} (${job.printerName})`);
  const row = db.prepare(`
    INSERT INTO print_jobs (printer_serial, printer_name, file_name, filament_color, filament_type, total_layers, user_id)
    VALUES (:ps, :pn, :fn, :fc, :ft, :tl, :uid)
  `).run({
    ps: job.printerSerial, pn: job.printerName, fn: job.fileName,
    fc: normColor(job.filamentColor),
    ft: job.filamentType, tl: job.totalLayers,
    uid: userId,
  });
  const newJob = db.prepare('SELECT * FROM print_jobs WHERE id = :id').get({ id: row.lastInsertRowid });
  broadcast(userId, 'print-complete', { ...newJob, source: 'mqtt' });
  // 10 s après, enrichir depuis l'API historique (thumbnail, poids, durée…)
  setTimeout(() => enrichJobFromHistory(userId, newJob.id, job.fileName), 10_000);
}

function connectBambu(userId, token, printers, userEmail) {
  const prev = bambuByUser.get(userId);
  if (prev?.client) prev.client.end(true);
  let client;
  client = bambu.connect({
    token, printers: printers || [], userEmail,
    onPrintComplete: job => onPrintCompleteForUser(userId, job),
    onStateChange: status => {
      if ((bambuByUser.get(userId) || {}).client === client) onStateChange(userId, status);
    },
  });
  bambuByUser.set(userId, { status: 'connecting', client });
}

// Sauvegarde un token Bambu dans la table users
function saveBambuToken(userId, token, printers, email) {
  db.prepare('UPDATE users SET bambu_token=?, bambu_printers=?, bambu_email=? WHERE id=?')
    .run(token, JSON.stringify(printers || []), email || null, userId);
}

// Sessions 2FA en attente (stockées en mémoire, expirent en 10 min)
const pendingTfa = new Map(); // sessionId → { email, password, expires, userId }
// Purge automatique toutes les 2 min pour éviter de garder des credentials en RAM indéfiniment
setInterval(() => {
  const now = Date.now();
  for (const [sid, tfa] of pendingTfa.entries()) {
    if (now > tfa.expires) pendingTfa.delete(sid);
  }
}, 2 * 60_000);

// ── SERVEUR ───────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url   = req.url.split('?')[0];
  const parts = url.split('/').filter(Boolean);
  const [, , id, sub] = parts;

  try {

    // ── STATIC ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(landingCache);
      return;
    }
    if (req.method === 'GET' && (url === '/app' || url === '/app/')) {
      const user = getSessionUser(req);
      if (!user) { res.writeHead(302, { Location: '/' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlCache);
      return;
    }
    if (req.method === 'GET' && url === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
      res.end(MANIFEST);
      return;
    }
    if (req.method === 'GET' && url === '/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(ICON_SVG);
      return;
    }

    // ── FICHIERS UPLOADS ─────────────────────────────────────────────────
    if (req.method === 'GET' && parts[0] === 'uploads' && parts[1]) {
      const filename = path.basename(parts[1]);
      const filepath = path.join(UPLOADS_DIR, filename);
      const ext = path.extname(filename).slice(1).toLowerCase();
      const mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif' };
      if (!mimeMap[ext]) { res.writeHead(403); res.end('Type de fichier non autorisé'); return; }
      if (!fs.existsSync(filepath)) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': mimeMap[ext], 'Cache-Control': 'public, max-age=31536000' });
      fs.createReadStream(filepath).pipe(res);
      return;
    }

    // ── AUTH ROUTES (publiques) ──────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/auth/me') {
      const user = getSessionUser(req);
      if (!user) { json(res, { user: null }); return; }
      json(res, { user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
      return;
    }

    if (req.method === 'POST' && url === '/api/auth/register') {
      const b = await parseBody(req);
      const { email, password, name } = b;
      if (!email || !password) { json(res, { error: 'Email et mot de passe requis' }, 400); return; }
      const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
      if (existing) { json(res, { error: 'Email déjà utilisé' }, 409); return; }
      const hash = await bcrypt.hash(password, 12);
      const uid = nanoid();
      db.prepare('INSERT INTO users (id,email,password_hash,name,created_at) VALUES (?,?,?,?,?)')
        .run(uid, email.toLowerCase(), hash, name || null, new Date().toISOString());
      // Assigner items existants sans user_id au premier utilisateur
      const orphans = db.prepare('SELECT COUNT(*) as c FROM items WHERE user_id IS NULL').get().c;
      if (orphans > 0) {
        db.prepare('UPDATE items SET user_id=? WHERE user_id IS NULL').run(uid);
        db.prepare('UPDATE categories SET user_id=? WHERE user_id IS NULL').run(uid);
        db.prepare('UPDATE print_jobs SET user_id=? WHERE user_id IS NULL').run(uid);
        db.prepare('UPDATE history SET user_id=? WHERE user_id IS NULL').run(uid);
      }
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 30*24*3600*1000).toISOString();
      db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(token, uid, expires);
      setSessionCookie(res, token);
      json(res, { user: { id: uid, email: email.toLowerCase(), name: name || null, plan: 'beta' } });
      return;
    }

    if (req.method === 'POST' && url === '/api/auth/login') {
      const b = await parseBody(req);
      const { email, password } = b;
      const user = db.prepare('SELECT * FROM users WHERE email=?').get((email||'').toLowerCase());
      if (!user) { json(res, { error: 'Email ou mot de passe incorrect' }, 401); return; }
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) { json(res, { error: 'Email ou mot de passe incorrect' }, 401); return; }
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 30*24*3600*1000).toISOString();
      db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(token, user.id, expires);
      setSessionCookie(res, token);
      // Auto-connect Bambu si token valide
      if (user.bambu_token && !isTokenExpired(user.bambu_token)) {
        const printers = JSON.parse(user.bambu_printers || '[]');
        connectBambu(user.id, user.bambu_token, printers, user.bambu_email);
      }
      json(res, { user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
      return;
    }

    if (req.method === 'POST' && url === '/api/auth/logout') {
      const cookie = req.headers.cookie || '';
      const m = cookie.match(/(?:^|;\s*)bs_session=([^;]+)/);
      const sessionToken = m ? m[1] : null;
      let userId = null;
      if (sessionToken) {
        const sess = db.prepare('SELECT user_id FROM sessions WHERE token=?').get(sessionToken);
        if (sess) userId = sess.user_id;
        db.prepare('DELETE FROM sessions WHERE token=?').run(sessionToken);
        // Déconnecter Bambu si plus de sessions actives pour cet user
        if (userId) {
          const otherSessions = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id=?').get(userId).c;
          if (otherSessions === 0) {
            const state = bambuByUser.get(userId);
            if (state?.client) state.client.end(true);
            bambuByUser.delete(userId);
          }
        }
      }
      setSessionCookie(res, '');
      json(res, { ok: true });
      return;
    }

    // ── SSE ──────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/sse') {
      const user = getSessionUser(req);
      if (!user) { res.writeHead(401); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: bambu-status\ndata: ${JSON.stringify({ status: getBambuStatus(user.id) })}\n\n`);
      if (!sseByUser.has(user.id)) sseByUser.set(user.id, new Set());
      sseByUser.get(user.id).add(res);
      const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(keepalive);
        const s = sseByUser.get(user.id);
        if (s) { s.delete(res); if (!s.size) sseByUser.delete(user.id); }
      });
      return;
    }

    // ── MIDDLEWARE AUTH (toutes les routes /api/* suivantes) ─────────────
    if (url.startsWith('/api/')) {
      const user = getSessionUser(req);
      if (!user) { json(res, { error: 'Non authentifié' }, 401); return; }
      const userId = user.id;

      // ── UPLOAD PHOTO ─────────────────────────────────────────────────
      if (req.method === 'POST' && url === '/api/upload') {
        const b = await parseBody(req);
        if (!b.data || !b.data.startsWith('data:image')) {
          json(res, { error: 'Données image invalides' }, 400); return;
        }
        const m = b.data.match(/^data:image\/(\w+);base64,(.+)$/s);
        if (!m) { json(res, { error: 'Format image invalide' }, 400); return; }
        const MAX_IMG = 5 * 1024 * 1024;
        if (m[2].length > MAX_IMG * 1.4) {
          json(res, { error: 'Image trop volumineuse (max 5 Mo)' }, 413); return;
        }
        const allowedExts = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
        const rawExt = m[1].toLowerCase();
        if (!allowedExts.includes(rawExt)) {
          json(res, { error: 'Format image non supporté' }, 415); return;
        }
        const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
        const filename = `photo_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(m[2], 'base64'));
        json(res, { url: `/uploads/${filename}` });
        return;
      }

      // ── SSE (legacy endpoint) ─────────────────────────────────────────
      if (req.method === 'GET' && url === '/api/events') {
        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        });
        const pending = db.prepare("SELECT * FROM print_jobs WHERE status='pending' AND user_id=? ORDER BY ts DESC").all(userId);
        res.write(`event: init\ndata: ${JSON.stringify({ bambuStatus: getBambuStatus(userId), pending })}\n\n`);
        if (!sseByUser.has(userId)) sseByUser.set(userId, new Set());
        sseByUser.get(userId).add(res);
        const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(keepalive);
          const s = sseByUser.get(userId);
          if (s) { s.delete(res); if (!s.size) sseByUser.delete(userId); }
        });
        return;
      }

      // ── PRINT JOBS ───────────────────────────────────────────────────
      if (req.method === 'GET' && url === '/api/print-jobs') {
        json(res, db.prepare("SELECT * FROM print_jobs WHERE status='pending' AND user_id=? ORDER BY ts DESC").all(userId));
        return;
      }
      if (req.method === 'DELETE' && url === '/api/print-jobs') {
        db.prepare("UPDATE print_jobs SET status='dismissed' WHERE status='pending' AND user_id=?").run(userId);
        json(res, { ok: true });
        return;
      }
      if (req.method === 'DELETE' && parts[1] === 'print-jobs' && id) {
        db.prepare('UPDATE print_jobs SET status=:s WHERE id=:id AND user_id=:uid').run({ s: 'dismissed', id, uid: userId });
        json(res, { ok: true });
        return;
      }
      if (req.method === 'PATCH' && parts[1] === 'print-jobs' && id && sub === 'done') {
        db.prepare('UPDATE print_jobs SET status=:s WHERE id=:id AND user_id=:uid').run({ s: 'done', id, uid: userId });
        json(res, { ok: true });
        return;
      }

      // Version de l'application
      if (req.method === 'GET' && url === '/api/version') {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        json(res, {
          version: process.env.APP_VERSION || pkg.version,
          commit:  process.env.GIT_COMMIT  || 'dev',
        });
        return;
      }

      // Statut connexion Bambu
      if (req.method === 'GET' && url === '/api/bambu/status') {
        json(res, { status: getBambuStatus(userId) });
        return;
      }

      // Auth Bambu email/password → token
      if (req.method === 'POST' && url === '/api/bambu/auth') {
        const b = await parseBody(req);
        if (!b.email || !b.password) { json(res, { error: 'Email et mot de passe requis' }, 400); return; }
        try {
          const d = await curlPost('https://api.bambulab.com/v1/user-service/user/login', {
            account: b.email, password: b.password,
          });
          if (d.loginType === 'verifyCode') {
            try {
              await curlPost('https://api.bambulab.com/v1/user-service/user/sendemail/code', {
                email: b.email,
                type:  'codeLogin',
              });
              console.log(`  [Bambu] Code 2FA envoyé à ${b.email}`);
            } catch(sendErr) {
              console.warn('  [Bambu] Avertissement envoi code :', sendErr.message);
            }
            const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2);
            pendingTfa.set(sessionId, { email: b.email, password: b.password, expires: Date.now() + 10 * 60_000, userId });
            json(res, { needsCode: true, sessionId });
            return;
          }
          const token = d.accessToken || d.token || d.data?.accessToken;
          if (!token) throw new Error(d.message || d.error || 'Pas de token dans la réponse');
          const currentUser = db.prepare('SELECT bambu_printers FROM users WHERE id=?').get(userId);
          const printers = JSON.parse(currentUser?.bambu_printers || '[]');
          saveBambuToken(userId, token, printers, b.email);
          connectBambu(userId, token, printers, b.email);
          onStateChange(userId, 'connected');
          json(res, { ok: true });
        } catch(e) {
          json(res, { error: e.message }, 401);
        }
        return;
      }

      // Validation du code 2FA Bambu
      if (req.method === 'POST' && url === '/api/bambu/verify') {
        const b = await parseBody(req);
        const { code, sessionId } = b;
        if (!code || !sessionId) { json(res, { error: 'Code et session requis' }, 400); return; }
        const tfa = pendingTfa.get(sessionId);
        if (!tfa || Date.now() > tfa.expires) {
          pendingTfa.delete(sessionId);
          json(res, { error: 'Session expirée — recommence la connexion' }, 400);
          return;
        }
        try {
          const d = await curlPost('https://api.bambulab.com/v1/user-service/user/login', {
            account: tfa.email, password: tfa.password, code: code.trim(),
          });
          const token = d.accessToken || d.token || d.data?.accessToken;
          if (!token) throw new Error(d.message || d.error || 'Code invalide ou expiré');
          const email = tfa.email;
          const tfaUserId = tfa.userId || userId;
          pendingTfa.delete(sessionId);
          const currentUser = db.prepare('SELECT bambu_printers FROM users WHERE id=?').get(tfaUserId);
          const printers = JSON.parse(currentUser?.bambu_printers || '[]');
          saveBambuToken(tfaUserId, token, printers, email);
          connectBambu(tfaUserId, token, printers, email);
          onStateChange(tfaUserId, 'connected');
          json(res, { ok: true });
        } catch(e) {
          json(res, { error: e.message }, 401);
        }
        return;
      }

      // Enregistre un token Bambu manuellement et reconnecte MQTT
      if (req.method === 'POST' && url === '/api/bambu/token') {
        const b = await parseBody(req);
        const token = (b.token || '').trim();
        if (!token || !token.startsWith('eyJ')) {
          json(res, { error: 'Token invalide (doit commencer par eyJ)' }, 400); return;
        }
        try {
          const currentUser = db.prepare('SELECT bambu_printers FROM users WHERE id=?').get(userId);
          const printers = JSON.parse(currentUser?.bambu_printers || '[]');
          saveBambuToken(userId, token, printers, null);
          connectBambu(userId, token, printers);
          json(res, { ok: true });
        } catch(e) {
          json(res, { error: e.message }, 500);
        }
        return;
      }

      // ⚠️ Endpoint de test — simule une impression terminée
      if (req.method === 'POST' && url === '/api/print-jobs/test') {
        const b = await parseBody(req).catch(() => ({}));
        const row = db.prepare(`
          INSERT INTO print_jobs (printer_serial, printer_name, file_name, filament_color, filament_type, total_layers, user_id)
          VALUES (:ps, :pn, :fn, :fc, :ft, :tl, :uid)
        `).run({
          ps: 'TEST00000000000',
          pn: b.printerName   || 'H2D (test)',
          fn: b.fileName      || 'Support_plateau_v3',
          fc: b.filamentColor || '#6c47ff',
          ft: b.filamentType  || 'PETG',
          tl: 142,
          uid: userId,
        });
        const newJob = db.prepare('SELECT * FROM print_jobs WHERE id = :id').get({ id: row.lastInsertRowid });
        broadcast(userId, 'print-complete', { ...newJob, source: 'mqtt' });
        json(res, newJob, 201);
        return;
      }

      // Proxy image Bambu (miniature protégée par auth)
      if (req.method === 'GET' && url === '/api/bambu/image') {
        const imgUrl = new URLSearchParams(req.url.split('?')[1] || '').get('url');
        if (!imgUrl) { res.writeHead(400); res.end('url manquante'); return; }
        try {
          const parsed = new URL(imgUrl);
          const allowedDomains = ['bambulab.com', 'bambulab.cn', 'bblmw.com'];
          const ok = parsed.protocol === 'https:' &&
            allowedDomains.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d));
          if (!ok) { res.writeHead(403); res.end('Domaine non autorisé'); return; }
        } catch { res.writeHead(400); res.end('URL invalide'); return; }
        const currentUser = db.prepare('SELECT bambu_token FROM users WHERE id=?').get(userId);
        const token = currentUser?.bambu_token;
        // Use https module to proxy instead of execFile curl
        const imgParsed = new URL(imgUrl);
        const imgOpts = {
          hostname: imgParsed.hostname,
          path: imgParsed.pathname + imgParsed.search,
          method: 'GET',
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
          timeout: 15000,
        };
        const imgReq = https.request(imgOpts, imgRes => {
          if (!imgRes.statusCode || imgRes.statusCode >= 400) {
            res.writeHead(502); res.end('Erreur image'); return;
          }
          const ext = (imgUrl.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
          const mime = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp' }[ext] || 'image/jpeg';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
          imgRes.pipe(res);
        });
        imgReq.on('error', () => { res.writeHead(502); res.end('Erreur image'); });
        imgReq.end();
        return;
      }

      // Historique des tâches Bambu Cloud
      if (req.method === 'GET' && url.startsWith('/api/bambu/tasks')) {
        const currentUser = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
        const token = currentUser?.bambu_token;
        if (!token) { json(res, { error: 'Token Bambu absent — connecte-toi d\'abord' }, 401); return; }
        const qs     = req.url.includes('?') ? req.url.split('?')[1] : '';
        const params = new URLSearchParams(qs);
        const limit  = Math.min(parseInt(params.get('limit')  || '30'), 50);
        const offset = parseInt(params.get('offset') || '0');
        try {
          const d = await curlGet(
            `https://api.bambulab.com/v1/user-service/my/tasks?deviceId=&limit=${limit}&offset=${offset}`,
            token,
          );
          const cleanName = s => (s || '').replace(/\.gcode\.3mf$|\.gcode$|\.3mf$/i, '').trim() || 'Impression';
          const tasks = d.hits || d.data?.hits || d.tasks || [];
          for (const t of tasks) {
            const name = cleanName(t.designTitle || t.title || t.name || t.subtaskName || '');
            const row = db.prepare(
              'SELECT status FROM print_jobs WHERE file_name=:fn AND user_id=:uid ORDER BY ts DESC LIMIT 1'
            ).get({ fn: name, uid: userId });
            t._localStatus = row?.status || null;
          }
          json(res, d);
        } catch(e) {
          json(res, { error: e.message }, 500);
        }
        return;
      }

      // Import manuel d'un task Bambu dans la queue "À valider"
      if (req.method === 'POST' && url === '/api/print-jobs/import') {
        const b = await parseBody(req);
        const existing = db.prepare(
          "SELECT id FROM print_jobs WHERE printer_serial=:ps AND file_name=:fn AND status='pending' AND user_id=:uid"
        ).get({ ps: b.printer_serial || '', fn: b.file_name || '', uid: userId });
        if (existing) { json(res, { error: 'Déjà dans la queue', id: existing.id }, 409); return; }

        const localThumb = await downloadToUploads(b.thumbnail || null);
        if (b.thumbnail && localThumb) console.log(`  [Import] Vignette téléchargée : ${localThumb}`);
        else if (b.thumbnail)          console.warn('  [Import] Vignette non téléchargée (CDN inaccessible ?)');

        const row = db.prepare(`
          INSERT INTO print_jobs (printer_serial, printer_name, file_name, filament_color, filament_type, total_layers, thumbnail, weight, duration, user_id)
          VALUES (:ps, :pn, :fn, :fc, :ft, :tl, :th, :wt, :du, :uid)
        `).run({
          ps: b.printer_serial || '',
          pn: b.printer_name   || '',
          fn: b.file_name      || '',
          fc: b.filament_color || null,
          ft: b.filament_type  || null,
          tl: b.total_layers   || null,
          th: localThumb       || b.thumbnail || null,
          wt: b.weight         || null,
          du: b.duration       || null,
          uid: userId,
        });
        const newJob = db.prepare('SELECT * FROM print_jobs WHERE id = :id').get({ id: row.lastInsertRowid });
        broadcast(userId, 'print-complete', { ...newJob, source: 'import' });
        json(res, newJob, 201);
        return;
      }

      // ── CATÉGORIES ──────────────────────────────────────────────────────
      if (req.method === 'GET' && url === '/api/categories') {
        json(res, db.prepare('SELECT * FROM categories WHERE user_id=? ORDER BY name ASC').all(userId));
        return;
      }
      if (req.method === 'POST' && url === '/api/categories') {
        const b = await parseBody(req);
        const name = (b.name || '').trim();
        if (!name) { json(res, { error: 'Nom requis' }, 400); return; }
        try {
          db.prepare('INSERT INTO categories (name, user_id) VALUES (:name, :uid)').run({ name, uid: userId });
          const row = db.prepare('SELECT * FROM categories WHERE name = :name AND user_id = :uid').get({ name, uid: userId });
          json(res, row, 201);
        } catch {
          json(res, { error: 'Cette catégorie existe déjà' }, 409);
        }
        return;
      }
      if (req.method === 'PUT' && parts[1] === 'categories' && id) {
        const b = await parseBody(req);
        const name = (b.name || '').trim();
        if (!name) { json(res, { error: 'Nom requis' }, 400); return; }
        const old = db.prepare('SELECT name FROM categories WHERE id = :id AND user_id = :uid').get({ id, uid: userId });
        if (!old) { json(res, { error: 'Catégorie introuvable' }, 404); return; }
        try {
          db.prepare('UPDATE categories SET name = :name WHERE id = :id AND user_id = :uid').run({ name, id, uid: userId });
          db.prepare('UPDATE items SET category = :name, updatedAt = :now WHERE category = :oldName AND user_id = :uid')
            .run({ name, id, now: new Date().toISOString(), oldName: old.name, uid: userId });
          json(res, { ok: true, name });
        } catch { json(res, { error: 'Cette catégorie existe déjà' }, 409); }
        return;
      }
      if (req.method === 'DELETE' && parts[1] === 'categories' && id) {
        db.prepare('DELETE FROM categories WHERE id = :id AND user_id = :uid').run({ id, uid: userId });
        json(res, { ok: true });
        return;
      }

      // ── ITEMS ────────────────────────────────────────────────────────────
      if (req.method === 'GET' && url === '/api/items') {
        json(res, db.prepare('SELECT * FROM items WHERE user_id=? ORDER BY createdAt DESC').all(userId));
        return;
      }

      // Import en masse — remplace tout le stock en une seule transaction atomique
      if (req.method === 'POST' && url === '/api/import') {
        const data = await parseBody(req);
        if (!Array.isArray(data)) { json(res, { error: 'Tableau JSON attendu' }, 400); return; }
        const normArr = v => {
          if (Array.isArray(v)) return v;
          if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
          return [];
        };
        const partSum = p => Math.floor((normArr(p.variants)).reduce((s, v) => s + (v.qty || 0), 0) / (p.count || 1));
        const importAll = db.transaction(items => {
          db.prepare('DELETE FROM items WHERE user_id=?').run(userId);
          const stmt = db.prepare(`INSERT INTO items
            (id,name,"desc",filament,color,colorName,qty,threshold,photo,category,trackStock,variants,parts,assembledQty,assembledItems,createdAt,updatedAt,user_id)
            VALUES (:id,:name,:desc,:filament,:color,:colorName,:qty,:threshold,:photo,:category,:trackStock,:variants,:parts,:assembledQty,:assembledItems,:createdAt,:updatedAt,:uid)`);
          for (const b of items) {
            const vArr = normArr(b.variants);
            const vJson = JSON.stringify(vArr);
            const pArr  = normArr(b.parts);
            const pJson = JSON.stringify(pArr);
            const qty   = pArr.length > 0 ? Math.min(...pArr.map(partSum)) : totalQty(vJson);
            const aItems = typeof b.assembledItems === 'string'
              ? b.assembledItems
              : JSON.stringify(b.assembledItems || []);
            stmt.run({
              id: b.id, name: b.name, desc: b.desc || null,
              filament: b.filament || null, color: '', colorName: '',
              qty, threshold: b.threshold ?? 3, photo: b.photo || null,
              category: b.category || null,
              trackStock: (b.trackStock === false || b.trackStock === 0) ? 0 : 1,
              variants: vJson, parts: pJson,
              assembledQty: b.assembledQty || 0, assembledItems: aItems,
              createdAt: b.createdAt || new Date().toISOString(),
              updatedAt: b.updatedAt || new Date().toISOString(),
              uid: userId,
            });
          }
        });
        importAll(data);
        json(res, { ok: true, count: data.length });
        return;
      }

      // Export
      if (req.method === 'GET' && url === '/api/export') {
        json(res, db.prepare('SELECT * FROM items WHERE user_id=? ORDER BY createdAt DESC').all(userId));
        return;
      }

      if (req.method === 'POST' && url === '/api/items') {
        const b = await parseBody(req);
        const now = new Date().toISOString();
        const variantsArr = typeof b.variants === 'string'
          ? (() => { try { return JSON.parse(b.variants); } catch { return []; } })()
          : (Array.isArray(b.variants) ? b.variants : []);
        const variantsJson = JSON.stringify(variantsArr);
        const partsArr  = Array.isArray(b.parts) ? b.parts
                        : (b.parts ? (() => { try { return JSON.parse(b.parts); } catch { return []; } })() : []);
        const partsJson = JSON.stringify(partsArr);
        const partSum   = p => Math.floor(
          (p.variants || []).reduce((s, v) => s + (v.qty || 0), 0) / (p.count || 1)
        );
        const effectiveQty = partsArr.length > 0
          ? Math.min(...partsArr.map(partSum))
          : totalQty(variantsJson);
        db.prepare(`INSERT INTO items (id,name,"desc",filament,color,colorName,qty,threshold,photo,category,trackStock,variants,parts,assembledQty,assembledItems,createdAt,updatedAt,user_id)
          VALUES (:id,:name,:desc,:filament,:color,:colorName,:qty,:threshold,:photo,:category,:trackStock,:variants,:parts,:assembledQty,:assembledItems,:createdAt,:updatedAt,:uid)`)
          .run({
            id: b.id,
            name: b.name,
            desc: b.desc || null,
            filament: b.filament || null,
            color: '',
            colorName: '',
            qty: effectiveQty,
            threshold: b.threshold ?? 3,
            photo: b.photo || null,
            category: b.category || null,
            trackStock: b.trackStock !== false ? 1 : 0,
            variants: variantsJson,
            parts: partsJson,
            assembledQty: b.assembledQty || 0,
            assembledItems: b.assembledItems || null,
            createdAt: now,
            updatedAt: now,
            uid: userId,
          });
        logHistory(b.id, b.name, 'add', { totalQty: totalQty(variantsJson), filament: b.filament });
        json(res, { ok: true });
        return;
      }

      if (req.method === 'PUT' && id && !sub) {
        const b = await parseBody(req);
        const variantsJson = typeof b.variants === 'string' ? b.variants : JSON.stringify(b.variants || []);
        const tQty = totalQty(variantsJson);
        const partsArrUpd  = typeof b.parts === 'string' ? JSON.parse(b.parts || '[]') : (b.parts || []);
        const partsJsonUpd = typeof b.parts === 'string' ? b.parts : JSON.stringify(b.parts || []);
        const partSumUpd   = p => Math.floor((p.variants || []).reduce((s, v) => s + (v.qty || 0), 0) / (p.count || 1));
        const effectiveQtyUpd = partsArrUpd.length > 0
          ? Math.min(...partsArrUpd.map(partSumUpd))
          : tQty;
        const existingRow = db.prepare('SELECT assembledItems, name FROM items WHERE id=:id AND user_id=:uid').get({ id, uid: userId });
        if (!existingRow) { json(res, { error: 'Introuvable' }, 404); return; }
        const assembledItemsUpd = b.assembledItems !== undefined
          ? (typeof b.assembledItems === 'string' ? b.assembledItems : JSON.stringify(b.assembledItems || []))
          : (existingRow?.assembledItems || null);
        db.prepare(`UPDATE items SET name=:name,"desc"=:desc,filament=:filament,color=:color,
          colorName=:colorName,qty=:qty,threshold=:threshold,photo=:photo,
          category=:category,trackStock=:trackStock,variants=:variants,parts=:parts,
          assembledQty=:assembledQty,assembledItems=:assembledItems,updatedAt=:updatedAt
          WHERE id=:id AND user_id=:uid`)
          .run({
            id,
            uid: userId,
            name: b.name,
            desc: b.desc || null,
            filament: b.filament || null,
            color: '',
            colorName: '',
            qty: effectiveQtyUpd,
            threshold: b.threshold ?? 3,
            photo: b.photo || null,
            category: b.category || null,
            trackStock: b.trackStock !== false ? 1 : 0,
            variants: variantsJson,
            parts: partsJsonUpd,
            assembledQty: b.assembledQty || 0,
            assembledItems: assembledItemsUpd,
            updatedAt: new Date().toISOString(),
          });
        logHistory(id, b.name || existingRow?.name || id, 'update', { totalQty: tQty });
        json(res, { ok: true });
        return;
      }

      // Déclarer N assemblages : déduit des pièces + incrémente assembledQty
      if (req.method === 'PATCH' && id && sub === 'assembled') {
        const b    = await parseBody(req);
        const row  = db.prepare('SELECT * FROM items WHERE id = :id AND user_id = :uid').get({ id, uid: userId });
        if (!row) { json(res, { error: 'Introuvable' }, 404); return; }

        if (b.op === 'setItems' && Array.isArray(b.assembledItems)) {
          const newArr      = b.assembledItems;
          const newAssembled = newArr.length;
          const currentParts = safeParseJson(row.parts);
          const pSumFn = p => Math.floor((p.variants||[]).reduce((s,v)=>s+(v.qty||0),0)/(p.count||1));
          const newQty = currentParts.length ? Math.min(...currentParts.map(pSumFn)) : 0;
          db.prepare(`UPDATE items SET assembledQty=:a, assembledItems=:ai, qty=:qty, updatedAt=:u WHERE id=:id AND user_id=:uid`)
            .run({ a: newAssembled, ai: JSON.stringify(newArr), qty: newQty, u: new Date().toISOString(), id, uid: userId });
          const updated = db.prepare('SELECT * FROM items WHERE id = :id').get({ id });
          json(res, { ok: true, item: updated });
          return;
        }
        const delta = b.delta || 0;
        let newParts = row.parts;

        const mkId = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
        let assembledArr = safeParseJson(row.assembledItems);

        if (delta > 0 && !b.manual) {
          const parts   = safeParseJson(row.parts);
          const partSum = p => Math.floor(
            (p.variants || []).reduce((s, v) => s + (v.qty || 0), 0) / (p.count || 1)
          );
          const possible   = parts.length ? Math.min(...parts.map(partSum)) : 0;
          const toAssemble = Math.min(delta, possible);

          const selections = b.selections || [];

          const resolvedParts = parts.map(part => {
            const sel = selections.find(s => s.partId === part.id);
            let target = sel ? part.variants.find(v => v.id === sel.variantId) : null;
            if (!target) target = part.variants.reduce(
              (best, v) => (v.qty || 0) > (best?.qty || 0) ? v : best, null
            );
            return { part, target };
          });

          for (const { part, target } of resolvedParts) {
            if (target) {
              const needed = (part.count || 1) * toAssemble;
              target.qty = Math.max(0, (target.qty || 0) - needed);
            }
          }
          newParts = JSON.stringify(parts);

          const now = new Date().toISOString();
          for (let n = 0; n < toAssemble; n++) {
            assembledArr.push({
              id:    mkId(),
              date:  now,
              parts: resolvedParts.map(({ part, target }) => ({
                partId:    part.id,
                partName:  part.name,
                color:     target?.color     || '#888888',
                colorName: target?.colorName || '',
              })),
            });
          }

        } else if (delta > 0 && b.manual) {
          const toAdd = delta;
          const now = new Date().toISOString();
          for (let n = 0; n < toAdd; n++) {
            assembledArr.push({ id: mkId(), date: now, manual: true, parts: [] });
          }

        } else if (delta < 0) {
          const toRemove = Math.min(Math.abs(delta), assembledArr.length);
          assembledArr.splice(assembledArr.length - toRemove, toRemove);
        }

        const newAssembled = assembledArr.length;
        const newAssembledItems = JSON.stringify(assembledArr);

        const updatedPartsArr = safeParseJson(newParts);
        const partSumFn = p => Math.floor(
          (p.variants || []).reduce((s, v) => s + (v.qty || 0), 0) / (p.count || 1)
        );
        const newQty = updatedPartsArr.length ? Math.min(...updatedPartsArr.map(partSumFn)) : 0;

        db.prepare(`UPDATE items SET assembledQty=:a, parts=:p, qty=:qty,
          assembledItems=:ai, updatedAt=:u WHERE id=:id AND user_id=:uid`)
          .run({ a: newAssembled, p: newParts, qty: newQty, ai: newAssembledItems,
                 u: new Date().toISOString(), id, uid: userId });
        const updated = db.prepare('SELECT * FROM items WHERE id = :id').get({ id });
        logHistory(id, row.name, 'assemble', { delta, assembledQty: newAssembled });
        json(res, { ok: true, item: updated });
        return;
      }

      // Mise à jour des variantes uniquement (changement de quantité rapide)
      if (req.method === 'PATCH' && id && sub === 'variants') {
        const b = await parseBody(req);
        const variantsJson = JSON.stringify(b.variants || []);
        const tQty = totalQty(variantsJson);
        const old = db.prepare('SELECT qty, name FROM items WHERE id = :id AND user_id = :uid').get({ id, uid: userId });
        if (!old) { json(res, { error: 'Introuvable' }, 404); return; }
        db.prepare('UPDATE items SET variants=:variants, qty=:qty, updatedAt=:updatedAt WHERE id=:id AND user_id=:uid')
          .run({ variants: variantsJson, qty: tQty, updatedAt: new Date().toISOString(), id, uid: userId });
        if (old) logHistory(id, old.name, 'qty', { from: old.qty, to: tQty });
        json(res, { ok: true });
        return;
      }

      if (req.method === 'DELETE' && id && !sub) {
        const item = db.prepare('SELECT name FROM items WHERE id = :id AND user_id = :uid').get({ id, uid: userId });
        db.prepare('DELETE FROM items WHERE id = :id AND user_id = :uid').run({ id, uid: userId });
        if (item) logHistory(id, item.name, 'delete', null);
        json(res, { ok: true });
        return;
      }

      // ── HISTORIQUE ───────────────────────────────────────────────────────
      if (req.method === 'GET' && url === '/api/history') {
        json(res, db.prepare('SELECT h.* FROM history h WHERE h.user_id=? ORDER BY h.ts DESC LIMIT 300').all(userId));
        return;
      }
      if (req.method === 'GET' && parts[1] === 'history' && id) {
        json(res, db.prepare('SELECT * FROM history WHERE item_id = :id AND user_id = :uid ORDER BY ts DESC').all({ id, uid: userId }));
        return;
      }

      res.writeHead(404); res.end('Not found');
      return;
    }

    res.writeHead(404); res.end('Not found');

  } catch (e) {
    console.error('[Erreur]', e.message);
    json(res, { error: e.message }, 500);
  }

// Écoute sur toutes les interfaces (PC + téléphone sur le même Wi-Fi)
}).listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('  BambuStock SaaS demarre !');
  console.log('');
  console.log('  PC        : http://localhost:' + PORT);
  console.log('  Telephone : http://' + ip + ':' + PORT);
  console.log('');
  console.log('  Base de donnees : ' + DB_FILE);
  console.log('  Fermez cette fenetre pour arreter.');
  console.log('');

  // ── AUTO-CONNECT BAMBU pour tous les users avec token valide ─────────────
  const usersWithToken = db.prepare("SELECT * FROM users WHERE bambu_token IS NOT NULL").all();
  for (const u of usersWithToken) {
    if (!isTokenExpired(u.bambu_token)) {
      const printers = JSON.parse(u.bambu_printers || '[]');
      if (printers.length > 0) {
        console.log(`  [Bambu] Auto-connect user ${u.email}...`);
        connectBambu(u.id, u.bambu_token, printers, u.bambu_email);
      } else {
        bambuByUser.set(u.id, { status: 'connected' });
        console.log(`  [Bambu] User ${u.email} : token valide, pas d'imprimante configurée.`);
      }
    } else {
      console.log(`  [Bambu] User ${u.email} : token expiré, reconnexion requise.`);
    }
  }
  if (!usersWithToken.length) {
    console.log('  [Bambu] Aucun utilisateur avec token — connecte-toi via l\'interface.');
  }
});
