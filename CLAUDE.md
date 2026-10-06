# Instructions pour Claude Code

## Flux de travail
- `master` déploie un **environnement de test** (Fly.io), pas la production.
- À chaque modification demandée : construire (`cd configurator && python3 build.py` si le
  configurateur est touché), committer, puis **pousser tout de suite sur `master`**
  (avance rapide depuis la branche de travail, après avoir intégré `origin/master`).
  Ne pas attendre de confirmation.
- Le CI incrémente la version (`chore: bump version`) sur `master` après chaque push :
  toujours récupérer `origin/master` avant de pousser.

## Configurateur
- Source : `configurator/cfg_src.html`. Le fichier `configurateur.html` à la racine est
  **généré** par `configurator/build.py` (three.js et GLTFLoader inlinés) : modifier la
  source, puis reconstruire, et committer les deux.

## Travaux en attente (v2 du configurateur) — à reprendre
Tout le code est en place dans `configurator/cfg_src.html` mais **désactivé par défaut**
(`config.pose.unroll === false`). Case « Redresser le dragon à plat (v2, expérimental) »
dans l'atelier, groupe « Orientation du dragon », pour l'activer modèle par modèle.
- `dragonRig()` : remet le dragon debout (axe le plus fin du corps = verticale, face la plus
  dense = dessous), extrait la colonne vertébrale (`cineBuildPath`), déroule le dragon sur une
  ligne droite tête vers +X par pièces rigides (composantes connexes), construit un squelette
  (un os par segment, deux chaînes depuis le bassin) et lie les maillages en skinning.
  La tête est orientée selon son propre axe principal ; tête/queue départagées par la plus
  grosse pièce terminale du corps (ailes ignorées), repli sur le volume de surface.
- `cineUpdate()` : cinématique du récap jouée par le dragon (ondulation, se redresse, regarde,
  se cabre pour montrer la gravure, feu sur les coups, repos), calée sur la piste de 20 s
  (`CINE_HITS`, `CINE_FIRE_HITS`), caméra en orbite lente. N'est lancée que si le squelette
  existe (`state.rig`).
- Repères atelier (groupe « Cinématique du récap ») : queue, tête, yeux, gueule, points de
  passage, placés au clic, stockés dans `config.cine` (espace du modèle d'origine remis debout).
- Validé sur les 5 modèles (Dragon-light, Rose, Baby Crystal, Baby Orchid, Crystalwing).
  Reste à juger par le client : qualité visuelle de l'animation et des plans caméra.
