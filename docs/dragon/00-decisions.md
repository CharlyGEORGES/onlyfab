# Onlyfab Dragon Configurator + Production Live : décisions à trancher

> Proposition v1, septembre 2026. Rien n'est implémenté au-delà du spike (étape 1).
> Chaque section se termine par une recommandation ferme. À valider ou amender avant tout code.

## 0. État des lieux (ce qui change le brief)

Deux faits vérifiés le 5 septembre 2026 :

1. **Le site Onlyfab existe déjà et tourne sur Shopify** : www.onlyfab.fr, plan Basic, devise EUR, 3 commandes passées (#1001 à #1003), une quinzaine de produits dont « Dragon Cristal phosphorescent » (39,90 €, brouillon, type produit « Dragon »). Le produit « Boîte à billes » encode déjà les options payantes (gravure, couleur) en variantes Shopify.
2. **Ce dépôt (`onlyfab`) héberge BambuStock**, le SaaS de gestion de stock pour makers : Node 20 HTTP natif, SQLite, SPA vanilla, déploiement Fly.io sur push `master`. Il contient déjà une intégration MQTT Bambu (cloud) dans `bambu.js` et une file « impressions à valider » multi-tenant.

Conséquence : la question « repartir de zéro ou s'intégrer » se pose entre **Shopify** (le site) et **BambuStock** (le code maker existant), pas entre un site inexistant et une page blanche.

## 1. Front et backend : s'appuyer sur Shopify, construire une app Shopify dès le jour 1

### Recommandation

Le « front public » n'est pas un site à construire. C'est la boutique Shopify actuelle, enrichie par **une app Shopify custom** (privée pour Onlyfab d'abord, publiable sur l'App Store ensuite). L'app fournit :

| Bloc du brief | Réalisation Shopify | Pourquoi |
| --- | --- | --- |
| Configurateur 3D | **App block (theme app extension)** injecté sur la page produit Dragon | Reste dans le thème, hérite du panier, checkout et paiement Shopify. Zéro tunnel d'achat à coder. |
| Prix en direct | Calcul côté client à partir des **variantes** (options payantes) + options gratuites en **line item properties** | Le prix affiché est exactement celui que Shopify facturera. Voir contrainte ci-dessous. |
| Espace client : historique | **Comptes clients Shopify** natifs | Déjà en place, rien à coder. |
| Espace client : statut, live, time-lapse | **Page App Proxy** `/apps/atelier/commande/<token>` rendue par notre backend, dans le thème | Les Customer Account UI Extensions n'autorisent pas de balise `<video>` ni de player HLS : l'app proxy est la seule voie propre pour la vidéo. Lien envoyé dans la notification « commande confirmée » et affiché sur la page de commande. |
| Backend commandes | Webhooks `orders/create`, `orders/paid`, `fulfillments/create` vers notre backend | Shopify reste la source de vérité commande/client. Notre base ne stocke que la production. |
| SaaS multi-clients | C'est le modèle natif d'une app Shopify : un `shop` = un tenant | Le brief « app Shopify pour makers » est atteint sans réécriture. |

**Contrainte à accepter** : Shopify ne permet pas de fixer un prix libre à la ligne de panier. Toute option qui change le prix (modèle, gravure oui/non, taille) doit être une **variante** ou un **produit additionnel** ajouté au panier. Les couleurs par zone, sans impact prix, passent en line item properties (texte libre, visible sur la commande et dans le backoffice). Les Cart Transform Functions avec ajustement de prix ne sont pas disponibles sur le plan Basic. Onlyfab fait déjà exactement ça sur les boîtes à billes, donc pas de rupture.

### Stack technique

- **App Shopify** : template officiel Shopify CLI, soit **React Router 7 (ex Remix) + Node 20 + TypeScript + Prisma + Polaris** pour l'admin embarqué. Suivre le template évite de réinventer OAuth, sessions, webhooks HMAC, App Bridge, et garde le chemin App Store ouvert.
- **Backend production** : mêmes process Node (routes React Router `/api/*` et `/apps/*`), ou service Fastify séparé si la charge vidéo l'exige plus tard. Un seul déploiement au départ.
- **Configurateur (theme app extension)** : TypeScript vanilla + Three.js, bundlé en un fichier ESM. Pas de React côté storefront : le thème n'en a pas et le poids compte.
- **Hébergement** : Fly.io région CDG, comme BambuStock. Coût attendu 5 à 10 €/mois.
- **Langage commun** : Node/TypeScript partout, bridge compris. Une seule stack à maintenir pour une équipe d'une personne.

### Rejeté

- Site Next.js/Nuxt from scratch avec Stripe : refaire checkout, comptes, emails, TVA, déjà fournis par Shopify, et s'éloigner de la cible SaaS Shopify.
- Greffer le configurateur dans BambuStock : `server.js` fait 200 Ko en un fichier, pas d'OAuth Shopify, pas de TypeScript. BambuStock reste un produit distinct. Le bridge pourra lui être proposé plus tard comme brique commune.

## 2. Rendu 3D : Three.js + glTF/GLB

### Recommandation

- **Moteur** : Three.js (release courante), OrbitControls pour rotation/zoom, GLTFLoader + DRACOLoader. Bibliothèque mature, sans framework imposé, embarquable dans un app block.
- **Format** : **GLB compressé Draco**, un fichier par modèle de dragon, cible < 3 Mo. Dans le GLB, **un mesh par zone colorable**, nommé `zone:<id>` (`zone:corps`, `zone:ailes`, `zone:yeux`). À l'exécution, chaque zone reçoit un `MeshStandardMaterial` dont la couleur vient du catalogue tenant (nom, hex, référence filament). Les autres meshes gardent leur matériau.
- **Gravure** : en v1, texte dessiné sur un `CanvasTexture` appliqué à un mesh `zone:gravure` (plaque ou socle). Pas de géométrie générée : rendu instantané et suffisant pour l'aperçu. Gravure réelle côté slicer par vous, à partir de la line item property.
- **Pipeline d'assets** : le 3MF imprimable (dragon articulé, millions de triangles) ne se charge pas dans un navigateur. Passage par Blender : import, pose statique, décimation à 100 à 200 k triangles, découpe et nommage des zones, export GLB Draco. Ce travail manuel par modèle est le vrai coût de l'étape 5.
- **Hébergement des GLB** : bucket R2 (voir section 3) derrière le domaine de l'app, cache long. Les assets d'une theme app extension sont plafonnés en taille, les modèles ne doivent pas y être.

### Rejeté

- `<model-viewer>` : plus simple, mais le contrôle par zone et le décal texte passent par une API de scene graph limitée. Reste un plan B si Three.js coûte trop cher en temps.
- Babylon.js : plus lourd, aucun avantage ici.
- Spline / services SaaS 3D : dépendance externe et coût récurrent pour un rendu de 5 modèles.

## 3. Hébergement du flux HLS et du stockage vidéo

### Recommandation : live depuis l'atelier via tunnel, time-lapses sur R2

**Live**
- Sur la machine atelier, **MediaMTX** (ex rtsp-simple-server) ingère le RTSPS de la H2D et publie en HLS (et WebRTC en bonus). Une seule connexion vers l'imprimante quel que soit le nombre de spectateurs, ce qui règle la limite de connexions RTSPS simultanées. Remux, pas de transcodage : charge CPU négligeable, plusieurs imprimantes sur un Pi 5.
- Exposition via **Cloudflare Tunnel** (gratuit, pas d'ouverture de port, TLS géré). Cloudflare met en cache les segments HLS, donc la bande passante montante de l'atelier ne grandit pas avec le nombre de spectateurs.
- **Autorisation** : le backend signe un token court (lié à la commande et au flux) ; MediaMTX le vérifie par son hook d'auth HTTP externe. Un client ne voit que le flux de sa propre impression.
- **Overlay sur le live** : en **HTML/CSS par-dessus le player**, pas incrusté dans la vidéo. Incruster obligerait à ré-encoder en continu, ce qui contredit la contrainte « remux ». Le rendu visuel (logo, prénom, numéro de commande) est identique pour le client.
- ffmpeg reste dans la boucle uniquement comme plan B si MediaMTX pose problème avec le RTSPS Bambu (à trancher pendant le spike).

**Time-lapses**
- Le bridge récupère le fichier par FTP en fin d'impression, **incruste l'overlay avec ffmpeg** (logo + prénom + numéro, template unique du tenant) : un fichier de 30 à 90 s, ré-encodé une fois, 1 à 3 min sur Pi 5.
- Upload vers **Cloudflare R2** via URL présignée fournie par le backend. R2 : compatible S3, 10 Go gratuits puis ~0,015 $/Go/mois, **zéro frais de sortie**, ce qui compte pour de la vidéo téléchargée.
- Livraison au client par URL présignée courte depuis la page App Proxy.

**Machine atelier** : Raspberry Pi 5 8 Go + SSD, Docker Compose avec trois conteneurs : `mediamtx`, `cloudflared`, `bridge` (Node). Redémarrage automatique, journaux centralisés vers le backend.

### Rejeté

- Pousser le live en HLS vers R2 depuis l'atelier : simple et sans tunnel, mais 15 à 30 s de latence et une écriture continue en stockage. À garder si la connexion de l'atelier s'avère trop faible.
- Services vidéo managés (Mux, Cloudflare Stream Live) : 10 à 50 €/mois par flux permanent, injustifié pour un flux privé à 1 ou 2 spectateurs.

## 4. Base de données et modèle de données

### Recommandation : PostgreSQL + Prisma, Shopify source de vérité commande

- **PostgreSQL** dès le départ (Neon, offre gratuite, ou Fly Postgres). Un SaaS multi-tenant avec webhooks concurrents, sessions Shopify et médias sort du confort SQLite mono-fichier. Prisma est ce que le template Shopify utilise pour ses sessions.
- Notre base ne duplique pas la commande Shopify. Elle stocke **ce que Shopify ne sait pas** : la production.

Modèle (tables principales) :

| Table | Rôle | Champs clés |
| --- | --- | --- |
| `Shop` | Tenant | `shopifyDomain`, token offline, `config` JSON (identité visuelle, template overlay, pattern de nommage des jobs, catalogue des couleurs) |
| `Printer` | Imprimante d'un tenant | `serial`, `name`, `model`, `bridgeId`, `streamPath` |
| `Bridge` | Instance atelier | `apiKeyHash`, `lastSeenAt`, version |
| `Order` | Miroir minimal d'une commande Shopify | `shopifyOrderId`, `orderNumber` (1004), `customerFirstName`, `customerEmail`, `accessToken` (lien client), `productionStatus` |
| `OrderItem` | Ligne à produire | `shopifyLineItemId`, `variantId`, `config` JSON (couleurs par zone, gravure), `quantity`, `jobKey` (`1004-1`) |
| `PrintJob` | Impression vue par le bridge | `printerId`, `jobName`, `state`, `progressPct`, `layer`, `startedAt`, `finishedAt`, `orderItemId` nullable, `mappingSource` (`auto`, `manual`, `none`) |
| `Media` | Fichiers vidéo | `orderItemId`, `printJobId`, `kind` (`timelapse_raw`, `timelapse_final`), `storageKey`, `durationSec`, `status` |

**Statuts de production** (champ `productionStatus` de `Order`, dérivé des `PrintJob`) : `received` → `queued` → `printing` → `printed` → `shipped` (posé par le webhook fulfillment). Un seul enum, affiché tel quel dans l'espace client.

**Mapping job → commande (étape 2)** : convention de nommage du fichier envoyé à l'imprimante : `<numéro de commande>-<index de ligne> <libellé libre>`, exemple `1004-1 dragon rouge.3mf`. La H2D remonte ce nom dans `subtask_name` via MQTT. Le backend applique le pattern du tenant (par défaut `^(\d{4,})-(\d+)\b`) et rattache le job à `OrderItem.jobKey`. Si aucun match : le job reste `none` et apparaît dans une file « à rattacher » de l'admin, sur le modèle de la file « à valider » de BambuStock. Un job déjà rattaché n'est jamais réassigné automatiquement.

**Configuration tenant** : un seul fichier `config/<shop>.json` en développement, la même structure en base (`Shop.config`) en production. Aucune valeur Onlyfab dans le code : logo, couleurs, template d'overlay, catalogue dragons et grille de prix, credentials imprimantes, tout passe par là. Test de non-régression : le même build doit démarrer avec un `config/demo.json` fictif.

## 5. Le site existe : intégration, pas repartir de zéro

Réponse tranchée par le constat de la section 0 : **on s'intègre à la boutique Shopify existante**. Le configurateur remplace le sélecteur de variantes standard sur la page produit Dragon ; le reste du site ne bouge pas.

Point à trancher avec vous : **où vit le code**. Recommandation : **un nouveau dépôt** `onlyfab-app` (monorepo : `apps/shopify-app`, `apps/bridge`, `packages/shared`, `config/`). Ce dépôt garde sa CI de déploiement BambuStock intacte ; seul le présent dossier `docs/dragon/` et le spike y sont ajoutés. Alternative acceptable : un dossier `apps/` ici, à condition de ne pas toucher au Dockerfile ni au workflow existants.

## 6. Points spécifiques H2D à vérifier pendant le spike

- **Mode développeur** : depuis les firmwares 2025 (contrôle d'autorisation Bambu), l'accès MQTT local et FTP par un tiers exige d'activer « Developer Mode » dans les réglages LAN, en plus de « LAN Only Liveview » pour la caméra. À confirmer sur l'écran de la H2D ; c'est le premier blocage possible.
- **URL RTSPS** : le rapport MQTT contient un champ `ipcam.rtsp_url` qui donne l'URL exacte. Le spike l'affiche pour valider le format `rtsps://bblp:<code>@<ip>:322/streaming/live/1`.
- **Time-lapse** : l'option doit être cochée dans Bambu Studio pour chaque impression, sinon aucun fichier. Vérifier aussi le format produit par la H2D (mp4 attendu) et l'emplacement FTP (`/timelapse`).
- **Connexions simultanées RTSPS** : mesurer à 1, 2 et 3 clients ffplay. Si la limite est 1, MediaMTX devient obligatoire, pas optionnel.
- **Redémarrer l'imprimante** après activation des options et après chaque mise à jour firmware.

## 7. Ordre proposé après validation

1. Spike bridge (script livré dans `spike/bridge-h2d/`, à lancer dans l'atelier).
2. Squelette app Shopify + webhooks + modèle Prisma + mapping job/commande.
3. Bridge v1 (MQTT local → API backend) + page App Proxy « ma commande » brute.
4. MediaMTX + tunnel + overlay time-lapse + R2.
5. Configurateur Three.js + pipeline Blender des modèles.

## 8. Ce qu'il faut de vous pour démarrer

- Validation ou amendements des sections 1 à 5, en particulier : app Shopify (oui/non), nouveau dépôt (oui/non), Postgres Neon ou Fly.
- Accès Partner Shopify pour créer l'app custom sur la boutique Onlyfab.
- Résultat du spike : IP, serial, access code restent dans l'atelier ; seul le compte rendu (ce qui marche, ce qui bloque) est nécessaire.
- Fichiers sources des dragons (3MF ou STL) et liste des zones colorables souhaitées par modèle.
