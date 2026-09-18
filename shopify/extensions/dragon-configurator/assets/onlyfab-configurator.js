/* Onlyfab — pont entre le configurateur 3D (iframe) et le panier natif Shopify.
 *
 * Rôle :
 *  1. Écouter les messages du configurateur (source "onlyfab-configurator").
 *  2. À "ready" : renvoyer les tailles disponibles (tiers) + la devise -> le
 *     configurateur contraint son curseur de taille aux variantes réelles.
 *  3. À "price" : trouver la variante Shopify correspondante et renvoyer son
 *     prix réel ("setprice") -> le configurateur affiche le prix qui sera facturé.
 *  4. À "add" : ajouter la variante au panier via /cart/add.js, avec la config
 *     complète en propriétés de ligne (dont la fiche de production en _spec).
 *
 * Aucun backend requis : tout passe par l'AJAX Cart de Shopify.
 */
(function () {
  'use strict';

  var HOST = 'onlyfab-host';
  var GUEST = 'onlyfab-configurator';

  function parseNum(s) {
    if (s == null) return null;
    var m = String(s).replace(',', '.').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }
  function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
  function originOf(url) { try { return new URL(url, location.href).origin; } catch (e) { return '*'; } }

  function initBlock(root) {
    if (root.__onlyfabInit) return;
    root.__onlyfabInit = true;

    var iframe = root.querySelector('iframe.onlyfab-configurator__frame');
    var dataEl = root.querySelector('script[data-onlyfab-data]');
    if (!iframe || !dataEl) return;

    var data;
    try { data = JSON.parse(dataEl.textContent); } catch (e) { console.warn('[onlyfab] données illisibles', e); return; }

    var cfgOrigin = originOf(iframe.getAttribute('src'));
    var settings = data.settings || {};
    var product = data.product || {};
    var options = product.options || [];        // noms des options, dans l'ordre
    var variants = product.variants || [];
    var routes = data.routes || {};
    var shop = data.shop || {};
    var locale = (document.documentElement.lang || 'fr-FR').replace('_', '-');

    // Index des axes de prix dans product.options (par nom, insensible à la casse).
    function optIndex(name) {
      if (!name) return -1;
      var n = norm(name);
      for (var i = 0; i < options.length; i++) if (norm(options[i]) === n) return i;
      return -1;
    }
    var idxSize = optIndex(settings.optionSize);
    var idxFinish = optIndex(settings.optionFinish);
    var idxEng = optIndex(settings.optionEngraving);

    // Tailles disponibles (tiers) déduites des variantes.
    function sizeTiers() {
      if (idxSize < 0) return [];
      var set = {};
      variants.forEach(function (v) {
        var cm = parseNum((v.options || [])[idxSize]);
        if (cm != null) set[cm] = true;
      });
      return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    }

    function post(type, extra) {
      var msg = { source: HOST, type: type };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
      try { iframe.contentWindow.postMessage(msg, cfgOrigin === '*' ? '*' : cfgOrigin); } catch (e) {}
    }

    // ---- Analyse d'un payload configurateur -> axes de choix ----
    function readChoice(payload) {
      payload = payload || {};
      var props = payload.properties || {};
      var spec = payload.spec || {};
      var zones = spec.zones || [];

      var sizeCm = parseNum(props['Taille']);

      // Premium = au moins une zone premium, ou une finition spéciale (non "uni").
      var premium = false;
      zones.forEach(function (z) { if (z && (z.premium || (z.type && z.type !== 'uni'))) premium = true; });
      if (!premium) {
        Object.keys(props).forEach(function (k) {
          var val = norm(props[k]);
          if (val.indexOf('(premium)') >= 0 || val.indexOf('(finition)') >= 0) premium = true;
        });
      }

      // Gravure = propriété "Gravure" non vide / différente de "—".
      var eng = props['Gravure'];
      var engraving = !!(eng && norm(eng) !== '—' && norm(eng) !== '');

      return { sizeCm: sizeCm, premium: premium, engraving: engraving };
    }

    // Trouve la variante qui correspond le mieux aux axes disponibles.
    function matchVariant(choice) {
      if (!variants.length) return null;

      // Valeurs cibles par axe présent dans le produit.
      var targetSize = null;
      if (idxSize >= 0 && choice.sizeCm != null) {
        // valeur d'option dont le nombre est le plus proche de la taille choisie
        var best = null, bestD = Infinity;
        variants.forEach(function (v) {
          var cm = parseNum((v.options || [])[idxSize]);
          if (cm == null) return;
          var d = Math.abs(cm - choice.sizeCm);
          if (d < bestD) { bestD = d; best = (v.options || [])[idxSize]; }
        });
        targetSize = best;
      }
      var premiumLabel = norm(settings.valuePremium || 'Premium');
      var engYesLabel = norm(settings.valueEngravingYes || 'Avec');

      function matches(v, strict) {
        var o = v.options || [];
        if (targetSize != null && norm(o[idxSize]) !== norm(targetSize)) return false;
        if (idxFinish >= 0) {
          var isPrem = norm(o[idxFinish]) === premiumLabel;
          if (choice.premium !== isPrem) return false;
        }
        if (idxEng >= 0) {
          var isYes = norm(o[idxEng]) === engYesLabel;
          if (choice.engraving !== isYes) return false;
        }
        if (strict && !v.available) return false;
        return true;
      }

      // 1) correspondance exacte + disponible, 2) exacte, 3) même taille, 4) 1re dispo
      var v = variants.filter(function (x) { return matches(x, true); })[0]
           || variants.filter(function (x) { return matches(x, false); })[0];
      if (!v && targetSize != null) {
        v = variants.filter(function (x) { return norm((x.options || [])[idxSize]) === norm(targetSize); })[0];
      }
      if (!v) v = variants.filter(function (x) { return x.available; })[0] || variants[0];
      return v || null;
    }

    function pushPrice(payload) {
      var v = matchVariant(readChoice(payload));
      if (!v) return;
      var note = v.available ? null : 'Cette combinaison est momentanément indisponible.';
      post('setprice', {
        amount: (v.price || 0) / 100,   // Shopify: prix en centimes
        currency: shop.currency || 'EUR',
        locale: locale,
        note: note
      });
    }

    // Construit les propriétés de ligne (visibles + techniques cachées "_").
    function lineProperties(payload) {
      var props = {};
      var src = (payload && payload.properties) || {};
      Object.keys(src).forEach(function (k) { if (src[k] != null && src[k] !== '') props[k] = String(src[k]); });
      if (payload && payload.spec) props['_spec'] = JSON.stringify(payload.spec);
      if (payload && payload.delay) props['_delai_jours'] = payload.delay.min + '-' + payload.delay.max;
      return props;
    }

    function openCartDrawer() {
      // Rafraîchit les sections panier du thème si possible, sinon ouvre /cart.
      document.dispatchEvent(new CustomEvent('onlyfab:added'));
      var drawer = document.querySelector('cart-drawer, #CartDrawer, .drawer--cart, #cart-notification, cart-notification');
      if (drawer && (drawer.open || drawer.show)) {
        try { (drawer.open || drawer.show).call(drawer); return true; } catch (e) {}
      }
      // Bouton d'ouverture du tiroir (thèmes type Dawn)
      var toggle = document.querySelector('[aria-controls="CartDrawer"], .header__icon--cart, a[href$="/cart"]');
      if (toggle && toggle.click) { try { toggle.click(); return true; } catch (e) {} }
      return false;
    }

    function addToCart(payload, qty) {
      var choice = readChoice(payload);
      var v = matchVariant(choice);
      if (!v) { post('error', { message: 'Aucune variante ne correspond à cette configuration.' }); return; }
      if (!v.available) { post('error', { message: 'Cette combinaison est indisponible en stock.' }); return; }

      var body = {
        items: [{
          id: v.id,
          quantity: Math.max(1, parseInt(qty, 10) || 1),
          properties: lineProperties(payload)
        }]
      };
      fetch((routes.cartAdd || '/cart/add') + '.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error((e && e.description) || 'Ajout refusé'); });
        return r.json();
      }).then(function () {
        post('added', {});
        var mode = settings.afterAdd || 'drawer';
        if (mode === 'cart') { window.top.location.href = routes.cart || '/cart'; }
        else if (mode === 'drawer') { if (!openCartDrawer()) window.top.location.href = routes.cart || '/cart'; }
        // 'stay' : ne rien faire
      }).catch(function (err) {
        post('error', { message: err.message || 'Impossible d\'ajouter au panier.' });
      });
    }

    // ---- Écoute des messages du configurateur ----
    window.addEventListener('message', function (ev) {
      if (cfgOrigin !== '*' && ev.origin !== cfgOrigin) return;
      var d = ev.data || {};
      if (d.source !== GUEST) return;
      if (d.type === 'ready') {
        post('configure', { sizeTiers: sizeTiers(), currency: shop.currency || 'EUR', locale: locale });
        if (settings.modelKey) post('select-model', { model: settings.modelKey });
        if (d.payload) pushPrice(d.payload);
      } else if (d.type === 'price') {
        if (d.payload) pushPrice(d.payload);
      } else if (d.type === 'add') {
        if (d.payload) addToCart(d.payload, d.qty);
      }
    });
  }

  function initAll() {
    var nodes = document.querySelectorAll('[data-onlyfab-configurator]');
    for (var i = 0; i < nodes.length; i++) initBlock(nodes[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
  // Re-init si le thème réinjecte la section (éditeur de thème / sections dynamiques)
  document.addEventListener('shopify:section:load', initAll);
})();
