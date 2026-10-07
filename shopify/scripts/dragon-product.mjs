#!/usr/bin/env node
/* Génère (et, avec un jeton, crée) le produit Shopify d'un dragon à partir de la config
 * de l'atelier publiée par le serveur du configurateur.
 *
 *   node shopify/scripts/dragon-product.mjs <cle-modele> [--server https://onlyfab.fly.dev] [--apply]
 *
 * Sans --apply : affiche les entrées GraphQL (productCreate + productVariantsBulkCreate +
 * publishablePublish) à exécuter, par exemple depuis une session Claude via l'outil Shopify.
 * Avec --apply : les exécute avec SHOPIFY_SHOP (ex. onlyfab.myshopify.com) et
 * SHOPIFY_ADMIN_TOKEN (jeton Admin API, scopes write_products + write_publications).
 *
 * Conventions (lues par le pont onlyfab-configurator.js) :
 *   - options  : Taille (« 6 cm »…) × Finition (« <déclinaison> » / « <déclinaison> premium ») × Gravure (Sans / Avec)
 *   - prix     : base_déclinaison × (cm / refCm) ^ exposant  (+ premium) (+ frais de gravure)
 *   - produit  : statut UNLISTED (lien direct seulement), métachamp onlyfab.model_key = clé du modèle,
 *                template « dragon-configurateur », vente sans stock (fabrication à la demande).
 */
const args = process.argv.slice(2);
const key = args.find(a => !a.startsWith('--'));
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SERVER = opt('--server', 'https://onlyfab.fly.dev');
const APPLY = args.includes('--apply');
const SIZES = (opt('--sizes', '6,9,12,15,18')).split(',').map(Number);
const PUBLICATION = opt('--publication', 'gid://shopify/Publication/286118805849'); // « Boutique en ligne »
if (!key) { console.error('usage: dragon-product.mjs <cle-modele> [--server URL] [--sizes 6,9,12] [--apply]'); process.exit(1); }

const [models, configs] = await Promise.all([
  fetch(`${SERVER}/api/configurator/models`).then(r => r.json()),
  fetch(`${SERVER}/api/configurator/configs`).then(r => r.json()),
]);
const model = (models.models || []).find(m => m.key === key);
const cfg = (configs.configs || {})[key];
if (!model || !cfg) { console.error(`modèle « ${key} » introuvable sur ${SERVER}`); process.exit(1); }

const sz = cfg.size || {}, ref = sz.refCm || 10, exp = sz.exp || 2;
const prem = (cfg.premium && cfg.premium.surcharge) || 0, grav = (cfg.engraving && cfg.engraving.offered) ? (cfg.engraving.fee || 0) : null;
const finitions = [];
for (const v of cfg.variants || []) { finitions.push({ name: v.name, base: v.price, premium: false }); finitions.push({ name: `${v.name} premium`, base: v.price, premium: true }); }
const gravures = grav == null ? ['Sans'] : ['Sans', 'Avec'];
const variants = [];
for (const cm of SIZES) for (const f of finitions) for (const g of gravures) {
  const price = f.base * Math.pow(cm / ref, exp) + (f.premium ? prem : 0) + (g === 'Avec' ? grav : 0);
  variants.push({ price: price.toFixed(2), inventoryPolicy: 'CONTINUE', inventoryItem: { tracked: false },
    optionValues: [{ optionName: 'Taille', name: `${cm} cm` }, { optionName: 'Finition', name: f.name }, { optionName: 'Gravure', name: g }] });
}
if (variants.length > 100) console.warn(`attention : ${variants.length} variantes (limite Shopify : 100 sur les plans de base)`);
const handle = `${model.name}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const product = {
  title: model.name, handle, status: 'UNLISTED', productType: 'Dragon', vendor: 'Onlyfab',
  tags: ['dragon', 'articulé', 'impression 3D', 'configurateur', 'fait main', 'Fontainebleau'],
  templateSuffix: 'dragon-configurateur',
  descriptionHtml: `<p>Dragon articulé imprimé en 3D dans notre atelier de Fontainebleau. Choisis sa taille, ses couleurs, sa finition et une gravure personnalisée directement dans le configurateur 3D.</p>`,
  metafields: [{ namespace: 'onlyfab', key: 'model_key', type: 'single_line_text_field', value: key }],
  productOptions: [
    { name: 'Taille', position: 1, values: SIZES.map(cm => ({ name: `${cm} cm` })) },
    { name: 'Finition', position: 2, values: finitions.map(f => ({ name: f.name })) },
    { name: 'Gravure', position: 3, values: gravures.map(g => ({ name: g })) },
  ],
};
const ops = {
  productCreate: { query: 'mutation($input: ProductCreateInput!){ productCreate(product:$input){ product{ id handle } userErrors{ field message } } }', variables: { input: product } },
  productVariantsBulkCreate: { query: 'mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!){ productVariantsBulkCreate(productId:$productId, variants:$variants, strategy: REMOVE_STANDALONE_VARIANT){ productVariants{ id title price } userErrors{ field message } } }', variables: { productId: '<id du produit créé>', variants } },
  publishablePublish: { query: 'mutation($id: ID!, $input: [PublicationInput!]!){ publishablePublish(id:$id, input:$input){ userErrors{ field message } } }', variables: { id: '<id du produit créé>', input: [{ publicationId: PUBLICATION }] } },
};
if (!APPLY) { console.log(JSON.stringify({ model: key, variantes: variants.length, ops }, null, 2)); process.exit(0); }

const SHOP = process.env.SHOPIFY_SHOP, TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
if (!SHOP || !TOKEN) { console.error('--apply : définir SHOPIFY_SHOP et SHOPIFY_ADMIN_TOKEN'); process.exit(1); }
const gql = async (query, variables) => {
  const r = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN }, body: JSON.stringify({ query, variables }) });
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors)); return j.data;
};
const c = await gql(ops.productCreate.query, ops.productCreate.variables);
if (c.productCreate.userErrors.length) throw new Error(JSON.stringify(c.productCreate.userErrors));
const id = c.productCreate.product.id; console.log('produit', id, c.productCreate.product.handle);
const v = await gql(ops.productVariantsBulkCreate.query, { productId: id, variants });
if (v.productVariantsBulkCreate.userErrors.length) throw new Error(JSON.stringify(v.productVariantsBulkCreate.userErrors));
console.log('variantes', v.productVariantsBulkCreate.productVariants.length);
const p = await gql(ops.publishablePublish.query, { id, input: [{ publicationId: PUBLICATION }] });
if (p.publishablePublish.userErrors.length) throw new Error(JSON.stringify(p.publishablePublish.userErrors));
console.log('publié sur la Boutique en ligne');
