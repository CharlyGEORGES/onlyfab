// Première installation sur Cloudflare : crée la base D1 et l'espace KV, remplit
// wrangler.toml, applique le schéma, demande les secrets puis déploie.
// Usage : npm run setup   (après `npx wrangler login`)
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';

const run = (cmd, opts = {}) => {
  console.log('\n$ ' + cmd);
  return execSync(cmd, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8' });
};
const output = e => (e.stdout || '') + (e.stderr || '');
const rl = createInterface({ input: process.stdin, output: process.stdout });
let toml = readFileSync('wrangler.toml', 'utf8');

try { run('npx wrangler whoami', { capture: true }); }
catch { console.log("Connectez-vous d'abord : npx wrangler login"); process.exit(1); }

// --- base D1
if (toml.includes('database_id = "A_REMPLIR"')) {
  let out;
  try { out = run('npx wrangler d1 create alain-georges', { capture: true }); }
  catch (e) {
    out = output(e);
    if (!/already exists/i.test(out)) { console.error(out); process.exit(1); }
    out = run('npx wrangler d1 info alain-georges', { capture: true });
  }
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  if (!m) { console.error('Identifiant D1 introuvable dans :\n' + out); process.exit(1); }
  toml = toml.replace('database_id = "A_REMPLIR"', `database_id = "${m[0]}"`);
  writeFileSync('wrangler.toml', toml);
  console.log('Base D1 : ' + m[0]);
}

// --- espace KV
if (/\[\[kv_namespaces\]\][^[]*id = "A_REMPLIR"/.test(toml)) {
  let out;
  try { out = run('npx wrangler kv namespace create MEDIA', { capture: true }); }
  catch (e) { out = output(e); }
  let id = (out.match(/id\s*=\s*"([0-9a-f]{32})"/) || [])[1];
  if (!id) {
    const list = run('npx wrangler kv namespace list', { capture: true });
    const ns = JSON.parse(list).find(n => /MEDIA/.test(n.title));
    id = ns && ns.id;
  }
  if (!id) { console.error('Identifiant KV introuvable dans :\n' + out); process.exit(1); }
  toml = toml.replace(/(\[\[kv_namespaces\]\][^[]*id = )"A_REMPLIR"/, `$1"${id}"`);
  writeFileSync('wrangler.toml', toml);
  console.log('Espace KV : ' + id);
}

// --- schéma
run('npx wrangler d1 execute alain-georges --remote --yes --file=schema.sql');

// --- secrets
const secret = (name, value) => execSync(`npx wrangler secret put ${name}`, { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
const pw = (await rl.question("\nMot de passe de l'espace famille (plusieurs possibles, séparés par des virgules) : ")).trim();
if (pw) secret('ADMIN_PASSWORD', pw);
secret('SESSION_SECRET', randomBytes(32).toString('hex'));
const mail = (await rl.question('Courriel pour être prévenu des contributions (vide = pas de notification) : ')).trim();
if (mail) {
  secret('NOTIFY_EMAIL', mail);
  const key = (await rl.question('Clé API Resend (resend.com, gratuit ; vide = plus tard) : ')).trim();
  if (key) secret('RESEND_API_KEY', key);
}
rl.close();

// --- déploiement
run('npx wrangler deploy');
console.log("\nTerminé. Le site est en ligne à l'adresse affichée ci-dessus ; l'espace famille est sur /admin.");
