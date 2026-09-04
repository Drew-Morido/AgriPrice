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

  return { show, success, invalid, error, warning, authFailure, close, confirm };
})();
