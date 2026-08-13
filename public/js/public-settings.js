/* AgriPricePH — Public site settings (logged-in only: Account, Preferences, Appearance, Privacy) */
window.AgriPricePH = window.AgriPricePH || {};

(function applyThemeBoot() {
  try {
    const prefs = JSON.parse(localStorage.getItem('agriprice_public_prefs') || 'null') || {};
    const legacy = localStorage.getItem('agriprice_dark_mode');
    let dark = false;
    const theme = prefs.theme || (legacy === '1' ? 'dark' : legacy === '0' ? 'light' : 'system');
    if (theme === 'dark') dark = true;
    else if (theme === 'light') dark = false;
    else dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('theme-dark', dark);
    document.documentElement.classList.toggle('public-compact', !!prefs.compact);
    document.documentElement.classList.toggle('reduce-motion', !!prefs.reduceMotion);
  } catch { /* ignore */ }
})();

AgriPricePH.PublicSettings = (function () {
  const PREFS_KEY = 'agriprice_public_prefs';
  const DARK_KEY = 'agriprice_dark_mode';
  const STATS_KEY = 'agriprice_stats_audience';
  const DATE_KEY = 'agriprice_date_format';
  const USERS_KEY = 'agriprice_public_users';

  const DEFAULTS = {
    theme: 'system',
    compact: false,
    reduceMotion: false,
    defaultStatsView: 'vendor',
    defaultPage: 'current-prices.html',
    dateFormat: 'mdy',
  };

  function getPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
      return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function savePrefs(partial) {
    const next = { ...getPrefs(), ...partial };
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    applyAll(next);
    return next;
  }

  function resolveDark(theme) {
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyAll(prefs) {
    const p = prefs || getPrefs();
    const dark = resolveDark(p.theme);
    document.documentElement.classList.toggle('theme-dark', dark);
    document.documentElement.classList.toggle('public-compact', !!p.compact);
    document.documentElement.classList.toggle('reduce-motion', !!p.reduceMotion);
    try {
      localStorage.setItem(DARK_KEY, dark ? '1' : '0');
      localStorage.setItem(STATS_KEY, p.defaultStatsView === 'household' ? 'household' : 'vendor');
      localStorage.setItem(DATE_KEY, ['mdy', 'dmy', 'iso'].includes(p.dateFormat) ? p.dateFormat : 'mdy');
    } catch { /* ignore */ }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderAccountCard() {
    const el = document.getElementById('settings-account-card');
    if (!el) return;
    const session = AgriPricePH.PublicAuth?.getSession?.();
    const loggedIn = AgriPricePH.PublicAuth?.isLoggedIn?.();

    if (!(loggedIn && session)) {
      el.innerHTML = `
        <div class="settings-account-status settings-account-status--guest">
          <div class="settings-account-avatar guest">G</div>
          <div><h3>Guest</h3><p>Please log in to manage your account.</p></div>
        </div>`;
      return;
    }

    const initials = (session.name || 'U').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    el.innerHTML = `
      <div class="settings-account-status settings-account-status--user">
        <div class="settings-account-avatar">${esc(initials)}</div>
        <div>
          <h3>${esc(session.name || 'Account')}</h3>
          <p>${esc(session.email || '')} · <span class="pill pill-blue">Retailer</span></p>
        </div>
      </div>
      <p class="settings-hint">Your account is stored on this device only (demo mode).</p>

      <details class="settings-account-details" style="margin-top:6px;">
        <summary style="cursor:pointer;font-weight:600;font-size:13px;">Edit profile</summary>
        <div style="display:grid;gap:8px;margin-top:8px;max-width:340px;">
          <label style="font-size:12px;">Name
            <input id="acc-name" type="text" class="form-input" value="${esc(session.name || '')}" />
          </label>
          <label style="font-size:12px;">Email (your login)
            <input id="acc-email" type="email" class="form-input" value="${esc(session.email || '')}" />
          </label>
          <div><button type="button" class="btn btn-primary btn-sm" id="acc-save-profile">Save profile</button></div>
        </div>
      </details>

      <details class="settings-account-details" style="margin-top:8px;">
        <summary style="cursor:pointer;font-weight:600;font-size:13px;">Change password</summary>
        <div style="display:grid;gap:8px;margin-top:8px;max-width:340px;">
          <label style="font-size:12px;">Current password
            <input id="acc-pw-current" type="password" class="form-input" autocomplete="current-password" />
          </label>
          <label style="font-size:12px;">New password
            <input id="acc-pw-new" type="password" class="form-input" autocomplete="new-password" />
          </label>
          <label style="font-size:12px;">Confirm new password
            <input id="acc-pw-confirm" type="password" class="form-input" autocomplete="new-password" />
          </label>
          <div style="font-size:11px;color:var(--text-muted);">At least 8 characters with uppercase, lowercase, and a number.</div>
          <div><button type="button" class="btn btn-primary btn-sm" id="acc-save-password">Update password</button></div>
        </div>
      </details>

      <div class="settings-account-actions" style="margin-top:12px;">
        <button type="button" class="btn btn-outline btn-sm" id="settings-btn-logout">Log out</button>
      </div>
    `;

    document.getElementById('settings-btn-logout')?.addEventListener('click', () => {
      AgriPricePH.PublicAuth?.logout?.();
    });
    document.getElementById('acc-save-profile')?.addEventListener('click', saveProfile);
    document.getElementById('acc-save-password')?.addEventListener('click', savePassword);
  }

  function saveProfile() {
    const name = document.getElementById('acc-name')?.value;
    const email = document.getElementById('acc-email')?.value;
    const res = AgriPricePH.PublicAuth?.updateProfile?.({ name, email });
    if (res?.ok) {
      renderAccountCard();
      AgriPricePH.PublicAuth?.updateTopbarUser?.();
      showSavedToast('Profile updated.');
    } else {
      AgriPricePH.PublicAlert?.invalid?.(res?.message || 'Could not update profile.');
    }
  }

  function savePassword() {
    const current = document.getElementById('acc-pw-current')?.value || '';
    const next = document.getElementById('acc-pw-new')?.value || '';
    const confirm = document.getElementById('acc-pw-confirm')?.value || '';
    if (next !== confirm) { AgriPricePH.PublicAlert?.invalid?.('New passwords do not match.'); return; }
    const res = AgriPricePH.PublicAuth?.changeUserPassword?.({ current, next });
    if (res?.ok) {
      ['acc-pw-current', 'acc-pw-new', 'acc-pw-confirm'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      showSavedToast('Password updated.');
    } else {
      AgriPricePH.PublicAlert?.invalid?.(res?.message || 'Could not change password.');
    }
  }

  function exportData() {
    const dump = { exported_at: new Date().toISOString(), localStorage: {}, sessionStorage: {} };
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('agriprice')) dump.localStorage[k] = localStorage.getItem(k);
      }
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith('agriprice')) dump.sessionStorage[k] = sessionStorage.getItem(k);
      }
    } catch { /* ignore */ }
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `agriprice-my-data-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showSavedToast('Your data was exported.');
  }

  function resetPrefs() {
    if (!confirm('Reset appearance and preferences to defaults? Your account is not affected.')) return;
    try {
      localStorage.removeItem(PREFS_KEY);
      localStorage.removeItem(DARK_KEY);
      localStorage.removeItem(DATE_KEY);
    } catch { /* ignore */ }
    applyAll(DEFAULTS);
    bindForm();
    showSavedToast('Preferences reset.');
  }

  function clearData() {
    if (!confirm('Remove saved accounts and log out on this device? Your preferences (theme, etc.) stay.')) return;
    try {
      localStorage.removeItem(USERS_KEY);
      sessionStorage.removeItem('agriprice_public_session');
      sessionStorage.removeItem('agriprice_admin_session');
    } catch { /* ignore */ }
    window.location.replace('landpage.html');
  }

  function bindForm() {
    const prefs = getPrefs();
    const themeEl = document.getElementById('set-theme');
    const compactEl = document.getElementById('set-compact');
    const motionEl = document.getElementById('set-reduce-motion');
    const dpEl = document.getElementById('set-default-page');
    const dfEl = document.getElementById('set-date-format');

    if (themeEl) themeEl.value = prefs.theme;
    if (compactEl) compactEl.checked = !!prefs.compact;
    if (motionEl) motionEl.checked = !!prefs.reduceMotion;
    if (dpEl) dpEl.value = prefs.defaultPage;
    if (dfEl) dfEl.value = prefs.dateFormat;

    const onChange = () => {
      savePrefs({
        theme: themeEl?.value || 'system',
        compact: !!compactEl?.checked,
        reduceMotion: !!motionEl?.checked,
        defaultPage: dpEl?.value || 'current-prices.html',
        dateFormat: dfEl?.value || 'mdy',
      });
      showSavedToast();
    };

    themeEl?.addEventListener('change', onChange);
    compactEl?.addEventListener('change', onChange);
    motionEl?.addEventListener('change', onChange);
    dpEl?.addEventListener('change', onChange);
    dfEl?.addEventListener('change', onChange);

    document.getElementById('set-export-data')?.addEventListener('click', exportData);
    document.getElementById('set-reset-prefs')?.addEventListener('click', resetPrefs);
    document.getElementById('set-clear-data')?.addEventListener('click', clearData);
  }

  function showSavedToast(msg) {
    const text = msg || 'Saved';
    if (AgriPricePH.PublicAlert?.success) {
      AgriPricePH.PublicAlert.success(text);
      return;
    }
    const el = document.getElementById('settings-toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('visible');
    clearTimeout(showSavedToast._t);
    showSavedToast._t = setTimeout(() => el.classList.remove('visible'), 2800);
  }

  function initSettingsPage() {
    // Logged-in users only. Guests (incl. direct-URL access) are redirected — enforced in auth logic.
    if (!AgriPricePH.PublicAuth?.isLoggedIn?.()) {
      window.location.replace('landpage.html');
      return;
    }
    renderAccountCard();
    bindForm();
    AgriPricePH.PublicAuth?.updateTopbarUser?.();
  }

  return {
    getPrefs,
    savePrefs,
    applyAll,
    initSettingsPage,
  };
})();
