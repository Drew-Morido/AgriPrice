/* AgriPricePH — Public alert modals (success / invalid / error) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.PublicAlert = (function () {
  const ROOT_ID = 'public-alert-root';
  let onConfirm = null;

  const META = {
    success: {
      title: 'Success',
      className: 'public-alert--success',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    },
    invalid: {
      title: 'Invalid',
      className: 'public-alert--invalid',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    },
    error: {
      title: 'Error',
      className: 'public-alert--error',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    },
    warning: {
      title: 'Warning',
      className: 'public-alert--warning',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    },
  };

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;

    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'public-alert-root';
    root.innerHTML = `
      <div class="public-alert-backdrop" data-alert-close tabindex="-1"></div>
      <div class="public-alert-dialog" role="alertdialog" aria-modal="true" aria-labelledby="public-alert-title" aria-describedby="public-alert-message" hidden>
        <button type="button" class="public-alert-x" id="public-alert-x" aria-label="Close">&times;</button>
        <div class="public-alert-head">
          <div class="public-alert-icon" id="public-alert-icon"></div>
          <h2 class="public-alert-title" id="public-alert-title"></h2>
        </div>
        <p class="public-alert-message" id="public-alert-message"></p>
        <div class="public-alert-actions">
          <button type="button" class="public-alert-btn" id="public-alert-ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    root.querySelector('[data-alert-close]')?.addEventListener('click', close);
    root.querySelector('#public-alert-x')?.addEventListener('click', close);
    root.querySelector('#public-alert-ok')?.addEventListener('click', confirm);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root.classList.contains('is-open')) close();
    });

    return root;
  }

  function confirm() {
    const cb = onConfirm;
    close();
    if (typeof cb === 'function') cb();
  }

  function close() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.classList.remove('is-open');
    const dialog = root.querySelector('.public-alert-dialog');
    dialog?.setAttribute('hidden', '');
    document.body.classList.remove('public-alert-open');
    onConfirm = null;
  }

  function show(type, message, options = {}) {
    const meta = META[type] || META.error;
    const root = ensureRoot();
    const dialog = root.querySelector('.public-alert-dialog');

    dialog.classList.remove('public-alert--success', 'public-alert--invalid', 'public-alert--error', 'public-alert--warning');
    dialog.classList.add(meta.className);

    root.querySelector('#public-alert-icon').innerHTML = meta.icon;
    root.querySelector('#public-alert-title').textContent = options.title || meta.title;
    root.querySelector('#public-alert-message').textContent = message || '';

    onConfirm = options.onConfirm || null;

    dialog.removeAttribute('hidden');
    root.classList.add('is-open');
    document.body.classList.add('public-alert-open');
    root.querySelector('#public-alert-ok')?.focus();

    const autoMs = options.autoCloseMs;
    if (autoMs > 0) {
      setTimeout(() => {
        if (root.classList.contains('is-open')) confirm();
      }, autoMs);
    }
  }

  function success(message, options) {
    show('success', message, options);
  }

  function invalid(message, options) {
    show('invalid', message, options);
  }

  function error(message, options) {
    show('error', message, options);
  }

  function warning(message, options) {
    show('warning', message, options);
  }

  /** Pick invalid vs error from common auth / form messages */
  function authFailure(message, options) {
    const m = String(message || '').toLowerCase();
    const isInvalid = /fill in|at least|already registered|valid email|6-digit|enter your|incorrect format|required/i.test(m);
    if (isInvalid) invalid(message, options);
    else error(message, options);
  }

  /* ---------------- sign-in / sign-up success ----------------
     A dedicated, animated card instead of the generic "Success" box: the person's photo (or
     initials) inside a ring that draws itself, a check, a small burst of rice grains, and a bar
     that continues on its own (or press Continue). */
  const PAGE_LABELS = {
    'current-prices.html': 'Price Forecast',
    'rice-catalog.html': 'Rice Catalog',
    'historical.html': 'Price History',
    'statistics.html': 'Charts & Stats',
    'profile.html': 'your profile',
    'settings.html': 'Settings',
  };

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '✓';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  /**
   * celebrate({ variant: 'login' | 'signup' | 'admin', name, avatar, roleLabel, dest, onContinue, autoMs })
   */
  function celebrate(opts = {}) {
    const variant = opts.variant || 'login';
    const first = String(opts.name || '').trim().split(/\s+/)[0] || '';
    const page = String(opts.dest || '').split(/[?#]/)[0];
    const where = PAGE_LABELS[page] ? `Taking you to ${PAGE_LABELS[page]}…` : 'Taking you in…';
    const copy = {
      login: { eyebrow: 'Signed in', title: first ? `Welcome back, ${first}!` : 'Welcome back!', sub: where },
      signup: { eyebrow: 'Account created', title: first ? `You’re all set, ${first}!` : 'You’re all set!', sub: `Your free account is ready. ${where}` },
      admin: { eyebrow: 'Admin sign-in', title: first ? `Welcome back, ${first}!` : 'Welcome back!', sub: 'Opening the admin dashboard…' },
    }[variant] || {};
    if (opts.sub) copy.sub = opts.sub;
    const autoMs = Number(opts.autoMs) > 0 ? Number(opts.autoMs) : 2600;

    document.getElementById('public-hello-root')?.remove();
    const root = document.createElement('div');
    root.id = 'public-hello-root';
    root.className = `hello-root hello-${variant}`;
    const grains = Array.from({ length: 14 }, (_, i) =>
      `<i style="--a:${Math.round(i * (360 / 14) + (i % 2 ? 9 : -6))}deg;--r:${74 + (i % 4) * 9}px;--c:${i % 3 ? '#E9C46A' : 'var(--color-accent, #4CAF6E)'}"></i>`).join('');
    root.innerHTML = `
      <div class="hello-backdrop" data-hello-go></div>
      <div class="hello-card" role="alertdialog" aria-modal="true" aria-labelledby="hello-title" aria-describedby="hello-sub">
        <div class="hello-stage" aria-hidden="true">
          <span class="hello-glow"></span>
          <span class="hello-burst">${grains}</span>
          <svg class="hello-ring" viewBox="0 0 120 120"><circle class="hello-ring-track" cx="60" cy="60" r="54"/><circle class="hello-ring-fill" cx="60" cy="60" r="54"/></svg>
          <span class="hello-avatar${opts.avatar ? ' has-photo' : ''}">${opts.avatar ? `<img src="${escHtml(opts.avatar)}" alt="" />` : escHtml(initialsOf(opts.name))}</span>
          <span class="hello-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
        </div>
        <span class="hello-eyebrow">${escHtml(copy.eyebrow)}</span>
        <h2 class="hello-title" id="hello-title">${escHtml(copy.title)}</h2>
        <p class="hello-sub" id="hello-sub">${escHtml(copy.sub)}</p>
        ${opts.roleLabel ? `<span class="hello-role">${escHtml(opts.roleLabel)}</span>` : ''}
        <button type="button" class="hello-btn" data-hello-go>Continue
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        </button>
        <div class="hello-progress" aria-hidden="true"><span style="animation-duration:${autoMs}ms"></span></div>
      </div>`;
    document.body.appendChild(root);
    document.body.classList.add('public-alert-open');
    requestAnimationFrame(() => root.classList.add('is-open'));
    setTimeout(() => root.querySelector('.hello-btn')?.focus(), 450);

    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      root.classList.add('is-leaving');
      setTimeout(() => {
        document.body.classList.remove('public-alert-open');
        if (typeof opts.onContinue === 'function') opts.onContinue();
        root.remove();
      }, 260);
    };
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); go(); } };
    // The bar starts after the entrance animation; when it fills, continue.
    const timer = setTimeout(go, autoMs + 600);
    document.addEventListener('keydown', onKey);
    root.addEventListener('click', (e) => { if (e.target.closest('[data-hello-go]')) go(); });
  }

  return { show, success, invalid, error, warning, authFailure, close, confirm, celebrate };
})();
