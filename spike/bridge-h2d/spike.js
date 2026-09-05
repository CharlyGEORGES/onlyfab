'use strict';
// ── Spike étape 1 : bridge Bambu Lab H2D ─────────────────────────────────────
// Objectif : prouver depuis un script local qu'on récupère
//   1. le statut d'impression par MQTT local (TLS, port 8883)
//   2. le dernier time-lapse par FTP implicite TLS (port 990)
//   3. le flux caméra RTSPS (port 322) via ffmpeg / ffplay
//
// Usage : node spike.js <mqtt|ftp|rtsp|play|all>
// Config : variables d'environnement PRINTER_IP, PRINTER_SERIAL, ACCESS_CODE
//          (un fichier .env à côté du script est lu s'il existe).
//
// Script jetable : aucune valeur Onlyfab en dur, tout vient de l'environnement.

const fs   = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ── Config ───────────────────────────────────────────────────────────────────
loadDotEnv(path.join(__dirname, '.env'));

const CFG = {
  ip:      process.env.PRINTER_IP,
  serial:  process.env.PRINTER_SERIAL,
  code:    process.env.ACCESS_CODE,
  outDir:  path.resolve(__dirname, process.env.OUT_DIR || './out'),
  mqttSec: intEnv('MQTT_LISTEN_SECONDS', 20),
  rtspSec: intEnv('RTSP_SAMPLE_SECONDS', 15),
};

// URL documentée pour X1 et H2D (LAN Only Liveview activé). Le rapport MQTT
// expose aussi ipcam.rtsp_url : le test mqtt l'affiche pour comparer.
const rtspUrl = () => `rtsps://bblp:${CFG.code}@${CFG.ip}:322/streaming/live/1`;
const redact  = s => s.replace(CFG.code, '********');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
function intEnv(name, def) { const v = parseInt(process.env[name] || '', 10); return Number.isFinite(v) ? v : def; }
function log(tag, ...a)  { console.log(`[${tag}]`, ...a); }
function fail(tag, ...a) { console.error(`[${tag}] ÉCHEC`, ...a); }

function requireConfig() {
  const missing = ['ip', 'serial', 'code'].filter(k => !CFG[k]);
  if (missing.length) {
    console.error('Config manquante : PRINTER_IP, PRINTER_SERIAL, ACCESS_CODE (voir .env.example)');
    process.exit(2);
  }
  fs.mkdirSync(CFG.outDir, { recursive: true });
}

function hasBinary(bin) {
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  return !r.error;
}

// ── 1. MQTT local ────────────────────────────────────────────────────────────
// Identifiants : user "bblp", password = access code, TLS auto-signé.
// Topics : device/<serial>/report (lecture), device/<serial>/request (commande).
// Sans "pushall", l'imprimante n'envoie que des deltas : on le demande d'emblée.
async function testMqtt() {
  const mqtt = require('mqtt');
  log('mqtt', `Connexion mqtts://${CFG.ip}:8883 en tant que bblp…`);

  return new Promise(resolve => {
    const client = mqtt.connect({
      host: CFG.ip, port: 8883, protocol: 'mqtts',
      username: 'bblp', password: CFG.code,
      clientId: `spike_${Date.now().toString(36)}`,
      rejectUnauthorized: false,
      connectTimeout: 10_000, reconnectPeriod: 0,
    });

    const summary = { connected: false, reports: 0, lastPrint: null, ipcam: null };
    const done = ok => { clearTimeout(timer); client.end(true); resolve(ok); };
    const timer = setTimeout(() => {
      if (!summary.connected) { fail('mqtt', 'Timeout de connexion. Vérifier IP, access code, et le Mode développeur dans les réglages LAN.'); return done(false); }
      if (!summary.reports)   { fail('mqtt', 'Connecté mais aucun rapport reçu. Serial incorrect ?'); return done(false); }
      log('mqtt', `OK : ${summary.reports} rapport(s) reçu(s) en ${CFG.mqttSec}s`);
      done(true);
    }, CFG.mqttSec * 1000);

    client.on('connect', () => {
      summary.connected = true;
      log('mqtt', 'Connecté. Abonnement au topic report + demande pushall…');
      client.subscribe(`device/${CFG.serial}/report`, err => {
        if (err) { fail('mqtt', 'subscribe :', err.message); return done(false); }
        client.publish(`device/${CFG.serial}/request`,
          JSON.stringify({ pushing: { sequence_id: '1', command: 'pushall', version: 1, push_target: 1 } }));
      });
    });

    client.on('message', (_topic, msg) => {
      let data;
      try { data = JSON.parse(msg.toString()); } catch { return; }
      const p = data.print;
      if (!p) return;
      summary.reports++;
      // Champs utiles au bridge : état, progression, nom du job (= mapping commande)
      const view = {
        gcode_state:       p.gcode_state,
        mc_percent:        p.mc_percent,
        mc_remaining_time: p.mc_remaining_time,
        layer:             p.layer_num != null ? `${p.layer_num}/${p.total_layer_num}` : undefined,
        subtask_name:      p.subtask_name,
        gcode_file:        p.gcode_file,
        nozzle_temper:     p.nozzle_temper,
        bed_temper:        p.bed_temper,
      };
      const changed = JSON.stringify(view) !== JSON.stringify(summary.lastPrint);
      if (changed) { summary.lastPrint = view; log('mqtt', 'print :', JSON.stringify(view)); }
      if (p.ipcam && !summary.ipcam) {
        summary.ipcam = p.ipcam;
        log('mqtt', 'ipcam :', JSON.stringify(p.ipcam));
        if (p.ipcam.rtsp_url) {
          const same = p.ipcam.rtsp_url.includes(':322/streaming/live/1');
          log('mqtt', same ? 'rtsp_url conforme au format attendu.' : 'ATTENTION : rtsp_url différente du format attendu, utiliser celle-ci pour le test rtsp.');
        }
      }
    });

    client.on('error', err => { fail('mqtt', err.message, err.code ? `(code ${err.code})` : ''); done(false); });
  });
}

// ── 2. FTP time-lapse ────────────────────────────────────────────────────────
// FTPS implicite sur 990, user bblp, password = access code, cert auto-signé.
// Les time-lapses sont dans /timelapse (mp4 sur X1/H2D, avi sur P1/A1).
async function testFtp() {
  const { Client } = require('basic-ftp');
  const client = new Client(20_000);
  log('ftp', `Connexion ftps://${CFG.ip}:990 (implicite)…`);
  try {
    await client.access({
      host: CFG.ip, port: 990, user: 'bblp', password: CFG.code,
      secure: 'implicit', secureOptions: { rejectUnauthorized: false },
    });
    log('ftp', 'Connecté.');
    const root = await client.list('/');
    log('ftp', 'Racine :', root.map(f => f.name).join(', '));

    let files;
    try { files = await client.list('/timelapse'); }
    catch (e) { fail('ftp', '/timelapse inaccessible :', e.message, '(time-lapse jamais activé dans Bambu Studio ?)'); return false; }

    const videos = files
      .filter(f => f.isFile && /\.(mp4|avi|mkv)$/i.test(f.name))
      .sort((a, b) => (b.modifiedAt?.getTime() || 0) - (a.modifiedAt?.getTime() || 0) || b.name.localeCompare(a.name));
    log('ftp', `${videos.length} time-lapse(s) : ${videos.slice(0, 5).map(f => `${f.name} (${Math.round(f.size / 1e6)} Mo)`).join(', ')}`);
    if (!videos.length) { fail('ftp', 'Aucun fichier vidéo dans /timelapse. Cocher "Time-lapse" dans Bambu Studio et lancer une impression.'); return false; }

    const latest = videos[0];
    const dest = path.join(CFG.outDir, latest.name);
    log('ftp', `Téléchargement de ${latest.name} → ${dest}`);
    client.trackProgress(info => { if (info.bytes) process.stdout.write(`\r[ftp] ${Math.round(info.bytes / 1e6)} Mo`); });
    await client.downloadTo(dest, `/timelapse/${latest.name}`);
    client.trackProgress();
    process.stdout.write('\n');
    log('ftp', `OK : ${fs.statSync(dest).size} octets`);
    return true;
  } catch (e) {
    fail('ftp', e.message, '(Mode développeur activé dans les réglages LAN ?)');
    return false;
  } finally {
    client.close();
  }
}

// ── 3. RTSPS via ffmpeg ──────────────────────────────────────────────────────
// Remux (-c copy), aucun transcodage : c'est exactement ce que fera le relais.
// Produit un échantillon MP4 et une playlist HLS dans OUT_DIR.
function runFfmpeg(args, label) {
  return new Promise(resolve => {
    log('rtsp', `${label} : ffmpeg ${redact(args.join(' '))}`);
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-stats', ...args], { stdio: ['ignore', 'inherit', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; process.stderr.write(redact(d.toString())); });
    p.on('error', e => { fail('rtsp', 'ffmpeg introuvable :', e.message); resolve(false); });
    p.on('close', code => {
      if (code === 0) { log('rtsp', `${label} : OK`); return resolve(true); }
      fail('rtsp', `${label} : ffmpeg code ${code}`);
      if (/401|Unauthorized/i.test(err)) console.error('  → Access code refusé.');
      if (/Connection refused|timed out|No route/i.test(err)) console.error('  → Port 322 fermé : activer "LAN Only Liveview" puis redémarrer l\'imprimante.');
      if (/tls|ssl/i.test(err)) console.error('  → Problème TLS : essayer d\'ajouter -tls_verify 0 ou une autre build ffmpeg.');
      resolve(false);
    });
  });
}

async function testRtsp() {
  if (!hasBinary('ffmpeg')) { fail('rtsp', 'ffmpeg absent du PATH. Installer ffmpeg (apt install ffmpeg / brew install ffmpeg).'); return false; }
  const url = process.env.RTSP_URL || rtspUrl();
  const input = ['-rtsp_transport', 'tcp', '-i', url];

  // Sonde : codec, résolution, fps. C'est ce qui décide du remux HLS.
  const probe = spawnSync('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,r_frame_rate,pix_fmt', '-of', 'json', url], { encoding: 'utf8', timeout: 30_000 });
  if (probe.status === 0) log('rtsp', 'ffprobe :', probe.stdout.replace(/\s+/g, ' ').trim());
  else fail('rtsp', 'ffprobe :', redact((probe.stderr || '').trim() || `code ${probe.status}`));

  const mp4 = path.join(CFG.outDir, 'live-sample.mp4');
  const okMp4 = await runFfmpeg([...input, '-t', String(CFG.rtspSec), '-c', 'copy', '-movflags', '+faststart', '-y', mp4], `Échantillon ${CFG.rtspSec}s → ${mp4}`);

  const hlsDir = path.join(CFG.outDir, 'hls');
  fs.mkdirSync(hlsDir, { recursive: true });
  const okHls = await runFfmpeg([...input, '-t', String(CFG.rtspSec), '-c', 'copy', '-f', 'hls',
    '-hls_time', '2', '-hls_list_size', '6', '-hls_flags', 'delete_segments+append_list', '-y', path.join(hlsDir, 'live.m3u8')],
  `HLS ${CFG.rtspSec}s → ${hlsDir}/live.m3u8`);

  if (okHls) log('rtsp', `Pour tester la lecture web : npx serve ${CFG.outDir} puis ouvrir hls/live.m3u8 dans un player HLS (Safari ou hls.js).`);
  return okMp4 && okHls;
}

// Affiche le flux en direct (test visuel + test de connexions simultanées :
// lancer "play" dans 2 ou 3 terminaux pour mesurer la limite de l'imprimante).
function play() {
  if (!hasBinary('ffplay')) { fail('play', 'ffplay absent du PATH.'); return false; }
  const url = process.env.RTSP_URL || rtspUrl();
  log('play', `ffplay ${redact(url)} (fermer la fenêtre pour arrêter)`);
  const p = spawn('ffplay', ['-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay', '-window_title', 'H2D live', url], { stdio: 'inherit' });
  p.on('error', e => fail('play', e.message));
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cmd = (process.argv[2] || 'all').toLowerCase();
  requireConfig();
  log('spike', `Imprimante ${CFG.ip} (serial ${CFG.serial}), sortie ${CFG.outDir}`);

  const results = {};
  if (cmd === 'play') { play(); return; }
  if (cmd === 'mqtt' || cmd === 'all') results.mqtt = await testMqtt();
  if (cmd === 'ftp'  || cmd === 'all') results.ftp  = await testFtp();
  if (cmd === 'rtsp' || cmd === 'all') results.rtsp = await testRtsp();
  if (!Object.keys(results).length) { console.error('Commande inconnue. Usage : node spike.js <mqtt|ftp|rtsp|play|all>'); process.exit(2); }

  console.log('\n── Résultat ──');
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(5)} ${v ? 'OK' : 'ÉCHEC'}`);
  const allOk = Object.values(results).every(Boolean);
  console.log(allOk
    ? '\nLes trois briques répondent : l\'architecture bridge est validée.'
    : '\nAu moins une brique échoue : voir les messages ci-dessus avant de poursuivre.');
  process.exit(allOk ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
