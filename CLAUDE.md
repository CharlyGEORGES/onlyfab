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
