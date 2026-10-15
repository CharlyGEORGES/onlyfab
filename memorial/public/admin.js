// Espace famille : validation des contributions, galerie, frise, famille, réglages.
(function () {
  const { $, $$, esc, fmtDate, toast, api, prepareImage, mediaUrl } = Mem;
  const app = $('#app');
  let tab = 'pending';

  init();

  async function init() {
    const me = await api('/api/admin/me');
    if (!me.admin) return renderLogin();
    app.innerHTML = '';
    app.appendChild($('#tpl-admin').content.cloneNode(true));
    $('#logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); location.reload(); });
    $$('#tabs button').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; $$('#tabs button').forEach(x => x.classList.toggle('active', x === b)); render(); }));
    refreshBadge();
    render();
  }

  function renderLogin() {
    app.innerHTML = '';
    app.appendChild($('#tpl-login').content.cloneNode(true));
    $('#login-form').addEventListener('submit', async e => {
      e.preventDefault();
      try { await api('/api/admin/login', { method: 'POST', json: { password: $('#pw').value } }); init(); }
      catch (err) { $('#login-error').textContent = err.message; }
    });
  }

  async function refreshBadge() {
    const rows = await api('/api/admin/posts?status=pending');
    const b = $('#pending-badge'); b.textContent = rows.length; b.classList.toggle('hidden', !rows.length);
  }

  function render() {
    const panel = $('#panel');
    panel.innerHTML = '<p class="muted">Chargement…</p>';
    ({ pending: renderPending, posts: renderPosts, events: renderEvents, family: renderFamily, music: renderMusic, qr: renderQr, settings: renderSettings })[tab](panel);
  }

  // Envoi d'un fichier (photo redimensionnée côté client, ou audio) ; retourne l'enregistrement media.
  async function uploadFile(file) {
    const prepared = /^image\//.test(file.type) ? await prepareImage(file) : { file, thumb: null };
    const fd = new FormData();
    fd.set('file', prepared.file);
    if (prepared.thumb) fd.set('thumb', prepared.thumb);
    return api('/api/admin/media', { method: 'POST', form: fd });
  }

  const KIND = { photo: 'Photo', memory: 'Souvenir', audio: 'Enregistrement', candle: 'Bougie', music: 'Musique' };
  const STATUS = { pending: 'En attente', approved: 'Publié', rejected: 'Refusé' };

  function postCard(p, { editable = true } = {}) {
    const hasMedia = !!p.media_id;
    const mediaHtml = !hasMedia ? '' : p.kind === 'audio'
      ? `<audio controls preload="none" src="${mediaUrl(p.media_id)}" style="width:110px"></audio>`
      : `<a href="${mediaUrl(p.media_id)}" target="_blank"><img class="thumb" src="${mediaUrl(p.media_id, true)}" alt=""></a>`;
    return `
      <div class="item ${hasMedia ? '' : 'no-media'}" data-id="${p.id}">
        ${mediaHtml}
        <div>
          <div class="meta">
            <span class="pill ${p.status}">${STATUS[p.status]}</span><span class="pill">${KIND[p.kind] || p.kind}</span>
            <span>${p.source === 'admin' ? 'Famille' : 'Visiteur'}</span>
            <span>${esc(fmtDate(p.created_at.slice(0, 10)))}</span>
            ${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ''}
          </div>
          ${editable ? `
          <div class="row" style="margin:.6em 0">
            <div><label>${p.kind === 'music' ? 'Artiste' : 'Auteur'}</label><input data-f="author" value="${esc(p.author || '')}"></div>
            <div><label>Titre</label><input data-f="title" value="${esc(p.title || '')}"></div>
            <div><label>Date / année</label><input data-f="taken_at" value="${esc(p.taken_at || '')}"></div>
            <div><label>Lieu</label><input data-f="place" value="${esc(p.place || '')}"></div>
          </div>
          <label>${p.kind === 'music' ? 'Pourquoi cette musique (facultatif)' : 'Texte'}</label><textarea data-f="body">${esc(p.body || '')}</textarea>` : ''}
          <div class="actions">
            ${p.status !== 'approved' ? `<button class="btn-ok btn-sm" data-act="approved">✓ Publier</button>` : ''}
            ${p.status !== 'rejected' ? `<button class="btn-soft btn-sm" data-act="rejected">Refuser</button>` : ''}
            ${p.status !== 'pending' && editable ? `<button class="btn-soft btn-sm" data-act="save">Enregistrer les modifications</button>` : ''}
            <button class="btn-danger btn-sm" data-act="delete">Supprimer</button>
          </div>
        </div>
      </div>`;
  }

  function bindPostActions(root, after) {
    $$('.item', root).forEach(item => {
      const id = item.dataset.id;
      const fields = () => Object.fromEntries($$('[data-f]', item).map(el => [el.dataset.f, el.value]));
      $$('[data-act]', item).forEach(btn => btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        try {
          if (act === 'delete') {
            if (!confirm('Supprimer définitivement cette publication (et son fichier) ?')) return;
            await api(`/api/admin/posts/${id}`, { method: 'DELETE' });
            toast('Supprimé.');
          } else if (act === 'save') {
            await api(`/api/admin/posts/${id}`, { method: 'PATCH', json: fields() });
            toast('Enregistré.');
          } else {
            await api(`/api/admin/posts/${id}`, { method: 'PATCH', json: { ...fields(), status: act } });
            toast(act === 'approved' ? 'Publié sur le site.' : 'Refusé (conservé ici, non publié).');
          }
          refreshBadge(); after && after();
        } catch (e) { toast(e.message, true); }
      }));
    });
  }

  // ------------------------------------------------------------- à valider
  async function renderPending(panel) {
    const rows = await api('/api/admin/posts?status=pending');
    panel.innerHTML = rows.length
      ? `<p class="muted">${rows.length} contribution${rows.length > 1 ? 's' : ''} à relire. Vous pouvez corriger le texte avant de publier.</p><div class="list">${rows.map(p => postCard(p)).join('')}</div>`
      : `<div class="card center"><p>Rien à valider pour le moment.</p><p class="hint">Les souvenirs, photos et messages vocaux proposés par les visiteurs apparaîtront ici.</p></div>`;
    bindPostActions(panel, render);
  }

  // ------------------------------------------------------------- photos & souvenirs
  async function renderPosts(panel) {
    const status = panel.dataset.filter || 'approved';
    const rows = (await api(`/api/admin/posts?status=${status}`)).filter(p => p.kind !== 'candle' && p.kind !== 'music');
    panel.innerHTML = `
      <div class="card" style="margin-bottom:1.4em">
        <h3>Ajouter</h3>
        <div class="row">
          <div>
            <label>Photos (plusieurs à la fois)</label>
            <input type="file" id="add-photos" accept="image/*" multiple>
            <p class="hint">Redimensionnées automatiquement. Vous pourrez ensuite ajouter titre, date et lieu.</p>
            <div id="add-progress" class="hint"></div>
          </div>
          <div>
            <label>Un souvenir écrit par la famille</label>
            <input id="add-author" placeholder="Signé (ex. : Ses enfants)" style="margin-bottom:.5em">
            <textarea id="add-body" placeholder="Texte du souvenir…" style="min-height:80px"></textarea>
            <button class="btn-sm" id="add-memory" style="margin-top:.5em">Publier ce souvenir</button>
          </div>
        </div>
      </div>
      <div class="toolbar">
        <span class="muted">Afficher :</span>
        ${['approved', 'rejected', 'all'].map(s => `<button class="btn-sm ${s === status ? '' : 'btn-soft'}" data-filter="${s}">${{ approved: 'Publiés', rejected: 'Refusés', all: 'Tous' }[s]}</button>`).join('')}
        <span class="hint" style="margin-left:auto">Ordre d'affichage : ▲ ▼ sur chaque photo</span>
      </div>
      <div class="list" id="post-list">${rows.map(p => postCard(p)).join('') || '<p class="muted">Aucune publication.</p>'}</div>`;

    $$('[data-filter]', panel).forEach(b => b.addEventListener('click', () => { panel.dataset.filter = b.dataset.filter; render(); }));
    bindPostActions(panel, render);

    // Boutons d'ordre
    $$('#post-list .item', panel).forEach(item => {
      const act = $('.actions', item);
      act.insertAdjacentHTML('beforeend', `<button class="btn-soft btn-sm" data-move="-1" title="Monter">▲</button><button class="btn-soft btn-sm" data-move="1" title="Descendre">▼</button>`);
      $$('[data-move]', item).forEach(b => b.addEventListener('click', async () => {
        const list = $('#post-list', panel), items = $$('.item', list), i = items.indexOf(item), j = i + +b.dataset.move;
        if (j < 0 || j >= items.length) return;
        list.insertBefore(item, +b.dataset.move < 0 ? items[j] : items[j].nextSibling);
        await api('/api/admin/reorder', { method: 'POST', json: { table: 'posts', ids: $$('.item', list).map(x => x.dataset.id) } });
      }));
    });

    $('#add-photos', panel).addEventListener('change', async e => {
      const files = Array.from(e.target.files); let n = 0;
      for (const f of files) {
        $('#add-progress', panel).textContent = `Envoi ${++n} / ${files.length}…`;
        try {
          const prepared = await prepareImage(f);
          const fd = new FormData(); fd.set('kind', 'photo'); fd.set('file', prepared.file); if (prepared.thumb) fd.set('thumb', prepared.thumb);
          await api('/api/admin/posts', { method: 'POST', form: fd });
        } catch (err) { toast(`${f.name} : ${err.message}`, true); }
      }
      toast(`${files.length} photo${files.length > 1 ? 's' : ''} ajoutée${files.length > 1 ? 's' : ''}.`);
      panel.dataset.filter = 'approved'; render();
    });
    $('#add-memory', panel).addEventListener('click', async () => {
      const body = $('#add-body', panel).value.trim();
      if (!body) return toast('Écrivez le texte du souvenir.', true);
      const fd = new FormData(); fd.set('kind', 'memory'); fd.set('body', body); fd.set('author', $('#add-author', panel).value.trim() || 'La famille');
      await api('/api/admin/posts', { method: 'POST', form: fd });
      toast('Souvenir publié.'); render();
    });
  }

  // ------------------------------------------------------------- champ photo réutilisable (réglages, frise, famille)
  function mediaPicker(id, currentId, { round = false } = {}) {
    return `<div class="media-pick" data-picker="${id}" data-media="${esc(currentId || '')}">
      <img src="${currentId ? mediaUrl(currentId, true) : ''}" alt="" style="${round ? 'border-radius:50%' : ''}${currentId ? '' : ';visibility:hidden'}">
      <div><input type="file" accept="image/*" data-pick-file><div class="hint">JPEG, PNG, WebP</div>
      ${currentId ? `<button type="button" class="btn-ghost btn-sm" data-pick-clear>Retirer la photo</button>` : ''}</div>
    </div>`;
  }
  function bindPickers(root) {
    $$('[data-picker]', root).forEach(p => {
      $('[data-pick-file]', p).addEventListener('change', async e => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const m = await uploadFile(f);
          p.dataset.media = m.id; const img = $('img', p); img.src = mediaUrl(m.id, true); img.style.visibility = '';
          toast('Photo envoyée, pensez à enregistrer.');
        } catch (err) { toast(err.message, true); }
      });
      const clear = $('[data-pick-clear]', p);
      if (clear) clear.addEventListener('click', () => { p.dataset.media = ''; $('img', p).style.visibility = 'hidden'; });
    });
  }
  const pickerValue = (root, id) => $(`[data-picker="${id}"]`, root).dataset.media || '';

  // ------------------------------------------------------------- frise de vie
  async function renderEvents(panel) {
    const site = await api('/api/site');
    const events = site.events;
    const form = (e = {}) => `
      <form class="card" data-event="${e.id || ''}" style="margin-bottom:1em">
        <div class="row">
          <div><label>Date (AAAA, AAAA-MM ou AAAA-MM-JJ) *</label><input name="date" value="${esc(e.date || '')}" required placeholder="1952-03-14"></div>
          <div><label>Titre *</label><input name="title" value="${esc(e.title || '')}" required placeholder="Naissance à Lyon"></div>
          <div><label>Lieu</label><input name="place" value="${esc(e.place || '')}" placeholder="Lyon"></div>
        </div>
        <div class="field"><label>Texte</label><textarea name="body" style="min-height:70px">${esc(e.body || '')}</textarea></div>
        <div class="row">
          <div><label>Latitude (pour la carte)</label><input name="lat" value="${e.lat ?? ''}" placeholder="45.7640"></div>
          <div><label>Longitude</label><input name="lng" value="${e.lng ?? ''}" placeholder="4.8357"></div>
          <div><label>Photo</label>${mediaPicker('ev-' + (e.id || 'new'), e.media_id)}</div>
        </div>
        <p class="hint">Astuce : sur Google Maps, clic droit sur un lieu → la première ligne donne « latitude, longitude ».</p>
        <div class="actions" style="display:flex;gap:.5em;flex-wrap:wrap">
          <button type="submit" class="btn-sm">${e.id ? 'Enregistrer' : 'Ajouter l\'étape'}</button>
          ${e.id ? `<button type="button" class="btn-danger btn-sm" data-del>Supprimer</button>` : ''}
        </div>
      </form>`;
    panel.innerHTML = `<h3>Nouvelle étape</h3>${form()}<h3 style="margin-top:2em">Étapes (${events.length})</h3>${events.map(form).join('') || '<p class="muted">Aucune étape pour l\'instant.</p>'}`;
    bindPickers(panel);
    $$('form[data-event]', panel).forEach(f => {
      const id = f.dataset.event;
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const fd = new FormData(f);
        const body = Object.fromEntries(fd.entries());
        body.media_id = pickerValue(panel, 'ev-' + (id || 'new'));
        try {
          await api(id ? `/api/admin/events/${id}` : '/api/admin/events', { method: id ? 'PATCH' : 'POST', json: body });
          toast('Enregistré.'); render();
        } catch (err) { toast(err.message, true); }
      });
      const del = $('[data-del]', f);
      if (del) del.addEventListener('click', async () => {
        if (!confirm('Supprimer cette étape ?')) return;
        await api(`/api/admin/events/${id}`, { method: 'DELETE' }); render();
      });
    });
  }

  // ------------------------------------------------------------- famille
  async function renderFamily(panel) {
    const site = await api('/api/site');
    const people = site.family;
    const form = (p = {}) => `
      <form class="card" data-person="${p.id || ''}" style="margin-bottom:1em">
        <div class="row">
          <div><label>Nom *</label><input name="name" value="${esc(p.name || '')}" required></div>
          <div><label>Lien *</label><input name="relation" value="${esc(p.relation || '')}" required placeholder="Épouse, Fils, Petite-fille…"></div>
          <div><label>Groupe</label><input name="grp" value="${esc(p.grp || 'Famille')}" placeholder="Famille, Enfants, Petits-enfants…"></div>
          <div><label>Ordre</label><input name="sort" type="number" value="${p.sort || 0}"></div>
          <div><label>Photo</label>${mediaPicker('fa-' + (p.id || 'new'), p.media_id, { round: true })}</div>
        </div>
        <div style="display:flex;gap:.5em;flex-wrap:wrap">
          <button type="submit" class="btn-sm">${p.id ? 'Enregistrer' : 'Ajouter'}</button>
          ${p.id ? `<button type="button" class="btn-danger btn-sm" data-del>Supprimer</button>` : ''}
        </div>
      </form>`;
    panel.innerHTML = `<h3>Ajouter un proche</h3>${form()}<h3 style="margin-top:2em">Proches (${people.length})</h3>${people.map(form).join('') || '<p class="muted">Personne pour l\'instant.</p>'}`;
    bindPickers(panel);
    $$('form[data-person]', panel).forEach(f => {
      const id = f.dataset.person;
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(f).entries());
        body.media_id = pickerValue(panel, 'fa-' + (id || 'new'));
        try {
          await api(id ? `/api/admin/family/${id}` : '/api/admin/family', { method: id ? 'PATCH' : 'POST', json: body });
          toast('Enregistré.'); render();
        } catch (err) { toast(err.message, true); }
      });
      const del = $('[data-del]', f);
      if (del) del.addEventListener('click', async () => {
        if (!confirm('Retirer cette personne ?')) return;
        await api(`/api/admin/family/${id}`, { method: 'DELETE' }); render();
      });
    });
  }

  // ------------------------------------------------------------- musiques
  async function renderMusic(panel) {
    const rows = (await api('/api/admin/posts?status=all')).filter(p => p.kind === 'music');
    panel.innerHTML = `
      <div class="card" style="margin-bottom:1.4em">
        <h3>Ajouter une musique</h3>
        <p class="hint">Un fichier MP3, M4A ou OGG par morceau. Les visiteurs l'écoutent avec un lecteur discret, jamais en lecture automatique.</p>
        <div class="row">
          <div><label>Titre *</label><input id="m-title" placeholder="La Montagne"></div>
          <div><label>Artiste</label><input id="m-artist" placeholder="Jean Ferrat"></div>
        </div>
        <div class="field"><label>Pourquoi cette musique (facultatif)</label><input id="m-note" placeholder="Il la chantait en voiture…"></div>
        <div class="field"><label>Fichier audio *</label><input type="file" id="m-file" accept="audio/*,.mp3,.m4a,.ogg"></div>
        <button class="btn-sm" id="m-add">Ajouter</button> <span class="hint" id="m-progress"></span>
      </div>
      <h3>Morceaux (${rows.length})</h3>
      <div class="list" id="post-list">${rows.map(p => postCard(p)).join('') || '<p class="muted">Aucune musique pour l\'instant.</p>'}</div>`;
    bindPostActions(panel, render);
    $$('#post-list .item', panel).forEach(item => {
      const act = $('.actions', item);
      act.insertAdjacentHTML('beforeend', `<button class="btn-soft btn-sm" data-move="-1" title="Monter">▲</button><button class="btn-soft btn-sm" data-move="1" title="Descendre">▼</button>`);
      $$('[data-move]', item).forEach(b => b.addEventListener('click', async () => {
        const list = $('#post-list', panel), items = $$('.item', list), i = items.indexOf(item), j = i + +b.dataset.move;
        if (j < 0 || j >= items.length) return;
        list.insertBefore(item, +b.dataset.move < 0 ? items[j] : items[j].nextSibling);
        await api('/api/admin/reorder', { method: 'POST', json: { table: 'posts', ids: $$('.item', list).map(x => x.dataset.id) } });
      }));
    });
    $('#m-add', panel).addEventListener('click', async () => {
      const f = $('#m-file', panel).files[0], title = $('#m-title', panel).value.trim();
      if (!title) return toast('Indiquez le titre.', true);
      if (!f) return toast('Choisissez le fichier audio.', true);
      const fd = new FormData();
      fd.set('kind', 'music'); fd.set('title', title); fd.set('author', $('#m-artist', panel).value.trim()); fd.set('body', $('#m-note', panel).value.trim());
      fd.set('file', f.type ? f : new File([f], f.name, { type: 'audio/mpeg' }));
      $('#m-progress', panel).textContent = 'Envoi…';
      try { await api('/api/admin/posts', { method: 'POST', form: fd }); toast('Musique ajoutée.'); render(); }
      catch (e) { toast(e.message, true); $('#m-progress', panel).textContent = ''; }
    });
  }

  // ------------------------------------------------------------- QR code
  async function renderQr(panel) {
    panel.innerHTML = `
      <div class="card">
        <h3>QR code pour la cérémonie</h3>
        <p class="hint">À imprimer sur le livret, un chevalet ou une affiche : les invités scannent et arrivent directement sur le site.</p>
        <div class="row">
          <div><label>Adresse encodée</label><input id="qr-url" value="${esc(location.origin + '/')}"></div>
          <div><label>Texte sous le code</label><input id="qr-text" value="Partagez vos souvenirs d'Alain"></div>
        </div>
        <div class="row" style="align-items:start">
          <div id="qr-box" style="display:grid;justify-items:center;gap:.6em;background:#fff;color:#000;padding:1.2em;border-radius:12px;max-width:360px">
            <div id="qr-canvas"></div>
            <div id="qr-caption" style="font-family:var(--serif);font-size:1.3rem;text-align:center;color:#000"></div>
            <div id="qr-url-text" style="font-size:.8rem;color:#444;text-align:center;word-break:break-all"></div>
          </div>
          <div style="display:grid;gap:.6em;align-content:start">
            <button class="btn-sm" id="qr-download">Télécharger en PNG</button>
            <button class="btn-soft btn-sm" id="qr-print">Imprimer</button>
            <p class="hint">Testez-le avec votre téléphone avant d'imprimer.</p>
          </div>
        </div>
      </div>`;
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
    const draw = () => {
      const box = $('#qr-canvas', panel); box.innerHTML = '';
      new QRCode(box, { text: $('#qr-url', panel).value.trim(), width: 280, height: 280, correctLevel: QRCode.CorrectLevel.M });
      $('#qr-caption', panel).textContent = $('#qr-text', panel).value;
      $('#qr-url-text', panel).textContent = $('#qr-url', panel).value.trim();
    };
    draw();
    $('#qr-url', panel).addEventListener('input', draw); $('#qr-text', panel).addEventListener('input', draw);
    $('#qr-download', panel).addEventListener('click', () => {
      const c = $('#qr-canvas canvas', panel); if (!c) return;
      const a = document.createElement('a'); a.download = 'qr-code-hommage.png'; a.href = c.toDataURL('image/png'); a.click();
    });
    $('#qr-print', panel).addEventListener('click', () => {
      const w = window.open('', '_blank');
      w.document.write(`<title>QR code</title><body style="display:grid;place-items:center;height:100vh;margin:0;font-family:Georgia,serif;text-align:center"><div><img src="${$('#qr-canvas canvas', panel).toDataURL('image/png')}" style="width:70vmin"><div style="font-size:2.2em;margin-top:.5em">${esc($('#qr-text', panel).value)}</div><div style="color:#444;margin-top:.4em">${esc($('#qr-url', panel).value)}</div></div></body>`);
      w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
    });
  }
  function loadScript(src) {
    return new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }

  // ------------------------------------------------------------- réglages
  async function renderSettings(panel) {
    const s = await api('/api/admin/settings');
    const text = (k, label, ph = '', type = 'text') => `<div class="field"><label>${label}</label><input name="${k}" type="${type}" value="${esc(s[k])}" placeholder="${esc(ph)}"></div>`;
    const area = (k, label, h = 120, hint = '') => `<div class="field"><label>${label}</label><textarea name="${k}" style="min-height:${h}px">${esc(s[k])}</textarea>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    const check = (k, label) => `<label style="display:flex;gap:.6em;align-items:center;color:var(--ink)"><input type="checkbox" name="${k}" ${s[k] === '1' ? 'checked' : ''} style="width:auto"> ${label}</label>`;
    panel.innerHTML = `
      <form id="settings-form">
        <div class="card" style="margin-bottom:1.2em"><h3>Identité</h3>
          <div class="row">${text('name', 'Nom complet *')}${text('subtitle', 'Sous-titre', 'Père, grand-père, ami fidèle…')}</div>
          <div class="row">${text('birth_date', 'Date de naissance', '1952-03-14', 'date')}${text('death_date', 'Date de décès', '', 'date')}</div>
          <div class="row">${text('birth_place', 'Lieu de naissance')}${text('death_place', 'Lieu de décès')}</div>
          <div class="row">
            <div><label>Grande photo d'en-tête (paysage)</label>${mediaPicker('hero', s.hero_media)}</div>
            <div><label>Portrait (rond)</label>${mediaPicker('portrait', s.portrait_media, { round: true })}</div>
          </div>
        </div>
        <div class="card" style="margin-bottom:1.2em"><h3>Textes</h3>
          ${text('intro_quote', 'Citation d\'ouverture', 'Une phrase qu\'il aimait, un vers…')}
          ${area('main_text', 'Texte principal (sa vie, qui il était)', 260, 'Paragraphes séparés par une ligne vide. **gras**, *italique*.')}
        </div>
        <div class="card" style="margin-bottom:1.2em"><h3>Informations pratiques</h3>
          ${area('ceremony', 'Cérémonie, lieu, horaires, remerciements', 100, 'Affiché en haut du site jusqu\'à la date ci-dessous.')}
          <div class="row">${text('ceremony_until', 'Masquer ces informations après le', '', 'date')}${text('donation_url', 'Lien d\'une cagnotte ou association', 'https://…')}${text('donation_label', 'Libellé du bouton', 'Faire un don à …')}</div>
        </div>
        <div class="card" style="margin-bottom:1.2em"><h3>Accès et rubriques</h3>
          <div class="row">${text('access_code', 'Code d\'accès (vide = site public)', 'Laisser vide pour un site ouvert à tous')}${text('accent', 'Couleur d\'accent', '#8a6d3b', 'color')}</div>
          <div style="display:grid;gap:.5em">
            ${check('contributions_open', 'Permettre aux visiteurs de proposer des souvenirs et des photos')}
            ${check('show_candles', 'Afficher les bougies')}
            ${check('show_family', 'Afficher la famille')}
            ${check('show_map', 'Afficher la carte des lieux (étapes avec coordonnées)')}
          </div>
        </div>
        <button type="submit">Enregistrer les réglages</button>
      </form>`;
    bindPickers(panel);
    $('#settings-form', panel).addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, body = {};
      $$('input, textarea', f).forEach(el => {
        if (!el.name) return;
        body[el.name] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
      });
      body.hero_media = pickerValue(panel, 'hero');
      body.portrait_media = pickerValue(panel, 'portrait');
      try { await api('/api/admin/settings', { method: 'PUT', json: body }); toast('Réglages enregistrés.'); }
      catch (err) { toast(err.message, true); }
    });
  }
})();
