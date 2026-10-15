// Serveur Node pour Fly.io (ou toute machine) : exécute le même code que le worker
// Cloudflare en lui fournissant une base SQLite (node:sqlite) et un stockage de
// fichiers sur disque, à la place de D1 et KV.
//
//   DATA_DIR        dossier persistant (volume Fly) : base + médias. Défaut : ./data
//   PORT            port d'écoute. Défaut : 3000
//   ADMIN_PASSWORD  mot(s) de passe de l'espace famille (séparés par des virgules)
//   SESSION_SECRET  chaîne aléatoire longue
//   RESEND_API_KEY, NOTIFY_EMAIL, SITE_NAME, MAX_UPLOAD_MB : facultatifs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import worker from './src/worker.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ------------------------------------------------------------------ base (interface D1)
const db = new DatabaseSync(path.join(DATA_DIR, 'memorial.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

class Statement {
  constructor(sql, params = []) { this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.sql, params); }
  async all() { return { results: db.prepare(this.sql).all(...this.params), success: true }; }
  async first() { return db.prepare(this.sql).get(...this.params) ?? null; }
  async run() { const r = db.prepare(this.sql).run(...this.params); return { success: true, meta: { changes: r.changes } }; }
}
const DB = {
  prepare: sql => new Statement(sql),
  async batch(stmts) {
    db.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  },
};

// ------------------------------------------------------------------ fichiers (interface KV)
const safeKey = key => String(key).replace(/[^\w.-]/g, '_');
const MEDIA = {
  async put(key, value, { metadata } = {}) {
    const file = path.join(MEDIA_DIR, safeKey(key));
    await fs.promises.writeFile(file, Buffer.from(value));
    await fs.promises.writeFile(file + '.json', JSON.stringify(metadata || {}));
  },
  async getWithMetadata(key) {
    const file = path.join(MEDIA_DIR, safeKey(key));
    if (!fs.existsSync(file)) return { value: null, metadata: null };
    let metadata = null;
    try { metadata = JSON.parse(await fs.promises.readFile(file + '.json', 'utf8')); } catch { /* sans métadonnées */ }
    return { value: Readable.toWeb(fs.createReadStream(file)), metadata, size: fs.statSync(file).size };
  },
  async delete(key) {
    const file = path.join(MEDIA_DIR, safeKey(key));
    await Promise.all([fs.promises.rm(file, { force: true }), fs.promises.rm(file + '.json', { force: true })]);
  },
};

const env = { DB, MEDIA, ...process.env };
if (!env.ADMIN_PASSWORD) console.warn('ATTENTION : ADMIN_PASSWORD n\'est pas défini, l\'espace famille sera inaccessible.');

// ------------------------------------------------------------------ fichiers statiques
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };

function staticFile(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p.endsWith('.html')) return { redirect: p.slice(0, -5) || '/' };
  if (p === '/') p = '/index.html';
  else if (!path.extname(p)) p += '.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { file, type: MIME[path.extname(file)] || 'application/octet-stream' };
}

// ------------------------------------------------------------------ serveur HTTP
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  try {
    if (!url.startsWith('/api/') && !url.startsWith('/media/')) {
      const st = staticFile(url);
      if (!st) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
      if (st.redirect) { res.writeHead(307, { Location: st.redirect }); return res.end(); }
      res.writeHead(200, { 'Content-Type': st.type, 'Cache-Control': st.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600' });
      return fs.createReadStream(st.file).pipe(res);
    }
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || 'localhost';
    const request = new Request(`${proto}://${host}${url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req),
      duplex: 'half',
    });
    const pending = [];
    const response = await worker.fetch(request, env, { waitUntil: p => pending.push(Promise.resolve(p).catch(e => console.error(e))) });
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = k === 'set-cookie' ? response.headers.getSetCookie() : v; });
    res.writeHead(response.status, headers);
    if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Erreur interne');
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Site d'hommage en écoute sur http://0.0.0.0:${PORT} (données : ${DATA_DIR})`));
