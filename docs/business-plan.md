# Business plan — BambuStock

> Document de travail · Avril 2026
> Société porteuse : à constituer (SAS unipersonnelle prévue, France)
> Site : https://bambustock.com

---

## 1. Le projet en une page

**BambuStock** est un logiciel en ligne (SaaS) qui permet aux utilisateurs d'imprimantes 3D Bambu Lab de gérer leur stock d'objets imprimés et leurs filaments, en se connectant directement à leur imprimante pour suivre les impressions en temps réel.

- **Marché cible** : 1,1 M d'utilisateurs Bambu Lab actifs en 2026, dont ~120 k makers professionnels ou semi-pro.
- **Produit** : application web (et PWA mobile), inventaire articles + variantes couleur + pièces assemblées, file de validation à chaque fin d'impression, intégration MQTT live avec Bambu.
- **Modèle** : SaaS freemium (Free / Maker 6 € / Pro 12 € / Studio 29 €).
- **Ambition 18 mois** : 3 000 comptes payants, MRR 35 k€ (~420 k€ ARR).
- **Investissement nécessaire pour atteindre la cible** : ≈ 60 k€ (équipe + acquisition).
- **Statut actuel** : produit en production, ~150 utilisateurs beta, monétisation prévue pour mai 2026.

---

## 2. Le produit

### 2.1 Description fonctionnelle

BambuStock est une application web hébergée à laquelle l'utilisateur se connecte via email + mot de passe. Une fois authentifié, il peut :

1. **Cataloguer ses articles imprimés** (un article = un produit fini, ex. « Porte-clé Logo X »). Chaque article supporte des variantes (couleurs), des pièces démontables (un drone = 12 pièces), des photos, un seuil d'alerte stock bas.
2. **Connecter son compte Bambu Lab** (email + mot de passe + 2FA si activé). BambuStock se branche en MQTT à l'imprimante et reçoit en direct chaque fin d'impression.
3. **Valider les impressions** : à chaque fin d'impression, un job apparaît dans la file « À valider ». L'utilisateur dit « cette impression correspond à 3 unités du Porte-clé X en bleu » et le stock est mis à jour.
4. **Suivre l'historique** : chaque modification est tracée (qui, quand, quoi).
5. **Sauvegarder** : export / import JSON manuel, et sauvegarde automatique côté serveur.

### 2.2 Architecture technique

Stack volontairement minimaliste pour rester ultra-rapide à itérer :

- **Backend** : Node.js 20 (HTTP natif), SQLite (better-sqlite3), MQTT pour Bambu, bcryptjs pour les mots de passe.
- **Frontend** : SPA vanilla JS / CSS (pas de framework lourd), PWA installable.
- **Hébergement** : Fly.io région Paris CDG, 1 instance, volume persistant pour la DB et les uploads.
- **CI/CD** : GitHub Actions, push sur `master` → déploiement automatique Fly.io.
- **Coût d'infra actuel** : ~10 €/mois (1 vm shared 1x). Estimation à 5 000 utilisateurs : ~80 €/mois.

### 2.3 Roadmap produit (12 prochains mois)

| Trimestre | Livrables clés |
| --- | --- |
| **Q2 2026** | Stripe (abonnements payants), réinitialisation mot de passe, page profil, panel admin, refonte mobile (achevés en avril). |
| **Q3 2026** | Multi-utilisateurs par organisation (atelier partagé, plusieurs sièges), notifications email & Telegram pour stock bas, traduction EN. |
| **Q4 2026** | API publique + webhooks (Etsy, Shopify, Vinted), traduction DE/ES, support multi-marque (Prusa Connect, Creality Cloud). |
| **Q1 2027** | Catalogues marketplace (un maker publie un catalogue type), facturation pro avec TVA OSS. |

---

## 3. Le marché

Voir [`etude-commerciale.md`](etude-commerciale.md) pour l'analyse détaillée. Synthèse :

- TAM (Total Addressable Market) : 1,1 M d'utilisateurs Bambu Lab actifs en 2026.
- SAM (Serviceable Addressable Market) : ~120 k makers semi-pro / pro francophones, anglophones, hispanophones, germanophones.
- SOM (Serviceable Obtainable Market à 18 mois) : ~25 000 inscrits, ~3 000 payants.

Le marché est en forte croissance (+30 %/an) et n'a pas de leader établi sur la verticale « stock + impression Bambu ».

---

## 4. Stratégie commerciale

### 4.1 Tarification

| Plan | Prix mensuel HT | Cible utilisateur | % attendu de la base payante M18 |
| --- | --- | --- | --- |
| Free | 0 € | Hobbyiste, lead gen. | n/a (gratuit) |
| Maker | 6 € | Maker actif, side income. | 65 % |
| Pro | 12 € | Micro-atelier 2–3 imprimantes. | 28 % |
| Studio | 29 € | Studio 5+ imprimantes, équipe. | 7 % |

**ARPU pondéré** = 0,65 × 6 + 0,28 × 12 + 0,07 × 29 ≈ **9,3 €/mois**.

### 4.2 Acquisition

| Canal | Budget mensuel cible (M12) | Inscrits attendus / mois |
| --- | --- | --- |
| Reddit + Discord (organique, content) | 0 € | 600 |
| Sponsoring YouTube créateurs Bambu (×2 / mois) | 1 200 € | 800 |
| Facebook / Reddit Ads ciblé Bambu | 800 € | 400 |
| SEO long-tail (5 articles / mois rédigés en interne) | 0 € | 200 (montée progressive) |
| Affiliation (10 % récurrents 12 mois) | variable | 100 |
| **Total** | **≈ 2 000 €** | **~2 100 inscrits / mois en M12** |

CAC blendé attendu en M12 : **2 000 € / (2 100 × 6 % conversion) ≈ 16 €**.

### 4.3 Rétention

Levier rétention #1 : **ne jamais perdre la connexion MQTT à l'imprimante** (la valeur perçue tombe à zéro sinon). Levier #2 : **emails mensuels récap** (« Tu as imprimé 47 objets ce mois, ton article le plus populaire est X, tu manques bientôt de filament Y »). Levier #3 : **gamification douce** (streaks, badges « 100 impressions »).

Churn cible : 4 %/mois en année 1, 3 %/mois en année 2.

---

## 5. Plan financier

### 5.1 Hypothèses clés

- 1 fondateur à plein temps dès M1 (rémunération chargée 3 500 €/mois, brute charges incluses).
- 1ʳᵉ embauche développeur freelance à mi-temps en M9 (1 800 €/mois).
- 1ʳᵉ embauche junior CSM/marketing à plein temps en M14 (3 200 €/mois chargé).
- Frais d'infra Fly.io + Stripe + email transactionnel : 50 €/mois M1, 250 €/mois M12, 700 €/mois M18.
- Frais juridiques + comptable : 200 €/mois.
- Outils SaaS internes (Notion, Linear, Plausible, Brevo) : 80 €/mois.
- **Date de mise en production de Stripe** : 1ᵉʳ mai 2026 (M1).

### 5.2 Projection d'utilisateurs et MRR

| Mois | Inscrits cumulés | Payants cumulés | MRR (€) | Charges (€) | Solde mensuel (€) |
| --- | --- | --- | --- | --- | --- |
| M1 | 250 | 12 | 110 | 3 800 | -3 690 |
| M3 | 700 | 50 | 460 | 3 850 | -3 390 |
| M6 | 1 500 | 110 | 1 020 | 4 100 | -3 080 |
| M9 | 4 000 | 350 | 3 250 | 6 100 | -2 850 |
| M12 | 8 000 | 800 | 7 450 | 6 400 | +1 050 |
| M15 | 14 000 | 1 600 | 14 880 | 9 800 | +5 080 |
| M18 | 25 000 | 3 000 | 27 900 | 10 100 | +17 800 |

> **NB** : ces MRR sont prudents — ils prennent un ARPU 9,3 € et excluent la promotion early-bird (qui crée du MRR plus bas mais une base très fidèle).

### 5.3 Compte de résultat synthétique (€)

| | An 1 (M1–M12) | An 2 (M13–M24) |
| --- | --- | --- |
| Revenus SaaS | 19 800 | 245 000 |
| Coûts infra & outils SaaS | -3 200 | -10 200 |
| **Marge brute** | **16 600 (84 %)** | **234 800 (96 %)** |
| Salaires + charges | -45 800 | -98 400 |
| Acquisition payante | -16 000 | -36 000 |
| Frais admin / juridique | -3 600 | -3 600 |
| **Résultat avant impôt** | **-48 800** | **+96 800** |

### 5.4 Trésorerie et besoin de financement

- Solde cumulé creux : **≈ -52 000 € en M11** (point bas).
- Trésorerie d'ouverture nécessaire pour ne jamais passer en négatif : **60 000 €**.
- À partir de M12, l'activité devient cash-flow positive en mensuel ; le seuil de rentabilité cumulé est franchi vers **M18**.

### 5.5 Plan de financement

| Source | Montant | Conditions |
| --- | --- | --- |
| Apport fondateur | 15 000 € | Fonds propres, libéré à la création. |
| Aide BPI / Région (création d'entreprise innovante) | 15 000 € | Subvention non remboursable, dossier prévu Q2 2026. |
| Prêt d'honneur Initiative France (taux 0 %) | 15 000 € | Sur 5 ans, différé 1 an. |
| Pré-vente plans annuels « lifetime beta » | 10 000 € | 200 utilisateurs × 50 € lifetime, lancement avril 2026. |
| Marge sur revenus (M9 → M18) | 5 000 € | Couvre la fin du runway. |
| **Total** | **60 000 €** | |

**Aucune levée de fonds en equity prévue à 18 mois** — l'objectif est l'autofinancement par les revenus, qui devient atteignable dès M12.

### 5.6 Sensibilité

| Scénario | Cible 3 000 payants M18 | MRR M18 | Conclusion |
| --- | --- | --- | --- |
| **Pessimiste** (-40 % d'inscrits, churn 6 %) | 1 500 payants | 14 000 € | Pas de profitabilité, mais cash-flow nul. Pivot multi-marque accéléré. |
| **Médian** (assumption de base) | 3 000 payants | 28 000 € | Trajectoire cible. |
| **Optimiste** (+30 % d'inscrits, churn 3 %) | 4 200 payants | 39 000 € | Recrutement anticipé, levée optionnelle pour scale. |

---

## 6. L'équipe

**Aujourd'hui** : 1 fondateur tech (full-stack, ancien développeur, expérience 3D printing personnelle).

**Renforts prévus** :

- **M9** : 1 développeur senior à mi-temps (freelance), pour libérer du temps fondateur sur le commercial.
- **M14** : 1 CSM / marketing junior à plein temps, pour gérer la communauté, le SEO et le support utilisateur.

**Conseil** : 1 mentor produit (à recruter via Initiative France ou réseau personnel) — séances mensuelles.

---

## 7. Calendrier d'exécution (12 prochains mois)

| Mois | Jalon |
| --- | --- |
| **M0 (avril 2026)** | Fix UX mobile, profil utilisateur, panel admin, password reset (✅ en cours dans cette PR). |
| **M1 (mai)** | Mise en production Stripe (3 plans payants), promo early-bird lifetime. |
| **M2 (juin)** | Email transactionnel (Brevo), notifications stock bas. |
| **M3 (juillet)** | Première vidéo YouTube sponsorisée (créateur 30 k abonnés Bambu). |
| **M4 (août)** | Multi-utilisateurs par organisation (plan Studio prêt). |
| **M5 (septembre)** | Traduction anglais (canal vers r/3Dprinting EN, 1,5 M membres). |
| **M6 (octobre)** | Cap des 1 500 inscrits, réévaluation acquisition payante. |
| **M9 (janvier 2027)** | API publique + connecteur Etsy (intégration ventes). |
| **M12 (avril 2027)** | Cap MRR 7 500 € visé. Décision : auto-financement ou levée seed. |

---

## 8. Risques & plan de continuité

- **Risque API Bambu** : si Bambu Lab change ou ferme l'API MQTT, le module `bambu.js` est isolé et un sprint d'adaptation suffit. Plan B : importer manuellement depuis l'app Bambu Handy (déjà supporté).
- **Risque marché unique** : nous prévoyons d'élargir au multi-marque dès Q4 2026 pour ne plus dépendre de Bambu Lab.
- **Risque indispensabilité fondateur** : tout le code est versionné, déploiement automatisé, infra documentée. Plan de continuité : un dev externe peut reprendre en < 5 jours.
- **Risque RGPD** : données minimales, hébergement EU, mention RGPD prévue au lancement Stripe.

---

## 9. Pourquoi maintenant

Trois fenêtres se croisent pour la première fois :

1. Bambu Lab est devenu en 3 ans le **leader incontesté du marché grand public** (~50 % de parts de marché ≥ 200 €).
2. La **communauté de makers monétisant leur impression** (Etsy, marchés, Vinted, TikTok Shop) explose en France et en Europe — c'est notre cœur de cible payante.
3. Aucun concurrent n'a encore couvert sérieusement ce segment vertical (stock + suivi live multi-imprimante Bambu). Inventree est trop lourd, SpoolMan trop limité, Excel trop manuel.

Cette fenêtre se referme estimativement dans 12 à 18 mois. **C'est maintenant ou jamais.**
