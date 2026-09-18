# Onlyfab — App Shopify : configurateur 3D + panier natif

Ce dossier contient l'**app Shopify** qui embarque le configurateur 3D de dragons
sur la page produit de la boutique et branche le **panier natif Shopify**
(`/cart/add.js`). Aucun backend OAuth n'est nécessaire : le paiement, la caisse et
la commande sont 100 % gérés par Shopify.

```
shopify/
├─ shopify.app.toml                        # config app (une seule extension de thème)
└─ extensions/dragon-configurator/
   ├─ shopify.extension.toml               # extension type "theme"
   ├─ blocks/configurator.liquid           # bloc à poser sur la page produit
   ├─ assets/onlyfab-configurator.js       # pont iframe ⇆ panier Shopify
   ├─ assets/onlyfab-configurator.css
   └─ locales/{fr,en.default}.json
```

Le configurateur lui-même est le fichier autonome `../configurateur.html`
(source dans `../configurator/`, build via `python3 ../configurator/build.py`).

---

## 1. Architecture

```
Page produit Shopify
 └─ Bloc "Configurateur Dragon" (Liquid)
     ├─ <iframe src="…/configurateur.html?embed=1&model=baby&origin=…">
     │     → le configurateur tourne en "mode embarqué" :
     │       pas de panier interne, il envoie sa config au parent (postMessage)
     └─ onlyfab-configurator.js (pont)
           • reçoit "ready"  → renvoie les tailles dispo + la devise
           • reçoit "price"  → trouve la variante et renvoie son prix réel
           • reçoit "add"    → POST /cart/add.js (variante + propriétés de ligne)
```

**Ce qui porte le prix = les variantes Shopify.** Le panier natif ne peut facturer
que le prix d'une variante. On discrétise donc en axes de variante :

| Axe        | Rôle                         | Exemple de valeurs              |
|------------|------------------------------|---------------------------------|
| `Taille`   | prix volumétrique            | `6 cm`, `9 cm`, `12 cm`, `15 cm`, `18 cm` |
| `Finition` | supplément premium           | `Standard`, `Premium`           |
| `Gravure`  | supplément gravure           | `Sans`, `Avec`                  |

**Ce qui ne porte PAS le prix = propriétés de ligne** (gratuit, affiché sur la
commande) : couleurs par zone, texte de gravure, modèle, et la **fiche de
production** complète en propriété cachée `_spec` (JSON).

Le prix affiché *dans* le configurateur est le prix **réel de la variante**
(renvoyé par le pont) : ce qui est montré = ce qui est facturé.

---

## 2. Héberger le configurateur

Le bloc charge le configurateur par URL. Le serveur Node du projet
(`../server.js`) sert déjà le fichier avec le bon en-tête d'embarquement :

```
GET /configurateur.html   →   Content-Security-Policy: frame-ancestors <boutique>
```

Domaines autorisés à l'embarquer : réglés par la variable d'env
`CONFIGURATOR_FRAME_ANCESTORS` (défaut : `'self' https://onlyfab.fr
https://www.onlyfab.fr https://*.myshopify.com`).

→ URL à mettre dans le bloc : `https://www.onlyfab.fr/configurateur.html`
(ou l'URL du serveur d'app si le storefront et l'app sont sur des domaines
différents — l'embarquement inter-domaine fonctionne, le postMessage est géré).

Pour régénérer `configurateur.html` après une modif du configurateur :

```bash
cd configurator
python3 build.py        # réinjecte three.js + GLBs + le source → ../configurateur.html
```

---

## 3. Créer le produit et ses variantes

Pour chaque modèle de dragon, créer **un produit** avec les 3 options ci-dessus
(ou seulement `Taille` si pas de premium/gravure). Nombre de variantes =
tailles × 2 × 2 (ex. 5 × 2 × 2 = 20, largement sous la limite de 100 du plan Basic).

**Prix de chaque variante** (formule volumétrique, identique à l'atelier) :

```
prix_taille = base × (taille_cm / refCm) ^ exposant
prix_variante = prix_taille + (Premium ? supplément_premium : 0)
                            + (Avec  ? frais_gravure       : 0)
```

Exemple avec `base = 5 €`, `refCm = 10`, `exposant = 2`,
`premium = +3 €`, `gravure = +5 €` :

| Taille | Standard/Sans | Premium/Sans | Standard/Avec | Premium/Avec |
|-------:|--------------:|-------------:|--------------:|-------------:|
| 6 cm   | 1,80 €        | 4,80 €       | 6,80 €        | 9,80 €       |
| 9 cm   | 4,05 €        | 7,05 €       | 9,05 €        | 12,05 €      |
| 12 cm  | 7,20 €        | 10,20 €      | 12,20 €       | 15,20 €      |
| 15 cm  | 11,25 €       | 14,25 €      | 16,25 €       | 19,25 €      |
| 18 cm  | 16,20 €       | 19,20 €      | 21,20 €       | 24,20 €      |

> Les **noms exacts** des options et des valeurs `Premium` / `Avec` sont
> configurables dans les réglages du bloc (voir §5). Les valeurs de `Taille`
> doivent contenir le nombre de cm (`"12 cm"`, `"12"`, `"12cm"` — le pont lit le
> nombre). Le curseur de taille du configurateur est automatiquement limité aux
> tailles qui existent en variante.

Astuce : mettre en stock (ou activer « continuer la vente si rupture ») toutes
les variantes vendables. Le pont refuse une variante indisponible et le signale
au client.

---

## 4. Déployer l'extension

Prérequis : [Shopify CLI](https://shopify.dev/docs/apps/tools/cli), Node ≥ 18,
un compte Partner, un accès admin à la boutique.

```bash
cd shopify
shopify app dev        # 1re fois : crée l'app, remplit client_id, ouvre un tunnel de dev
# … tester dans l'éditeur de thème …
shopify app deploy     # publie l'extension de thème (version figée)
```

`shopify app dev` sert l'extension à chaud : on peut l'ajouter et la tester dans
l'éditeur de thème avant tout déploiement.

---

## 5. Ajouter et régler le bloc dans le thème

1. Éditeur de thème → page **Produit** → **Ajouter un bloc** → section *Apps* →
   **Configurateur Dragon**.
2. Réglages du bloc :
   - **URL du configurateur** : `https://www.onlyfab.fr/configurateur.html`
   - **Modèle de dragon** : `baby`, `rose`, `or`, `petit` (selon le produit)
   - **Hauteur** : ~760 px
   - **Correspondance des variantes** : noms des options (`Taille`, `Finition`,
     `Gravure`) et valeurs premium/gravure, s'ils diffèrent des défauts.
   - **Après l'ajout au panier** : tiroir panier / redirection `/cart` / rester.
3. Masquer le sélecteur de variantes natif du thème sur ces produits si besoin
   (le configurateur pilote la variante). Le bouton d'achat natif peut être laissé
   caché : l'ajout se fait depuis le configurateur.

---

## 6. Sur la commande

Chaque ligne de commande porte :

- **Propriétés visibles** : `Variante`, chaque zone → couleur/finition,
  `Gravure`, `Taille`, `Modèle 3D`.
- **Propriétés techniques** (préfixe `_`, cachées du client) :
  - `_spec` : fiche de production JSON (zones → couleur/filament/hex, taille mm,
    gravure + rotation) — directement exploitable en atelier / OrcaSlicer.
  - `_delai_jours` : fourchette de délai estimée.

---

## 7. Natif vs à faire côté Shopify

| Élément                                   | État                              |
|-------------------------------------------|-----------------------------------|
| Ajout au panier, caisse, paiement, commande | ✅ natif Shopify (`/cart/add.js`) |
| Prix facturé = prix affiché               | ✅ variante = source de vérité    |
| Fiche de production sur la commande       | ✅ propriété de ligne `_spec`     |
| Couleurs / texte de gravure sans surcoût  | ✅ propriétés de ligne            |
| Création auto des produits/variantes      | ⛏️ manuelle (ou script MCP admin) |
| Persistance atelier ⇆ Shopify (metafields) | ⛏️ non couvert (app admin séparée) |
| Hébergement de nouveaux modèles GLB       | ⛏️ via le serveur (`configurator/`)|

Le prix, le stock et la disponibilité restent gérés dans Shopify. Le configurateur
n'invente aucun prix : il montre celui de la variante sélectionnée.

---

## 8. Production Live (suivi d'impression pour le client)

Le client suit la fabrication de sa commande **en direct depuis son compte
Shopify** (progression, couche, temps restant, étape). v1 = statut/progression
(pas de caméra vidéo — voir plus bas).

### Flux

```
Imprimante Bambu (H2D…) ──MQTT cloud──▶ serveur Onlyfab (Fly)
   report en continu → état live en mémoire (par imprimante)

Compte client Shopify (connecté)
   page "Suivi de production" (bloc live-tracker)
      └─ fetch /apps/onlyfab/live?email=…            (relatif, sur la boutique)
           └─ Shopify App Proxy : signe + ajoute logged_in_customer_id
                └─ serveur Onlyfab /proxy/live : vérifie la signature,
                   ne renvoie que les impressions de CE client (progression only)
```

### Côté serveur (déjà en place sur cette branche)

- `bambu.js` remonte l'état d'impression en continu (`onReport`) — plus seulement
  la fin d'impression.
- Table `live_prints` : association commande ↔ imprimante.
- Endpoint public **signé** `GET /proxy/live` (+ `?order=`) : vérifie la
  signature App Proxy (`SHOPIFY_APP_SECRET`), exige un client connecté, et ne
  renvoie que les impressions dont l'email/`customer_gid` correspond.
- API atelier (session requise) :
  - `GET  /api/live-prints` — liste les associations actives + leur live.
  - `POST /api/live-prints` — `{order_number, printer_serial, customer_email, label, shop}`.
  - `PATCH/DELETE /api/live-prints/:id` — clôture (`done`) / annule (`cancelled`).

### À configurer

1. **Secret app** sur Fly : `flyctl secrets set SHOPIFY_APP_SECRET=<client secret de l'app>`
   (indispensable : sans lui, `/proxy/live` répond `503 proxy-not-configured`).
2. **App Proxy** : déjà déclaré dans `shopify.app.toml` (`/apps/onlyfab` →
   `https://onlyfab.fly.dev/proxy`). Ajuster l'URL si le domaine du serveur diffère,
   puis `shopify app deploy`.
3. **Page client** : créer une page (ex. « Suivi de production »), y ajouter le bloc
   **Suivi de production**, et la lier depuis le compte client / l'email de commande.
   Le bloc est réservé au client connecté (sinon il invite à se connecter).

### Associer une commande à une imprimante

Quand l'atelier lance l'impression d'une commande, il crée l'association
(`POST /api/live-prints` avec le n° de commande, l'email client et le serial de
l'imprimante). Le client voit alors le live sur son compte.

> ⛏️ **À faire** : l'écran atelier (dans `index.html`) pour créer/clôturer ces
> associations en un clic n'est pas encore branché — l'API est prête, l'UI reste
> à ajouter. Automatisation possible ensuite via un webhook `orders/create` Shopify.

### Caméra vidéo (phase 2, non incluse)

La caméra de la H2D n'est pas un flux public. Un flux vidéo public nécessiterait
un **agent tournant à l'atelier** (sur le réseau de l'imprimante) qui capte la
caméra et la relaie (WebRTC/HLS). La page client est conçue pour l'accueillir plus
tard sans refonte.
