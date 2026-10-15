# Site d'hommage — Alain Georges

Un site pour se souvenir : photos, texte principal, frise de vie, famille, carte des lieux,
bougies virtuelles, et contributions des proches (textes, photos, messages vocaux) **validées
par la famille avant publication**.

Hébergement, base de données et stockage des photos sont entièrement sur l'offre gratuite de
Cloudflare (Workers + D1 + KV), sans carte bancaire. Seul un nom de domaine personnalisé peut
coûter quelque chose, et il est facultatif.

## Ce que fait le site

**Côté visiteurs** (`/`)
- En-tête avec grande photo, portrait, nom, dates et lieux.
- Citation, texte principal (mise en forme simple : paragraphes, `**gras**`, `*italique*`).
- Informations pratiques (cérémonie, remerciements, lien de cagnotte), masquées automatiquement après une date.
- Frise de vie : étapes datées avec texte, lieu et photo.
- Galerie photo avec visionneuse (clavier, flèches).
- Souvenirs : textes, photos et enregistrements audio publiés.
- Bougies : « Allumer une bougie » avec son prénom, compteur et liste.
- Famille, groupée (Enfants, Petits-enfants…), avec photo.
- Carte des lieux de sa vie (étapes de la frise avec coordonnées).
- Formulaire « Partager un souvenir » : texte, photo (redimensionnée dans le navigateur), fichier audio,
  ou **message vocal enregistré au micro**. Tout part en attente de validation.
- Bandeau automatique le jour de son anniversaire et à la date anniversaire du décès.
- « Imprimer le livre de souvenirs » (mise en page d'impression / PDF), « Partager ce site ».
- Code d'accès facultatif pour réserver le site aux proches.
- Thème clair / sombre selon le réglage de l'appareil, couleur d'accent réglable.

**Côté famille** (`/admin`, protégé par mot de passe, plusieurs mots de passe possibles)
- **À valider** : chaque contribution avec son texte modifiable, Publier / Refuser / Supprimer.
- **Photos & souvenirs** : ajout de photos par lot, souvenirs signés par la famille, titres, dates, lieux, ordre d'affichage.
- **Frise de vie** et **Famille** : ajout, modification, suppression, photo.
- **Textes & réglages** : identité, photos d'en-tête, textes, informations pratiques, code d'accès, rubriques affichées.
- Notification par courriel à chaque contribution (facultatif, via Resend, 100 courriels/jour gratuits).

## Mise en ligne (une fois, 10 minutes)

Prérequis : Node.js 18+, un compte Cloudflare gratuit (https://dash.cloudflare.com/sign-up).

```bash
cd memorial
npm install
npx wrangler login        # ouvre le navigateur pour autoriser l'outil
npm run setup             # crée la base, l'espace de stockage, demande le mot de passe, déploie
```

Le script affiche l'adresse du site, de la forme `https://alain-georges.<votre-compte>.workers.dev`.
L'espace famille est sur `/admin`. Commencez par « Textes & réglages ».

Pour redéployer après une modification du code : `npm run deploy`.

## Adresse du site

| Option | Coût | Exemple |
|---|---|---|
| Adresse Cloudflare fournie | 0 € | `alain-georges.charly.workers.dev` |
| Sous-domaine d'un domaine que vous possédez déjà | 0 € | `alain.g2i365.com`, `alain.onlyfab.fr` |
| Nouveau domaine | 7 à 12 € par an | `alain-georges.fr`, `alaingeorges.fr` |

Pour un domaine ou un sous-domaine : Cloudflare → Workers & Pages → `alain-georges` → Settings →
Domains & Routes → Add → Custom domain. Le domaine (ou sa zone DNS) doit être géré chez Cloudflare,
ce qui est gratuit : on y transfère juste les DNS, pas le domaine lui-même.

## Au quotidien

- Les contributions en attente apparaissent dans l'onglet « À valider » (pastille rouge) et, pour vous
  quand vous êtes connecté, dans un bandeau en haut du site public.
- Vous pouvez corriger une faute dans le texte d'un visiteur avant de publier.
- « Refuser » conserve la contribution sans la publier ; « Supprimer » efface aussi le fichier.
- Photos : le navigateur les réduit à 1800 px avant envoi (environ 300 Ko chacune), ce qui laisse
  de la place pour plusieurs milliers de photos dans l'espace gratuit.

## Limites de l'offre gratuite et sauvegardes

- Stockage des photos et audios (KV) : 1 Go, soit environ 3 000 photos réduites. Les messages vocaux
  sont limités à 5 minutes, les fichiers à 20 Mo.
- Base de données (D1) : 5 Go, largement suffisant.
- Trafic : 100 000 requêtes par jour, soit plusieurs milliers de visites quotidiennes.
- Sauvegarde de la base : `npx wrangler d1 export alain-georges --remote --output sauvegarde.sql`.
- Les fichiers sont dans l'espace KV `MEDIA` (listables avec `npx wrangler kv key list --binding MEDIA --remote`).

## Développement local

```bash
cp .dev.vars.example .dev.vars   # mot de passe local
npm run db:init                   # base locale
npm run dev                       # http://localhost:8788
```

## Organisation du code

- `src/worker.js` : API (contributions, modération, réglages, médias), cookies signés, anti-abus.
- `schema.sql` : tables `settings`, `media`, `posts`, `events`, `family`.
- `public/index.html` + `app.js` : site public. `public/admin.html` + `admin.js` : espace famille.
  `shared.js` : utilitaires communs (redimensionnement des photos, appels API). `style.css` : styles et impression.
- `scripts/setup.mjs` : installation automatisée sur Cloudflare.
- Secrets (jamais dans le code) : `ADMIN_PASSWORD`, `SESSION_SECRET`, et pour les notifications
  `RESEND_API_KEY` + `NOTIFY_EMAIL` (`npx wrangler secret put NOM`).
