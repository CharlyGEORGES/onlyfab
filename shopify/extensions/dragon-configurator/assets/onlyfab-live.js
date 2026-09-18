/* Onlyfab — suivi de production live côté client (compte Shopify).
 *
 * Interroge l'App Proxy signé (/apps/onlyfab/live?email=…). Shopify ajoute
 * automatiquement logged_in_customer_id + la signature ; le serveur Onlyfab
 * vérifie et ne renvoie que les impressions du client. Aucune donnée perso,
 * uniquement la progression.
 */
(function () {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function fmtEta(min) {
    if (min == null || !isFinite(min) || min <= 0) return null;
    var h = Math.floor(min / 60), m = Math.round(min % 60);
    return h > 0 ? (h + ' h ' + (m < 10 ? '0' + m : m)) : (m + ' min');
  }

  // Libellé lisible de l'état d'impression.
  var STATE_LABELS = {
    RUNNING: 'Impression en cours', PREPARE: 'Préparation', SLICING: 'Préparation',
    PAUSE: 'En pause', FINISH: 'Terminée', FAILED: 'Interrompue', IDLE: 'En attente'
  };

  function ring(percent) {
    var p = Math.max(0, Math.min(100, percent || 0));
    var r = 52, c = 2 * Math.PI * r, off = c * (1 - p / 100);
    return '' +
      '<svg class="onlyfab-live__ring" viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">' +
      '<circle cx="60" cy="60" r="' + r + '" class="onlyfab-live__ring-bg"></circle>' +
      '<circle cx="60" cy="60" r="' + r + '" class="onlyfab-live__ring-fg" ' +
      'style="stroke-dasharray:' + c.toFixed(1) + ';stroke-dashoffset:' + off.toFixed(1) + '"></circle>' +
      '<text x="60" y="60" class="onlyfab-live__ring-pct">' + Math.round(p) + '%</text>' +
      '</svg>';
  }

  function card(item) {
    var live = item.live;
    var stateKey = live && live.state;
    var stateLabel = (stateKey && STATE_LABELS[stateKey]) || (live ? 'En cours' : 'En attente de l\'atelier');
    var done = stateKey === 'FINISH';
    var paused = stateKey === 'PAUSE';
    var percent = live ? (done ? 100 : (live.percent || 0)) : 0;
    var eta = live && !done ? fmtEta(live.remainingMin) : null;
    var stale = live && live.stale;

    var lines = [];
    if (live && live.layer != null && live.totalLayers) lines.push('Couche ' + live.layer + ' / ' + live.totalLayers);
    if (eta) lines.push('Fin estimée dans ~' + eta);
    if (live && live.stageLabel && !done) lines.push(live.stageLabel);

    return '' +
      '<article class="onlyfab-live__card' + (done ? ' is-done' : '') + (paused ? ' is-paused' : '') + '">' +
        '<div class="onlyfab-live__ringwrap">' + ring(percent) + '</div>' +
        '<div class="onlyfab-live__info">' +
          '<div class="onlyfab-live__order">Commande ' + esc(item.order) + '</div>' +
          '<div class="onlyfab-live__label">' + esc(item.label) + '</div>' +
          '<div class="onlyfab-live__state">' + esc(stateLabel) +
            (stale ? ' <span class="onlyfab-live__stale">(hors ligne)</span>' : '') + '</div>' +
          (lines.length ? '<ul class="onlyfab-live__meta"><li>' + lines.map(esc).join('</li><li>') + '</li></ul>' : '') +
        '</div>' +
      '</article>';
  }

  function initBlock(root) {
    if (root.__onlyfabLive) return;
    root.__onlyfabLive = true;
    var listEl = root.querySelector('[data-onlyfab-live-list]');
    var cfgEl = root.querySelector('script[data-onlyfab-live-config]');
    if (!listEl || !cfgEl) return;

    var cfg;
    try { cfg = JSON.parse(cfgEl.textContent); } catch (e) { return; }
    var url = cfg.endpoint + (cfg.endpoint.indexOf('?') >= 0 ? '&' : '?') + 'email=' + encodeURIComponent(cfg.email || '');
    var pollMs = Math.max(3000, cfg.pollMs || 5000);
    var timer = null, stopped = false;

    function render(data) {
      if (!data || !data.loggedIn) {
        listEl.innerHTML = '<p class="onlyfab-live__empty">Connecte-toi pour voir tes impressions.</p>';
        return;
      }
      var prints = data.prints || [];
      if (!prints.length) {
        listEl.innerHTML = '<p class="onlyfab-live__empty">Aucune impression en cours pour le moment. ' +
          'Tu verras ici la fabrication de ta commande dès qu\'elle démarre à l\'atelier.</p>';
        return;
      }
      listEl.innerHTML = prints.map(card).join('');
    }

    function tick() {
      if (stopped) return;
      fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d) render(d); })
        .catch(function () { /* silencieux : on réessaiera au prochain tick */ })
        .then(function () { if (!stopped) timer = setTimeout(tick, pollMs); });
    }

    // Suspend le polling quand l'onglet est caché (économie batterie/réseau).
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopped = true; clearTimeout(timer); }
      else if (stopped) { stopped = false; tick(); }
    });

    tick();
  }

  function initAll() {
    var nodes = document.querySelectorAll('[data-onlyfab-live]');
    for (var i = 0; i < nodes.length; i++) initBlock(nodes[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
  document.addEventListener('shopify:section:load', initAll);
})();
