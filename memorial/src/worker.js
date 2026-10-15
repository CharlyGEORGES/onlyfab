// Site mémorial — API, médias, espace d'administration.
// Tourne tel quel sur Cloudflare Workers (D1 + KV) ou sur Fly.io / Node via server.js,
// qui fournit les mêmes objets env.DB (base) et env.MEDIA (fichiers).
// Les pages (public/*.html) sont servies comme fichiers statiques ; seules les routes
// /api/* et /media/* arrivent ici.

const ADMIN_COOKIE = 'mem_admin';
const ACCESS_COOKIE = 'mem_access';
const SESSION_DAYS = 30;
const DEFAULT_MAX_UPLOAD_MB = 20; // limite KV : 25 Mo par valeur ; réglable via la variable MAX_UPLOAD_MB

const PUBLIC_SETTINGS = [
  'name', 'subtitle', 'birth_date', 'death_date', 'birth_place', 'death_place',
  'main_text', 'intro_quote', 'hero_media', 'portrait_media', 'ceremony', 'ceremony_until',
  'donation_url', 'donation_label', 'show_family', 'show_map', 'show_candles',
  'contributions_open', 'has_access_code', 'accent',
];

const DEFAULT_SETTINGS = {
  name: 'Alain Georges',
  subtitle: '',
  birth_date: '',
  death_date: '',
  birth_place: '',
  death_place: '',
  intro_quote: '',
  main_text: '',
  hero_media: '',
  portrait_media: '',
  ceremony: '',
  ceremony_until: '',
  donation_url: '',
  donation_label: '',
  access_code: '',
  show_family: '1',
  show_map: '1',
  show_candles: '1',
  contributions_open: '1',
  accent: '#8a6d3b',
};

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error(err && err.stack || err);
      return json({ error: 'Erreur interne : ' + (err && err.message || err) }, 500);
    }
  },
};

// ---------------------------------------------------------------- routage

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  // Adresse principale (CANONICAL_HOST, ex. alain-georges.com) : les autres noms
  // (alain-georges.fly.dev, www.) y renvoient, une fois le domaine et son certificat actifs.
  const canonical = (env.CANONICAL_HOST || '').trim().toLowerCase();
  if (canonical && url.hostname !== canonical && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) {
    return Response.redirect(`https://${canonical}${url.pathname}${url.search}`, 301);
  }

  if (path.startsWith('/media/')) return serveMedia(request, env, url);

  if (!path.startsWith('/api/')) return new Response('Introuvable', { status: 404 });

  // --- espace public
  if (path === '/api/site' && method === 'GET') return getSite(request, env);
  if (path === '/api/access' && method === 'POST') return postAccess(request, env);
  if (path === '/api/contribute' && method === 'POST') return postContribute(request, env, ctx);
  if (path === '/api/candle' && method === 'POST') return postCandle(request, env);

  // --- administration
  if (path === '/api/admin/login' && method === 'POST') return adminLogin(request, env);
  if (path === '/api/admin/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(ADMIN_COOKIE) });
  }
  const admin = await isAdmin(request, env);
  if (path === '/api/admin/me' && method === 'GET') return json({ admin });
  if (!admin) return json({ error: 'Connexion requise' }, 401);

  let m;
  if (path === '/api/admin/overview' && method === 'GET') return adminOverview(env);
  if (path === '/api/admin/settings' && method === 'GET') return json(await getSettings(env));
  if (path === '/api/admin/settings' && method === 'PUT') return putSettings(request, env);
  if (path === '/api/admin/media' && method === 'POST') return adminUploadMedia(request, env);
  if ((m = path.match(/^\/api\/admin\/media\/([\w-]+)$/)) && method === 'DELETE') {
    await deleteMedia(env, m[1]);
    return json({ ok: true });
  }
  if (path === '/api/admin/posts' && method === 'GET') return adminListPosts(url, env);
  if (path === '/api/admin/posts' && method === 'POST') return adminCreatePost(request, env);
  if ((m = path.match(/^\/api\/admin\/posts\/([\w-]+)$/))) {
    if (method === 'PATCH') return adminUpdatePost(request, env, m[1]);
    if (method === 'DELETE') return adminDeletePost(env, m[1]);
  }
  if (path === '/api/admin/events' && method === 'POST') return upsertRow(request, env, 'events', null);
  if ((m = path.match(/^\/api\/admin\/events\/([\w-]+)$/))) {
    if (method === 'PATCH') return upsertRow(request, env, 'events', m[1]);
    if (method === 'DELETE') return deleteRow(env, 'events', m[1]);
  }
  if (path === '/api/admin/family' && method === 'POST') return upsertRow(request, env, 'family', null);
  if ((m = path.match(/^\/api\/admin\/family\/([\w-]+)$/))) {
    if (method === 'PATCH') return upsertRow(request, env, 'family', m[1]);
    if (method === 'DELETE') return deleteRow(env, 'family', m[1]);
  }
  if (path === '/api/admin/reorder' && method === 'POST') return reorder(request, env);

  return json({ error: 'Route inconnue' }, 404);
}

// ---------------------------------------------------------------- public

async function getSite(request, env) {
  const settings = await getSettings(env);
  const admin = await isAdmin(request, env);
  const locked = !!settings.access_code && !admin && !(await hasAccess(request, env, settings));
  const pub = publicSettings(settings);
  if (locked) return json({ locked: true, settings: { name: pub.name, subtitle: pub.subtitle, birth_date: pub.birth_date, death_date: pub.death_date } }, 200);

  const [posts, candles, events, family, pending] = await Promise.all([
    env.DB.prepare(
      `SELECT p.id, p.kind, p.source, p.author, p.title, p.body, p.media_id, p.taken_at, p.place, p.sort, p.created_at,
              m.mime, m.width, m.height, m.has_thumb
         FROM posts p LEFT JOIN media m ON m.id = p.media_id
        WHERE p.status = 'approved' AND p.kind != 'candle'
        ORDER BY p.sort ASC, p.created_at DESC`).all(),
    env.DB.prepare(
      `SELECT author, created_at FROM posts WHERE kind = 'candle' AND status = 'approved'
        ORDER BY created_at DESC LIMIT 60`).all(),
    env.DB.prepare(
      `SELECT e.*, m.has_thumb FROM events e LEFT JOIN media m ON m.id = e.media_id
        ORDER BY e.date ASC, e.sort ASC`).all(),
    env.DB.prepare(`SELECT * FROM family ORDER BY sort ASC, name ASC`).all(),
    admin ? env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE status = 'pending'`).first() : null,
  ]);
  const candleCount = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE kind = 'candle' AND status = 'approved'`).first()).n;

  return json({
    locked: false,
    admin,
    pending: pending ? pending.n : 0,
    settings: pub,
    posts: posts.results,
    candles: { count: candleCount, recent: candles.results },
    events: events.results,
    family: family.results,
  }, 200, { 'Cache-Control': 'no-store' });
}

async function postAccess(request, env) {
  const body = await readJson(request);
  const settings = await getSettings(env);
  if (!settings.access_code) return json({ ok: true });
  const ip = clientIp(request);
  if (!(await rateLimit(env, 'access:' + ip, 15, 15 * 60))) return json({ error: 'Trop de tentatives, réessayez dans quelques minutes.' }, 429);
  if (!safeEqual(norm(body.code), norm(settings.access_code))) return json({ error: 'Code incorrect' }, 403);
  const token = await sign(env, 'access:' + settings.access_code, 365);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(ACCESS_COOKIE, token, 365) });
}

async function postContribute(request, env, ctx) {
  const settings = await getSettings(env);
  if (settings.contributions_open !== '1') return json({ error: 'Les contributions sont fermées.' }, 403);
  if (settings.access_code && !(await isAdmin(request, env)) && !(await hasAccess(request, env, settings))) {
    return json({ error: 'Accès réservé' }, 403);
  }
  const ip = clientIp(request);
  if (!(await rateLimit(env, 'contrib:' + ip, 12, 60 * 60))) return json({ error: 'Trop de contributions envoyées, réessayez plus tard.' }, 429);

  const form = await request.formData();
  if (form.get('website')) return json({ ok: true }); // pot de miel anti-robots
  const author = clip(form.get('author'), 80);
  const email = clip(form.get('email'), 120);
  const title = clip(form.get('title'), 120);
  const text = clip(form.get('body'), 5000);
  const taken_at = clip(form.get('taken_at'), 40);
  const place = clip(form.get('place'), 120);
  const file = form.get('file');
  const thumb = form.get('thumb');

  if (!author) return json({ error: 'Indiquez votre nom.' }, 400);
  const hasFile = file && typeof file !== 'string' && file.size > 0;
  if (!text && !hasFile) return json({ error: 'Écrivez un souvenir ou ajoutez une photo ou un enregistrement.' }, 400);

  let media = null;
  if (hasFile) media = await storeMedia(env, file, thumb);
  const kind = media ? (media.kind === 'audio' ? 'audio' : 'photo') : 'memory';
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO posts (id, kind, source, status, author, email, title, body, media_id, taken_at, place)
     VALUES (?, ?, 'public', 'pending', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, kind, author, email || null, title || null, text || null, media ? media.id : null, taken_at || null, place || null).run();

  ctx.waitUntil(notify(env, settings, { author, kind, text, title }));
  return json({ ok: true, id });
}

async function postCandle(request, env) {
  const settings = await getSettings(env);
  if (settings.show_candles !== '1') return json({ error: 'Désactivé' }, 403);
  if (settings.access_code && !(await isAdmin(request, env)) && !(await hasAccess(request, env, settings))) {
    return json({ error: 'Accès réservé' }, 403);
  }
  const ip = clientIp(request);
  if (!(await rateLimit(env, 'candle:' + ip, 5, 24 * 60 * 60))) return json({ error: 'Vous avez déjà allumé plusieurs bougies aujourd\'hui.' }, 429);
  const body = await readJson(request);
  const author = clip(body.author, 60) || 'Anonyme';
  await env.DB.prepare(`INSERT INTO posts (id, kind, source, status, author) VALUES (?, 'candle', 'public', 'approved', ?)`)
    .bind(uid(), author).run();
  const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE kind = 'candle' AND status = 'approved'`).first()).n;
  return json({ ok: true, count: n });
}

// ---------------------------------------------------------------- médias

async function serveMedia(request, env, url) {
  const id = url.pathname.slice('/media/'.length).replace(/[^\w-]/g, '');
  if (!id) return new Response('Introuvable', { status: 404 });
  const settings = await getSettings(env);
  if (settings.access_code && !(await isAdmin(request, env)) && !(await hasAccess(request, env, settings))) {
    return new Response('Accès réservé', { status: 403 });
  }
  const wantThumb = url.searchParams.has('thumb');
  let key = (wantThumb ? 't:' : 'm:') + id;
  let obj = await env.MEDIA.getWithMetadata(key, { type: 'stream' });
  if (!obj.value && wantThumb) obj = await env.MEDIA.getWithMetadata('m:' + id, { type: 'stream' });
  if (!obj.value) return new Response('Introuvable', { status: 404 });
  const mime = (obj.metadata && obj.metadata.mime) || 'application/octet-stream';
  return new Response(obj.value, {
    headers: {
      'Content-Type': mime,
      'Cache-Control': settings.access_code ? 'private, max-age=3600' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function storeMedia(env, file, thumb) {
  const maxMb = Number(env.MAX_UPLOAD_MB) || DEFAULT_MAX_UPLOAD_MB;
  if (file.size > maxMb * 1024 * 1024) throw new HttpError(413, `Fichier trop volumineux (${maxMb} Mo maximum).`);
  const mime = (file.type || '').toLowerCase();
  let kind;
  if (/^image\/(jpeg|png|webp|gif|heic|heif)$/.test(mime)) kind = 'image';
  else if (/^audio\/|^video\/(webm|mp4)$/.test(mime)) kind = 'audio';
  else throw new HttpError(415, 'Format non pris en charge (photo JPEG/PNG/WebP ou enregistrement audio).');

  const id = uid();
  const buf = await file.arrayBuffer();
  await env.MEDIA.put('m:' + id, buf, { metadata: { mime } });
  let hasThumb = 0;
  if (thumb && typeof thumb !== 'string' && thumb.size > 0 && thumb.size < 2 * 1024 * 1024) {
    await env.MEDIA.put('t:' + id, await thumb.arrayBuffer(), { metadata: { mime: thumb.type || 'image/jpeg' } });
    hasThumb = 1;
  }
  await env.DB.prepare(`INSERT INTO media (id, kind, mime, size, has_thumb) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, kind, mime, file.size, hasThumb).run();
  return { id, kind, mime, has_thumb: hasThumb };
}

async function deleteMedia(env, id) {
  if (!id) return;
  await Promise.all([env.MEDIA.delete('m:' + id), env.MEDIA.delete('t:' + id)]);
  await env.DB.prepare(`DELETE FROM media WHERE id = ?`).bind(id).run();
}

// ---------------------------------------------------------------- administration

async function adminLogin(request, env) {
  const ip = clientIp(request);
  if (!(await rateLimit(env, 'login:' + ip, 10, 15 * 60))) return json({ error: 'Trop de tentatives, réessayez dans 15 minutes.' }, 429);
  const body = await readJson(request);
  const given = String(body.password || '');
  const allowed = String(env.ADMIN_PASSWORD || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.length) return json({ error: 'ADMIN_PASSWORD n\'est pas configuré sur le serveur.' }, 500);
  if (!allowed.some(p => safeEqual(p, given))) return json({ error: 'Mot de passe incorrect' }, 403);
  const token = await sign(env, 'admin', SESSION_DAYS);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(ADMIN_COOKIE, token, SESSION_DAYS) });
}

async function isAdmin(request, env) {
  const tok = cookies(request)[ADMIN_COOKIE];
  return !!tok && (await verify(env, 'admin', tok));
}

async function hasAccess(request, env, settings) {
  const tok = cookies(request)[ACCESS_COOKIE];
  return !!tok && (await verify(env, 'access:' + settings.access_code, tok));
}

async function adminOverview(env) {
  const counts = await env.DB.prepare(
    `SELECT status, kind, COUNT(*) AS n FROM posts GROUP BY status, kind`).all();
  const media = await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM media`).first();
  return json({ counts: counts.results, media });
}

async function putSettings(request, env) {
  const body = await readJson(request);
  const stmts = [];
  for (const [k, v] of Object.entries(body)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmts.push(env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(k, String(v == null ? '' : v)));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json(await getSettings(env));
}

async function adminUploadMedia(request, env) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) return json({ error: 'Aucun fichier' }, 400);
  try {
    return json(await storeMedia(env, file, form.get('thumb')));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    throw e;
  }
}

async function adminListPosts(url, env) {
  const status = url.searchParams.get('status') || 'pending';
  const where = status === 'all' ? '1=1' : 'p.status = ?';
  const q = env.DB.prepare(
    `SELECT p.*, m.mime, m.has_thumb FROM posts p LEFT JOIN media m ON m.id = p.media_id
      WHERE ${where} ORDER BY p.created_at DESC LIMIT 500`);
  const rows = status === 'all' ? await q.all() : await q.bind(status).all();
  return json(rows.results);
}

async function adminCreatePost(request, env) {
  const form = await request.formData();
  const file = form.get('file');
  let media = null;
  if (file && typeof file !== 'string' && file.size) {
    try { media = await storeMedia(env, file, form.get('thumb')); }
    catch (e) { if (e instanceof HttpError) return json({ error: e.message }, e.status); throw e; }
  }
  const media_id = media ? media.id : (clip(form.get('media_id'), 40) || null);
  let kind = clip(form.get('kind'), 20) || (media ? (media.kind === 'audio' ? 'audio' : 'photo') : 'memory');
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO posts (id, kind, source, status, author, title, body, media_id, taken_at, place, sort, reviewed_at)
     VALUES (?, ?, 'admin', 'approved', ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
    .bind(id, kind, clip(form.get('author'), 80) || null, clip(form.get('title'), 120) || null,
      clip(form.get('body'), 20000) || null, media_id, clip(form.get('taken_at'), 40) || null,
      clip(form.get('place'), 120) || null, Number(form.get('sort') || 0)).run();
  return json({ ok: true, id, media });
}

async function adminUpdatePost(request, env, id) {
  const body = await readJson(request);
  const fields = ['status', 'author', 'title', 'body', 'taken_at', 'place', 'sort', 'kind'];
  const sets = [], vals = [];
  for (const f of fields) {
    if (!(f in body)) continue;
    let v = body[f];
    if (f === 'status' && !['pending', 'approved', 'rejected'].includes(v)) return json({ error: 'Statut invalide' }, 400);
    if (f === 'kind' && !['photo', 'memory', 'audio', 'candle', 'music'].includes(v)) return json({ error: 'Type invalide' }, 400);
    if (f === 'sort') v = Number(v) || 0;
    else if (v != null) v = String(v);
    sets.push(`${f} = ?`); vals.push(v);
  }
  if ('status' in body) sets.push(`reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
  if (!sets.length) return json({ error: 'Rien à modifier' }, 400);
  vals.push(id);
  await env.DB.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return json(await env.DB.prepare(`SELECT * FROM posts WHERE id = ?`).bind(id).first());
}

async function adminDeletePost(env, id) {
  const row = await env.DB.prepare(`SELECT media_id FROM posts WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: 'Introuvable' }, 404);
  await env.DB.prepare(`DELETE FROM posts WHERE id = ?`).bind(id).run();
  if (row.media_id) {
    const still = await env.DB.prepare(
      `SELECT 1 FROM posts WHERE media_id = ? UNION SELECT 1 FROM events WHERE media_id = ? UNION SELECT 1 FROM family WHERE media_id = ? LIMIT 1`)
      .bind(row.media_id, row.media_id, row.media_id).first();
    if (!still) await deleteMedia(env, row.media_id);
  }
  return json({ ok: true });
}

const ROW_FIELDS = {
  events: { date: 40, title: 160, body: 5000, media_id: 40, place: 160, lat: 'num', lng: 'num', sort: 'int' },
  family: { name: 120, relation: 80, grp: 80, media_id: 40, sort: 'int' },
};

async function upsertRow(request, env, table, id) {
  const body = await readJson(request);
  const spec = ROW_FIELDS[table];
  const row = {};
  for (const [f, rule] of Object.entries(spec)) {
    if (!(f in body)) continue;
    const v = body[f];
    if (rule === 'num') row[f] = v === '' || v == null ? null : Number(v);
    else if (rule === 'int') row[f] = Number(v) || 0;
    else row[f] = clip(v, rule) || null;
  }
  if (table === 'events' && !id && (!row.date || !row.title)) return json({ error: 'Date et titre obligatoires' }, 400);
  if (table === 'family' && !id && (!row.name || !row.relation)) return json({ error: 'Nom et lien obligatoires' }, 400);
  if (!id) {
    id = uid();
    const cols = ['id', ...Object.keys(row)];
    await env.DB.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .bind(id, ...Object.values(row)).run();
  } else if (Object.keys(row).length) {
    await env.DB.prepare(`UPDATE ${table} SET ${Object.keys(row).map(k => k + ' = ?').join(', ')} WHERE id = ?`)
      .bind(...Object.values(row), id).run();
  }
  return json(await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first());
}

async function deleteRow(env, table, id) {
  const row = await env.DB.prepare(`SELECT media_id FROM ${table} WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: 'Introuvable' }, 404);
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
  if (row.media_id) {
    const still = await env.DB.prepare(
      `SELECT 1 FROM posts WHERE media_id = ? UNION SELECT 1 FROM events WHERE media_id = ? UNION SELECT 1 FROM family WHERE media_id = ? LIMIT 1`)
      .bind(row.media_id, row.media_id, row.media_id).first();
    if (!still) await deleteMedia(env, row.media_id);
  }
  return json({ ok: true });
}

async function reorder(request, env) {
  const body = await readJson(request);
  const table = ['posts', 'events', 'family'].includes(body.table) ? body.table : null;
  if (!table || !Array.isArray(body.ids)) return json({ error: 'Paramètres invalides' }, 400);
  const stmts = body.ids.slice(0, 2000).map((id, i) =>
    env.DB.prepare(`UPDATE ${table} SET sort = ? WHERE id = ?`).bind(i, String(id)));
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
}

// ---------------------------------------------------------------- notification courriel (facultatif, via Resend)

async function notify(env, settings, { author, kind, text, title }) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return;
  const kindLabel = { photo: 'une photo', memory: 'un souvenir', audio: 'un enregistrement' }[kind] || 'une contribution';
  const site = env.SITE_NAME || settings.name;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${site} <onboarding@resend.dev>`,
        to: [env.NOTIFY_EMAIL],
        subject: `${author} a proposé ${kindLabel} — à valider`,
        text: `${author} a proposé ${kindLabel} sur le site « ${site} ».\n\n${title ? title + '\n\n' : ''}${text || '(sans texte)'}\n\nValider ou refuser : ouvrez la page /admin du site.`,
      }),
    });
  } catch (e) {
    console.error('notification impossible', e);
  }
}

// ---------------------------------------------------------------- réglages

async function getSettings(env) {
  const rows = await env.DB.prepare(`SELECT key, value FROM settings`).all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows.results) if (r.key in DEFAULT_SETTINGS) s[r.key] = r.value;
  return s;
}

function publicSettings(s) {
  const out = {};
  for (const k of PUBLIC_SETTINGS) if (k in s) out[k] = s[k];
  out.has_access_code = s.access_code ? '1' : '0';
  return out;
}

// ---------------------------------------------------------------- anti-abus

async function rateLimit(env, key, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`SELECT count, reset FROM ratelimit WHERE key = ?`).bind(key).first();
  if (!row || row.reset <= now) {
    await env.DB.prepare(`INSERT INTO ratelimit (key, count, reset) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, reset = excluded.reset`)
      .bind(key, now + windowSec).run();
    return true;
  }
  if (row.count >= max) return false;
  await env.DB.prepare(`UPDATE ratelimit SET count = count + 1 WHERE key = ?`).bind(key).run();
  return true;
}

// ---------------------------------------------------------------- jetons signés (HMAC-SHA256)

async function hmacKey(env) {
  const secret = env.SESSION_SECRET || env.ADMIN_PASSWORD;
  if (!secret) throw new Error('SESSION_SECRET manquant');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(env, scope, days) {
  const exp = Date.now() + days * 86400000;
  const payload = `${scope}|${exp}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(payload));
  return `${exp}.${b64url(sig)}`;
}

async function verify(env, scope, token) {
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const payload = `${scope}|${exp}`;
  const expected = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(payload));
  return safeEqual(b64url(expected), sig);
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------------------------------------------------------------- utilitaires

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

async function readJson(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}

function cookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, days) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${days * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('Fly-Client-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() || '0.0.0.0';
}

function uid() {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

function clip(v, max) {
  if (v == null || typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function norm(s) {
  return String(s || '').trim().toLowerCase();
}
