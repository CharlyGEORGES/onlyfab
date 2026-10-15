// Fonctions partagées entre le site public et l'administration.
window.Mem = (function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Mise en forme légère : paragraphes, **gras**, *italique*, liens.
  function rich(text) {
    if (!text) return '';
    return String(text).trim().split(/\n{2,}/).map(p => {
      let h = esc(p).replace(/\n/g, '<br>');
      h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
      h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      return `<p>${h}</p>`;
    }).join('');
  }

  const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  function fmtDate(s, { long = true } = {}) {
    if (!s) return '';
    const m = String(s).match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
    if (!m) return s;
    const [, y, mo, d] = m;
    if (!mo) return y;
    if (!d) return `${MONTHS[+mo - 1]} ${y}`;
    return long ? `${+d === 1 ? '1er' : +d} ${MONTHS[+mo - 1]} ${y}` : `${d}/${mo}/${y}`;
  }
  function year(s) { const m = String(s || '').match(/\d{4}/); return m ? m[0] : ''; }

  let toastTimer;
  function toast(msg, err = false) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), err ? 6000 : 3500);
  }

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
    if (opts.form) init.body = opts.form;
    const r = await fetch(path, init);
    let data = null;
    try { data = await r.json(); } catch { /* vide */ }
    if (!r.ok) throw new Error((data && data.error) || `Erreur ${r.status}`);
    return data;
  }

  // Redimensionne une image côté client : retourne { file, thumb } en JPEG.
  async function prepareImage(file, maxSide = 1800, thumbSide = 480) {
    if (!/^image\//.test(file.type) || file.type === 'image/gif') return { file, thumb: null };
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { try { bmp = await loadImage(file); } catch { return { file, thumb: null }; } }
    const main = await draw(bmp, maxSide, .86);
    const thumb = await draw(bmp, thumbSide, .8);
    return {
      file: new File([main], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }),
      thumb: new File([thumb], 'thumb.jpg', { type: 'image/jpeg' }),
    };
  }
  function loadImage(file) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img); img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }
  function draw(src, maxSide, q) {
    const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
    const k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', q));
  }

  function mediaUrl(id, thumb) { return id ? `/media/${id}${thumb ? '?thumb=1' : ''}` : ''; }

  return { $, $$, esc, rich, fmtDate, year, toast, api, prepareImage, mediaUrl };
})();
