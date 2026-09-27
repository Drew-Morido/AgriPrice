/* AgriPricePH — full-size photo viewer with zoom (Rice Catalog product modal).
 *
 * AgriPricePH.ImageZoom.open({ src, alt, caption, from }) shows `src` centred over the page. It
 * grows out of the `from` element (the modal photo) and shrinks back into it on close; with
 * "Reduce motion" on (Settings, or the OS preference) it simply fades.
 *
 * Opens fitted to the screen (never enlarged past the file's own size). Zoom goes to at least
 * 3x, and to 2x the file's real resolution for large photos:
 *   - mouse wheel / trackpad zooms toward the pointer; click the photo to zoom in there or back out;
 *   - drag to pan when zoomed; two-finger pinch on touch screens;
 *   - toolbar: zoom out, zoom in, 1:1 (actual pixels), fit — the % shown is of the full resolution;
 *   - keys: + / − zoom, 0 fit, 1 actual size, arrows pan, Esc closes. Tab stays inside the viewer.
 */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.ImageZoom = (function () {
  const ICON = {
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };
  const ANIM_MS = 320;
  const CLICK_ZOOM = 2.5;

  let root, stage, img, captionEl, pctEl, closeBtn;
  let natural = { w: 0, h: 0 };   // the file's own pixel size
  let base = { w: 0, h: 0 };      // fitted size on screen = scale 1
  let s = 1, tx = 0, ty = 0;      // current zoom and pan (px, relative to centred)
  let maxScale = 3;
  let fromEl = null;
  let returnFocus = null;
  let isOpen = false;
  let closing = false;
  const pointers = new Map();
  let gesture = null;             // { type: 'drag' | 'pinch', ... }
  let moved = false;

  const reduceMotion = () => document.documentElement.classList.contains('reduce-motion')
    || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function build() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'rc-lightbox';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Full-size photo');
    root.innerHTML = `
      <p class="rc-lb-caption" id="rc-lb-caption"></p>
      <div class="rc-lb-stage"><img class="rc-lb-img" alt="" draggable="false"></div>
      <div class="rc-lb-bar" role="toolbar" aria-label="Zoom">
        <button type="button" class="rc-lb-btn" data-act="out" aria-label="Zoom out">${ICON.minus}</button>
        <span class="rc-lb-pct" aria-live="polite">100%</span>
        <button type="button" class="rc-lb-btn" data-act="in" aria-label="Zoom in">${ICON.plus}</button>
        <button type="button" class="rc-lb-btn rc-lb-btn--text" data-act="actual" aria-label="Actual size (full resolution)">1:1</button>
        <button type="button" class="rc-lb-btn" data-act="fit" aria-label="Fit to screen">${ICON.fit}</button>
      </div>
      <button type="button" class="rc-lb-close" aria-label="Close full-size photo">${ICON.close}</button>`;
    document.body.appendChild(root);
    stage = root.querySelector('.rc-lb-stage');
    img = root.querySelector('.rc-lb-img');
    captionEl = root.querySelector('.rc-lb-caption');
    pctEl = root.querySelector('.rc-lb-pct');
    closeBtn = root.querySelector('.rc-lb-close');
    root.setAttribute('aria-describedby', 'rc-lb-caption');

    closeBtn.addEventListener('click', close);
    root.querySelector('.rc-lb-bar').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'in') zoomAt(center(), s * 1.6, true);
      else if (act === 'out') zoomAt(center(), s / 1.6, true);
      else if (act === 'fit') zoomAt(center(), 1, true);
      else if (act === 'actual') zoomAt(center(), natural.w / base.w, true);
    });
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointercancel', onPointerUp);
    // Capture phase, so Esc closes only this viewer and not the product modal underneath.
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', () => { if (isOpen) { layout(); apply(false); } });
  }

  /* ---------- geometry ---------- */
  function stageSize() { return { w: stage.clientWidth, h: stage.clientHeight }; }
  function center() { const z = stageSize(); return { x: z.w / 2, y: z.h / 2 }; }

  function layout() {
    const z = stageSize();
    const r = Math.min((z.w * 0.94) / natural.w, (z.h * 0.94) / natural.h, 1);
    base = { w: natural.w * r, h: natural.h * r };
    maxScale = Math.max(3, Math.min(8, (natural.w / base.w) * 2));
    img.style.width = `${base.w}px`;
    img.style.height = `${base.h}px`;
    img.style.left = `${(z.w - base.w) / 2}px`;
    img.style.top = `${(z.h - base.h) / 2}px`;
    clampPan();
  }

  function clampPan() {
    const z = stageSize();
    const mx = Math.max(0, (base.w * s - z.w) / 2);
    const my = Math.max(0, (base.h * s - z.h) / 2);
    tx = Math.min(mx, Math.max(-mx, tx));
    ty = Math.min(my, Math.max(-my, ty));
  }

  function apply(smooth) {
    img.classList.toggle('is-animating', !!smooth && !reduceMotion());
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    root.classList.toggle('is-zoomed', s > 1.001);
    pctEl.textContent = `${Math.round(((base.w * s) / natural.w) * 100)}%`;
  }

  /** Zoom to `next`, keeping the image point under `p` (stage px) where it is. */
  function zoomAt(p, next, smooth) {
    next = Math.min(maxScale, Math.max(1, next));
    const z = stageSize();
    const k = next / s;
    const dx = p.x - z.w / 2 - tx;
    const dy = p.y - z.h / 2 - ty;
    tx += dx * (1 - k);
    ty += dy * (1 - k);
    s = next;
    if (s === 1) { tx = 0; ty = 0; }
    clampPan();
    apply(smooth);
  }

  function stagePoint(e) {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /* ---------- input ---------- */
  function onWheel(e) {
    e.preventDefault();
    zoomAt(stagePoint(e), s * Math.exp(-e.deltaY * 0.0015), false);
  }

  function onPointerDown(e) {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, stagePoint(e));
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), s0: s, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    } else if (pointers.size === 1) {
      const p = stagePoint(e);
      gesture = { type: 'drag', x: p.x, y: p.y, tx0: tx, ty0: ty, onImg: e.target === img };
      if (s > 1) root.classList.add('is-dragging');
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = stagePoint(e);
    pointers.set(e.pointerId, p);
    if (gesture?.type === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      zoomAt(gesture.mid, gesture.s0 * (dist / gesture.dist), false);
      tx += mid.x - gesture.mid.x;
      ty += mid.y - gesture.mid.y;
      gesture.mid = mid;
      gesture.s0 = s;
      gesture.dist = dist;
      clampPan();
      apply(false);
      moved = true;
    } else if (gesture?.type === 'drag') {
      const dx = p.x - gesture.x;
      const dy = p.y - gesture.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (s > 1) {
        tx = gesture.tx0 + dx;
        ty = gesture.ty0 + dy;
        clampPan();
        apply(false);
      }
    }
  }

  function onPointerUp(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = stagePoint(e);
    pointers.delete(e.pointerId);
    root.classList.remove('is-dragging');
    const g = gesture;
    if (pointers.size === 1 && g?.type === 'pinch') {
      // one finger lifted: carry on as a drag with the other
      const q = [...pointers.values()][0];
      gesture = { type: 'drag', x: q.x, y: q.y, tx0: tx, ty0: ty, onImg: false };
      return;
    }
    if (pointers.size) return;
    gesture = null;
    if (moved || !g || g.type !== 'drag') return;
    // A plain click: on the photo it toggles zoom at that point; on the dark backdrop it closes.
    if (g.onImg) zoomAt(p, s > 1.001 ? 1 : Math.min(CLICK_ZOOM, maxScale), true);
    else close();
  }

  function onKey(e) {
    if (!isOpen) return;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (k === 'Tab') {
      // keep focus inside the viewer
      const f = [...root.querySelectorAll('button')];
      const i = f.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
      e.preventDefault();
      f[next].focus();
      return;
    }
    if (k === '+' || k === '=') zoomAt(center(), s * 1.6, true);
    else if (k === '-' || k === '_') zoomAt(center(), s / 1.6, true);
    else if (k === '0') zoomAt(center(), 1, true);
    else if (k === '1') zoomAt(center(), natural.w / base.w, true);
    else if (k.startsWith('Arrow') && s > 1) {
      const step = 60;
      if (k === 'ArrowLeft') tx += step;
      if (k === 'ArrowRight') tx -= step;
      if (k === 'ArrowUp') ty += step;
      if (k === 'ArrowDown') ty -= step;
      clampPan();
      apply(true);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /* ---------- open / close ---------- */
  /** Transform that makes the fitted image sit over `el` (contained in it, centred). */
  function transformOver(el) {
    if (!el || !document.contains(el)) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const st = stage.getBoundingClientRect();
    const k = Math.min(r.width / base.w, r.height / base.h);
    const x = r.left + r.width / 2 - (st.left + st.width / 2);
    const y = r.top + r.height / 2 - (st.top + st.height / 2);
    return `translate(${x}px, ${y}px) scale(${k})`;
  }

  async function open({ src, alt = '', caption = '', from = null } = {}) {
    if (!src) return;
    build();
    fromEl = from;
    returnFocus = document.activeElement;
    captionEl.innerHTML = caption;
    captionEl.hidden = !caption;
    img.alt = alt;
    img.src = src;
    root.classList.remove('is-open', 'is-zoomed', 'has-error');
    root.hidden = false;
    isOpen = true;
    closing = false;
    try {
      if (img.decode) await img.decode();
      else if (!img.complete) await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; });
    } catch {
      root.classList.add('has-error', 'is-open');
      captionEl.hidden = false;
      captionEl.textContent = 'This photo could not be loaded.';
      closeBtn.focus();
      return;
    }
    if (!isOpen) return;
    natural = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
    s = 1; tx = 0; ty = 0;
    layout();

    const startAt = reduceMotion() ? null : transformOver(fromEl);
    img.classList.remove('is-animating');
    img.style.opacity = startAt ? '1' : '0';
    img.style.transform = startAt || 'translate(0px, 0px) scale(0.96)';
    void img.offsetWidth; // commit the start state before transitioning
    requestAnimationFrame(() => {
      root.classList.add('is-open');
      img.style.opacity = '1';
      apply(true);   // animates from the modal photo to the centred, fitted view
    });
    closeBtn.focus();
  }

  function close() {
    if (!isOpen || closing) return;
    closing = true;
    const endAt = reduceMotion() ? null : transformOver(fromEl);
    img.classList.add('is-animating');
    if (endAt) img.style.transform = endAt;
    else { img.style.opacity = '0'; img.style.transform = `translate(${tx}px, ${ty}px) scale(${s * 0.96})`; }
    root.classList.remove('is-open');
    const done = () => {
      root.hidden = true;
      isOpen = false;
      closing = false;
      img.removeAttribute('src');
      pointers.clear();
      gesture = null;
      if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
    };
    if (reduceMotion()) done();
    else setTimeout(done, ANIM_MS);
  }

  return { open, close, isOpen: () => isOpen };
})();
