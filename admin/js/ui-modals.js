/* AgriPricePH — shared on-theme dialogs: alert / confirm / loading.
   One overlay element, reused across modules, styled entirely from CSS variables
   (see admin/css/ui-modals.css) so it matches light/dark theme automatically. */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Modals = (function () {

  const ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>',
    danger:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  function _overlay() {
    let el = document.getElementById('ui-modal-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ui-modal-overlay';
      el.className = 'ui-modal-overlay';
      el.hidden = true;
      document.body.appendChild(el);
    }
    return el;
  }

  function _close(overlay) {
    overlay.classList.remove('visible');
    if (overlay._escHandler) {
      document.removeEventListener('keydown', overlay._escHandler);
      overlay._escHandler = null;
    }
    clearTimeout(overlay._closeTimer);
    // Tagged with the current generation so that if another modal opens on this same shared
    // overlay before the fade-out finishes, this stale callback skips its cleanup instead of
    // wiping out (hiding + clearing innerHTML of) the newer modal that replaced it.
    const gen = overlay._gen;
    overlay._closeTimer = setTimeout(() => {
      if (overlay._gen !== gen) return;
      overlay.hidden = true;
      overlay.innerHTML = '';
    }, 160);
  }

  function _show(overlay) {
    clearTimeout(overlay._closeTimer);
    overlay._gen = (overlay._gen || 0) + 1;
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('visible'));
  }

  function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function alert({ title = 'Notice', text = '', type = 'info', okText = 'OK' } = {}) {
    return new Promise((resolve) => {
      const overlay = _overlay();
      overlay.innerHTML = `
        <div class="ui-modal-box" role="alertdialog" aria-modal="true" aria-label="${_esc(title)}">
          <div class="ui-modal-icon ui-modal-icon-${type}">${ICONS[type] || ICONS.info}</div>
          <h3 class="ui-modal-title">${_esc(title)}</h3>
          ${text ? `<p class="ui-modal-text">${_esc(text)}</p>` : ''}
          <div class="ui-modal-actions">
            <button type="button" class="btn btn-primary" data-act="ok">${_esc(okText)}</button>
          </div>
        </div>`;
      _show(overlay);

      const onBackdrop = (e) => { if (e.target === overlay) finish(); };
      const finish = () => {
        overlay.removeEventListener('click', onBackdrop);
        _close(overlay);
        resolve();
      };
      overlay.querySelector('[data-act="ok"]').addEventListener('click', finish);
      overlay.addEventListener('click', onBackdrop);
      overlay._escHandler = (e) => { if (e.key === 'Escape') finish(); };
      document.addEventListener('keydown', overlay._escHandler);
    });
  }

  function confirm({
    title = 'Are you sure?', text = '', type = 'warning',
    okText = 'Confirm', cancelText = 'Cancel', danger = false,
  } = {}) {
    return new Promise((resolve) => {
      const overlay = _overlay();
      overlay.innerHTML = `
        <div class="ui-modal-box" role="alertdialog" aria-modal="true" aria-label="${_esc(title)}">
          <div class="ui-modal-icon ui-modal-icon-${type}">${ICONS[type] || ICONS.warning}</div>
          <h3 class="ui-modal-title">${_esc(title)}</h3>
          ${text ? `<p class="ui-modal-text">${_esc(text)}</p>` : ''}
          <div class="ui-modal-actions">
            <button type="button" class="btn btn-outline" data-act="cancel">${_esc(cancelText)}</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${_esc(okText)}</button>
          </div>
        </div>`;
      _show(overlay);

      const onBackdrop = (e) => { if (e.target === overlay) finish(false); };
      const finish = (val) => {
        overlay.removeEventListener('click', onBackdrop);
        _close(overlay);
        resolve(val);
      };
      overlay.querySelector('[data-act="ok"]').addEventListener('click', () => finish(true));
      overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
      overlay.addEventListener('click', onBackdrop);
      overlay._escHandler = (e) => { if (e.key === 'Escape') finish(false); };
      document.addEventListener('keydown', overlay._escHandler);
    });
  }

  function loading(text = 'Loading…') {
    const overlay = _overlay();
    if (overlay._escHandler) {
      document.removeEventListener('keydown', overlay._escHandler);
      overlay._escHandler = null;
    }
    overlay.innerHTML = `
      <div class="ui-modal-box ui-modal-box-loading" role="status" aria-live="polite">
        <div class="ui-modal-spinner"></div>
        <p class="ui-modal-text">${_esc(text)}</p>
      </div>`;
    _show(overlay);
  }

  function hideLoading() {
    const overlay = document.getElementById('ui-modal-overlay');
    if (overlay && !overlay.hidden) _close(overlay);
  }

  return { alert, confirm, loading, hideLoading };
})();
