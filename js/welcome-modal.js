/* AgriPricePH — one-time welcome popup, shared by the public site and the admin dashboard.
   Shown the first time a new account signs in (the server tracks it per account:
   users.welcome_seen_at / admin_accounts.welcome_seen_at); the caller marks it seen on close.
   Loads its own stylesheet (../css/welcome-modal.css — same relative path from public/ and admin/). */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.WelcomeModal = (function () {
  const CSS_HREF = '../css/welcome-modal.css';

  const ICONS = {
    tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  function ensureCss() {
    if (document.querySelector(`link[href="${CSS_HREF}"]`)) return Promise.resolve();
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS_HREF;
      link.onload = resolve;
      link.onerror = resolve;
      document.head.appendChild(link);
    });
  }

  /** A row of swaying rice stalks for the header — drawn, not an image, so it follows the theme. */
  function fieldSvg() {
    let stalks = '';
    const xs = [24, 62, 98, 140, 176, 214, 380, 418, 452, 494, 530];
    xs.forEach((x, i) => {
      const h = 58 + ((i * 37) % 34);
      const bend = (i % 2 ? 1 : -1) * (8 + (i % 3) * 4);
      const tipX = x + bend;
      const tipY = 150 - h;
      let grains = '';
      for (let g = 0; g < 5; g++) {
        const t = g / 5;
        const gx = tipX - bend * t * 0.35 + (g % 2 ? 4 : -4);
        const gy = tipY + 6 + g * 7;
        grains += `<ellipse cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" rx="2.6" ry="5.4" transform="rotate(${g % 2 ? 28 : -28} ${gx.toFixed(1)} ${gy.toFixed(1)})"/>`;
      }
      stalks += `<g class="wm-stalk" style="--d:${(i % 5) * 0.35}s;transform-origin:${x}px 150px">
        <path d="M${x} 150 Q${x + bend * 0.2} ${150 - h * 0.55} ${tipX} ${tipY}" />
        <g class="wm-grains">${grains}</g>
      </g>`;
    });
    return `<svg class="wm-field" viewBox="0 0 560 150" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <circle class="wm-sun" cx="470" cy="38" r="22"/>
      <path class="wm-hill wm-hill-back" d="M0 118 C 120 88, 220 112, 320 98 S 500 84, 560 104 L560 150 L0 150 Z"/>
      ${stalks}
      <path class="wm-hill wm-hill-front" d="M0 136 C 140 120, 260 142, 380 130 S 520 124, 560 134 L560 150 L0 150 Z"/>
    </svg>`;
  }

  let _open = null;

  /**
   * show({ name, avatar, eyebrow, title, text, badge, tiles: [{ icon, title, text }],
   *        primary: { label, onClick }, secondary: { label, onClick } | null })
   * Resolves with 'primary' | 'secondary' | 'dismiss' once the popup is closed.
   */
  async function show(opts = {}) {
    await ensureCss();
    if (_open) _open.remove();
    const root = document.createElement('div');
    root.className = 'wm-root';
    const tiles = (opts.tiles || []).map((t, i) => `
      <li class="wm-tile" style="--i:${i}">
        <span class="wm-tile-icon">${ICONS[t.icon] || ICONS.grid}</span>
        <span class="wm-tile-text"><b>${esc(t.title)}</b><small>${esc(t.text)}</small></span>
      </li>`).join('');
    root.innerHTML = `
      <div class="wm-backdrop" data-wm="dismiss"></div>
      <div class="wm-card" role="dialog" aria-modal="true" aria-labelledby="wm-title" aria-describedby="wm-text">
        <div class="wm-hero">
          ${fieldSvg()}
          <span class="wm-float" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>
          <button type="button" class="wm-x" data-wm="dismiss" aria-label="Close">&times;</button>
          <div class="wm-avatar${opts.avatar ? ' has-photo' : ''}" aria-hidden="true">
            ${opts.avatar ? `<img src="${esc(opts.avatar)}" alt="" />` : esc(initials(opts.name))}
          </div>
        </div>
        <div class="wm-body">
          <span class="wm-eyebrow">${esc(opts.eyebrow || 'Welcome')}</span>
          <h2 class="wm-title" id="wm-title">${esc(opts.title || 'Welcome!')}</h2>
          <p class="wm-text" id="wm-text">${esc(opts.text || '')}</p>
          ${opts.badge ? `<div class="wm-badge">${opts.badge}</div>` : ''}
          ${tiles ? `<ul class="wm-tiles">${tiles}</ul>` : ''}
          <div class="wm-actions">
            ${opts.secondary ? `<button type="button" class="btn btn-outline wm-btn" data-wm="secondary">${esc(opts.secondary.label)}</button>` : ''}
            <button type="button" class="btn btn-primary wm-btn" data-wm="primary">${esc(opts.primary?.label || 'Get started')}</button>
          </div>
          <p class="wm-foot">You'll only see this welcome once.</p>
        </div>
      </div>`;
    document.body.appendChild(root);
    _open = root;
    const prevFocus = document.activeElement;
    requestAnimationFrame(() => root.classList.add('is-open'));
    setTimeout(() => root.querySelector('[data-wm="primary"]')?.focus(), 380);

    return new Promise((resolve) => {
      const finish = (how) => {
        document.removeEventListener('keydown', onKey);
        root.classList.remove('is-open');
        root.classList.add('is-closing');
        setTimeout(() => { root.remove(); if (_open === root) _open = null; }, 240);
        try { prevFocus?.focus?.(); } catch { /* ignore */ }
        resolve(how);
        if (how === 'primary') opts.primary?.onClick?.();
        if (how === 'secondary') opts.secondary?.onClick?.();
      };
      const onKey = (e) => {
        if (e.key === 'Escape') finish('dismiss');
        if (e.key === 'Tab') { // keep focus inside the dialog
          const f = [...root.querySelectorAll('button')];
          if (!f.length) return;
          const first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      document.addEventListener('keydown', onKey);
      root.addEventListener('click', (e) => {
        const t = e.target.closest('[data-wm]');
        if (t) finish(t.dataset.wm);
      });
    });
  }

  return { show, ICONS };
})();
