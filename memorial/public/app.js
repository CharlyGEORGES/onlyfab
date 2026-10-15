// Site public : chargement des données et rendu des sections.
(function () {
  const { $, $$, esc, rich, fmtDate, year, toast, api, prepareImage, mediaUrl } = Mem;
  const app = $('#app');
  let data = null;
  let lightboxItems = [], lightboxIndex = 0;

  load();

  async function load() {
    try {
      data = await api('/api/site');
    } catch (e) {
      app.innerHTML = `<div class="lock"><div class="card"><p>Le site n'est pas joignable pour le moment.</p><p class="hint">${esc(e.message)}</p></div></div>`;
      return;
    }
    if (data.locked) return renderLock();
    renderSite();
  }

  // ------------------------------------------------------------- accès réservé
  function renderLock() {
    app.innerHTML = '';
    app.appendChild($('#tpl-lock').content.cloneNode(true));
    const s = data.settings;
    $('#lock-name').textContent = s.name;
    $('#lock-dates').textContent = dateRange(s);
    document.title = s.name;
    $('#lock-form').addEventListener('submit', async e => {
      e.preventDefault();
      $('#lock-error').textContent = '';
      try {
        await api('/api/access', { method: 'POST', json: { code: $('#lock-code').value } });
        load();
      } catch (err) { $('#lock-error').textContent = err.message; }
    });
  }

  function dateRange(s) {
    const b = fmtDate(s.birth_date), d = fmtDate(s.death_date);
    if (b && d) return `${b} – ${d}`;
    return b || d || '';
  }

  // ------------------------------------------------------------- site
  function renderSite() {
    const s = data.settings;
    app.innerHTML = '';
    app.appendChild($('#tpl-site').content.cloneNode(true));
    if (s.accent) document.documentElement.style.setProperty('--accent', s.accent);
    document.title = `En mémoire de ${s.name}`;

    // En-tête
    $('#name').textContent = s.name;
    $('#dates').textContent = dateRange(s) + (s.birth_place || s.death_place ? '' : '');
    const places = [s.birth_place, s.death_place].filter(Boolean);
    if (places.length) $('#dates').textContent += `  ·  ${places.join(' – ')}`;
    $('#subtitle').textContent = s.subtitle || '';
    $('#footer-name').textContent = `${s.name} · ${year(s.birth_date)}${year(s.death_date) ? ' – ' + year(s.death_date) : ''}`;
    if (s.hero_media) $('#hero-bg').style.backgroundImage = `url(${mediaUrl(s.hero_media)})`;
    else $('.hero').classList.add('no-photo');
    if (s.portrait_media) { const p = $('#portrait'); p.src = mediaUrl(s.portrait_media); p.alt = s.name; p.classList.remove('hidden'); }

    // Bandeau anniversaire
    const today = new Date(), mmdd = `-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (s.birth_date && s.birth_date.endsWith(mmdd) && s.birth_date.length === 10) {
      show('#banner', `Aujourd'hui, ${s.name} aurait eu ${today.getFullYear() - +year(s.birth_date)} ans. Une pensée pour lui.`);
    } else if (s.death_date && s.death_date.endsWith(mmdd) && s.death_date.length === 10 && today.getFullYear() > +year(s.death_date)) {
      const n = today.getFullYear() - +year(s.death_date);
      show('#banner', `Il y a ${n} an${n > 1 ? 's' : ''} aujourd'hui, ${s.name} nous quittait.`);
    }
    if (data.admin && data.pending) {
      const b = $('#banner');
      b.innerHTML = `<a href="/admin" style="color:inherit">${data.pending} contribution${data.pending > 1 ? 's' : ''} en attente de validation — ouvrir l'espace famille</a>`;
      b.classList.remove('hidden');
    }

    // Citation et texte principal
    if (s.intro_quote) { $('#quote').textContent = `« ${s.intro_quote.replace(/^«\s*|\s*»$/g, '')} »`; $('#intro').classList.remove('hidden'); }
    if (s.main_text) { $('#main-text').innerHTML = rich(s.main_text); $('#story').classList.remove('hidden'); }

    // Informations pratiques (masquées après la date de fin)
    const until = s.ceremony_until ? new Date(s.ceremony_until + 'T23:59:59') : null;
    if ((s.ceremony || s.donation_url) && (!until || until >= today)) {
      $('#ceremony').innerHTML = rich(s.ceremony);
      if (s.donation_url) {
        const a = $('#donation-link'); a.href = s.donation_url; a.textContent = s.donation_label || 'Faire un don en sa mémoire';
        $('#donation').classList.remove('hidden');
      }
      $('#practical').classList.remove('hidden');
    }

    renderTimeline();
    renderGallery();
    renderMemories();
    renderCandles();
    renderFamily();
    renderMap();
    if (s.contributions_open === '1') { $('#contribute').classList.remove('hidden'); setupForm(); }

    // Navigation
    const nav = $('#nav');
    const links = [
      ['#story', 'Sa vie', s.main_text], ['#timeline-section', 'Frise', data.events.length],
      ['#gallery-section', 'Photos', photos().length], ['#memories-section', 'Souvenirs', memories().length],
      ['#candles', 'Bougies', s.show_candles === '1'], ['#family-section', 'Famille', s.show_family === '1' && data.family.length],
      ['#contribute', 'Participer', s.contributions_open === '1'],
    ];
    nav.innerHTML = links.filter(l => l[2]).map(l => `<a href="${l[0]}">${l[1]}</a>`).join('');

    $('#print-btn').addEventListener('click', () => window.print());
    $('#share-btn').addEventListener('click', share);
    if (data.admin) $('#admin-link').textContent = 'Administration';
  }

  function show(sel, text) { const el = $(sel); el.textContent = text; el.classList.remove('hidden'); }
  function photos() { return data.posts.filter(p => p.kind === 'photo' && p.media_id); }
  function memories() { return data.posts.filter(p => p.kind === 'memory' || p.kind === 'audio'); }

  // ------------------------------------------------------------- frise de vie
  function renderTimeline() {
    if (!data.events.length) return;
    const tl = $('#timeline');
    tl.innerHTML = data.events.map(e => `
      <div class="tl-item ${e.media_id ? 'has-photo' : ''}">
        <div>
          <div class="tl-date">${esc(fmtDate(e.date))}</div>
          <h3>${esc(e.title)}</h3>
          ${e.place ? `<div class="tl-place">📍 ${esc(e.place)}</div>` : ''}
          ${e.body ? `<div>${rich(e.body)}</div>` : ''}
        </div>
        ${e.media_id ? `<img src="${mediaUrl(e.media_id, true)}" alt="${esc(e.title)}" loading="lazy" data-full="${mediaUrl(e.media_id)}" data-cap="${esc(e.title)}">` : ''}
      </div>`).join('');
    $$('img[data-full]', tl).forEach(img => img.addEventListener('click', () => openLightbox([{ src: img.dataset.full, cap: img.dataset.cap }], 0)));
    $('#timeline-section').classList.remove('hidden');
  }

  // ------------------------------------------------------------- galerie
  function renderGallery() {
    const list = photos();
    if (!list.length) return;
    const g = $('#gallery');
    g.innerHTML = list.map((p, i) => `
      <figure data-i="${i}">
        <img src="${mediaUrl(p.media_id, true)}" alt="${esc(p.title || '')}" loading="lazy">
        ${(p.title || p.taken_at || p.author) ? `<figcaption>${esc(p.title || '')}${p.taken_at ? ` <span class="muted">· ${esc(p.taken_at)}</span>` : ''}${p.source === 'public' && p.author ? `<br><span class="muted">partagée par ${esc(p.author)}</span>` : ''}</figcaption>` : ''}
      </figure>`).join('');
    const items = list.map(p => ({ src: mediaUrl(p.media_id), cap: [p.title, p.taken_at, p.place, p.body, p.source === 'public' && p.author ? `partagée par ${p.author}` : ''].filter(Boolean).join(' · ') }));
    $$('figure', g).forEach(f => f.addEventListener('click', () => openLightbox(items, +f.dataset.i)));
    $('#gallery-section').classList.remove('hidden');
  }

  // ------------------------------------------------------------- souvenirs
  function renderMemories() {
    const list = memories();
    if (!list.length) return;
    $('#memories').innerHTML = list.map(p => `
      <article class="memory">
        <div class="who"><b>${esc(p.author || 'La famille')}</b><span>${esc(p.taken_at || fmtDate(p.created_at.slice(0, 10)))}</span></div>
        ${p.title ? `<h3>${esc(p.title)}</h3>` : ''}
        ${p.kind === 'audio' && p.media_id ? `<audio controls preload="none" src="${mediaUrl(p.media_id)}"></audio>` : ''}
        ${p.kind !== 'audio' && p.media_id ? `<img src="${mediaUrl(p.media_id, true)}" alt="" loading="lazy" data-full="${mediaUrl(p.media_id)}">` : ''}
        ${p.body ? `<div class="text">${esc(p.body)}</div>` : ''}
        ${p.place ? `<div class="hint">📍 ${esc(p.place)}</div>` : ''}
      </article>`).join('');
    $$('#memories img[data-full]').forEach(img => img.addEventListener('click', () => openLightbox([{ src: img.dataset.full, cap: '' }], 0)));
    $('#memories-section').classList.remove('hidden');
  }

  // ------------------------------------------------------------- bougies
  function renderCandles() {
    if (data.settings.show_candles !== '1') return;
    $('#candle-count').textContent = data.candles.count;
    $('#candle-names').innerHTML = data.candles.recent.map(c => `<span>🕯️ ${esc(c.author)}</span>`).join('');
    const btn = $('#light-candle');
    if (localStorage.getItem('mem_candle')) btn.textContent = 'Allumer une autre bougie';
    btn.addEventListener('click', async () => {
      const name = prompt('Votre nom (ou laissez vide pour rester anonyme) :', localStorage.getItem('mem_name') || '');
      if (name === null) return;
      btn.disabled = true;
      try {
        const r = await api('/api/candle', { method: 'POST', json: { author: name.trim() } });
        $('#candle-count').textContent = r.count;
        $('#candle-names').insertAdjacentHTML('afterbegin', `<span>🕯️ ${esc(name.trim() || 'Anonyme')}</span>`);
        localStorage.setItem('mem_candle', '1');
        if (name.trim()) localStorage.setItem('mem_name', name.trim());
        toast('Merci. Votre bougie brille pour lui.');
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });
    $('#candles').classList.remove('hidden');
  }

  // ------------------------------------------------------------- famille
  function renderFamily() {
    if (data.settings.show_family !== '1' || !data.family.length) return;
    const groups = {};
    for (const p of data.family) (groups[p.grp || 'Famille'] ||= []).push(p);
    $('#family').innerHTML = Object.entries(groups).map(([g, people]) => `
      <div class="family-group"><h3>${esc(g)}</h3>
        <div class="family">${people.map(p => `
          <div class="person">
            ${p.media_id ? `<img class="avatar" src="${mediaUrl(p.media_id, true)}" alt="">` : `<div class="avatar">${esc(p.name.trim()[0] || '·')}</div>`}
            <div class="name">${esc(p.name)}</div><div class="rel">${esc(p.relation)}</div>
          </div>`).join('')}</div>
      </div>`).join('');
    $('#family-section').classList.remove('hidden');
  }

  // ------------------------------------------------------------- carte (Leaflet chargé à la demande)
  function renderMap() {
    if (data.settings.show_map !== '1') return;
    const pts = data.events.filter(e => e.lat != null && e.lng != null);
    if (!pts.length) return;
    $('#map-section').classList.remove('hidden');
    const css = document.createElement('link'); css.rel = 'stylesheet';
    css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    js.onload = () => {
      const map = L.map('map', { scrollWheelZoom: false });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
      const group = L.featureGroup(pts.map(e => L.marker([e.lat, e.lng]).bindPopup(`<b>${esc(e.title)}</b><br>${esc(fmtDate(e.date))}${e.place ? '<br>' + esc(e.place) : ''}`)));
      group.addTo(map);
      map.fitBounds(group.getBounds().pad(.3), { maxZoom: 10 });
    };
    document.head.appendChild(js);
  }

  // ------------------------------------------------------------- visionneuse
  function openLightbox(items, i) {
    lightboxItems = items; lightboxIndex = i;
    let lb = $('#lightbox');
    if (!lb) {
      lb = document.createElement('div'); lb.id = 'lightbox'; lb.className = 'lightbox';
      lb.innerHTML = `<button class="close" aria-label="Fermer">×</button><button class="nav prev" aria-label="Précédente">‹</button><button class="nav next" aria-label="Suivante">›</button><div><img alt=""><div class="cap"></div></div>`;
      document.body.appendChild(lb);
      lb.addEventListener('click', e => { if (e.target === lb || e.target.classList.contains('close')) lb.remove(); });
      $('.prev', lb).addEventListener('click', () => step(-1));
      $('.next', lb).addEventListener('click', () => step(1));
      document.addEventListener('keydown', onKey);
    }
    draw();
    function draw() {
      const it = lightboxItems[lightboxIndex];
      $('img', lb).src = it.src; $('.cap', lb).textContent = it.cap || '';
      $('.prev', lb).style.display = $('.next', lb).style.display = lightboxItems.length > 1 ? '' : 'none';
    }
    function step(d) { lightboxIndex = (lightboxIndex + d + lightboxItems.length) % lightboxItems.length; draw(); }
    function onKey(e) {
      if (!document.body.contains(lb)) return document.removeEventListener('keydown', onKey);
      if (e.key === 'Escape') lb.remove();
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    }
  }

  // ------------------------------------------------------------- formulaire de contribution
  function setupForm() {
    const form = $('#contrib-form'), input = $('#c-file'), dz = $('#dropzone'), preview = $('#preview');
    let chosen = null; // { file, thumb }
    let recorder = null, chunks = [];

    $('#c-author').value = localStorage.getItem('mem_name') || '';
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('active'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('active'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('active'); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
    input.addEventListener('change', () => input.files[0] && setFile(input.files[0]));

    async function setFile(file) {
      if (/^image\//.test(file.type)) {
        preview.innerHTML = '<span class="hint">Préparation de la photo…</span>'; preview.classList.remove('hidden');
        chosen = await prepareImage(file);
        preview.innerHTML = `<img src="${URL.createObjectURL(chosen.file)}" alt=""><span class="hint">${esc(file.name)} · ${Math.round(chosen.file.size / 1024)} Ko</span><button type="button" class="btn-ghost btn-sm" id="rm-file">Retirer</button>`;
      } else if (/^(audio|video)\//.test(file.type)) {
        chosen = { file, thumb: null };
        preview.innerHTML = `<audio controls src="${URL.createObjectURL(file)}"></audio><button type="button" class="btn-ghost btn-sm" id="rm-file">Retirer</button>`;
        preview.classList.remove('hidden');
      } else { toast('Choisissez une photo ou un fichier audio.', true); return; }
      $('#rm-file').addEventListener('click', () => { chosen = null; preview.classList.add('hidden'); preview.innerHTML = ''; input.value = ''; });
    }

    // Enregistrement vocal
    const recBtn = $('#rec-btn'), recStatus = $('#rec-status');
    if (!navigator.mediaDevices || !window.MediaRecorder) recBtn.classList.add('hidden');
    recBtn.addEventListener('click', async () => {
      if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
        recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        chunks = [];
        recorder.ondataavailable = e => chunks.push(e.data);
        recorder.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          const type = recorder.mimeType || 'audio/webm';
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          setFile(new File([new Blob(chunks, { type })], `message-vocal.${ext}`, { type }));
          recBtn.textContent = '🎙️ Réenregistrer'; recStatus.innerHTML = '';
        };
        recorder.start();
        recBtn.textContent = '⏹ Arrêter';
        const t0 = Date.now();
        const tick = setInterval(() => {
          if (!recorder || recorder.state !== 'recording') return clearInterval(tick);
          const s = Math.floor((Date.now() - t0) / 1000);
          recStatus.innerHTML = `<span class="rec-dot"></span> ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
          if (s >= 300) recorder.stop(); // 5 minutes maximum
        }, 500);
      } catch { toast('Impossible d\'accéder au micro.', true); }
    });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(form);
      if (chosen) { fd.set('file', chosen.file); if (chosen.thumb) fd.set('thumb', chosen.thumb); }
      if (!fd.get('body').trim() && !chosen) return toast('Écrivez un souvenir ou ajoutez une photo.', true);
      const btn = $('#c-submit'); btn.disabled = true; btn.textContent = 'Envoi…';
      try {
        await api('/api/contribute', { method: 'POST', form: fd });
        localStorage.setItem('mem_name', fd.get('author'));
        form.reset(); chosen = null; preview.classList.add('hidden'); preview.innerHTML = '';
        $('#c-author').value = localStorage.getItem('mem_name') || '';
        toast('Merci. Votre souvenir a été transmis à la famille, il sera publié après relecture.');
      } catch (err) { toast(err.message, true); }
      btn.disabled = false; btn.textContent = 'Envoyer à la famille';
    });
  }

  async function share() {
    const url = location.origin + location.pathname;
    const title = `En mémoire de ${data.settings.name}`;
    if (navigator.share) { try { await navigator.share({ title, url }); return; } catch { /* annulé */ } }
    try { await navigator.clipboard.writeText(url); toast('Lien copié.'); } catch { prompt('Copiez ce lien :', url); }
  }
})();
