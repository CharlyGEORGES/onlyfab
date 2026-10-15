# Site d'hommage — Alain Georges

Un site pour se souvenir : photos, texte principal, frise de vie, famille, carte des lieux,
ses musiques, bougies virtuelles, et contributions des proches (textes, photos, messages vocaux)
**validées par la famille avant publication**. Pensé d'abord pour le téléphone : le QR code
imprimé pour la cérémonie mène directement au site.

Le même code tourne sur **Fly.io** (adresse `alain-georges.fly.dev`, recommandé) ou sur
**Cloudflare Workers** (gratuit, adresse `alain-georges.<compte>.workers.dev`).

## Ce que fait le site

**Côté visiteurs** (`/`)
- En-tête plein écran avec grande photo, portrait, nom, dates et lieux ; barre d'actions en bas
  de l'écran sur mobile (Bougie, Souvenir, Photos, Musiques).
- Citation, texte principal (paragraphes, `**gras**`, `*italique*`).
- Informations pratiques (cérémonie, remerciements, lien de cagnotte), masquées automatiquement après une date.
- Frise de vie : étapes datées avec texte, lieu et photo.
- Galerie photo avec visionneuse (flèches, clavier, balayage).
- Souvenirs : textes, photos et enregistrements audio publiés.
- **Ses musiques** : les morceaux qu'il aimait, avec un lecteur discret en bas d'écran
  (jamais de lecture automatique, commandes sur l'écran verrouillé du téléphone).
- Bougies : « Allumer une bougie » avec son prénom, compteur et liste.
- Famille, groupée (Enfants, Petits-enfants…), avec photo.
- Carte des lieux de sa vie (étapes de la frise avec coordonnées).
- Formulaire « Partager un souvenir » : texte, photo (réduite dans le navigateur), fichier audio,
  ou **message vocal enregistré au micro**. Tout part en attente de validation.
- Bandeau automatique le jour de son anniversaire et à la date anniversaire du décès.
- « Imprimer le livre de souvenirs » (mise en page d'impression / PDF), « Partager ce site ».
- Code d'accès facultatif pour réserver le site aux proches.
- Thème clair / sombre selon l'appareil, couleur d'accent réglable.

**Côté famille** (`/admin`, mot de passe ; plusieurs mots de passe possibles)
- **À valider** : chaque contribution avec son texte modifiable, Publier / Refuser / Supprimer.
- **Photos & souvenirs** : photos par lot, souvenirs signés par la famille, titres, dates, lieux, ordre.
- **Frise de vie**, **Famille**, **Musiques** (MP3, M4A, OGG, avec titre, artiste, et pourquoi ce morceau).
- **QR code** : génération, téléchargement PNG et impression du code à poser le jour de la cérémonie.
- **Textes & réglages** : identité, photos d'en-tête, textes, informations pratiques, code d'accès, rubriques.
- Notification par courriel à chaque contribution (facultatif, via Resend, 100 courriels/jour gratuits).

## Mise en ligne sur Fly.io (recommandé)

Prérequis : l'outil `fly` (https://fly.io/docs/flyctl/install/) et un compte Fly.io.
Coût : une petite machine qui s'endort entre deux visites et un volume de 1 Go,
soit de l'ordre de 1 à 2 € par mois (la machine est facturée uniquement quand elle tourne).

```bash
cd memorial
fly launch --copy-config --no-deploy --name alain-georges --region cdg
fly volumes create memorial_data --size 1 --region cdg --yes
fly secrets set ADMIN_PASSWORD='motdepasse1,motdepasse2' SESSION_SECRET="$(openssl rand -hex 32)"
fly deploy
```

Le site est alors sur `https://alain-georges.fly.dev`, l'espace famille sur `/admin`.
Commencez par « Textes & réglages », puis ajoutez les photos et les musiques.
Pour redéployer après une modification du code : `fly deploy`.

Notifications par courriel (facultatif) : créer une clé sur https://resend.com puis
`fly secrets set RESEND_API_KEY=re_xxx NOTIFY_EMAIL=vous@exemple.fr`.

Sauvegarde : tout est dans le volume (`/data/memorial.db` et `/data/media/`).
`fly ssh console -C "tar czf - /data" > sauvegarde.tgz` en fait une copie complète.

### Nom de domaine personnalisé (facultatif)

- `alain-georges.fly.dev` est fourni, sans frais.
- Un sous-domaine d'un domaine que vous possédez déjà (`alain.g2i365.com`, `alain.onlyfab.fr`) ne coûte rien :
  `fly certs add alain.g2i365.com`, puis ajouter chez votre registrar l'enregistrement CNAME indiqué.
- Un domaine neuf (`alain-georges.fr`) coûte 7 à 12 € par an, même procédure.

## Mise en ligne sur Cloudflare (alternative entièrement gratuite)

```bash
cd memorial
npm install
npx wrangler login
npm run cf:setup      # crée la base D1 et l'espace KV, demande le mot de passe, déploie
```

Limites de l'offre gratuite : 1 Go pour les photos et musiques (environ 3 000 photos réduites,
fichiers de 20 Mo au plus), 100 000 requêtes par jour. Sauvegarde de la base :
`npx wrangler d1 export alain-georges --remote --output sauvegarde.sql`.

## Au quotidien

- Les contributions en attente apparaissent dans l'onglet « À valider » (pastille rouge) et, pour vous
  quand vous êtes connecté, dans un bandeau en haut du site public.
- Vous pouvez corriger une faute dans le texte d'un visiteur avant de publier.
- « Refuser » conserve la contribution sans la publier ; « Supprimer » efface aussi le fichier.
- Les photos sont réduites à 1800 px avant envoi (environ 300 Ko chacune).
- Musiques : utilisez des fichiers que vous avez le droit de diffuser (achats, rips de CD familiaux) ;
  les plateformes de streaming ne permettent pas d'intégrer leurs morceaux dans un site.

## Développement local

```bash
npm run dev            # http://localhost:3000, mot de passe « changez-moi », données dans ./data
```

## Organisation du code

- `src/worker.js` : toute la logique (API, contributions, modération, réglages, médias, cookies signés,
  anti-abus). Écrite pour Cloudflare Workers, elle attend `env.DB` (base) et `env.MEDIA` (fichiers).
- `server.js` : serveur Node pour Fly.io, qui fournit ces deux objets avec SQLite (`node:sqlite`)
  et le disque, et sert les fichiers statiques. `Dockerfile` et `fly.toml` : déploiement Fly.
- `schema.sql` : tables `settings`, `media`, `posts` (photos, souvenirs, audios, musiques, bougies),
  `events`, `family`.
- `public/index.html` + `app.js` : site public. `public/admin.html` + `admin.js` : espace famille.
  `shared.js` : utilitaires communs. `style.css` : styles, mobile et impression.
- `wrangler.toml`, `scripts/setup.mjs` : déploiement Cloudflare.
- Secrets (jamais dans le code) : `ADMIN_PASSWORD`, `SESSION_SECRET`, et pour les notifications
  `RESEND_API_KEY` + `NOTIFY_EMAIL`.
