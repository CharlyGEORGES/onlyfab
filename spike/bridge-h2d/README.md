# Spike bridge H2D (étape 1)

Script jetable qui prouve, depuis un PC ou un Raspberry Pi sur le réseau de l'atelier, qu'on récupère bien :

1. le statut d'impression par **MQTT local** (TLS, port 8883),
2. le dernier **time-lapse par FTP** (FTPS implicite, port 990),
3. le **flux caméra RTSPS** (port 322), remuxé en MP4 et en HLS par ffmpeg sans transcodage.

Si l'une des trois briques échoue de façon définitive, l'architecture du bridge change : c'est le but du spike.

## Prérequis sur l'imprimante

Sur l'écran de la H2D, réglages réseau / LAN :

- activer **LAN Only Liveview** (n'impose pas le mode LAN Only complet, le cloud Bambu continue de fonctionner),
- activer **Developer Mode** (mode développeur) : requis par les firmwares récents pour l'accès MQTT et FTP par un logiciel tiers,
- noter **IP locale**, **access code**, **numéro de série**,
- **redémarrer l'imprimante** après avoir activé ces options (et après chaque mise à jour firmware).

Pour le test FTP, au moins une impression doit avoir été lancée avec l'option **Time-lapse** cochée dans Bambu Studio.

## Prérequis sur la machine

- Node.js 20 ou plus,
- ffmpeg, ffprobe et ffplay dans le PATH (`sudo apt install ffmpeg` sur Debian/Raspberry Pi OS, `brew install ffmpeg` sur macOS, build gyan.dev sur Windows).

## Lancement

```bash
cd spike/bridge-h2d
npm install
cp .env.example .env      # renseigner PRINTER_IP, PRINTER_SERIAL, ACCESS_CODE
npm run all               # les trois tests à la suite
```

Tests unitaires :

```bash
npm run mqtt   # 20 s d'écoute, affiche état, progression, nom du job, bloc ipcam
npm run ftp    # liste /timelapse et télécharge le plus récent dans ./out
npm run rtsp   # échantillon MP4 + playlist HLS de 15 s dans ./out
npm run play   # ouvre le flux dans ffplay (à lancer dans 2 ou 3 terminaux pour mesurer la limite de connexions)
```

Variables optionnelles : `MQTT_LISTEN_SECONDS`, `RTSP_SAMPLE_SECONDS`, `OUT_DIR`, `RTSP_URL` (pour forcer l'URL affichée par `ipcam.rtsp_url` si elle diffère du format attendu).

## Ce qu'il faut noter pendant le spike

| Question | Où regarder |
| --- | --- |
| Format exact de l'URL RTSPS | ligne `ipcam :` du test mqtt, champ `rtsp_url` |
| Codec, résolution, fps du flux | ligne `ffprobe :` du test rtsp (décide du remux HLS) |
| Nombre de connexions RTSPS simultanées tolérées | lancer `npm run play` dans plusieurs terminaux jusqu'à refus |
| Nom du job tel que remonté par l'imprimante | champ `subtask_name` du test mqtt (base du mapping job → commande) |
| Format et taille des time-lapses | ligne `time-lapse(s) :` du test ftp |
| Stabilité après redémarrage | relancer `npm run all` après un reboot de l'imprimante |

Le fichier `.env` et le dossier `out/` sont ignorés par git : rien de sensible ne doit remonter dans le dépôt.
