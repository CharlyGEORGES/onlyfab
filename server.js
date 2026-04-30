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
const MAX_BETA_USERS = parseInt(process.env.BETA_MAX_USERS || '20', 10);
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

// Migrations users (admin + reset password)
addColumnIfMissing('users', 'is_admin', 'INTEGER DEFAULT 0');
addColumnIfMissing('users', 'last_login', 'TEXT');

db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used       INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

// Migration : si aucun admin n'existe, promouvoir le compte le plus ancien.
// Couvre les utilisateurs inscrits avant la mise en place du flag is_admin.
(function ensureFirstAdmin() {
  const adminCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin=1').get().c;
  if (adminCount > 0) return;
  const oldest = db.prepare('SELECT id, email FROM users ORDER BY created_at ASC LIMIT 1').get();
  if (oldest) {
    db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(oldest.id);
    console.log(`  [Migration] Premier admin assigné : ${oldest.email}`);
  }
})();
// Promotion forcée par variable d'environnement ADMIN_EMAIL (utile pour
// reprendre la main si tu perds l'accès admin).
if (process.env.ADMIN_EMAIL) {
  const r = db.prepare('UPDATE users SET is_admin=1 WHERE email=?').run(process.env.ADMIN_EMAIL.toLowerCase());
  if (r.changes) console.log(`  [Migration] ADMIN_EMAIL : ${process.env.ADMIN_EMAIL} promu admin`);
}

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

// ── PAGE HTML : réinitialisation mot de passe ────────────────────────────
const RESET_PASSWORD_HTML = `<!DOCTYPE html><html lang="fr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Réinitialiser le mot de passe — BambuStock</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f13;color:#e8e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
  .card{background:#1a1a24;border:1px solid #2e2e45;border-radius:16px;padding:32px 28px;max-width:420px;width:100%;box-shadow:0 8px 40px rgba(108,71,255,0.15)}
  h1{font-size:1.4rem;margin-bottom:8px;color:#fff}
  p{font-size:0.92rem;color:#7070a0;margin-bottom:22px;line-height:1.5}
  label{display:block;font-size:0.82rem;color:#7070a0;margin-bottom:6px;font-weight:600}
  input{width:100%;background:#20202e;border:1px solid #2e2e45;border-radius:10px;color:#e8e8f0;padding:12px 14px;font-size:16px;outline:none;margin-bottom:14px;font-family:inherit}
  input:focus{border-color:#6c47ff}
  button{width:100%;background:#6c47ff;color:#fff;border:none;border-radius:10px;padding:13px;font-size:0.95rem;font-weight:700;cursor:pointer;transition:background .15s}
  button:hover{background:#5535d4}
  button:disabled{opacity:.6;cursor:not-allowed}
  .alert{padding:11px 13px;border-radius:8px;font-size:0.85rem;margin-bottom:14px;display:none}
  .alert.error{background:rgba(255,71,87,.1);border:1px solid rgba(255,71,87,.3);color:#ff4757;display:block}
  .alert.ok{background:rgba(0,212,170,.1);border:1px solid rgba(0,212,170,.3);color:#00d4aa;display:block}
  a{color:#6c47ff;text-decoration:none;font-size:0.85rem}
</style></head><body>
<div class="card">
  <h1>Nouveau mot de passe</h1>
  <p>Choisissez un nouveau mot de passe pour votre compte BambuStock. Toutes vos sessions actives seront déconnectées.</p>
  <div id="alert" class="alert"></div>
  <form id="form">
    <label for="pw">Nouveau mot de passe</label>
    <input id="pw" type="password" required minlength="8" autocomplete="new-password" placeholder="8 caractères minimum">
    <label for="pw2">Confirmer</label>
    <input id="pw2" type="password" required minlength="8" autocomplete="new-password" placeholder="Retaper le mot de passe">
    <button id="submit" type="submit">Réinitialiser le mot de passe</button>
  </form>
  <p style="margin-top:18px;text-align:center"><a href="/">← Retour à l'accueil</a></p>
</div>
<script>
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  const alertEl = document.getElementById('alert');
  function showAlert(type, msg){ alertEl.className='alert '+type; alertEl.textContent=msg; }
  if (!token){ showAlert('error', 'Lien invalide ou incomplet.'); document.getElementById('submit').disabled=true; }
  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = document.getElementById('pw').value;
    const pw2 = document.getElementById('pw2').value;
    if (pw !== pw2){ showAlert('error', 'Les mots de passe ne correspondent pas.'); return; }
    if (pw.length < 8){ showAlert('error', 'Mot de passe trop court (8 caractères minimum).'); return; }
    const btn = document.getElementById('submit');
    btn.disabled = true; btn.textContent = 'En cours...';
    try {
      const r = await fetch('/api/auth/reset', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token, password: pw})});
      const data = await r.json();
      if (!r.ok){ showAlert('error', data.error || 'Erreur'); btn.disabled=false; btn.textContent='Réinitialiser le mot de passe'; return; }
      showAlert('ok', 'Mot de passe réinitialisé. Redirection...');
      setTimeout(() => location.href='/', 1500);
    } catch { showAlert('error', 'Erreur réseau.'); btn.disabled=false; btn.textContent='Réinitialiser le mot de passe'; }
  });
</script></body></html>`;

// ── SERVICE WORKER ────────────────────────────────────────────────────────
// Stratégie : stale-while-revalidate pour /app et les assets statiques.
// Cache-first immutable pour /uploads/* (les images d'objets ne changent
// jamais une fois uploadées — elles ont un nom de fichier unique). Permet
// un rendu INSTANTANÉ depuis le cache même après un tab discard Chrome
// Android / iOS Safari (cause principale des "sauts" sur mobile), puis
// revalidation silencieuse en arrière-plan. Le cache est purgé à la
// déconnexion via postMessage('clear-cache').
const SERVICE_WORKER = `
const CACHE_VERSION = 'bs-v9';
const STATIC_ASSETS = ['/icon.svg', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(c => c.addAll(STATIC_ASSETS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('message', e => {
  if (e.data === 'clear-cache') {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
  }
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // On ne cache PAS les API, le SSE, ni la landing.
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sse') return;
  if (url.pathname === '/' || url.pathname === '/reset-password') return;

  // /uploads/* : cache-first immutable (les fichiers ont un nom unique).
  if (url.pathname.startsWith('/uploads/')) {
    e.respondWith(
      caches.open(CACHE_VERSION).then(cache =>
        cache.match(req).then(cached => {
          if (cached) return cached;
          return fetch(req).then(resp => {
            if (resp && resp.ok) cache.put(req, resp.clone());
            return resp;
          });
        })
      )
    );
    return;
  }

  // /app et /sw.js : NETWORK-FIRST avec timeout 1.5s.
  // Garantit que l'utilisateur a TOUJOURS la dernière version du HTML
  // (avec les derniers fixes), tout en restant offline-friendly :
  // si le réseau ne répond pas en 1.5s, on sert le cache.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    try {
      const networkResp = await Promise.race([
        fetch(req).then(resp => {
          if (resp && resp.ok) cache.put(req, resp.clone());
          return resp;
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
      ]);
      if (networkResp) return networkResp;
    } catch {}
    return cached || fetch(req);
  })());
});
`;

// ── MANIFEST PWA ──────────────────────────────────────────────────────────
const MANIFEST = JSON.stringify({
  name: 'BambuStock | Gestion du stock',
  short_name: 'BambuStock',
  description: 'Gestion du stock impression 3D',
  start_url: '/app',
  display: 'standalone',
  background_color: '#0f0f13',
  theme_color: '#0f0f13',
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
      // Si déjà connecté, redirige côté serveur vers /app pour éviter tout
      // flash visuel mobile entre la landing et l'app.
      const user = getSessionUser(req);
      if (user) { res.writeHead(302, { Location: '/app' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(landingCache);
      return;
    }
    if (req.method === 'GET' && (url === '/app' || url === '/app/')) {
      const user = getSessionUser(req);
      if (!user) { res.writeHead(302, { Location: '/' }); res.end(); return; }
      // SSR : on inline les items + catégories de l'utilisateur dans le HTML
      // pour que la page arrive rendue (zéro fetch côté client = zéro flash).
      const items = db.prepare('SELECT * FROM items WHERE user_id=? ORDER BY createdAt DESC').all(user.id);
      const categories = db.prepare('SELECT * FROM categories WHERE user_id=? ORDER BY name ASC').all(user.id);
      const initialData = {
        user: {
          id: user.id, email: user.email, name: user.name, plan: user.plan,
          is_admin: !!user.is_admin, created_at: user.created_at,
        },
        items, categories,
      };
      // Échappe `<` pour empêcher l'injection d'un `</script>` via les noms d'items.
      const safeJson = JSON.stringify(initialData).replace(/</g, '\\u003c');
      const html = htmlCache.replace(
        '<!-- INITIAL_DATA -->',
        `<script>window.__INITIAL_DATA__=${safeJson};</script>`
      );
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // Pas de cache : les données sont per-user
        'Cache-Control': 'private, no-store',
      });
      res.end(html);
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
    if (req.method === 'GET' && url === '/sw.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache', // toujours revalider le SW lui-même
        'Service-Worker-Allowed': '/',
      });
      res.end(SERVICE_WORKER);
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
      json(res, { user: {
        id: user.id, email: user.email, name: user.name, plan: user.plan,
        is_admin: !!user.is_admin, created_at: user.created_at,
      }});
      return;
    }

    // GET /api/auth/seats → nombre de comptes restants pendant la bêta
    if (req.method === 'GET' && url === '/api/auth/seats') {
      const used = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      const max = MAX_BETA_USERS;
      json(res, { used, max, remaining: Math.max(0, max - used) });
      return;
    }

    if (req.method === 'POST' && url === '/api/auth/register') {
      const b = await parseBody(req);
      const { email, password, name } = b;
      if (!email || !password) { json(res, { error: 'Email et mot de passe requis' }, 400); return; }
      if (password.length < 8) { json(res, { error: 'Mot de passe trop court (8 caractères min)' }, 400); return; }
      const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      // Limite stricte de la bêta : on refuse les inscriptions au-delà de
      // MAX_BETA_USERS. Variable d'environnement BETA_MAX_USERS pour modifier
      // sans redéploiement de code.
      if (userCount >= MAX_BETA_USERS) {
        json(res, { error: `Bêta complète — ${MAX_BETA_USERS} comptes maximum, plus de places disponibles. Réessayez plus tard.` }, 403);
        return;
      }
      const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
      if (existing) { json(res, { error: 'Email déjà utilisé' }, 409); return; }
      const hash = await bcrypt.hash(password, 12);
      const uid = nanoid();
      // Premier utilisateur créé = admin
      const isAdmin = userCount === 0 ? 1 : 0;
      db.prepare('INSERT INTO users (id,email,password_hash,name,is_admin,created_at) VALUES (?,?,?,?,?,?)')
        .run(uid, email.toLowerCase(), hash, name || null, isAdmin, new Date().toISOString());
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
      json(res, { user: {
        id: uid, email: email.toLowerCase(), name: name || null, plan: 'beta',
        is_admin: !!isAdmin, created_at: new Date().toISOString(),
      }});
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
      db.prepare('UPDATE users SET last_login=? WHERE id=?').run(new Date().toISOString(), user.id);
      setSessionCookie(res, token);
      // Auto-connect Bambu si token valide
      if (user.bambu_token && !isTokenExpired(user.bambu_token)) {
        const printers = JSON.parse(user.bambu_printers || '[]');
        connectBambu(user.id, user.bambu_token, printers, user.bambu_email);
      }
      json(res, { user: {
        id: user.id, email: user.email, name: user.name, plan: user.plan,
        is_admin: !!user.is_admin, created_at: user.created_at,
      }});
      return;
    }

    // ── PASSWORD RESET (publiques) ──────────────────────────────────────
    // POST /api/auth/forgot { email } → renvoie toujours { ok: true } pour ne pas
    // divulguer la liste des emails. Crée un token de reset valable 1h.
    if (req.method === 'POST' && url === '/api/auth/forgot') {
      const b = await parseBody(req).catch(() => ({}));
      const email = (b.email || '').toLowerCase().trim();
      if (!email) { json(res, { error: 'Email requis' }, 400); return; }
      const user = db.prepare('SELECT id, email FROM users WHERE email=?').get(email);
      if (user) {
        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?,?,?)')
          .run(token, user.id, expires);
        // En attendant l'envoi d'email réel (SMTP), on log le lien (visible dans
        // les logs Fly.io) et on le renvoie en dev seulement.
        const resetUrl = `https://bambustock.com/reset-password?token=${token}`;
        console.log(`  [Password Reset] ${user.email} → ${resetUrl}`);
        const devReply = process.env.NODE_ENV !== 'production'
          ? { ok: true, devLink: resetUrl }
          : { ok: true };
        json(res, devReply);
        return;
      }
      // Réponse identique pour empêcher l'énumération d'emails
      json(res, { ok: true });
      return;
    }

    // POST /api/auth/reset { token, password } → réinitialise le mot de passe
    if (req.method === 'POST' && url === '/api/auth/reset') {
      const b = await parseBody(req).catch(() => ({}));
      const { token: rtoken, password } = b;
      if (!rtoken || !password) { json(res, { error: 'Token et mot de passe requis' }, 400); return; }
      if (password.length < 8) { json(res, { error: 'Mot de passe trop court (8 caractères min)' }, 400); return; }
      const row = db.prepare(
        "SELECT user_id, used FROM password_resets WHERE token=? AND expires_at>datetime('now')"
      ).get(rtoken);
      if (!row || row.used) { json(res, { error: 'Lien invalide ou expiré' }, 400); return; }
      const hash = await bcrypt.hash(password, 12);
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, row.user_id);
      db.prepare('UPDATE password_resets SET used=1 WHERE token=?').run(rtoken);
      // Invalide toutes les sessions actives pour ce user
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
      json(res, { ok: true });
      return;
    }

    // GET /reset-password → page HTML de saisie du nouveau mot de passe
    if (req.method === 'GET' && url === '/reset-password') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(RESET_PASSWORD_HTML);
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
          // Bambu envoie automatiquement le code par email quand le compte a la
          // 2FA activée (changement d'API ~2025). On NE déclenche PLUS de
          // sendemail/code explicite : ça envoyait un 2ᵉ email qui invalidait
          // le 1er → l'utilisateur ne savait pas lequel utiliser.
          if (d.loginType === 'verifyCode') {
            console.log(`  [Bambu] 2FA requis pour ${b.email} — code envoyé par Bambu`);
            const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2);
            pendingTfa.set(sessionId, {
              email: b.email,
              password: b.password,
              tfaKey: d.tfaKey || d.data?.tfaKey || null,
              expires: Date.now() + 10 * 60_000,
              userId,
            });
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
          console.warn('  [Bambu] /api/bambu/auth erreur :', e.message);
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
        const cleanCode = String(code).trim().replace(/\s+/g, '');
        try {
          // Bambu accepte le code soit via { account, password, code }, soit via
          // { tfaKey, code } selon la version. On essaie d'abord avec tous les
          // champs pour maximiser la compatibilité.
          const payload = {
            account: tfa.email,
            password: tfa.password,
            code: cleanCode,
          };
          if (tfa.tfaKey) payload.tfaKey = tfa.tfaKey;
          const d = await curlPost('https://api.bambulab.com/v1/user-service/user/login', payload);
          const token = d.accessToken || d.token || d.data?.accessToken;
          if (!token) {
            console.warn('  [Bambu] /api/bambu/verify : pas de token. Réponse :', JSON.stringify(d).slice(0, 500));
            throw new Error(d.message || d.error || `Code invalide ou expiré (réponse Bambu : ${JSON.stringify(d).slice(0,120)})`);
          }
          const email = tfa.email;
          const tfaUserId = tfa.userId || userId;
          pendingTfa.delete(sessionId);
          const currentUser = db.prepare('SELECT bambu_printers FROM users WHERE id=?').get(tfaUserId);
          const printers = JSON.parse(currentUser?.bambu_printers || '[]');
          saveBambuToken(tfaUserId, token, printers, email);
          connectBambu(tfaUserId, token, printers, email);
          onStateChange(tfaUserId, 'connected');
          console.log(`  [Bambu] 2FA validé pour ${email}`);
          json(res, { ok: true });
        } catch(e) {
          console.warn('  [Bambu] /api/bambu/verify erreur :', e.message);
          json(res, { error: e.message }, 401);
        }
        return;
      }

      // POST /api/bambu/resend-code → renvoie un nouveau code 2FA si l'utilisateur
      // n'a rien reçu ou a perdu le mail. Garde une trace en mémoire pour invalider
      // l'ancien proprement côté UI.
      if (req.method === 'POST' && url === '/api/bambu/resend-code') {
        const b = await parseBody(req).catch(() => ({}));
        const { sessionId } = b;
        if (!sessionId) { json(res, { error: 'Session requise' }, 400); return; }
        const tfa = pendingTfa.get(sessionId);
        if (!tfa || Date.now() > tfa.expires) {
          pendingTfa.delete(sessionId);
          json(res, { error: 'Session expirée — recommence la connexion' }, 400);
          return;
        }
        try {
          await curlPost('https://api.bambulab.com/v1/user-service/user/sendemail/code', {
            email: tfa.email,
            type:  'codeLogin',
          });
          console.log(`  [Bambu] Code 2FA renvoyé à ${tfa.email}`);
          json(res, { ok: true });
        } catch(e) {
          console.warn('  [Bambu] resend-code erreur :', e.message);
          json(res, { error: e.message }, 500);
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

      // ── PROFIL UTILISATEUR ───────────────────────────────────────────────
      // GET /api/profile → retourne les infos détaillées du compte courant
      if (req.method === 'GET' && url === '/api/profile') {
        const u = db.prepare(
          'SELECT id,email,name,plan,is_admin,bambu_email,created_at,last_login FROM users WHERE id=?'
        ).get(userId);
        const stats = {
          items:  db.prepare('SELECT COUNT(*) AS c FROM items WHERE user_id=?').get(userId).c,
          history: db.prepare('SELECT COUNT(*) AS c FROM history WHERE user_id=?').get(userId).c,
          prints: db.prepare('SELECT COUNT(*) AS c FROM print_jobs WHERE user_id=?').get(userId).c,
        };
        json(res, { user: { ...u, is_admin: !!u.is_admin }, stats });
        return;
      }

      // PATCH /api/profile { name?, email? } → modifie infos non sensibles
      if (req.method === 'PATCH' && url === '/api/profile') {
        const b = await parseBody(req);
        const updates = [];
        const params = {};
        if (typeof b.name === 'string') {
          updates.push('name=:name'); params.name = b.name.trim() || null;
        }
        if (typeof b.email === 'string') {
          const newEmail = b.email.toLowerCase().trim();
          if (!newEmail.includes('@')) { json(res, { error: 'Email invalide' }, 400); return; }
          if (newEmail !== user.email) {
            const taken = db.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(newEmail, userId);
            if (taken) { json(res, { error: 'Email déjà utilisé' }, 409); return; }
            updates.push('email=:email'); params.email = newEmail;
          }
        }
        if (!updates.length) { json(res, { ok: true }); return; }
        params.id = userId;
        db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id=:id`).run(params);
        json(res, { ok: true });
        return;
      }

      // POST /api/profile/password { currentPassword, newPassword }
      if (req.method === 'POST' && url === '/api/profile/password') {
        const b = await parseBody(req);
        const { currentPassword, newPassword } = b;
        if (!currentPassword || !newPassword) { json(res, { error: 'Champs requis' }, 400); return; }
        if (newPassword.length < 8) { json(res, { error: 'Nouveau mot de passe trop court (8 min)' }, 400); return; }
        const fresh = db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId);
        const ok = await bcrypt.compare(currentPassword, fresh.password_hash);
        if (!ok) { json(res, { error: 'Mot de passe actuel incorrect' }, 401); return; }
        const hash = await bcrypt.hash(newPassword, 12);
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, userId);
        // Invalide les autres sessions
        const cookie = req.headers.cookie || '';
        const m = cookie.match(/(?:^|;\s*)bs_session=([^;]+)/);
        const currentToken = m ? m[1] : null;
        if (currentToken) {
          db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(userId, currentToken);
        }
        json(res, { ok: true });
        return;
      }

      // DELETE /api/profile { password } → supprime le compte et toutes ses données
      if (req.method === 'DELETE' && url === '/api/profile') {
        const b = await parseBody(req).catch(() => ({}));
        if (!b.password) { json(res, { error: 'Mot de passe requis pour confirmer' }, 400); return; }
        const fresh = db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId);
        const ok = await bcrypt.compare(b.password, fresh.password_hash);
        if (!ok) { json(res, { error: 'Mot de passe incorrect' }, 401); return; }
        // Déconnecter Bambu
        const state = bambuByUser.get(userId);
        if (state?.client) state.client.end(true);
        bambuByUser.delete(userId);
        // Suppression cascade
        const tx = db.transaction(() => {
          db.prepare('DELETE FROM items      WHERE user_id=?').run(userId);
          db.prepare('DELETE FROM categories WHERE user_id=?').run(userId);
          db.prepare('DELETE FROM print_jobs WHERE user_id=?').run(userId);
          db.prepare('DELETE FROM history    WHERE user_id=?').run(userId);
          db.prepare('DELETE FROM sessions   WHERE user_id=?').run(userId);
          db.prepare('DELETE FROM password_resets WHERE user_id=?').run(userId);
          db.prepare('DELETE FROM users      WHERE id=?').run(userId);
        });
        tx();
        setSessionCookie(res, '');
        json(res, { ok: true });
        return;
      }

      // ── ADMIN PANEL (réservé aux admins) ─────────────────────────────────
      if (url.startsWith('/api/admin/')) {
        if (!user.is_admin) { json(res, { error: 'Accès admin requis' }, 403); return; }

        // GET /api/admin/users → liste tous les comptes avec stats
        if (req.method === 'GET' && url === '/api/admin/users') {
          const rows = db.prepare(`
            SELECT u.id, u.email, u.name, u.plan, u.is_admin, u.bambu_email,
                   u.created_at, u.last_login,
                   (SELECT COUNT(*) FROM items      WHERE user_id=u.id) AS items_count,
                   (SELECT COUNT(*) FROM print_jobs WHERE user_id=u.id) AS prints_count,
                   (SELECT COUNT(*) FROM sessions   WHERE user_id=u.id AND expires_at>datetime('now')) AS active_sessions
            FROM users u ORDER BY u.created_at DESC
          `).all();
          json(res, rows.map(r => ({ ...r, is_admin: !!r.is_admin, bambu_connected: getBambuStatus(r.id) })));
          return;
        }

        // PATCH /api/admin/users/:id { plan?, is_admin? }
        if (req.method === 'PATCH' && parts[2] === 'users' && parts[3]) {
          const targetId = parts[3];
          const b = await parseBody(req);
          const updates = []; const params = {};
          if (typeof b.plan === 'string') { updates.push('plan=:plan'); params.plan = b.plan; }
          if (typeof b.is_admin === 'boolean') {
            // Empêcher de retirer le dernier admin
            if (!b.is_admin) {
              const admins = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin=1').get().c;
              const target = db.prepare('SELECT is_admin FROM users WHERE id=?').get(targetId);
              if (target && target.is_admin && admins <= 1) {
                json(res, { error: 'Impossible de retirer le dernier admin' }, 400);
                return;
              }
            }
            updates.push('is_admin=:ia'); params.ia = b.is_admin ? 1 : 0;
          }
          if (!updates.length) { json(res, { ok: true }); return; }
          params.id = targetId;
          db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id=:id`).run(params);
          json(res, { ok: true });
          return;
        }

        // DELETE /api/admin/users/:id → supprime un compte (interdit pour soi)
        if (req.method === 'DELETE' && parts[2] === 'users' && parts[3]) {
          const targetId = parts[3];
          if (targetId === userId) { json(res, { error: 'Vous ne pouvez pas supprimer votre propre compte ici' }, 400); return; }
          const target = db.prepare('SELECT is_admin FROM users WHERE id=?').get(targetId);
          if (!target) { json(res, { error: 'Utilisateur introuvable' }, 404); return; }
          if (target.is_admin) {
            const admins = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin=1').get().c;
            if (admins <= 1) { json(res, { error: 'Impossible de supprimer le dernier admin' }, 400); return; }
          }
          const state = bambuByUser.get(targetId);
          if (state?.client) state.client.end(true);
          bambuByUser.delete(targetId);
          const tx = db.transaction(() => {
            db.prepare('DELETE FROM items      WHERE user_id=?').run(targetId);
            db.prepare('DELETE FROM categories WHERE user_id=?').run(targetId);
            db.prepare('DELETE FROM print_jobs WHERE user_id=?').run(targetId);
            db.prepare('DELETE FROM history    WHERE user_id=?').run(targetId);
            db.prepare('DELETE FROM sessions   WHERE user_id=?').run(targetId);
            db.prepare('DELETE FROM password_resets WHERE user_id=?').run(targetId);
            db.prepare('DELETE FROM users      WHERE id=?').run(targetId);
          });
          tx();
          json(res, { ok: true });
          return;
        }

        // GET /api/admin/stats → métriques globales
        if (req.method === 'GET' && url === '/api/admin/stats') {
          const c = (sql) => db.prepare(sql).get().c;
          const totalUsers = c('SELECT COUNT(*) AS c FROM users');
          const usersWithItems   = c('SELECT COUNT(DISTINCT user_id) AS c FROM items');
          const usersWithPrints  = c('SELECT COUNT(DISTINCT user_id) AS c FROM print_jobs');
          const usersWithBambu   = c('SELECT COUNT(*) AS c FROM users WHERE bambu_token IS NOT NULL');
          let dbSize = 0; try { dbSize = fs.statSync(DB_FILE).size; } catch {}
          let uploadsSize = 0;
          try {
            for (const f of fs.readdirSync(UPLOADS_DIR)) {
              try { uploadsSize += fs.statSync(path.join(UPLOADS_DIR, f)).size; } catch {}
            }
          } catch {}
          const stats = {
            // ── Utilisateurs ──
            users:           totalUsers,
            users_max:       MAX_BETA_USERS,
            users_capacity:  Math.round((totalUsers / MAX_BETA_USERS) * 100),
            users_24h:       c("SELECT COUNT(*) AS c FROM users WHERE created_at > datetime('now','-1 day')"),
            users_7d:        c("SELECT COUNT(*) AS c FROM users WHERE created_at > datetime('now','-7 days')"),
            users_30d:       c("SELECT COUNT(*) AS c FROM users WHERE created_at > datetime('now','-30 days')"),
            // ── Activité ──
            active_24h:      c("SELECT COUNT(*) AS c FROM users WHERE last_login > datetime('now','-1 day')"),
            active_7d:       c("SELECT COUNT(*) AS c FROM users WHERE last_login > datetime('now','-7 days')"),
            active_30d:      c("SELECT COUNT(*) AS c FROM users WHERE last_login > datetime('now','-30 days')"),
            never_logged:    c("SELECT COUNT(*) AS c FROM users WHERE last_login IS NULL"),
            // ── Onboarding funnel ──
            users_with_bambu:   usersWithBambu,
            users_with_items:   usersWithItems,
            users_with_prints:  usersWithPrints,
            bambu_connected_now: [...bambuByUser.values()].filter(b => b.status === 'connected').length,
            // ── Catalogue ──
            items_total:        c('SELECT COUNT(*) AS c FROM items'),
            categories_total:   c('SELECT COUNT(*) AS c FROM categories'),
            avg_items_per_user: totalUsers ? Math.round((c('SELECT COUNT(*) AS c FROM items') / totalUsers) * 10) / 10 : 0,
            // ── Impressions ──
            prints_total:     c('SELECT COUNT(*) AS c FROM print_jobs'),
            prints_pending:   c("SELECT COUNT(*) AS c FROM print_jobs WHERE status='pending'"),
            prints_done:      c("SELECT COUNT(*) AS c FROM print_jobs WHERE status='done'"),
            prints_dismissed: c("SELECT COUNT(*) AS c FROM print_jobs WHERE status='dismissed'"),
            prints_24h:       c("SELECT COUNT(*) AS c FROM print_jobs WHERE ts > datetime('now','-1 day')"),
            prints_7d:        c("SELECT COUNT(*) AS c FROM print_jobs WHERE ts > datetime('now','-7 days')"),
            // ── Système ──
            db_size_mb:       Math.round(dbSize / 1024 / 102.4) / 10,
            uploads_size_mb:  Math.round(uploadsSize / 1024 / 102.4) / 10,
            uptime_seconds:   Math.floor(process.uptime()),
            version:          process.env.APP_VERSION || JSON.parse(fs.readFileSync(path.join(__dirname,'package.json'),'utf8')).version,
          };
          json(res, stats);
          return;
        }

        // GET /api/admin/activity → 20 derniers événements (inscriptions + impressions)
        if (req.method === 'GET' && url === '/api/admin/activity') {
          const recentUsers = db.prepare(`
            SELECT 'register' AS type, id AS id, email AS label, created_at AS ts
            FROM users ORDER BY created_at DESC LIMIT 10
          `).all();
          const recentPrints = db.prepare(`
            SELECT 'print' AS type, p.id AS id, p.file_name AS label, p.ts AS ts,
                   p.status AS status, p.printer_name AS printer, u.email AS user_email
            FROM print_jobs p LEFT JOIN users u ON p.user_id=u.id
            ORDER BY p.ts DESC LIMIT 10
          `).all();
          const merged = [...recentUsers, ...recentPrints]
            .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
            .slice(0, 20);
          json(res, merged);
          return;
        }

        json(res, { error: 'Route admin inconnue' }, 404);
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
