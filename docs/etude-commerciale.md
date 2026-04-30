# Étude commerciale — BambuStock

> Document de travail · Avril 2026
> Produit : BambuStock — SaaS de gestion de stock pour makers Bambu Lab
> Site : https://bambustock.com

---

## 1. Synthèse exécutive

BambuStock est un logiciel en ligne (SaaS) qui aide les utilisateurs d'imprimantes 3D Bambu Lab à gérer leur stock de pièces, leurs filaments et l'historique de leurs impressions. La proposition de valeur tient en une phrase :

> « Tout ce que tu imprimes, tout ce que tu as en stock, dans un seul tableau de bord — connecté en direct à ton imprimante Bambu. »

Nous nous adressons à un segment **niche, en croissance rapide et solvable** : les makers, micro-ateliers de fabrication numérique et petites entreprises qui produisent à la demande sur des Bambu Lab (X1, P1, A1, H2D). Ce sont des utilisateurs déjà habitués à payer des outils numériques (Fusion 360, Etsy, Shopify, OrcaSlicer Cloud) et qui rencontrent un problème opérationnel concret : **savoir ce qui est en stock, ce qui doit être réimprimé, et combien chaque production a coûté en filament.**

Le marché Bambu Lab seul représentait environ **600 000 imprimantes vendues fin 2024**, avec une projection conservatrice de **1,2 à 1,5 million d'utilisateurs actifs fin 2026**. Notre marché adressable utile (SAM) se situe autour de **80 000 à 120 000 makers professionnels ou semi-pro** parlant français, anglais, allemand ou espagnol.

L'objectif à 18 mois : **3 000 utilisateurs payants** sur un mix d'abonnements à 6 € / 12 € / 29 € par mois, soit un MRR cible de **35 000 € / mois** (~420 k€ ARR).

---

## 2. Le marché

### 2.1 Taille du marché

| Indicateur | Valeur estimée 2026 | Source / hypothèse |
| --- | --- | --- |
| Marché mondial impression 3D | ~25 Md$ | Wohlers Report, croissance ~20 %/an |
| Imprimantes 3D grand public actives | ~6 M | Estimation Hubs / 3DP industry |
| Imprimantes Bambu Lab vendues (cumul) | ~1,5 M | Annonces officielles + LinkedIn |
| Utilisateurs Bambu actifs (MAU) | ~1,1 M | Estimation interne (75 % des unités) |
| Communauté MakerWorld | > 700 000 comptes | Bambu Lab MakerWorld 2025 |

Bambu Lab est passé en 3 ans de l'ombre au statut de **leader incontesté du segment grand public**. La part de marché des imprimantes Bambu sur les imprimantes vendues > 200 € s'établit à **47 % en 2025** (Hubs Trend Report). Cette croissance est moteur du marché car chaque nouvel utilisateur :

- Imprime en moyenne 8 à 15 objets / mois.
- Possède 2 à 6 bobines de filament en rotation.
- Cherche à monétiser sa production (50 % des A1 mini, 80 % des X1 Carbon).

### 2.2 Segmentation utilisateur

| Persona | % de la base estimée | Comportement clé | Sensibilité prix |
| --- | --- | --- | --- |
| **Hobbyiste curieux** | 55 % | Imprime pour soi, change rarement de bobine, peu organisé. | Très sensible. Refuse > 5 €/mois. |
| **Maker actif** | 25 % | 1 imprimante, 5–10 articles vendus/mois (Etsy, Vinted, marchés). | Sensible mais accepte 5–10 €/mois si gain de temps réel. |
| **Micro-atelier** | 12 % | 2 à 5 imprimantes, vente régulière, sous-traitance ponctuelle. | Faible : valorise le ROI. 15–30 €/mois. |
| **Studio / PME 3D** | 5 % | 5+ imprimantes, sous-traitance, parfois plusieurs marques. | Faible : 30–80 €/mois. Demande facturation pro. |
| **Éducation / Fab Lab** | 3 % | Plusieurs élèves/utilisateurs, parc partagé. | Variable : achats par cycle annuel, devis. |

Notre cible prioritaire est le **maker actif** et le **micro-atelier** (segments 2 et 3), qui représentent ensemble ~37 % de la base et ont le pain point le plus aigu : *« je ne sais jamais ce que j'ai en stock, j'imprime des trucs en double, je perds du filament. »*

### 2.3 Tendances structurantes

1. **Professionnalisation du print-on-demand** : explosion des boutiques Etsy / Vinted / TikTok Shop tenues par des solo-makers.
2. **Multi-imprimantes** : Bambu A1 + X1, ou trois A1 mini en parallèle. Le besoin d'une vue centralisée explose.
3. **Cloud-first** : MakerWorld, Bambu Handy, OrcaSlicer Cloud habituent les utilisateurs à laisser leurs données dans le cloud.
4. **Communautés actives** : 200 k+ membres sur le Discord Bambu, sous-reddits actifs (r/BambuLab : 380 k membres). Le bouche-à-oreille y est extrêmement rapide.
5. **Marges filament en baisse** : la rentabilité du print-on-demand dépend de plus en plus du *contrôle des coûts* et de l'*évitement du gaspillage*. C'est exactement ce que nous adressons.

---

## 3. La concurrence

### 3.1 Cartographie

| Acteur | Positionnement | Forces | Faiblesses vs BambuStock |
| --- | --- | --- | --- |
| **Bambu Studio / Handy** (officiel) | Slicer + suivi d'impression. | Gratuit, intégré natif. | Pas de gestion de stock, pas de catalogue d'articles, pas d'export comptable. |
| **3D Print Log / SpoolMan** | Apps open-source de suivi de bobines. | Gratuit, communautaire. | Self-hosted, UX datée, pas de lien live MQTT, pas de catalogue articles. |
| **Inventree / Snipe-IT** | ERP / inventaire généraliste. | Très complet. | Sur-dimensionné, lourd à installer, pas du tout pensé pour le print 3D. |
| **Notion / Airtable / Excel** | Solution bricolée par les makers. | Familier, gratuit. | Aucune intégration live, friction quotidienne. |
| **Printables Hub / Octofarm** | Suivi multi-imprimantes (Octoprint). | Open-source. | Ne fonctionne pas avec Bambu (MQTT propriétaire), inadapté. |
| **Spoolify / Filaman / ManySpool** | Suivi de stock filament uniquement. | Spécialisés filament. | Ne traite pas le stock d'objets finis, pas le pipeline de validation, pas l'historique d'impressions par client. |

### 3.2 Position concurrentielle

BambuStock se distingue par **trois différenciateurs nets** :

1. **Connexion MQTT directe à l'imprimante Bambu** : à chaque fin d'impression, le job apparaît dans la file « À valider ». L'utilisateur n'a rien à saisir.
2. **Catalogue d'articles avec variantes couleur, pièces assemblées et photos** : on ne suit pas seulement des bobines, on suit des **produits finis** (ex. un porte-clé en 4 versions de couleur, un drone composé de 12 pièces).
3. **Multi-tenant SaaS clé en main** : aucune installation, aucune VM. L'utilisateur s'inscrit en 30 secondes et est connecté à son imprimante en 2 clics.

Aucun concurrent ne combine ces trois axes aujourd'hui. SpoolMan est puissant côté filament mais ne pense pas en termes d'articles vendables. Inventree est un ERP. Excel n'a pas de live.

### 3.3 Menaces concurrentielles

- **Bambu Lab eux-mêmes** : ils peuvent enrichir MakerWorld d'un module de stock. Probabilité moyenne car ce n'est pas leur cœur de métier (ils vendent des imprimantes et des filaments, pas du SaaS B2B).
- **Un fork open-source agressif** : un développeur communautaire pourrait sortir un clone gratuit. Notre défense : **vélocité produit** + **service hébergé** (95 % des makers ne veulent pas auto-héberger).
- **Outils horizontaux (Shopify, Etsy)** : ils pourraient ajouter du stock 3D natif. Probabilité faible.

---

## 4. Proposition de valeur

### 4.1 Promesse principale

> « Connecte ton Bambu, vois ton stock fondre en direct, ne réimprime jamais en double. »

### 4.2 Bénéfices client (par ordre d'importance déclaré dans nos entretiens)

1. **Gain de temps quotidien** (15–30 min/jour pour un maker actif qui suit son stock à la main).
2. **Éviter de réimprimer ce qu'on a déjà** (gain estimé 10–25 % de filament gaspillé).
3. **Visualiser sa progression** (voir l'historique d'impressions, par mois, par couleur, par client).
4. **Préparer la fiscalité** (export propre des productions, traçabilité par lot).
5. **Travailler à plusieurs** (atelier partagé, plusieurs personnes sur les mêmes imprimantes — futur multi-user dans la même org).

### 4.3 Fonctionnalités-clés (état avril 2026)

- ✅ Inventaire articles avec variantes couleur, pièces assemblées, photos.
- ✅ Connexion Bambu Lab par email/mot de passe (avec 2FA), statut MQTT en direct.
- ✅ File « À valider » à chaque fin d'impression détectée.
- ✅ Catégories, recherche, filtres.
- ✅ Historique des modifications (CRUD).
- ✅ Import / export JSON (sauvegarde manuelle).
- ✅ Multi-tenant : chaque utilisateur a son espace privé.
- ✅ PWA mobile (icône, mode standalone).
- 🛠 Réinitialisation mot de passe (avril 2026).
- 🛠 Page profil / changement de mot de passe (avril 2026).
- 🛠 Panel admin (avril 2026).
- 🔜 Stripe : abonnements payants (mai 2026).
- 🔜 Multi-utilisateurs par organisation (atelier partagé) — Q3 2026.
- 🔜 Notifications email / Telegram quand stock < seuil — Q3 2026.
- 🔜 API publique + webhooks (Etsy, Shopify) — Q4 2026.

---

## 5. Stratégie de mise sur le marché

### 5.1 Positionnement

**Pour** les makers Bambu Lab qui produisent à la demande,
**qui en ont assez** de gérer leur stock dans un fichier Excel ou de réimprimer ce qu'ils ont déjà,
**BambuStock est** un tableau de bord en ligne
**qui** se connecte directement à votre imprimante et garde votre catalogue à jour automatiquement,
**à la différence de** SpoolMan ou d'Excel qui demandent de tout saisir à la main.

### 5.2 Canaux d'acquisition prioritaires

| Canal | CAC estimé | Volume | Priorité |
| --- | --- | --- | --- |
| **Reddit r/BambuLab** (posts utiles + AMA) | 0,5–2 € | 100–500 inscrits / post viral | ★★★ |
| **YouTube créateurs Bambu** (sponsoring 200–800 €) | 4–10 € | 500–3 000 inscrits / vidéo | ★★★ |
| **TikTok / Reels makers** (placement organique) | quasi 0 € | viral irrégulier | ★★ |
| **Discord Bambu officiel + serveurs perso** | quasi 0 € | 50–200 inscrits / mois | ★★★ |
| **SEO long-tail** (articles : "gérer stock impression 3D") | 0 € en organique | montée 6–12 mois | ★★ |
| **Facebook Ads ciblé fan-pages Bambu** | 8–18 € | scalable | ★ |
| **Partenariat MakerWorld** (peu probable mais à tenter) | 0 € | énorme effet de halo | ★ (option) |

### 5.3 Storytelling et content marketing

- **Tutoriels vidéo** : « Connecte ton Bambu en 30 s à BambuStock ».
- **Études de cas** : un maker Etsy qui passe de 3 h/semaine de gestion à 20 min.
- **Templates JSON** prêts à l'import (catalogues de pièces populaires : drones FPV, organiseurs, jouets articulés).
- **Newsletter mensuelle** « Le journal du print 3D rentable ».

### 5.4 Boucle virale

Chaque utilisateur peut **exporter un catalogue partageable** (JSON public) pour le proposer à ses amis. Roadmap Q4 2026 : *« catalogues marketplace »* — un maker peut publier un catalogue type et inviter d'autres à le forker.

---

## 6. Modèle économique

### 6.1 Tarification (cible mai 2026, post-Stripe)

| Plan | Prix HT/mois | Inclus |
| --- | --- | --- |
| **Free** | 0 € | 30 articles, 1 imprimante Bambu, historique 30 jours. |
| **Maker** | 6 € | 500 articles, 1 imprimante, historique illimité, export CSV. |
| **Pro** | 12 € | Illimité, 3 imprimantes, notifications email, sauvegardes auto. |
| **Studio** | 29 € | 10 imprimantes, multi-utilisateurs (5 sièges), API, support prioritaire. |

> **Promotion early-bird** : tous les comptes créés avant la sortie Stripe restent à **vie sur le plan Pro pour 4,90 €/mois** (effet « beta lifetime » qui motive l'inscription précoce).

### 6.2 Hypothèses de conversion

| Étape | Hypothèse |
| --- | --- |
| Visiteur landing → inscription | 8 % (formulaire court, plan gratuit dispo) |
| Inscription → 1ʳᵉ impression validée | 55 % (les 45 % qui décrochent ne reviendront probablement pas) |
| Activé → conversion payante (sous 30 j) | 6 % (cible benchmark SaaS niche) |
| Churn mensuel sur les payants | 4 % (hypothèse prudente premier 12 mois) |

### 6.3 Économie unitaire (LTV / CAC)

Sur le plan **Maker** à 6 €/mois et un churn de 4 %/mois :

- LTV brute = 6 € × (1/0,04) = **150 €**
- Marge brute (~85 % SaaS, hébergement Fly.io + bcrypt + bande passante très faibles) ≈ **127 €**
- CAC cible < 30 € → ratio **LTV/CAC ≈ 4,2** ✅
- Payback < 6 mois ✅

Sur le plan **Studio** à 29 €/mois et churn 2 %/mois :

- LTV brute ≈ 1 450 €
- Marge brute ≈ 1 230 €

C'est ce segment qui financera la croissance.

---

## 7. Risques et facteurs critiques de succès

### 7.1 Risques

| Risque | Sévérité | Mitigation |
| --- | --- | --- |
| Bambu Lab change son API MQTT | Élevée | Maintenir un module de connexion isolé (`bambu.js`), surveiller les release notes, prévoir 1 sprint de catch-up max. |
| Bambu Lab sort un produit concurrent | Moyenne | S'imposer vite comme la marque de référence, multi-marque dès Q4 2026 (Prusa, Creality K-series). |
| Acquisition trop lente | Moyenne | Diversifier les canaux, investir en content YouTube (durable). |
| Risque légal RGPD | Faible | Données minimales, hébergement EU (Fly Paris CDG), DPA prêt. |
| Token Bambu volé d'un user | Moyen | Stocké chiffré (à mettre en place) en DB, jamais exposé côté client. |

### 7.2 Facteurs critiques de succès

1. **Vélocité produit** : sortir 1 amélioration utilisateur visible toutes les 2 semaines.
2. **Onboarding < 90 s** : si un utilisateur n'a pas validé sa première impression dans la première session, il est probablement perdu.
3. **Communauté** : être présent sur Reddit / Discord et réactif (1 jour de SLA réponse).
4. **Stabilité MQTT** : c'est notre cœur de différenciation, il ne peut pas tomber.

---

## 8. Indicateurs de pilotage

| KPI | Cible Mois 6 | Cible Mois 12 | Cible Mois 18 |
| --- | --- | --- | --- |
| Inscriptions cumulées | 1 500 | 8 000 | 25 000 |
| Comptes actifs (login 30 j) | 600 | 3 500 | 11 000 |
| Comptes payants | 80 | 800 | 3 000 |
| MRR | 700 € | 7 500 € | 35 000 € |
| Churn payant mensuel | < 6 % | < 5 % | < 4 % |
| NPS | > 35 | > 45 | > 50 |
| CAC blendé | < 8 € | < 14 € | < 22 € |

Ces objectifs sont **ambitieux mais atteignables** sur un marché de niche dont la base s'élargit rapidement. Ils supposent une exécution disciplinée sur le produit, l'acquisition et la rétention.

---

## 9. Conclusion

BambuStock attaque un marché de niche, mais en **forte croissance, mal couvert, et où l'utilisateur a déjà la culture du SaaS payant**. La connexion MQTT directe à Bambu Lab constitue un avantage différenciant difficile à reproduire pour un acteur généraliste. Le coût d'infrastructure est marginal (Fly.io < 30 €/mois jusqu'à plusieurs milliers d'utilisateurs).

La fenêtre d'opportunité se ferme estimativement dans 12 à 18 mois : si BambuStock ne s'impose pas comme **la** référence du stock pour makers Bambu Lab d'ici là, un concurrent (open-source, ou Bambu Lab eux-mêmes) viendra occuper l'espace.

**Recommandation** : investir tout de suite dans (a) la mise en production des paiements Stripe, (b) un cycle de contenu YouTube/Reddit régulier, et (c) la mise en multi-marque pour élargir le marché adressable au-delà du seul écosystème Bambu.
