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
// last_seen : mis à jour à chaque ouverture de l'app (= chaque requête
// authentifiée), throttlé à 5 min côté getSessionUser. Reflète la
// dernière fois où l'utilisateur a ouvert l'app, même s'il n'a fait
// aucune action explicite. last_login reste figé au dernier POST login.
addColumnIfMissing('users', 'last_seen', 'TEXT');

// Tags multiples sur items (JSON array) — complète category (single).
addColumnIfMissing('items', 'tags', 'TEXT');

// Snapshot avant action pour pouvoir undo : on stocke la version sérialisée
// de l'item juste avant l'update/delete pour pouvoir le restaurer.
addColumnIfMissing('history', 'before_state', 'TEXT');

// Refresh token Bambu : permet de renouveler l'access token (qui expire
// régulièrement) sans demander à l'utilisateur de se re-login.
addColumnIfMissing('users', 'bambu_refresh_token', 'TEXT');

// Paramètres de coût (calculateur rentabilité) stockés en JSON :
// { filamentPricePerKg, electricityRatePerKwh, printerPowerW,
//   laborRatePerHour, targetMarginPct, currency }
addColumnIfMissing('users', 'cost_settings', 'TEXT');

// ── Programme partenaires / influenceurs ─────────────────────────────────
// is_influencer  : flag pour distinguer un compte partenaire
// referral_code  : code unique de l'influencer (NULL pour les users normaux)
// referred_by_code : code utilisé par l'user pour s'inscrire (si applicable),
//                    permet de compter les conversions par influencer.
addColumnIfMissing('users', 'is_influencer',    'INTEGER DEFAULT 0');
addColumnIfMissing('users', 'referral_code',    'TEXT');
addColumnIfMissing('users', 'referred_by_code', 'TEXT');

// Table des visites taggées : un row par fois que quelqu'un arrive sur
// la landing avec ?ref=CODE. Permet de calculer le ratio conversion.
db.exec(`
  CREATE TABLE IF NOT EXISTS referral_visits (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    ts   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ref_visits_code ON referral_visits(code);
`);
// Migration : on stocke aussi le referer (host) et le user-agent pour
// comprendre d'où viennent les clics — Instagram, YouTube, Twitter, etc.
addColumnIfMissing('referral_visits', 'referer',    'TEXT');
addColumnIfMissing('referral_visits', 'user_agent', 'TEXT');

// Note privée admin par partenaire (contrat, deal négocié, contacts)
// et taux de commission en % (pour le calcul futur des montants dus).
addColumnIfMissing('users', 'referral_note',           'TEXT');
addColumnIfMissing('users', 'referral_commission_pct', 'REAL DEFAULT 0');

// Flag onboarding : 0 = jamais terminé le wizard d'accueil (Bambu →
// coûts → tour) ; 1 = déjà passé. On l'utilise pour ouvrir le modal
// automatiquement au premier login.
addColumnIfMissing('users', 'onboarding_completed', 'INTEGER DEFAULT 0');

// Backfill : on considère que tout user déjà actif (qui a un last_login
// non-NULL ou des items) a "fini" l'onboarding implicitement — pas de
// raison de lui afficher le wizard. Idempotent : ne touche que les rows
// encore à 0.
db.exec(`
  UPDATE users SET onboarding_completed = 1
  WHERE onboarding_completed = 0
    AND (last_login IS NOT NULL
      OR id IN (SELECT DISTINCT user_id FROM items WHERE user_id IS NOT NULL));
`);

// Indexes pour requêtes fréquentes (créés après TOUTES les migrations
// pour garantir que colonnes et tables existent) :
// - history.item_id   : timeline d'un item (déjà existant)
// - *.user_id         : multi-tenant — sans index c'est full scan
// - items.category    : filtre par catégorie
// - print_jobs.status : queue À valider WHERE status='pending'
// - sessions.expires_at : purge des sessions expirées
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_history_item_id    ON history(item_id);
  CREATE INDEX IF NOT EXISTS idx_history_user_id    ON history(user_id);
  CREATE INDEX IF NOT EXISTS idx_items_user_id      ON items(user_id);
  CREATE INDEX IF NOT EXISTS idx_items_category     ON items(category);
  CREATE INDEX IF NOT EXISTS idx_categories_user_id ON categories(user_id);
  CREATE INDEX IF NOT EXISTS idx_print_jobs_user    ON print_jobs(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires   ON sessions(expires_at);
`);

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
const CACHE_VERSION = 'bs-v40';
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
// Traduit les messages d'erreur connus de l'API Bambu en français + ajoute
// éventuellement une piste de résolution. Si le message ne matche aucun
// pattern, on le renvoie tel quel.
function _translateBambuError(msg) {
  if (!msg) return 'Erreur inconnue de Bambu Lab';
  const m = String(msg);
  if (/incorrect account or password/i.test(m)) {
    return 'Email ou mot de passe incorrect côté Bambu Lab. Vérifie sur bambulab.com que tu peux te connecter avec ces identifiants. Si tu as fait plusieurs essais ratés, attends 15-30 min : Bambu rate-limite les comptes.';
  }
  if (/captcha|verify code/i.test(m) && /not.*found|invalid/i.test(m)) {
    return 'Vérification Bambu Lab requise. Connecte-toi une fois sur bambulab.com pour valider, puis réessaie ici.';
  }
  if (/too many|rate.?limit/i.test(m)) {
    return 'Trop de tentatives — Bambu Lab bloque temporairement les connexions. Patiente 15-30 min et réessaie.';
  }
  if (/account.*locked|disabled/i.test(m)) {
    return 'Compte Bambu Lab verrouillé. Vérifie le statut sur bambulab.com.';
  }
  return m;
}

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

function logHistory(itemId, itemName, action, detail = null, beforeState = null, userId = null) {
  db.prepare(`INSERT INTO history (item_id, item_name, action, detail, before_state, user_id)
              VALUES (:itemId, :itemName, :action, :detail, :before_state, :uid)`)
    .run({
      itemId, itemName, action,
      detail: detail ? JSON.stringify(detail) : null,
      before_state: beforeState ? JSON.stringify(beforeState) : null,
      uid: userId || null,
    });
}

// Snapshot d'un item avant modification (pour undo).
function snapshotItem(id) {
  const row = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  return row || null;
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
  const user = db.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>datetime('now')"
  ).get(m[1]) || null;
  if (user) _touchLastSeen(user);
  return user;
}

// Met à jour users.last_seen avec un throttle 5 min : évite d'écrire en
// BDD à chaque requête (un user qui ouvre l'app fait des dizaines de
// requêtes en quelques secondes). Le throttle est mémorisé en RAM, donc
// reset au redémarrage du serveur — acceptable.
const _lastSeenTouches = new Map(); // userId → timestamp ms du dernier UPDATE
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;
function _touchLastSeen(user) {
  if (!user || !user.id) return;
  const now = Date.now();
  const prev = _lastSeenTouches.get(user.id) || 0;
  if (now - prev < LAST_SEEN_THROTTLE_MS) return;
  _lastSeenTouches.set(user.id, now);
  try {
    db.prepare('UPDATE users SET last_seen=? WHERE id=?')
      .run(new Date(now).toISOString(), user.id);
  } catch {}
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
  const state = bambuByUser.get(userId) || {};
  // On indique aussi si le token API est valide. La pill côté client
  // doit pouvoir distinguer "MQTT down mais token OK" (= polling actif,
  // tout va bien) de "vraiment déconnecté" (= token absent/expiré).
  const u = db.prepare('SELECT bambu_token FROM users WHERE id=?').get(userId);
  const hasValidToken = !!(u?.bambu_token && !isTokenExpired(u.bambu_token));
  broadcast(userId, 'bambu-status', {
    status,
    lastSyncAt: state.lastSyncAt || null,
    lastSyncCount: state.lastSyncCount ?? null,
    hasValidToken,
  });
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
  // Règle 2 : reçu il y a moins de 90 s (Bambu renvoie souvent FINISH
  // plusieurs fois, parfois après l'expiration du dedup en mémoire de
  // 60 s côté MQTT). 90 s couvre ces doublons sans bloquer un vrai
  // re-print du même fichier (avant on était à 10 min, ce qui empêchait
  // de re-imprimer un petit objet plusieurs fois dans la même session).
  const justReceived = db.prepare(`
    SELECT id FROM print_jobs
    WHERE printer_serial=:ps AND file_name=:fn AND user_id=:uid
      AND ts > datetime('now','-90 seconds')
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

// ── POLL FALLBACK Bambu API ────────────────────────────────────────────────
// MQTT peut rater des messages (déconnexion silencieuse, sub failed, message
// perdu). On poll donc périodiquement l'API REST de Bambu pour détecter les
// prints manqués. Marche même si MQTT est complètement KO.
async function pollBambuForUser(userId) {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user?.bambu_token) return { imported: 0, error: 'no-token' };
  // Token expiré ? On tente un refresh avant de baisser les bras.
  if (isTokenExpired(user.bambu_token)) {
    if (user.bambu_refresh_token) {
      const r = await refreshBambuTokenForUser(userId);
      if (r.ok) user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      else { onStateChange(userId, 'token-expired'); return { imported: 0, error: 'token-expired' }; }
    } else {
      onStateChange(userId, 'token-expired');
      return { imported: 0, error: 'token-expired' };
    }
  }
  let tasks;
  try {
    const d = await curlGet(
      'https://api.bambulab.com/v1/user-service/my/tasks?deviceId=&limit=30&offset=0',
      user.bambu_token,
    );
    tasks = d.hits || d.data?.hits || d.tasks || [];
  } catch (e) {
    return { imported: 0, error: e.message };
  }

  let printers = JSON.parse(user.bambu_printers || '[]');
  // Si la liste est vide (ancien compte créé avant le fetch auto), on
  // tente de la peupler maintenant — ça permet de remplir les noms
  // conviviaux sans forcer l'utilisateur à se reconnecter.
  if (!printers.length) {
    const fetched = await bambu.fetchPrinters(user.bambu_token);
    if (fetched.length) {
      printers = fetched;
      saveBambuToken(userId, user.bambu_token, printers, user.bambu_email, user.bambu_refresh_token);
      _backfillPrinterNames(userId, printers);
    }
  }
  const printerSerials = new Set(printers.map(p => p.serial));
  let imported = 0;

  for (const task of tasks) {
    // Filtre : on veut uniquement les prints terminés. Bambu utilise
    // status numérique : on a vu '4' = success, '3' = en cours, autres
    // valeurs incluent failed/cancelled. On accepte 4 et la string
    // 'COMPLETED' au cas où l'API change.
    const st = task.status;
    const completed = st === 4 || st === '4' || st === 'COMPLETED' || st === 'SUCCESS';
    if (!completed) continue;

    const serial = task.deviceId || task.printerId;
    if (!serial) continue;
    // Si la liste de printers est vide on accepte quand même (l'utilisateur
    // n'a peut-être pas encore configuré, mais l'API renvoie ses tasks).
    if (printerSerials.size > 0 && !printerSerials.has(serial)) continue;

    const fileName = (task.designTitle || task.title || task.subtaskName || task.name || '')
      .replace(/\.gcode\.3mf$|\.gcode$|\.3mf$/i, '').trim();
    if (!fileName) continue;

    // Dédup : on évite de réimporter un print déjà présent (par MQTT ou
    // un poll précédent). Match sur printer + filename dans une fenêtre
    // de 6 heures autour de l'endTime — couvre les variations entre l'heure
    // d'enregistrement MQTT vs l'heure rapportée par l'API.
    const taskTs = task.endTime || task.startTime;
    let dupQ;
    if (taskTs) {
      // taskTs peut être en ms (number) ou string ISO
      const isoTs = typeof taskTs === 'number' ? new Date(taskTs).toISOString() : taskTs;
      dupQ = db.prepare(`
        SELECT id FROM print_jobs
        WHERE printer_serial = :ps AND file_name = :fn AND user_id = :uid
          AND ABS((julianday(:ts) - julianday(ts)) * 24) < 6
      `).get({ ps: serial, fn: fileName, uid: userId, ts: isoTs });
    } else {
      // Pas de timestamp — fallback sur dédup classique 24h.
      dupQ = db.prepare(`
        SELECT id FROM print_jobs
        WHERE printer_serial = :ps AND file_name = :fn AND user_id = :uid
          AND ts > datetime('now','-1 day')
      `).get({ ps: serial, fn: fileName, uid: userId });
    }
    if (dupQ) continue;

    const filaments = Array.isArray(task.filamentUsed) ? task.filamentUsed
                    : Array.isArray(task.filamentList)  ? task.filamentList : [];
    const fc = normColor(filaments[0]?.color || filaments[0]?.colorCode || task.filamentColor || null);
    const ft = (filaments.map(f => f.type || f.materialName || f.name).filter(Boolean).join(' · '))
            || task.filamentType || task.materialName || null;
    const tl = task.totalLayer || task.totalLayerNum || null;
    const printer = printers.find(p => p.serial === serial);
    // Priorité : nom convivial dans bambu_printers > deviceName du task
    // (souvent renseigné par Bambu cloud) > serial brut en dernier recours.
    const friendlyName = printer?.name || task.deviceName || task.printerName || serial;

    const row = db.prepare(`
      INSERT INTO print_jobs (printer_serial, printer_name, file_name, filament_color, filament_type, total_layers, user_id)
      VALUES (:ps, :pn, :fn, :fc, :ft, :tl, :uid)
    `).run({
      ps: serial, pn: friendlyName, fn: fileName,
      fc, ft, tl, uid: userId,
    });
    const newJob = db.prepare('SELECT * FROM print_jobs WHERE id = :id').get({ id: row.lastInsertRowid });
    broadcast(userId, 'print-complete', { ...newJob, source: 'poll' });
    imported++;
    // Enrichissement asynchrone (thumbnail, poids, durée)
    setTimeout(() => enrichJobFromHistory(userId, newJob.id, fileName), 5_000);
  }

  // Mémorise la date du dernier poll réussi (visible côté client).
  bambuByUser.set(userId, { ...(bambuByUser.get(userId) || {}), lastSyncAt: Date.now(), lastSyncCount: imported });
  // Re-broadcast pour que le pill côté client mette à jour "dernière sync".
  const state = bambuByUser.get(userId) || {};
  // hasValidToken: si on a réussi le poll, le token est forcément valide.
  broadcast(userId, 'bambu-status', {
    status: state.status || 'connected',
    lastSyncAt: state.lastSyncAt,
    lastSyncCount: state.lastSyncCount,
    hasValidToken: true,
  });
  if (imported > 0) console.log(`  [Bambu poll] User ${userId} : ${imported} print(s) importé(s) via fallback`);
  return { imported, error: null };
}

// Boucle automatique : 10 min entre chaque poll, démarre 1 min après le boot.
const BAMBU_POLL_INTERVAL_MS = parseInt(process.env.BAMBU_POLL_INTERVAL_MS || (10 * 60 * 1000), 10);
async function bambuPollAllUsers() {
  const users = db.prepare("SELECT id FROM users WHERE bambu_token IS NOT NULL").all();
  for (const u of users) {
    try { await pollBambuForUser(u.id); } catch (e) { console.warn('  [Bambu poll]', e.message); }
  }
}
setTimeout(bambuPollAllUsers, 60_000);
setInterval(bambuPollAllUsers, BAMBU_POLL_INTERVAL_MS);

// ── KEEP-ALIVE (anti-sleep Render free tier) ───────────────────────────────
// Render Free met le service en sommeil après 15 min sans requête HTTP
// entrante. Quand le service dort, on perd la connexion MQTT et le poll
// périodique → les prints terminés pendant ce temps ne sont jamais détectés.
//
// Solution : on s'auto-ping toutes les 10 min via PUBLIC_URL (= l'URL
// publique de l'app, ex bambustock.com). Le ping compte comme requête
// entrante côté Render → reset du timer de sleep.
//
// Activation : définir PUBLIC_URL dans les env vars Render
// (ex: PUBLIC_URL=https://bambustock.com).
// Pas de PUBLIC_URL → keep-alive inactif (utile pour dev local et Fly où
// auto_stop_machines=false rend ça inutile).
const PUBLIC_URL = process.env.PUBLIC_URL || '';
if (PUBLIC_URL) {
  const KEEPALIVE_INTERVAL_MS = parseInt(process.env.KEEPALIVE_INTERVAL_MS || (10 * 60 * 1000), 10);
  console.log(`  [Keep-alive] Auto-ping ${PUBLIC_URL}/api/version toutes les ${Math.round(KEEPALIVE_INTERVAL_MS/60000)} min`);
  setInterval(async () => {
    try {
      const r = await fetch(PUBLIC_URL.replace(/\/$/, '') + '/api/version', {
        method: 'GET',
        headers: { 'User-Agent': 'onlyfab-keepalive/1.0' },
      });
      // On log seulement les erreurs : succès = silencieux pour pas spammer
      if (!r.ok) console.warn(`  [Keep-alive] Ping HTTP ${r.status}`);
    } catch (e) {
      console.warn(`  [Keep-alive] Échec ping : ${e.message}`);
    }
  }, KEEPALIVE_INTERVAL_MS);
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

// Sauvegarde un token Bambu (+ refresh token si fourni) dans la table users.
// Backfill : met à jour les print_jobs existants dont printer_name est
// soit vide soit égal au serial, pour utiliser le vrai nom convivial.
// Appelé à chaque récupération fraîche de la liste des imprimantes.
function _backfillPrinterNames(userId, printers) {
  if (!printers || !printers.length) return;
  const upd = db.prepare(
    `UPDATE print_jobs SET printer_name = :name
     WHERE user_id = :uid AND printer_serial = :serial
       AND (printer_name IS NULL OR printer_name = '' OR printer_name = printer_serial)`
  );
  let total = 0;
  for (const p of printers) {
    if (!p.serial || !p.name || p.name === p.serial) continue;
    const r = upd.run({ name: p.name, uid: userId, serial: p.serial });
    total += r.changes;
  }
  if (total) console.log(`  [Bambu] Backfill noms imprimantes : ${total} print_jobs mis à jour`);
}

function saveBambuToken(userId, token, printers, email, refreshToken) {
  if (refreshToken !== undefined) {
    db.prepare('UPDATE users SET bambu_token=?, bambu_printers=?, bambu_email=?, bambu_refresh_token=? WHERE id=?')
      .run(token, JSON.stringify(printers || []), email || null, refreshToken || null, userId);
  } else {
    // Compat : si on n'a pas de nouveau refresh token, on garde l'ancien.
    db.prepare('UPDATE users SET bambu_token=?, bambu_printers=?, bambu_email=? WHERE id=?')
      .run(token, JSON.stringify(printers || []), email || null, userId);
  }
}

// ── REFRESH TOKEN BAMBU ────────────────────────────────────────────────────
// Bambu fournit un refresh token au login → on l'échange contre un nouvel
// access token avant que ce dernier n'expire, sans demander à l'utilisateur
// de se re-connecter (et sans devoir re-saisir le code 2FA).
async function refreshBambuTokenForUser(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user?.bambu_refresh_token) return { ok: false, reason: 'no-refresh-token' };
  try {
    // Endpoint Bambu : POST /v1/user-service/user/refreshtoken
    // Body : { refreshToken }. Réponse : { accessToken, refreshToken }.
    const r = await fetch('https://api.bambulab.com/v1/user-service/user/refreshtoken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ refreshToken: user.bambu_refresh_token }),
    });
    const text = await r.text();
    if (text.trimStart().startsWith('<')) return { ok: false, reason: 'cloudflare-html' };
    const d = JSON.parse(text);
    const newAccess  = d.accessToken || d.token || d.data?.accessToken;
    const newRefresh = d.refreshToken || d.data?.refreshToken || user.bambu_refresh_token;
    if (!newAccess) return { ok: false, reason: 'no-token-in-response', raw: text.slice(0, 200) };
    const printers = JSON.parse(user.bambu_printers || '[]');
    saveBambuToken(userId, newAccess, printers, user.bambu_email, newRefresh);
    console.log(`  [Bambu refresh] OK pour user ${user.email}`);
    // Reconnecte MQTT avec le nouveau token (l'ancienne session se ferme).
    connectBambu(userId, newAccess, printers, user.bambu_email);
    return { ok: true };
  } catch (e) {
    console.warn(`  [Bambu refresh] Échec pour user ${userId} :`, e.message);
    return { ok: false, reason: e.message };
  }
}

// Boucle automatique : toutes les 30 min, refresh proactif des tokens qui
// expirent dans moins de 24h. Beaucoup mieux que d'attendre l'expiry pour
// constater le pb (entre temps, MQTT est déconnecté + poll échoue + prints
// manqués). 30 min suffisent : si Bambu emet un access token de 7j, on a
// largement le temps de le rattraper.
async function refreshExpiringBambuTokens() {
  const users = db.prepare("SELECT id, bambu_token, bambu_refresh_token, email FROM users WHERE bambu_token IS NOT NULL AND bambu_refresh_token IS NOT NULL").all();
  for (const u of users) {
    try {
      const payload = JSON.parse(Buffer.from(u.bambu_token.split('.')[1], 'base64url').toString());
      const expSec = payload.exp;
      if (!expSec) continue;
      const remainingHours = (expSec - Date.now() / 1000) / 3600;
      // Refresh si moins de 24h restantes (ou déjà expiré).
      if (remainingHours < 24) {
        console.log(`  [Bambu refresh] Token de ${u.email} expire dans ${remainingHours.toFixed(1)}h → refresh`);
        await refreshBambuTokenForUser(u.id);
      }
    } catch (e) { /* token mal formé, on skip */ }
  }
}
// 1er passage 2 min après le boot, puis toutes les 30 min.
setTimeout(refreshExpiringBambuTokens, 2 * 60_000);
setInterval(refreshExpiringBambuTokens, 30 * 60_000);

// Sessions 2FA en attente (stockées en mémoire, expirent en 10 min)
const pendingTfa = new Map(); // sessionId → { email, password, expires, userId }
// Purge automatique toutes les 2 min pour éviter de garder des credentials en RAM indéfiniment
setInterval(() => {
  const now = Date.now();
  for (const [sid, tfa] of pendingTfa.entries()) {
    if (now > tfa.expires) pendingTfa.delete(sid);
  }
}, 2 * 60_000);

// ── BACKUPS AUTOMATIQUES ──────────────────────────────────────────────────
// Snapshot SQLite vers /data/backups/ toutes les BACKUP_INTERVAL_HOURS.
// Garde les BACKUP_RETENTION derniers, rotation FIFO sur le mtime.
// On utilise db.backup() (API native better-sqlite3) qui copie de manière
// cohérente même pendant des écritures (vs cp brut qui peut donner un fichier
// corrompu en cas de transaction en cours).
const BACKUP_DIR             = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const BACKUP_INTERVAL_HOURS  = parseInt(process.env.BACKUP_INTERVAL_HOURS || '4', 10);
const BACKUP_RETENTION       = parseInt(process.env.BACKUP_RETENTION || '14', 10);
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

async function runBackup() {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, `onlyfab-${ts}.db`);
    await db.backup(dest);
    // Rotation : ne garde que les BACKUP_RETENTION plus récents.
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('onlyfab-') && f.endsWith('.db'))
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(BACKUP_RETENTION)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, old.f)); } catch {}
    }
    console.log(`[backup] ${dest} (kept ${Math.min(files.length + 1, BACKUP_RETENTION)})`);
  } catch (e) {
    console.error('[backup] ERREUR :', e.message);
  }
}
// 1er backup 30s après le boot, puis tous les BACKUP_INTERVAL_HOURS.
setTimeout(runBackup, 30_000);
setInterval(runBackup, BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);

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
          onboarding_completed: !!user.onboarding_completed,
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
      res.writeHead(200, {
        'Content-Type': 'application/manifest+json',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(MANIFEST);
      return;
    }
    if (req.method === 'GET' && url === '/icon.svg') {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=86400',
      });
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
      // Les uploads ont un nom UUID donc le contenu ne change JAMAIS pour
      // une URL donnée — on peut servir avec immutable (les navigateurs
      // sautent la revalidation conditionnelle).
      res.writeHead(200, {
        'Content-Type': mimeMap[ext],
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
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
        onboarding_completed: !!user.onboarding_completed,
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

    // POST /api/ref/visit { code } → track une visite avec ?ref=CODE.
    // Public (pas d'auth requise). On valide que le code correspond à un
    // influencer actif pour ne pas polluer la table avec des codes random.
    if (req.method === 'POST' && url === '/api/ref/visit') {
      try {
        const b = await parseBody(req);
        if (typeof b?.code !== 'string') { json(res, { ok: true }); return; }
        const code = b.code.trim().toUpperCase().slice(0, 40);
        if (!code) { json(res, { ok: true }); return; }
        const valid = db.prepare('SELECT 1 FROM users WHERE referral_code=? AND is_influencer=1').get(code);
        if (!valid) { json(res, { ok: true }); return; }
        // Le client peut envoyer son document.referrer dans le body — c'est
        // souvent plus utile que celui du header HTTP (qui est /api/ref/visit
        // depuis la page elle-même). On garde uniquement le host pour la
        // confidentialité et pour faciliter l'agrégation.
        const clientRef = typeof b.referer === 'string' ? b.referer : (req.headers.referer || '');
        let host = '';
        try { if (clientRef) host = new URL(clientRef).host.toLowerCase().slice(0, 80); } catch {}
        const ua   = (req.headers['user-agent'] || '').slice(0, 240);
        db.prepare('INSERT INTO referral_visits (code, referer, user_agent) VALUES (?,?,?)')
          .run(code, host || null, ua || null);
      } catch { /* ignore */ }
      json(res, { ok: true });
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
      // Code influencer associé à l'inscription (si l'user est arrivé via un
      // lien ?ref=CODE et qu'on a stocké le code en localStorage côté client).
      // On valide juste que le code correspond à un compte influencer actif.
      let refByCode = null;
      if (typeof b.referredByCode === 'string' && b.referredByCode.trim()) {
        const candidate = b.referredByCode.trim().toUpperCase().slice(0, 40);
        const refOwner = db.prepare('SELECT id FROM users WHERE referral_code=? AND is_influencer=1').get(candidate);
        if (refOwner) refByCode = candidate;
      }
      db.prepare('INSERT INTO users (id,email,password_hash,name,is_admin,created_at,referred_by_code) VALUES (?,?,?,?,?,?,?)')
        .run(uid, email.toLowerCase(), hash, name || null, isAdmin, new Date().toISOString(), refByCode);
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
      // État initial : status MQTT + validité du token API. La pill peut
      // ainsi distinguer "MQTT en cours / token OK" (= polling actif) de
      // "vraiment déconnecté" (= il faut se reconnecter).
      const _initToken = db.prepare('SELECT bambu_token FROM users WHERE id=?').get(user.id);
      const _initState = bambuByUser.get(user.id) || {};
      res.write(`event: bambu-status\ndata: ${JSON.stringify({
        status: getBambuStatus(user.id),
        lastSyncAt: _initState.lastSyncAt || null,
        lastSyncCount: _initState.lastSyncCount ?? null,
        hasValidToken: !!(_initToken?.bambu_token && !isTokenExpired(_initToken.bambu_token)),
      })}\n\n`);
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
        // hasValidToken : indispensable dès l'init pour que la pill ne
        // flashe pas "Non connecté" pendant la fraction de seconde avant
        // le prochain événement bambu-status.
        const _initTokRow = db.prepare('SELECT bambu_token FROM users WHERE id=?').get(userId);
        const initData = {
          bambuStatus:   getBambuStatus(userId),
          hasValidToken: !!(_initTokRow?.bambu_token && !isTokenExpired(_initTokRow.bambu_token)),
          pending,
        };
        res.write(`event: init\ndata: ${JSON.stringify(initData)}\n\n`);
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
        // Récupère les pending avant de tous les marquer dismissed pour
        // pouvoir tracer l'action dans l'historique (utile pour le user).
        const rows = db.prepare("SELECT id, file_name, printer_name, printer_serial, filament_color, filament_type FROM print_jobs WHERE status='pending' AND user_id=?").all(userId);
        db.prepare("UPDATE print_jobs SET status='dismissed' WHERE status='pending' AND user_id=?").run(userId);
        for (const row of rows) {
          logHistory(
            'print-' + row.id,
            row.file_name || 'Impression',
            'print-dismiss',
            {
              printer:        row.printer_name || row.printer_serial || null,
              filament_color: row.filament_color || null,
              filament_type:  row.filament_type  || null,
              bulk:           true,
            },
            null,
            userId,
          );
        }
        json(res, { ok: true, dismissed: rows.length });
        return;
      }
      if (req.method === 'DELETE' && parts[1] === 'print-jobs' && id) {
        const row = db.prepare('SELECT file_name, printer_name, printer_serial, status, filament_color, filament_type FROM print_jobs WHERE id=:id AND user_id=:uid').get({ id, uid: userId });
        db.prepare('UPDATE print_jobs SET status=:s WHERE id=:id AND user_id=:uid').run({ s: 'dismissed', id, uid: userId });
        if (row) {
          logHistory(
            'print-' + id,
            row.file_name || 'Impression',
            'print-dismiss',
            {
              printer:        row.printer_name || row.printer_serial || null,
              filament_color: row.filament_color || null,
              filament_type:  row.filament_type  || null,
              prevStatus:     row.status,
            },
            null,
            userId,
          );
        }
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
        });
        return;
      }

      // Statut connexion Bambu (étendu : last sync, token expiry)
      if (req.method === 'GET' && url === '/api/bambu/status') {
        const u = db.prepare('SELECT bambu_token FROM users WHERE id=?').get(userId);
        const expired = u?.bambu_token ? isTokenExpired(u.bambu_token) : null;
        const state = bambuByUser.get(userId) || {};
        json(res, {
          status: expired ? 'token-expired' : (state.status || 'disconnected'),
          lastSyncAt: state.lastSyncAt || null,
          lastSyncCount: state.lastSyncCount ?? null,
          tokenExpired: expired,
        });
        return;
      }

      // Infos détaillées pour l'écran de gestion de la connexion : email,
      // expiry exacte, imprimantes, état refresh token, last sync.
      if (req.method === 'GET' && url === '/api/bambu/info') {
        const u = db.prepare('SELECT bambu_token, bambu_refresh_token, bambu_email, bambu_printers FROM users WHERE id=?').get(userId);
        const state = bambuByUser.get(userId) || {};
        let expiresAt = null;
        let expired = null;
        if (u?.bambu_token) {
          try {
            const payload = JSON.parse(Buffer.from(u.bambu_token.split('.')[1], 'base64url').toString());
            if (payload.exp) {
              expiresAt = payload.exp * 1000;
              expired = Date.now() > expiresAt;
            }
          } catch {}
        }
        const printers = (() => {
          try { return JSON.parse(u?.bambu_printers || '[]'); }
          catch { return []; }
        })();
        json(res, {
          connected: !!u?.bambu_token && !expired,
          status: expired ? 'token-expired' : (state.status || 'disconnected'),
          email: u?.bambu_email || null,
          expiresAt,
          tokenExpired: expired,
          hasRefreshToken: !!u?.bambu_refresh_token,
          lastSyncAt: state.lastSyncAt || null,
          lastSyncCount: state.lastSyncCount ?? null,
          printers,
        });
        return;
      }

      // Déconnexion Bambu : on coupe MQTT et on efface tokens + email + printers.
      if (req.method === 'POST' && url === '/api/bambu/disconnect') {
        const prev = bambuByUser.get(userId);
        if (prev?.client) { try { prev.client.end(true); } catch {} }
        bambuByUser.delete(userId);
        db.prepare('UPDATE users SET bambu_token=NULL, bambu_refresh_token=NULL, bambu_email=NULL, bambu_printers=? WHERE id=?')
          .run('[]', userId);
        broadcast(userId, 'bambu-status', { status: 'disconnected', lastSyncAt: null });
        console.log(`  [Bambu] User ${userId} déconnecté manuellement`);
        json(res, { ok: true });
        return;
      }

      // Trigger un poll Bambu manuel (bouton "Synchroniser maintenant").
      // Renvoie le nombre de prints importés.
      if (req.method === 'POST' && url === '/api/bambu/sync') {
        const result = await pollBambuForUser(userId);
        if (result.error === 'token-expired') { json(res, { error: 'Token Bambu expiré, reconnecte-toi.', tokenExpired: true }, 401); return; }
        if (result.error === 'no-token')      { json(res, { error: 'Pas de connexion Bambu configurée.' }, 400); return; }
        if (result.error)                     { json(res, { error: result.error }, 502); return; }
        json(res, { imported: result.imported });
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
          const refreshToken = d.refreshToken || d.data?.refreshToken || null;
          if (!token) throw new Error(d.message || d.error || 'Pas de token dans la réponse');
          // Récupère les imprimantes liées (avec leur nom convivial) pour
          // les afficher dans la queue À valider plutôt que le serial brut.
          let printers = await bambu.fetchPrinters(token);
          if (!printers.length) {
            // Fallback : on garde l'éventuelle liste précédente (ré-auth
            // sur le même compte) plutôt que d'écraser avec [].
            const currentUser = db.prepare('SELECT bambu_printers FROM users WHERE id=?').get(userId);
            printers = JSON.parse(currentUser?.bambu_printers || '[]');
          }
          saveBambuToken(userId, token, printers, b.email, refreshToken);
          _backfillPrinterNames(userId, printers);
          connectBambu(userId, token, printers, b.email);
          onStateChange(userId, 'connected');
          json(res, { ok: true });
        } catch(e) {
          console.warn('  [Bambu] /api/bambu/auth erreur :', e.message);
          json(res, { error: _translateBambuError(e.message) }, 401);
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
          const refreshToken = d.refreshToken || d.data?.refreshToken || null;
          if (!token) {
            console.warn('  [Bambu] /api/bambu/verify : pas de token. Réponse :', JSON.stringify(d).slice(0, 500));
            throw new Error(d.message || d.error || `Code invalide ou expiré (réponse Bambu : ${JSON.stringify(d).slice(0,120)})`);
          }
          const email = tfa.email;
          const tfaUserId = tfa.userId || userId;
          pendingTfa.delete(sessionId);
          let printers = await bambu.fetchPrinters(token);
          if (!printers.length) {
            const currentUser = db.prepare('SELECT bambu_printers FROM users WHERE id=?').get(tfaUserId);
            printers = JSON.parse(currentUser?.bambu_printers || '[]');
          }
          saveBambuToken(tfaUserId, token, printers, email, refreshToken);
          _backfillPrinterNames(tfaUserId, printers);
          connectBambu(tfaUserId, token, printers, email);
          onStateChange(tfaUserId, 'connected');
          console.log(`  [Bambu] 2FA validé pour ${email}`);
          json(res, { ok: true });
        } catch(e) {
          console.warn('  [Bambu] /api/bambu/verify erreur :', e.message);
          json(res, { error: _translateBambuError(e.message) }, 401);
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

      // ── EXPORT CSV ─────────────────────────────────────────────────────
      // Format : 1 ligne par article, variantes encodées en string
      // (color1|colorName1|qty1;color2|colorName2|qty2). Tags séparés par ;
      // BOM UTF-8 en tête pour qu'Excel affiche les accents correctement.
      if (req.method === 'GET' && url === '/api/export') {
        const rows = db.prepare('SELECT * FROM items WHERE user_id=? ORDER BY createdAt DESC').all(userId);
        const HEADERS = ['id','name','desc','filament','category','tags','threshold','trackStock','photo','variants','parts','assembledQty','createdAt','updatedAt'];
        const csvCell = v => {
          if (v === null || v === undefined) return '';
          const s = String(v);
          // Échappe : guillemet doublé si la valeur contient , " \n ou \r
          if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
          return s;
        };
        const encodeVariants = raw => {
          const arr = safeParseJson(raw, []);
          return arr.map(v => `${v.color||''}|${v.colorName||''}|${v.qty||0}`).join(';');
        };
        const encodeParts = raw => {
          const arr = safeParseJson(raw, []);
          return arr.map(p => {
            const vs = (p.variants||[]).map(v => `${v.color||''}|${v.colorName||''}|${v.qty||0}`).join('+');
            return `${p.name||''}::${p.filament||''}::${p.count||1}::${vs}`;
          }).join(';');
        };
        const encodeTags = raw => safeParseJson(raw, []).join(';');
        const lines = [HEADERS.join(',')];
        for (const r of rows) {
          lines.push([
            r.id, r.name, r.desc, r.filament, r.category,
            encodeTags(r.tags), r.threshold, r.trackStock, r.photo,
            encodeVariants(r.variants), encodeParts(r.parts),
            r.assembledQty, r.createdAt, r.updatedAt,
          ].map(csvCell).join(','));
        }
        const body = '﻿' + lines.join('\r\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="bambustock-${new Date().toISOString().slice(0,10)}.csv"`,
        });
        res.end(body);
        return;
      }

      // ── IMPORT CSV ─────────────────────────────────────────────────────
      // Accepte le même format que l'export. Remplace tout le stock du user
      // en une transaction atomique.
      if (req.method === 'POST' && url === '/api/import') {
        const raw = await new Promise((resolve, reject) => {
          let buf = '';
          req.on('data', c => { buf += c; if (buf.length > 50 * 1024 * 1024) { req.destroy(); reject(new Error('Too big')); } });
          req.on('end', () => resolve(buf));
          req.on('error', reject);
        });
        // Parse CSV simple : gère les guillemets et le BOM.
        const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
        const parseCsv = (str) => {
          const rows = [];
          let row = [], cell = '', inQuote = false;
          for (let i = 0; i < str.length; i++) {
            const c = str[i];
            if (inQuote) {
              if (c === '"' && str[i+1] === '"') { cell += '"'; i++; }
              else if (c === '"') { inQuote = false; }
              else { cell += c; }
            } else {
              if (c === '"') { inQuote = true; }
              else if (c === ',') { row.push(cell); cell = ''; }
              else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
              else { cell += c; }
            }
          }
          if (cell.length || row.length) { row.push(cell); rows.push(row); }
          return rows;
        };
        const rows = parseCsv(text).filter(r => r.some(c => c.trim() !== ''));
        if (!rows.length) { json(res, { error: 'CSV vide' }, 400); return; }
        const headers = rows.shift().map(h => h.trim());
        const idx = name => headers.indexOf(name);
        if (idx('name') === -1) { json(res, { error: 'Colonne "name" requise' }, 400); return; }
        const decodeVariants = (s) => (s || '').split(';').filter(Boolean).map(part => {
          const [color = '', colorName = '', qty = 0] = part.split('|');
          return { color, colorName, qty: parseInt(qty, 10) || 0 };
        });
        const decodeParts = (s) => (s || '').split(';').filter(Boolean).map(part => {
          const [name = '', filament = '', count = 1, vsRaw = ''] = part.split('::');
          const variants = vsRaw.split('+').filter(Boolean).map(v => {
            const [color = '', colorName = '', qty = 0] = v.split('|');
            return { color, colorName, qty: parseInt(qty, 10) || 0 };
          });
          return { name, filament, count: parseInt(count, 10) || 1, variants };
        });
        const decodeTags = (s) => (s || '').split(';').map(t => t.trim()).filter(Boolean);
        const items = rows.map(row => {
          const get = name => idx(name) !== -1 ? row[idx(name)] : '';
          return {
            id: get('id') || (Math.random().toString(36).slice(2, 9) + Date.now().toString(36)),
            name: get('name') || 'Sans nom',
            desc: get('desc') || null,
            filament: get('filament') || null,
            category: get('category') || null,
            tags: decodeTags(get('tags')),
            threshold: parseInt(get('threshold'), 10) || 3,
            trackStock: get('trackStock') === '0' || get('trackStock') === 'false' ? 0 : 1,
            photo: get('photo') || null,
            variants: decodeVariants(get('variants')),
            parts: decodeParts(get('parts')),
            assembledQty: parseInt(get('assembledQty'), 10) || 0,
            createdAt: get('createdAt') || new Date().toISOString(),
            updatedAt: get('updatedAt') || new Date().toISOString(),
          };
        });
        const partSumImp = p => Math.floor((p.variants || []).reduce((s, v) => s + (v.qty || 0), 0) / (p.count || 1));
        const importAll = db.transaction(items => {
          db.prepare('DELETE FROM items WHERE user_id=?').run(userId);
          const stmt = db.prepare(`INSERT INTO items
            (id,name,"desc",filament,color,colorName,qty,threshold,photo,category,tags,trackStock,variants,parts,assembledQty,assembledItems,createdAt,updatedAt,user_id)
            VALUES (:id,:name,:desc,:filament,:color,:colorName,:qty,:threshold,:photo,:category,:tags,:trackStock,:variants,:parts,:assembledQty,:assembledItems,:createdAt,:updatedAt,:uid)`);
          for (const b of items) {
            const vJson = JSON.stringify(b.variants);
            const pJson = JSON.stringify(b.parts);
            const qty = b.parts.length ? Math.min(...b.parts.map(partSumImp)) : totalQty(vJson);
            stmt.run({
              id: b.id, name: b.name, desc: b.desc, filament: b.filament,
              color: '', colorName: '',
              qty, threshold: b.threshold, photo: b.photo,
              category: b.category, tags: JSON.stringify(b.tags),
              trackStock: b.trackStock,
              variants: vJson, parts: pJson,
              assembledQty: b.assembledQty, assembledItems: '[]',
              createdAt: b.createdAt, updatedAt: b.updatedAt,
              uid: userId,
            });
          }
        });
        importAll(items);
        json(res, { ok: true, count: items.length });
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
        const tagsArr   = Array.isArray(b.tags) ? b.tags : (typeof b.tags === 'string' ? safeParseJson(b.tags, []) : []);
        const partSum   = p => Math.floor(
          (p.variants || []).reduce((s, v) => s + (v.qty || 0), 0) / (p.count || 1)
        );
        const effectiveQty = partsArr.length > 0
          ? Math.min(...partsArr.map(partSum))
          : totalQty(variantsJson);
        db.prepare(`INSERT INTO items (id,name,"desc",filament,color,colorName,qty,threshold,photo,category,tags,trackStock,variants,parts,assembledQty,assembledItems,createdAt,updatedAt,user_id)
          VALUES (:id,:name,:desc,:filament,:color,:colorName,:qty,:threshold,:photo,:category,:tags,:trackStock,:variants,:parts,:assembledQty,:assembledItems,:createdAt,:updatedAt,:uid)`)
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
            tags: JSON.stringify(tagsArr),
            trackStock: b.trackStock !== false ? 1 : 0,
            variants: variantsJson,
            parts: partsJson,
            assembledQty: b.assembledQty || 0,
            assembledItems: b.assembledItems || null,
            createdAt: now,
            updatedAt: now,
            uid: userId,
          });
        logHistory(b.id, b.name, 'add', { totalQty: totalQty(variantsJson), filament: b.filament }, null, userId);
        json(res, { ok: true });
        return;
      }

      if (req.method === 'PUT' && id && !sub) {
        const b = await parseBody(req);
        // Capture l'état AVANT modif pour permettre l'undo.
        const before = snapshotItem(id);
        if (!before || before.user_id !== userId) { json(res, { error: 'Introuvable' }, 404); return; }
        const variantsJson = typeof b.variants === 'string' ? b.variants : JSON.stringify(b.variants || []);
        const tQty = totalQty(variantsJson);
        const partsArrUpd  = typeof b.parts === 'string' ? JSON.parse(b.parts || '[]') : (b.parts || []);
        const partsJsonUpd = typeof b.parts === 'string' ? b.parts : JSON.stringify(b.parts || []);
        const tagsArrUpd   = Array.isArray(b.tags) ? b.tags : (typeof b.tags === 'string' ? safeParseJson(b.tags, []) : []);
        const partSumUpd   = p => Math.floor((p.variants || []).reduce((s, v) => s + (v.qty || 0), 0) / (p.count || 1));
        const effectiveQtyUpd = partsArrUpd.length > 0
          ? Math.min(...partsArrUpd.map(partSumUpd))
          : tQty;
        const assembledItemsUpd = b.assembledItems !== undefined
          ? (typeof b.assembledItems === 'string' ? b.assembledItems : JSON.stringify(b.assembledItems || []))
          : (before.assembledItems || null);
        db.prepare(`UPDATE items SET name=:name,"desc"=:desc,filament=:filament,color=:color,
          colorName=:colorName,qty=:qty,threshold=:threshold,photo=:photo,
          category=:category,tags=:tags,trackStock=:trackStock,variants=:variants,parts=:parts,
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
            tags: JSON.stringify(tagsArrUpd),
            trackStock: b.trackStock !== false ? 1 : 0,
            variants: variantsJson,
            parts: partsJsonUpd,
            assembledQty: b.assembledQty || 0,
            assembledItems: assembledItemsUpd,
            updatedAt: new Date().toISOString(),
          });
        logHistory(id, b.name || before.name || id, 'update', { totalQty: tQty }, before, userId);
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
        // Snapshot complet avant modif : permet l'undo et nourrit la ligne
        // d'historique (stock avant / delta / stock après).
        const before = snapshotItem(id);
        if (!before || before.user_id !== userId) { json(res, { error: 'Introuvable' }, 404); return; }
        db.prepare('UPDATE items SET variants=:variants, qty=:qty, updatedAt=:updatedAt WHERE id=:id AND user_id=:uid')
          .run({ variants: variantsJson, qty: tQty, updatedAt: new Date().toISOString(), id, uid: userId });
        // On ne log que si la quantité a réellement bougé : un simple
        // renommage de variante ou changement de couleur ne mérite pas une
        // ligne "Stock X → X" dans l'historique.
        if (tQty !== before.qty) {
          logHistory(id, before.name, 'qty',
            { from: before.qty, to: tQty, delta: tQty - before.qty },
            before, userId);
        }
        json(res, { ok: true });
        return;
      }

      if (req.method === 'DELETE' && id && !sub) {
        // Snapshot complet avant suppression pour pouvoir undo le delete.
        const beforeDel = snapshotItem(id);
        if (!beforeDel || beforeDel.user_id !== userId) { json(res, { error: 'Introuvable' }, 404); return; }
        db.prepare('DELETE FROM items WHERE id = :id AND user_id = :uid').run({ id, uid: userId });
        logHistory(id, beforeDel.name, 'delete', null, beforeDel, userId);
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

      // GET/PATCH /api/cost-settings → paramètres calculateur de rentabilité.
      // Stockés en JSON dans users.cost_settings. Valeurs absentes ⇒ defaults
      // côté UI (le client gère le rendu d'un formulaire vide).
      if (req.method === 'GET' && url === '/api/cost-settings') {
        const row = db.prepare('SELECT cost_settings FROM users WHERE id=?').get(userId);
        const cs  = row?.cost_settings ? safeParseJson(row.cost_settings, {}) : {};
        json(res, cs);
        return;
      }
      if (req.method === 'PATCH' && url === '/api/cost-settings') {
        const b = await parseBody(req);
        // On clamp/sanitise pour éviter NaN ou valeurs absurdes en base.
        const num = (v, min = 0, max = 1e6) => {
          const n = Number(v);
          if (!isFinite(n)) return null;
          return Math.max(min, Math.min(max, n));
        };
        const cleanStr = (v, maxLen = 40) =>
          (typeof v === 'string' ? v.trim().slice(0, maxLen) : '');
        // Listes filaments / imprimantes : on garde les entrées valides
        // (nom non vide + valeur numérique sensée). Cap à 50 entrées pour
        // éviter qu'un client malicieux pollue la base.
        const filaments = Array.isArray(b.filaments) ? b.filaments.slice(0, 50)
          .map(f => ({ name: cleanStr(f?.name), pricePerKg: num(f?.pricePerKg, 0, 10000) ?? 0 }))
          .filter(f => f.name) : [];
        const printers = Array.isArray(b.printers) ? b.printers.slice(0, 50)
          .map(p => ({
            name:            cleanStr(p?.name),
            powerW:          num(p?.powerW, 0, 5000) ?? 0,
            wearCostPerHour: num(p?.wearCostPerHour, 0, 100) ?? 0,
          }))
          .filter(p => p.name) : [];
        const clean = {
          electricityRatePerKwh:   num(b.electricityRatePerKwh, 0, 100) ?? 0,
          laborRatePerHour:        num(b.laborRatePerHour, 0, 10000) ?? 0,
          laborEnabled:            b.laborEnabled === true,
          maintenanceCostPerHour:  num(b.maintenanceCostPerHour, 0, 100) ?? 0,
          tvaEnabled:              b.tvaEnabled === true,
          tvaPct:                  num(b.tvaPct, 0, 100) ?? 20,
          targetMarginPct:         num(b.targetMarginPct, 0, 10000) ?? 50,
          currency:                (typeof b.currency === 'string' && b.currency.length <= 5) ? b.currency : 'EUR',
          filaments,
          printers,
        };
        db.prepare('UPDATE users SET cost_settings=? WHERE id=?')
          .run(JSON.stringify(clean), userId);
        json(res, { ok: true, settings: clean });
        return;
      }

      // POST /api/onboarding/complete → marque le wizard d'accueil comme
      // terminé pour ne plus le ré-ouvrir. Appelé soit à la fin du tour,
      // soit quand l'user clique sur "Passer" au début (un opt-out vaut
      // un opt-in : on ne va pas le harceler).
      if (req.method === 'POST' && url === '/api/onboarding/complete') {
        db.prepare('UPDATE users SET onboarding_completed=1 WHERE id=?').run(userId);
        json(res, { ok: true });
        return;
      }

      // GET /api/ref/me → infos influencer du user courant.
      // Renvoie un payload enrichi pour le dashboard partenaire :
      // { isInfluencer, code, link, stats, daily, last, best, recentSignups }.
      // Si l'user n'est pas un influencer, isInfluencer=false et le reste null.
      if (req.method === 'GET' && url === '/api/ref/me') {
        const me = db.prepare('SELECT is_influencer, referral_code FROM users WHERE id=?').get(userId);
        if (!me?.is_influencer || !me.referral_code) {
          json(res, { isInfluencer: false });
          return;
        }
        const c = me.referral_code;
        const visits   = db.prepare('SELECT COUNT(*) AS c FROM referral_visits WHERE code=?').get(c).c;
        const signups  = db.prepare('SELECT COUNT(*) AS c FROM users WHERE referred_by_code=?').get(c).c;
        const visits7  = db.prepare(`SELECT COUNT(*) AS c FROM referral_visits WHERE code=? AND ts > datetime('now','-7 days')`).get(c).c;
        const signups7 = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE referred_by_code=? AND created_at > datetime('now','-7 days')`).get(c).c;
        const lastVisit  = db.prepare('SELECT MAX(ts) AS t FROM referral_visits WHERE code=?').get(c).t;
        const lastSignup = db.prepare('SELECT MAX(created_at) AS t FROM users WHERE referred_by_code=?').get(c).t;
        // Série quotidienne 30j : visites + inscriptions, déjà groupées par
        // jour. Le client merge les deux séries par date pour le graphique.
        const visitsDaily = db.prepare(`
          SELECT DATE(ts) AS day, COUNT(*) AS c
          FROM referral_visits WHERE code=? AND ts > datetime('now','-30 days')
          GROUP BY DATE(ts) ORDER BY day ASC
        `).all(c);
        const signupsDaily = db.prepare(`
          SELECT DATE(created_at) AS day, COUNT(*) AS c
          FROM users WHERE referred_by_code=? AND created_at > datetime('now','-30 days')
          GROUP BY DATE(created_at) ORDER BY day ASC
        `).all(c);
        // Meilleur jour (mesuré en signups, fallback sur visites).
        const bestSignup = db.prepare(`
          SELECT DATE(created_at) AS day, COUNT(*) AS c FROM users
          WHERE referred_by_code=? GROUP BY day ORDER BY c DESC, day DESC LIMIT 1
        `).get(c);
        const bestVisit = db.prepare(`
          SELECT DATE(ts) AS day, COUNT(*) AS c FROM referral_visits
          WHERE code=? GROUP BY day ORDER BY c DESC, day DESC LIMIT 1
        `).get(c);
        const recent = db.prepare(`
          SELECT created_at, plan, email FROM users
          WHERE referred_by_code=? ORDER BY created_at DESC LIMIT 10
        `).all(c);
        // Email masqué : on garde la 1ère lettre + le domaine pour donner
        // une indication tangible au partenaire sans exposer l'identité.
        // Exemple : jean.dupont@gmail.com → j***@gmail.com
        const maskEmail = e => {
          if (!e || typeof e !== 'string') return '';
          const at = e.indexOf('@');
          if (at < 1) return '***';
          return e[0] + '***' + e.slice(at);
        };
        const base = process.env.PUBLIC_URL || 'https://bambustock.com';
        json(res, {
          isInfluencer: true,
          code: c,
          link: base.replace(/\/$/, '') + '/?ref=' + encodeURIComponent(c),
          stats: {
            visits, signups,
            visits_7d: visits7, signups_7d: signups7,
            conversionRate: visits ? signups / visits : 0,
          },
          daily: { visits: visitsDaily, signups: signupsDaily },
          last:  { visit_at: lastVisit, signup_at: lastSignup },
          best:  { signup: bestSignup || null, visit: bestVisit || null },
          recentSignups: recent.map(r => ({
            at: r.created_at,
            plan: r.plan,
            email_masked: maskEmail(r.email),
          })),
        });
        return;
      }

      // GET /api/bambu/printers → liste des imprimantes Bambu liées au
      // compte, avec puissance déduite du modèle (heuristique). Utilisé
      // par le calculateur pour pré-remplir la liste d'imprimantes.
      // Renvoie { configured: bool, printers: [...] }.
      if (req.method === 'GET' && url === '/api/bambu/printers') {
        const u = db.prepare('SELECT bambu_token, bambu_printers FROM users WHERE id=?').get(userId);
        const configured = !!u?.bambu_token;
        const stored = u?.bambu_printers ? safeParseJson(u.bambu_printers, []) : [];
        // Puissance moyenne consommée pendant un print en régime établi
        // (après chauffe initiale du bed + nozzle), en W. Sources :
        // mesures communautaires (r/BambuLab, YouTube Modbot, Maker's Muse)
        // sur des prints PLA de plusieurs heures avec un wattmètre.
        // Ce n'est PAS le pic (1000W+ pendant la chauffe du bed) mais la
        // moyenne horaire utile pour calculer le coût électrique réel.
        // L'user peut ajuster manuellement après.
        // Ordre : du plus spécifique au plus général.
        const inferPowerW = (name = '', model = '') => {
          const s = (name + ' ' + model).toUpperCase();
          if (s.includes('H2D'))                      return 280; // dual extruder, grande chambre
          if (s.includes('A1') && s.includes('MINI')) return 80;
          if (s.includes('A1'))                       return 130;
          if (s.includes('X1E'))                      return 220; // chambre chauffée
          if (s.includes('X1'))                       return 170; // X1, X1C
          if (s.includes('P2S') || s.includes('P2P')) return 160; // gamme P2
          if (s.includes('P1'))                       return 140; // P1P, P1S
          return 140;
        };
        // Coût horaire d'entretien et d'usure (amortissement machine +
        // nozzles + courroies + build plate). Calculé à partir du prix
        // d'achat divisé par ~3000h de durée de vie utile + pièces
        // d'usure régulières. Valeurs indicatives, l'user peut ajuster.
        const inferWearCostPerHour = (name = '', model = '') => {
          const s = (name + ' ' + model).toUpperCase();
          if (s.includes('H2D'))                      return 0.70; // machine premium
          if (s.includes('A1') && s.includes('MINI')) return 0.10;
          if (s.includes('A1'))                       return 0.15;
          if (s.includes('X1E'))                      return 0.55;
          if (s.includes('X1'))                       return 0.40; // X1, X1C
          if (s.includes('P2S') || s.includes('P2P')) return 0.25;
          if (s.includes('P1'))                       return 0.20;
          return 0.20;
        };
        const out = stored.map(p => ({
          name:            p.name || p.serial,
          serial:          p.serial,
          model:           p.model || null,
          powerW:          inferPowerW(p.name, p.model),
          wearCostPerHour: inferWearCostPerHour(p.name, p.model),
        }));
        json(res, { configured, printers: out });
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
                   u.created_at, u.last_login, u.last_seen,
                   u.is_influencer, u.referral_code,
                   (SELECT COUNT(*) FROM items      WHERE user_id=u.id) AS items_count,
                   (SELECT COUNT(*) FROM print_jobs WHERE user_id=u.id) AS prints_count,
                   (SELECT COUNT(*) FROM sessions   WHERE user_id=u.id AND expires_at>datetime('now')) AS active_sessions
            FROM users u ORDER BY u.created_at DESC
          `).all();
          json(res, rows.map(r => ({
            ...r,
            is_admin:        !!r.is_admin,
            is_influencer:   !!r.is_influencer,
            bambu_connected: getBambuStatus(r.id),
          })));
          return;
        }

        // PATCH /api/admin/users/:id { plan?, is_admin?, is_influencer?, referral_code? }
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
          if (typeof b.is_influencer === 'boolean') {
            updates.push('is_influencer=:ii'); params.ii = b.is_influencer ? 1 : 0;
          }
          if (typeof b.referral_code === 'string') {
            // Code court alphanumérique, uppercase, unique. Vide → on retire le code.
            const code = b.referral_code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
            if (code) {
              const taken = db.prepare('SELECT id FROM users WHERE referral_code=? AND id<>?').get(code, targetId);
              if (taken) { json(res, { error: `Code "${code}" déjà utilisé` }, 409); return; }
              updates.push('referral_code=:rc'); params.rc = code;
            } else {
              updates.push('referral_code=NULL');
            }
          }
          if (typeof b.referral_note === 'string') {
            updates.push('referral_note=:rn'); params.rn = b.referral_note.slice(0, 4000);
          }
          if (b.referral_commission_pct !== undefined) {
            const n = Number(b.referral_commission_pct);
            if (!isFinite(n) || n < 0 || n > 100) {
              json(res, { error: 'Commission entre 0 et 100' }, 400); return;
            }
            updates.push('referral_commission_pct=:rcp'); params.rcp = n;
          }
          if (!updates.length) { json(res, { ok: true }); return; }
          params.id = targetId;
          db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id=:id`).run(params);
          json(res, { ok: true });
          return;
        }

        // GET /api/admin/influencers → liste des comptes influencer avec stats
        // enrichies (7j / 30j / total + dernières activités) pour le panel
        // admin dédié. Inclut les partenaires désactivés (is_influencer=0)
        // tant qu'ils ont encore un code, pour pouvoir consulter et
        // réactiver depuis la liste.
        if (req.method === 'GET' && url === '/api/admin/influencers') {
          const rows = db.prepare(`
            SELECT u.id, u.email, u.name, u.referral_code, u.created_at,
              u.is_influencer, u.referral_commission_pct,
              (SELECT COUNT(*) FROM referral_visits v WHERE v.code=u.referral_code)                                          AS visits_total,
              (SELECT COUNT(*) FROM referral_visits v WHERE v.code=u.referral_code AND v.ts > datetime('now','-7 days'))     AS visits_7d,
              (SELECT COUNT(*) FROM referral_visits v WHERE v.code=u.referral_code AND v.ts > datetime('now','-30 days'))    AS visits_30d,
              (SELECT MAX(ts) FROM referral_visits v WHERE v.code=u.referral_code)                                           AS last_visit_at,
              (SELECT COUNT(*) FROM users x WHERE x.referred_by_code=u.referral_code)                                        AS signups_total,
              (SELECT COUNT(*) FROM users x WHERE x.referred_by_code=u.referral_code AND x.created_at > datetime('now','-7 days'))  AS signups_7d,
              (SELECT COUNT(*) FROM users x WHERE x.referred_by_code=u.referral_code AND x.created_at > datetime('now','-30 days')) AS signups_30d,
              (SELECT MAX(created_at) FROM users x WHERE x.referred_by_code=u.referral_code)                                 AS last_signup_at
            FROM users u
            WHERE u.referral_code IS NOT NULL
            ORDER BY u.is_influencer DESC, signups_total DESC, visits_total DESC
          `).all().map(r => ({ ...r, is_influencer: !!r.is_influencer }));
          // Stats globales pour les cartes du haut du panel.
          const totals = {
            partners:       rows.length,
            visits_total:   rows.reduce((s, r) => s + r.visits_total,   0),
            visits_30d:     rows.reduce((s, r) => s + r.visits_30d,     0),
            signups_total:  rows.reduce((s, r) => s + r.signups_total,  0),
            signups_30d:    rows.reduce((s, r) => s + r.signups_30d,    0),
          };
          json(res, { totals, partners: rows });
          return;
        }

        // GET /api/admin/influencers/:userId → détail d'un partenaire :
        // série quotidienne (30j) clics + signups, top referers, liste
        // complète des inscriptions avec statut Bambu, note privée et
        // commission. La même route accepte ?format=csv pour télécharger.
        if (req.method === 'GET' && parts[2] === 'influencers' && parts[3] && !parts[4]) {
          const targetId = parts[3];
          // L'is_influencer=0 reste accessible (vue admin d'un partenaire désactivé)
          // tant qu'il a encore un code, pour pouvoir consulter l'historique.
          const u = db.prepare(`
            SELECT id, email, name, referral_code, created_at, is_influencer,
                   referral_note, referral_commission_pct
            FROM users WHERE id=?`).get(targetId);
          if (!u || !u.referral_code) {
            json(res, { error: 'Partenaire introuvable' }, 404); return;
          }
          const visitsDaily = db.prepare(`
            SELECT DATE(ts) AS day, COUNT(*) AS c
            FROM referral_visits
            WHERE code=? AND ts > datetime('now','-30 days')
            GROUP BY DATE(ts) ORDER BY day ASC
          `).all(u.referral_code);
          const signupsDaily = db.prepare(`
            SELECT DATE(created_at) AS day, COUNT(*) AS c
            FROM users
            WHERE referred_by_code=? AND created_at > datetime('now','-30 days')
            GROUP BY DATE(created_at) ORDER BY day ASC
          `).all(u.referral_code);
          // Top referers (lifetime) + niveau UA agrégé en grandes familles
          // (mobile / desktop / inconnu) pour donner une idée des canaux.
          const topReferers = db.prepare(`
            SELECT COALESCE(referer, '(direct)') AS host, COUNT(*) AS c
            FROM referral_visits WHERE code=?
            GROUP BY COALESCE(referer, '(direct)')
            ORDER BY c DESC LIMIT 10
          `).all(u.referral_code);
          const deviceRows = db.prepare(`
            SELECT user_agent FROM referral_visits WHERE code=?
          `).all(u.referral_code);
          const devices = { mobile: 0, desktop: 0, bot: 0, unknown: 0 };
          for (const r of deviceRows) {
            const ua = (r.user_agent || '').toLowerCase();
            if (!ua)                                            devices.unknown++;
            else if (/bot|crawl|spider|preview/.test(ua))       devices.bot++;
            else if (/mobi|iphone|android|ipad/.test(ua))       devices.mobile++;
            else                                                devices.desktop++;
          }
          // Pour chaque filleul, on récupère aussi le statut Bambu pour
          // donner une indication d'engagement (l'user a-t-il vraiment
          // commencé à utiliser l'app ?).
          const signups = db.prepare(`
            SELECT id, email, name, created_at, plan, last_login, bambu_email
            FROM users WHERE referred_by_code=?
            ORDER BY created_at DESC
          `).all(u.referral_code);
          const signupsOut = signups.map(s => ({
            ...s,
            bambu_connected: getBambuStatus(s.id),
          }));

          const qs = new URLSearchParams((req.url.split('?')[1] || ''));
          if (qs.get('format') === 'csv') {
            const csvHead = 'id,email,name,plan,created_at,last_login,bambu_email,bambu_connected\n';
            const escCsv  = v => v == null ? '' : ('"' + String(v).replace(/"/g, '""') + '"');
            const lines = signupsOut.map(s => [
              s.id, s.email, s.name, s.plan, s.created_at,
              s.last_login, s.bambu_email, s.bambu_connected,
            ].map(escCsv).join(',')).join('\n');
            res.writeHead(200, {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': `attachment; filename="partenaire-${u.referral_code}-conversions.csv"`,
            });
            res.end(csvHead + lines + (lines ? '\n' : ''));
            return;
          }

          json(res, {
            user: {
              id: u.id, email: u.email, name: u.name,
              referral_code: u.referral_code,
              created_at: u.created_at,
              is_influencer: !!u.is_influencer,
              referral_note: u.referral_note || '',
              referral_commission_pct: u.referral_commission_pct || 0,
            },
            visits_daily:  visitsDaily,
            signups_daily: signupsDaily,
            top_referers:  topReferers,
            devices,
            signups: signupsOut,
          });
          return;
        }

        // POST /api/admin/influencers/:userId/regenerate → génère un code
        // aléatoire (8 caractères alphanum) pour le partenaire. L'ancien
        // code reste valable côté tracking historique (les visites
        // déjà comptées sur l'ancien code restent), mais les futurs liens
        // doivent utiliser le nouveau.
        if (req.method === 'POST' && parts[2] === 'influencers' && parts[3] && parts[4] === 'regenerate') {
          const targetId = parts[3];
          const u = db.prepare('SELECT id FROM users WHERE id=?').get(targetId);
          if (!u) { json(res, { error: 'Utilisateur introuvable' }, 404); return; }
          // 8 chars alphanum uppercase, on évite les ambiguïtés visuelles
          // (0/O, 1/I/L) pour que les partenaires puissent le lire facilement.
          const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
          let code = '';
          for (let attempts = 0; attempts < 8; attempts++) {
            code = '';
            for (let i = 0; i < 8; i++) code += ALPHA[Math.floor(Math.random() * ALPHA.length)];
            const taken = db.prepare('SELECT id FROM users WHERE referral_code=? AND id<>?').get(code, targetId);
            if (!taken) break;
            code = '';
          }
          if (!code) { json(res, { error: 'Impossible de générer un code unique' }, 500); return; }
          db.prepare('UPDATE users SET referral_code=?, is_influencer=1 WHERE id=?').run(code, targetId);
          json(res, { ok: true, code });
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
            // "Actifs" = vus récemment (= qui ont ouvert l'app), pas juste
            // qui se sont logués au sens strict. Fallback sur last_login pour
            // les comptes anciens qui n'ont pas encore last_seen.
            active_24h:      c("SELECT COUNT(*) AS c FROM users WHERE COALESCE(last_seen, last_login) > datetime('now','-1 day')"),
            active_7d:       c("SELECT COUNT(*) AS c FROM users WHERE COALESCE(last_seen, last_login) > datetime('now','-7 days')"),
            active_30d:      c("SELECT COUNT(*) AS c FROM users WHERE COALESCE(last_seen, last_login) > datetime('now','-30 days')"),
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
      if (req.method === 'GET' && parts[1] === 'history' && id && !sub) {
        json(res, db.prepare('SELECT * FROM history WHERE item_id = :id AND user_id = :uid ORDER BY ts DESC').all({ id, uid: userId }));
        return;
      }

      // POST /api/history/:histId/undo → restaure le before_state d'une entrée.
      // Couvre update et delete. Pour add, l'undo équivaut à une suppression.
      if (req.method === 'POST' && parts[1] === 'history' && id && sub === 'undo') {
        const histRow = db.prepare('SELECT * FROM history WHERE id = :id AND user_id = :uid').get({ id, uid: userId });
        if (!histRow) { json(res, { error: 'Entrée historique introuvable' }, 404); return; }
        const before = histRow.before_state ? safeParseJson(histRow.before_state, null) : null;

        if (histRow.action === 'add') {
          // Undo d'un add = on supprime l'item s'il existe encore.
          db.prepare('DELETE FROM items WHERE id = :id AND user_id = :uid').run({ id: histRow.item_id, uid: userId });
          logHistory(histRow.item_id, histRow.item_name, 'undo-add', { undoneHistoryId: histRow.id }, null, userId);
          json(res, { ok: true, action: 'deleted' });
          return;
        }

        if (!before) { json(res, { error: 'Pas de snapshot disponible pour cet historique' }, 400); return; }

        if (histRow.action === 'delete') {
          // Undo d'un delete = on ré-insère l'item depuis le snapshot.
          const exists = db.prepare('SELECT id FROM items WHERE id=?').get(before.id);
          if (exists) { json(res, { error: 'Article restauré déjà présent' }, 409); return; }
          db.prepare(`INSERT INTO items (id,name,"desc",filament,color,colorName,qty,threshold,photo,category,tags,trackStock,variants,parts,assembledQty,assembledItems,createdAt,updatedAt,user_id)
            VALUES (:id,:name,:desc,:filament,:color,:colorName,:qty,:threshold,:photo,:category,:tags,:trackStock,:variants,:parts,:assembledQty,:assembledItems,:createdAt,:updatedAt,:uid)`)
            .run({ ...before, uid: userId });
          logHistory(before.id, before.name, 'undo-delete', { undoneHistoryId: histRow.id }, null, userId);
          json(res, { ok: true, action: 'restored' });
          return;
        }

        // Update : on restore l'état d'avant.
        const cur = snapshotItem(histRow.item_id);
        if (!cur || cur.user_id !== userId) { json(res, { error: 'Article introuvable' }, 404); return; }
        db.prepare(`UPDATE items SET name=:name,"desc"=:desc,filament=:filament,color=:color,
          colorName=:colorName,qty=:qty,threshold=:threshold,photo=:photo,
          category=:category,tags=:tags,trackStock=:trackStock,variants=:variants,parts=:parts,
          assembledQty=:assembledQty,assembledItems=:assembledItems,updatedAt=:updatedAt
          WHERE id=:id AND user_id=:uid`)
          .run({ ...before, uid: userId, updatedAt: new Date().toISOString() });
        logHistory(histRow.item_id, before.name, 'undo-update', { undoneHistoryId: histRow.id }, cur, userId);
        json(res, { ok: true, action: 'reverted' });
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
    } else if (u.bambu_refresh_token) {
      // Token expiré mais on a un refresh : on essaie de récupérer un nouveau
      // access token. Si succès → connectBambu est rappelé en interne.
      console.log(`  [Bambu] User ${u.email} : token expiré, tentative de refresh…`);
      refreshBambuTokenForUser(u.id).then(r => {
        if (!r.ok) console.log(`  [Bambu] Refresh échoué pour ${u.email} (${r.reason}) — reconnexion manuelle requise.`);
      });
    } else {
      console.log(`  [Bambu] User ${u.email} : token expiré sans refresh, reconnexion requise.`);
    }
  }
  if (!usersWithToken.length) {
    console.log('  [Bambu] Aucun utilisateur avec token — connecte-toi via l\'interface.');
  }
});
