const http        = require('http');
const https       = require('https');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const Database = require('better-sqlite3');
const bambu = require('./bambu');

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

const PORT        = process.env.PORT || 3000;
const DATA_DIR    = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : __dirname;
const DB_FILE     = process.env.DB_PATH || path.join(__dirname, 'stock.db');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HTML_FILE = path.join(__dirname, 'index.html');

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
    // "duplicate column name" est normal au redémarrage — tout autre erreur est inattendue
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
let htmlCache = fs.readFileSync(HTML_FILE, 'utf8');

// Nettoyage des fichiers orphelins dans /uploads (pas référencés en BDD)
(function cleanOrphanUploads() {
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    if (!files.length) return;
    const referenced = new Set();
    // items.photo
    db.prepare("SELECT photo FROM items WHERE photo LIKE '/uploads/%'").all()
      .forEach(r => referenced.add(path.basename(r.photo)));
    // print_jobs.thumbnail
    db.prepare("SELECT thumbnail FROM print_jobs WHERE thumbnail LIKE '/uploads/%'").all()
      .forEach(r => referenced.add(path.basename(r.thumbnail)));
    // parts[].photo (photos de pièces stockées dans le JSON parts)
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
  name: 'Onlyfab | Gestion du stock',
  short_name: 'Onlyfab',
  description: 'Gestion du stock impression 3D',
  start_url: '/',
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

// ── SERVER-SENT EVENTS ────────────────────────────────────────────────────
const sseClients = new Set();
let bambuStatus = 'disconnected'; // connected | reconnecting | error | disconnected

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); }
    catch { sseClients.delete(client); }
  }
}

// ── BAMBU CALLBACKS (module-level pour être accessibles partout) ──────────
function onStateChange(status) { bambuStatus = status; broadcast('bambu-status', { status }); }

// Enrichit un job MQTT depuis l'historique Bambu (thumbnail, filament, poids…)
async function enrichJobFromHistory(jobId, fileName) {

  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const token = cfg.bambu?.token;
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
    broadcast('print-update', { ...updated, source: 'mqtt' });
    console.log(`  [Bambu] Job enrichi depuis l'historique : ${fileName}`);
  } catch(e) {
    console.warn(`  [Bambu] Enrichissement impossible : ${e.message}`);
  }
}

function onPrintComplete(job) {
  // Règle 1 : déjà dans la queue en attente → inutile d'en ajouter un autre
  const alreadyPending = db.prepare(`
    SELECT id FROM print_jobs
    WHERE printer_serial=:ps AND file_name=:fn AND status='pending'
  `).get({ ps: job.printerSerial, fn: job.fileName });
  if (alreadyPending) {
    console.log(`  [Bambu] Doublon ignoré : ${job.fileName} (déjà en attente)`);
    return;
  }
  // Règle 2 : reçu il y a moins de 10 min (Bambu renvoie souvent FINISH plusieurs fois)
  const justReceived = db.prepare(`
    SELECT id FROM print_jobs
    WHERE printer_serial=:ps AND file_name=:fn
      AND ts > datetime('now','-10 minutes')
  `).get({ ps: job.printerSerial, fn: job.fileName });
  if (justReceived) {
    console.log(`  [Bambu] Doublon ignoré : ${job.fileName} (reçu il y a moins de 10 min)`);
    return;
  }
  console.log(`  [Bambu] Impression terminée : ${job.fileName} (${job.printerName})`);
  const row = db.prepare(`
    INSERT INTO print_jobs (printer_serial, printer_name, file_name, filament_color, filament_type, total_layers)
    VALUES (:ps, :pn, :fn, :fc, :ft, :tl)
  `).run({
    ps: job.printerSerial, pn: job.printerName, fn: job.fileName,
    fc: normColor(job.filamentColor),           // normalise #RRGGBBAA → #RRGGBB
    ft: job.filamentType, tl: job.totalLayers,
  });
  const newJob = db.prepare('SELECT * FROM print_jobs WHERE id = :id').get({ id: row.lastInsertRowid });
  broadcast('print-complete', { ...newJob, source: 'mqtt' });
  // 10 s après, enrichir depuis l'API historique (thumbnail, poids, durée…)
  setTimeout(() => enrichJobFromHistory(newJob.id, job.fileName), 10_000);
}

function connectBambu(token, printers, userEmail) {
  if (global._bambuClient) global._bambuClient.end(true);
  // Capture la référence du nouveau client pour ignorer les events de l'ancien
  let client;
  client = global._bambuClient = bambu.connect({
    token, printers: printers || [], onPrintComplete, userEmail,
    onStateChange: status => {
      if (global._bambuClient === client) onStateChange(status);
      // sinon : event de l'ancien client après remplacement → ignoré
    },
  });
}

// Sauvegarde un token Bambu dans config.json
function saveBambuToken(token) {

  const cfg = fs.existsSync(CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    : { bambu: { printers: [] } };
  cfg.bambu = cfg.bambu || {};
  cfg.bambu.token = token;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

// Sessions 2FA en attente (stockées en mémoire, expirent en 10 min)
const pendingTfa = new Map(); // sessionId → { email, password, expires }
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
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
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
      // Extension whitelist — refuse tout ce qui n'est pas une image
      const ext = path.extname(filename).slice(1).toLowerCase();
      const mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif' };
      if (!mimeMap[ext]) { res.writeHead(403); res.end('Type de fichier non autorisé'); return; }
      if (!fs.existsSync(filepath)) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': mimeMap[ext], 'Cache-Control': 'public, max-age=31536000' });
      fs.createReadStream(filepath).pipe(res);
      return;
    }

    // ── UPLOAD PHOTO ─────────────────────────────────────────────────────
    if (req.method === 'POST' && url === '/api/upload') {
      const b = await parseBody(req);
      if (!b.data || !b.data.startsWith('data:image')) {
        json(res, { error: 'Données image invalides' }, 400); return;
      }
      const m = b.data.match(/^data:image\/(\w+);base64,(.+)$/s);
      if (!m) { json(res, { error: 'Format image invalide' }, 400); return; }
      // Limite 5 Mo (base64 ~1,33× le binaire, donc 6,7 Mo de chaîne max)
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

    // ── SSE ──────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/events') {
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      });
      // Premier message : état actuel Bambu + jobs en attente
      const pending = db.prepare("SELECT * FROM print_jobs WHERE status='pending' ORDER BY ts DESC").all();
      res.write(`event: init\ndata: ${JSON.stringify({ bambuStatus, pending })}\n\n`);
      sseClients.add(res);
      const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { sseClients.delete(res); clearInterval(keepalive); });
      return;
    }

    // ── PRINT JOBS ───────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/print-jobs') {
      json(res, db.prepare("SELECT * FROM print_jobs WHERE status='pending' ORDER BY ts DESC").all());
      return;
    }
    // Ignorer tous les prints en attente d'un coup
    if (req.method === 'DELETE' && url === '/api/print-jobs') {
      db.prepare("UPDATE print_jobs SET status='dismissed' WHERE status='pending'").run();
      json(res, { ok: true });
      return;
    }
    if (req.method === 'DELETE' && parts[1] === 'print-jobs' && id) {
      db.prepare('UPDATE print_jobs SET status=:s WHERE id=:id').run({ s: 'dismissed', id });
      json(res, { ok: true });
      return;
    }
    // Marquer comme traité (après création item ou ajout quantité)
    if (req.method === 'PATCH' && parts[1] === 'print-jobs' && id && sub === 'done') {
      db.prepare('UPDATE print_jobs SET status=:s WHERE id=:id').run({ s: 'done', id });
      json(res, { ok: true });
      return;
    }
    // Statut connexion Bambu
    if (req.method === 'GET' && url === '/api/bambu/status') {
      json(res, { status: bambuStatus });
      return;
    }
    // Auth Bambu email/password → token (via curl pour contourner Cloudflare)
    if (req.method === 'POST' && url === '/api/bambu/auth') {
      const b = await parseBody(req);
      if (!b.email || !b.password) { json(res, { error: 'Email et mot de passe requis' }, 400); return; }
      try {
        const d = await curlPost('https://api.bambulab.com/v1/user-service/user/login', {
          account: b.email, password: b.password,
        });
        // 2FA requis : il faut d'abord demander explicitement l'envoi du code
        if (d.loginType === 'verifyCode') {
          // Déclenche l'envoi du code par email
          try {
            await curlPost('https://api.bambulab.com/v1/user-service/user/sendemail/code', {
              email: b.email,
              type:  'codeLogin',
            });
            console.log(`  [Bambu] Code 2FA envoyé à ${b.email}`);
          } catch(sendErr) {
            console.warn('  [Bambu] Avertissement envoi code :', sendErr.message);
            // On continue quand même — certaines réponses non-JSON ne sont pas fatales
          }
          const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2);
          pendingTfa.set(sessionId, { email: b.email, password: b.password, expires: Date.now() + 10 * 60_000 });
          json(res, { needsCode: true, sessionId });
          return;
        }
        const token = d.accessToken || d.token || d.data?.accessToken;
        if (!token) throw new Error(d.message || d.error || 'Pas de token dans la réponse');
        const cfg = saveBambuToken(token);
        // Sauvegarde l'email pour fallback parseUserId au redémarrage
        cfg.bambu.email = b.email;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
        connectBambu(token, cfg.bambu.printers, b.email);
        onStateChange('connected');
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
        pendingTfa.delete(sessionId);
        const cfg = saveBambuToken(token);
        // Sauvegarde l'email pour fallback parseUserId au redémarrage
        cfg.bambu.email = email;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
        connectBambu(token, cfg.bambu.printers, email);
        // Token valide → on signale "connecté" même si aucune imprimante configurée
        onStateChange('connected');
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
        const cfg = saveBambuToken(token);
        connectBambu(token, cfg.bambu.printers);
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
        INSERT INTO print_jobs (printer_serial, printer_name, file_name, filament_color, filament_type, total_layers)
        VALUES (:ps, :pn, :fn, :fc, :ft, :tl)
      `).run({
        ps: 'TEST00000000000',
        pn: b.printerName   || 'H2D (test)',
        fn: b.fileName      || 'Support_plateau_v3',
        fc: b.filamentColor || '#6c47ff',
        ft: b.filamentType  || 'PETG',
        tl: 142,
      });
      const newJob = db.prepare('SELECT * FROM print_jobs WHERE id = :id').get({ id: row.lastInsertRowid });
      broadcast('print-complete', { ...newJob, source: 'mqtt' }); // test simulé MQTT
      json(res, newJob, 201);
      return;
    }

    // Proxy image Bambu (miniature protégée par auth)
    if (req.method === 'GET' && url === '/api/bambu/image') {
      const imgUrl = new URLSearchParams(req.url.split('?')[1] || '').get('url');
      if (!imgUrl) { res.writeHead(400); res.end('url manquante'); return; }
      // Anti-SSRF : seuls les domaines Bambu Lab sont autorisés
      try {
        const parsed = new URL(imgUrl);
        const allowedDomains = ['bambulab.com', 'bambulab.cn', 'bblmw.com'];
        const ok = parsed.protocol === 'https:' &&
          allowedDomains.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d));
        if (!ok) { res.writeHead(403); res.end('Domaine non autorisé'); return; }
      } catch { res.writeHead(400); res.end('URL invalide'); return; }
    
      const token = fs.existsSync(CONFIG_FILE)
        ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).bambu?.token
        : null;
      const args = ['-s', '--max-time', '15', '--location'];
      if (token) args.push('-H', `Authorization: Bearer ${token}`);
      args.push(imgUrl);
      execFile('curl', args, { encoding: 'buffer' }, (err, stdout) => {
        if (err || !stdout?.length) { res.writeHead(502); res.end('Erreur image'); return; }
        const ext = (imgUrl.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
        const mime = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp' }[ext] || 'image/jpeg';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
        res.end(stdout);
      });
      return;
    }

    // Historique des tâches Bambu Cloud
    if (req.method === 'GET' && url.startsWith('/api/bambu/tasks')) {
    
      if (!fs.existsSync(CONFIG_FILE)) { json(res, { error: 'Non configuré' }, 400); return; }
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const token = cfg.bambu?.token;
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
        // Enrichir chaque tâche avec le statut dans notre base locale
        const cleanName = s => (s || '').replace(/\.gcode\.3mf$|\.gcode$|\.3mf$/i, '').trim() || 'Impression';
        const tasks = d.hits || d.data?.hits || d.tasks || [];
        for (const t of tasks) {
          const name = cleanName(t.designTitle || t.title || t.name || t.subtaskName || '');
          const row = db.prepare(
            'SELECT status FROM print_jobs WHERE file_name=:fn ORDER BY ts DESC LIMIT 1'
          ).get({ fn: name });
          t._localStatus = row?.status || null; // 'pending' | 'done' | 'dismissed' | null
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
      // Vérifier que ce task n'est pas déjà dans la queue (status pending)
      const existing = db.prepare(
        "SELECT id FROM print_jobs WHERE printer_serial=:ps AND file_name=:fn AND status='pending'"
      ).get({ ps: b.printer_serial || '', fn: b.file_name || '' });
      if (existing) { json(res, { error: 'Déjà dans la queue', id: existing.id }, 409); return; }

      // Télécharger la vignette sur le Pi → URL locale (évite CORS côté navigateur)
      const localThumb = await downloadToUploads(b.thumbnail || null);
      if (b.thumbnail && localThumb) console.log(`  [Import] Vignette téléchargée : ${localThumb}`);
      else if (b.thumbnail)          console.warn('  [Import] Vignette non téléchargée (CDN inaccessible ?)');

      const row = db.prepare(`
        INSERT INTO print_jobs (printer_serial, printer_name, file_name, filament_color, filament_type, total_layers, thumbnail, weight, duration)
        VALUES (:ps, :pn, :fn, :fc, :ft, :tl, :th, :wt, :du)
      `).run({
        ps: b.printer_serial || '',
        pn: b.printer_name   || '',
        fn: b.file_name      || '',
        fc: b.filament_color || null,
        ft: b.filament_type  || null,
        tl: b.total_layers   || null,
        th: localThumb       || b.thumbnail || null, // local en priorité, CDN en fallback
        wt: b.weight         || null,
        du: b.duration       || null,
      });
      const newJob = db.prepare('SELECT * FROM print_jobs WHERE id = :id').get({ id: row.lastInsertRowid });
      broadcast('print-complete', { ...newJob, source: 'import' });
      json(res, newJob, 201);
      return;
    }

    // ── CATÉGORIES ──────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/categories') {
      json(res, db.prepare('SELECT * FROM categories ORDER BY name ASC').all());
      return;
    }
    if (req.method === 'POST' && url === '/api/categories') {
      const b = await parseBody(req);
      const name = (b.name || '').trim();
      if (!name) { json(res, { error: 'Nom requis' }, 400); return; }
      try {
        db.prepare('INSERT INTO categories (name) VALUES (:name)').run({ name });
        const row = db.prepare('SELECT * FROM categories WHERE name = :name').get({ name });
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
      const old = db.prepare('SELECT name FROM categories WHERE id = :id').get({ id });
      if (!old) { json(res, { error: 'Catégorie introuvable' }, 404); return; }
      try {
        db.prepare('UPDATE categories SET name = :name WHERE id = :id').run({ name, id });
        db.prepare('UPDATE items SET category = :name, updatedAt = :now WHERE category = :oldName')
          .run({ name, id, now: new Date().toISOString(), oldName: old.name });
        json(res, { ok: true, name });
      } catch { json(res, { error: 'Cette catégorie existe déjà' }, 409); }
      return;
    }
    if (req.method === 'DELETE' && parts[1] === 'categories' && id) {
      db.prepare('DELETE FROM categories WHERE id = :id').run({ id });
      json(res, { ok: true });
      return;
    }

    // ── ITEMS ────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/items') {
      json(res, db.prepare('SELECT * FROM items ORDER BY createdAt DESC').all());
      return;
    }

    if (req.method === 'POST' && url === '/api/items') {
      const b = await parseBody(req);
      const now = new Date().toISOString();
      const variantsJson = JSON.stringify(b.variants || []);
      // Supporte b.parts tableau ou chaîne JSON (double-sécurité)
      const partsArr  = Array.isArray(b.parts) ? b.parts
                      : (b.parts ? (() => { try { return JSON.parse(b.parts); } catch { return []; } })() : []);
      const partsJson = JSON.stringify(partsArr);
      // Tient compte du count (nb de cette pièce par assemblage)
      const partSum   = p => Math.floor(
        (p.variants || []).reduce((s, v) => s + (v.qty || 0), 0) / (p.count || 1)
      );
      const effectiveQty = partsArr.length > 0
        ? Math.min(...partsArr.map(partSum))
        : totalQty(variantsJson);
      db.prepare(`INSERT INTO items (id,name,"desc",filament,color,colorName,qty,threshold,photo,category,trackStock,variants,parts,assembledQty,assembledItems,createdAt,updatedAt)
        VALUES (:id,:name,:desc,:filament,:color,:colorName,:qty,:threshold,:photo,:category,:trackStock,:variants,:parts,:assembledQty,:assembledItems,:createdAt,:updatedAt)`)
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
      // Préserver assembledItems existant si le client n'en envoie pas (et lire le nom courant pour l'historique)
      const existingRow = db.prepare('SELECT assembledItems, name FROM items WHERE id=:id').get({ id });
      const assembledItemsUpd = b.assembledItems !== undefined
        ? (typeof b.assembledItems === 'string' ? b.assembledItems : JSON.stringify(b.assembledItems || []))
        : (existingRow?.assembledItems || null);
      db.prepare(`UPDATE items SET name=:name,"desc"=:desc,filament=:filament,color=:color,
        colorName=:colorName,qty=:qty,threshold=:threshold,photo=:photo,
        category=:category,trackStock=:trackStock,variants=:variants,parts=:parts,
        assembledQty=:assembledQty,assembledItems=:assembledItems,updatedAt=:updatedAt
        WHERE id=:id`)
        .run({
          id,
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
      const row  = db.prepare('SELECT * FROM items WHERE id = :id').get({ id });
      if (!row) { json(res, { error: 'Introuvable' }, 404); return; }

      // ── op: setItems — remplacement direct de la liste (ajout/retrait manuel par ligne) ──
      if (b.op === 'setItems' && Array.isArray(b.assembledItems)) {
        const newArr      = b.assembledItems;
        const newAssembled = newArr.length;
        const currentParts = safeParseJson(row.parts);
        const pSumFn = p => Math.floor((p.variants||[]).reduce((s,v)=>s+(v.qty||0),0)/(p.count||1));
        const newQty = currentParts.length ? Math.min(...currentParts.map(pSumFn)) : 0;
        db.prepare(`UPDATE items SET assembledQty=:a, assembledItems=:ai, qty=:qty, updatedAt=:u WHERE id=:id`)
          .run({ a: newAssembled, ai: JSON.stringify(newArr), qty: newQty, u: new Date().toISOString(), id });
        const updated = db.prepare('SELECT * FROM items WHERE id = :id').get({ id });
        json(res, { ok: true, item: updated });
        return;
      }
      const delta = b.delta || 0; // positif = déclarer assemblage, négatif = défaire
      let newParts = row.parts;

      const mkId = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);

      // Tableau des objets assemblés (historique détaillé)
      let assembledArr = safeParseJson(row.assembledItems);

      if (delta > 0 && !b.manual) {
        // ── Assemblage via le picker : déduit pièces + crée des enregistrements détaillés ──
        const parts   = safeParseJson(row.parts);
        const partSum = p => Math.floor(
          (p.variants || []).reduce((s, v) => s + (v.qty || 0), 0) / (p.count || 1)
        );
        const possible   = parts.length ? Math.min(...parts.map(partSum)) : 0;
        const toAssemble = Math.min(delta, possible);

        const selections = b.selections || []; // [{partId, variantId}]

        // Résoudre les cibles (variante choisie par pièce) avant de déduire
        const resolvedParts = parts.map(part => {
          const sel = selections.find(s => s.partId === part.id);
          let target = sel ? part.variants.find(v => v.id === sel.variantId) : null;
          if (!target) target = part.variants.reduce(
            (best, v) => (v.qty || 0) > (best?.qty || 0) ? v : best, null
          );
          return { part, target };
        });

        // Déduire le stock
        for (const { part, target } of resolvedParts) {
          if (target) {
            const needed = (part.count || 1) * toAssemble;
            target.qty = Math.max(0, (target.qty || 0) - needed);
          }
        }
        newParts = JSON.stringify(parts);

        // Créer un enregistrement par objet assemblé
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
        // ── Ajout manuel (sans déduire les pièces) ──
        const toAdd = delta;
        const now = new Date().toISOString();
        for (let n = 0; n < toAdd; n++) {
          assembledArr.push({ id: mkId(), date: now, manual: true, parts: [] });
        }

      } else if (delta < 0) {
        // ── Retrait : supprime les derniers enregistrements ──
        const toRemove = Math.min(Math.abs(delta), assembledArr.length);
        assembledArr.splice(assembledArr.length - toRemove, toRemove);
      }

      const newAssembled = assembledArr.length;
      const newAssembledItems = JSON.stringify(assembledArr);

      // Recalcul qty = assemblages possibles restants
      const updatedPartsArr = safeParseJson(newParts);
      const partSumFn = p => Math.floor(
        (p.variants || []).reduce((s, v) => s + (v.qty || 0), 0) / (p.count || 1)
      );
      const newQty = updatedPartsArr.length ? Math.min(...updatedPartsArr.map(partSumFn)) : 0;

      db.prepare(`UPDATE items SET assembledQty=:a, parts=:p, qty=:qty,
        assembledItems=:ai, updatedAt=:u WHERE id=:id`)
        .run({ a: newAssembled, p: newParts, qty: newQty, ai: newAssembledItems,
               u: new Date().toISOString(), id });
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
      const old = db.prepare('SELECT qty, name FROM items WHERE id = :id').get({ id });
      db.prepare('UPDATE items SET variants=:variants, qty=:qty, updatedAt=:updatedAt WHERE id=:id')
        .run({ variants: variantsJson, qty: tQty, updatedAt: new Date().toISOString(), id });
      if (old) logHistory(id, old.name, 'qty', { from: old.qty, to: tQty });
      json(res, { ok: true });
      return;
    }

    if (req.method === 'DELETE' && id && !sub) {
      const item = db.prepare('SELECT name FROM items WHERE id = :id').get({ id });
      db.prepare('DELETE FROM items WHERE id = :id').run({ id });
      if (item) logHistory(id, item.name, 'delete', null);
      json(res, { ok: true });
      return;
    }

    // ── HISTORIQUE ───────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/history') {
      json(res, db.prepare('SELECT * FROM history ORDER BY ts DESC LIMIT 300').all());
      return;
    }
    if (req.method === 'GET' && parts[1] === 'history' && id) {
      json(res, db.prepare('SELECT * FROM history WHERE item_id = :id ORDER BY ts DESC').all({ id }));
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
  console.log('  3D Stock demarre !');
  console.log('');
  console.log('  PC        : http://localhost:' + PORT);
  console.log('  Telephone : http://' + ip + ':' + PORT);
  console.log('');
  console.log('  Base de donnees : ' + DB_FILE);
  console.log('  Fermez cette fenetre pour arreter.');
  console.log('');

  // ── CONNEXION BAMBU LAB ──────────────────────────────────────────────────

  if (!fs.existsSync(CONFIG_FILE)) {
    console.log('  [Bambu] Pas de config.json — connexion Bambu désactivée.');
    return;
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!cfg.bambu?.printers?.length) {
    console.log('  [Bambu] config.json incomplet — connexion Bambu désactivée.');
    return;
  }

  // Helper : (re)auth par email/password et connexion
  function authWithCredentials(email, password, printers) {
    console.log('  [Bambu] Tentative auth email/password...');
    bambuStatus = 'reconnecting';
    curlPost('https://api.bambulab.com/v1/user-service/user/login', {
      account: email, password,
    }).then(d => {
      const token = d.accessToken || d.token || d.data?.accessToken;
      if (!token) throw new Error(d.message || '2FA requis — utilise l\'interface pour te connecter');
      const saved = saveBambuToken(token);
      // Supprimer le mot de passe de config.json, conserver l'email comme fallback
      delete saved.bambu.password;
      saved.bambu.email = email;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2));
      console.log('  [Bambu] Token obtenu et mot de passe retiré de config.json');
      connectBambu(token, printers, email);
    }).catch(err => {
      console.error('  [Bambu] Auth échouée :', err.message);
      console.log('  [Bambu] → Connecte-toi via l\'interface (onglet "À valider")');
      bambuStatus = 'error';
    });
  }

  // Token sauvegardé → vérifier l'expiration avant de se connecter
  if (cfg.bambu.token) {
    if (isTokenExpired(cfg.bambu.token)) {
      console.log('  [Bambu] Token expiré.');
      delete cfg.bambu.token;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      // Si email+password dispo → re-auth auto
      if (cfg.bambu.email && cfg.bambu.password) {
        authWithCredentials(cfg.bambu.email, cfg.bambu.password, cfg.bambu.printers);
      } else {
        console.log('  [Bambu] → Reconnecte-toi via l\'interface (onglet "À valider")');
        bambuStatus = 'error';
      }
    } else {
      console.log('  [Bambu] Token valide — connexion MQTT...');
      bambuStatus = 'reconnecting'; // "en cours" plutôt que "déconnecté" pendant la connexion initiale
      try { connectBambu(cfg.bambu.token, cfg.bambu.printers, cfg.bambu.email || null); }
      catch(e) { console.error('  [Bambu] Erreur connexion :', e.message); bambuStatus = 'error'; }
    }
    return;
  }

  // Pas de token → tenter email/password (première mise en service)
  if (cfg.bambu.email && cfg.bambu.password) {
    authWithCredentials(cfg.bambu.email, cfg.bambu.password, cfg.bambu.printers);
    return;
  }

  console.log('  [Bambu] Aucun token — utilise l\'interface pour connecter Bambu Lab.');
});
