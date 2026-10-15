-- Schéma de la base D1 du site mémorial. Appliqué par `npm run db:init` (local) et
-- `npm run db:init:remote` (Cloudflare). Idempotent.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Fichiers (photos, audio) : le contenu est dans KV sous la clé m:<id>, la vignette sous t:<id>.
CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,            -- image | audio
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  width      INTEGER,
  height     INTEGER,
  has_thumb  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Publications : photos de la galerie, souvenirs écrits, enregistrements, bougies.
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,           -- photo | memory | audio | candle
  source      TEXT NOT NULL,           -- admin | public
  status      TEXT NOT NULL,           -- pending | approved | rejected
  author      TEXT,
  email       TEXT,
  title       TEXT,
  body        TEXT,
  media_id    TEXT REFERENCES media(id),
  taken_at    TEXT,                    -- date ou année de la photo / du souvenir
  place       TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS posts_status ON posts(status, kind, created_at);

-- Frise de vie : une étape par ligne (date, titre, texte, photo, lieu, coordonnées).
CREATE TABLE IF NOT EXISTS events (
  id        TEXT PRIMARY KEY,
  date      TEXT NOT NULL,             -- AAAA ou AAAA-MM ou AAAA-MM-JJ
  title     TEXT NOT NULL,
  body      TEXT,
  media_id  TEXT REFERENCES media(id),
  place     TEXT,
  lat       REAL,
  lng       REAL,
  sort      INTEGER NOT NULL DEFAULT 0
);

-- Proches : famille affichée sur le site.
CREATE TABLE IF NOT EXISTS family (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  relation  TEXT NOT NULL,             -- Épouse, Fils, Petite-fille…
  grp       TEXT NOT NULL DEFAULT 'Famille',
  media_id  TEXT REFERENCES media(id),
  sort      INTEGER NOT NULL DEFAULT 0
);

-- Journal des connexions et contributions (anti-abus léger).
CREATE TABLE IF NOT EXISTS ratelimit (
  key   TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset INTEGER NOT NULL
);
