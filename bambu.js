'use strict';
// ── Module Bambu Lab Cloud MQTT ───────────────────────────────────────────────
// Gère l'authentification et la connexion MQTT au cloud Bambu Lab.
// Appelle onPrintComplete({ printerSerial, printerName, fileName,
//   filamentColor, filamentType, totalLayers }) quand une impression se termine.

const mqtt = require('mqtt');

const MQTT_HOST = 'us.mqtt.bambulab.com';
const MQTT_PORT = 8883;

// ── AUTH ─────────────────────────────────────────────────────────────────────
// Essaie plusieurs endpoints dans l'ordre jusqu'à obtenir un token
const AUTH_ENDPOINTS = [
  // Endpoint API direct (pas de Cloudflare)
  {
    url:  'https://api.bambulab.com/v1/user-service/user/login',
    body: (email, password) => ({ account: email, password }),
    pick: d => d.accessToken || d.token || d.data?.accessToken,
  },
  // Endpoint bambulab.com avec headers navigateur
  {
    url:  'https://bambulab.com/api/sign-in/form',
    body: (email, password) => ({ account: email, password, apiError: '' }),
    pick: d => d.token,
  },
];

async function getToken(email, password) {
  let lastErr = null;
  for (const ep of AUTH_ENDPOINTS) {
    try {
      const r = await fetch(ep.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':       'application/json',
        },
        body: JSON.stringify(ep.body(email, password)),
      });
      const text = await r.text();
      if (text.trimStart().startsWith('<')) { lastErr = new Error('Réponse HTML (Cloudflare)'); continue; }
      const data = JSON.parse(text);
      const token = ep.pick(data);
      if (token) { console.log(`  [Bambu] Auth OK via ${new URL(ep.url).hostname}`); return token; }
      lastErr = new Error('Pas de token dans la réponse : ' + text.slice(0, 120));
    } catch(e) { lastErr = e; }
  }
  throw lastErr || new Error('Tous les endpoints ont échoué');
}

// Extrait le user ID du payload JWT
function parseUserId(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    // Essaie base64url puis base64 classique
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); }
    catch { payload = JSON.parse(Buffer.from(parts[1], 'base64').toString()); }
    const id = payload.preferred_username || payload.username
            || payload.sub              || payload.uid
            || payload.userId           || payload.user_id || null;
    if (id) console.log(`  [Bambu] User ID JWT : ${id}`);
    return id;
  } catch { return null; }
}

// ── DÉDUPLICATION ─────────────────────────────────────────────────────────────
// Évite les doublons si Bambu envoie plusieurs fois le statut FINISH
const recentFinish = new Map(); // serial+fileName → timestamp
function isDuplicate(serial, fileName) {
  const key = `${serial}::${fileName}`;
  const last = recentFinish.get(key);
  if (last && Date.now() - last < 60_000) return true;
  recentFinish.set(key, Date.now());
  return false;
}

// ── CONNEXION MQTT ────────────────────────────────────────────────────────────
function connect({ token, printers, onPrintComplete, onStateChange, userEmail }) {
  let userId = parseUserId(token);
  if (!userId && userEmail) {
    // Fallback : Bambu MQTT accepte aussi le format "u_<email>" dans certains cas
    userId = userEmail;
    console.log(`  [Bambu] Utilisation email comme user ID : ${userId}`);
  }
  if (!userId) throw new Error('Impossible de lire le user ID depuis le token JWT');

  const client = mqtt.connect({
    host:              MQTT_HOST,
    port:              MQTT_PORT,
    protocol:          'mqtts',
    username:          `u_${userId}`,
    password:          token,
    clientId:          `onlyfab_${Date.now().toString(36)}`,
    rejectUnauthorized: false,
    reconnectPeriod:   15_000,
    connectTimeout:    20_000,
  });

  client.on('connect', () => {
    console.log('  [Bambu] MQTT connecté au cloud Bambu Lab');
    if (onStateChange) onStateChange('connected');
    for (const p of printers) {
      client.subscribe(`device/${p.serial}/report`, err => {
        if (!err) console.log(`  [Bambu] Écoute ${p.name || p.serial}`);
        else console.error(`  [Bambu] Erreur subscribe ${p.serial}:`, err.message);
      });
    }
  });

  client.on('message', (topic, msg) => {
    try {
      const data = JSON.parse(msg.toString());
      const print = data.print;
      if (!print) return;

      // On ne s'intéresse qu'aux impressions terminées
      if (print.gcode_state !== 'FINISH') return;

      const serial = topic.split('/')[1];
      const printer = printers.find(p => p.serial === serial);
      const fileName = (print.subtask_name || print.gcode_file || 'Impression')
        .replace(/\.gcode\.3mf$|\.gcode$|\.3mf$/i, '').trim();

      if (isDuplicate(serial, fileName)) return;

      // Couleur filament (string ou tableau AMS)
      let filamentColor = null;
      if (print.filament_color) {
        filamentColor = Array.isArray(print.filament_color)
          ? print.filament_color[0]
          : print.filament_color;
      }

      onPrintComplete({
        printerSerial: serial,
        printerName:   printer?.name || serial,
        fileName,
        filamentColor,
        filamentType:  print.filament_type || null,
        totalLayers:   print.total_layer_num || null,
      });
    } catch { /* ignore parsing errors */ }
  });

  client.on('error',     err => { console.error('  [Bambu] Erreur:', err.message); if (onStateChange) onStateChange('error'); });
  client.on('reconnect', ()  => { console.log('  [Bambu] Reconnexion...'); if (onStateChange) onStateChange('reconnecting'); });
  client.on('offline',   ()  => { console.log('  [Bambu] Hors ligne');     if (onStateChange) onStateChange('offline'); });
  client.on('close',     ()  => { if (onStateChange) onStateChange('disconnected'); });

  return client;
}

module.exports = { getToken, connect };
