/* AgriPricePH — Public site preferences (guest & logged-in) */
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
  const API_KEY = 'agriprice_api_base';
  const STATS_KEY = 'agriprice_stats_audience';

  const DEFAULTS = {
    theme: 'system',
    compact: false,
    reduceMotion: false,
    defaultStatsView: 'vendor',
    preferSampleFallback: true,
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
    } catch { /* ignore */ }
  }

  function getApiBase() {
    try {
      return localStorage.getItem(API_KEY) || '';
    } catch {
      return '';
    }
  }

  function setApiBase(url) {
    const trimmed = (url || '').trim().replace(/\/$/, '');
    try {
      if (trimmed) localStorage.setItem(API_KEY, trimmed);
      else localStorage.removeItem(API_KEY);
    } catch { /* ignore */ }
    AgriPricePH.API?.setBase?.(trimmed || AgriPricePH.API.FLASK_API);
  }

  function clearLocalSiteData() {
    const keep = new Set([PREFS_KEY, DARK_KEY, API_KEY]);
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('agriprice') && !keep.has(k)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
    sessionStorage.removeItem('agriprice_public_session');
    sessionStorage.removeItem('agriprice_admin_session');
  }

  function renderAccountCard() {
    const el = document.getElementById('settings-account-card');
    if (!el) return;
    const session = AgriPricePH.PublicAuth?.getSession?.();
    const loggedIn = AgriPricePH.PublicAuth?.isLoggedIn?.();

    if (loggedIn && session) {
      const roleLabel = session.role === 'vendor' ? 'Vendor' : 'Household';
      el.innerHTML = `
        <div class="settings-account-status settings-account-status--user">
          <div class="settings-account-avatar">${(session.name || 'U').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</div>
          <div>
            <h3>${session.name || 'Account'}</h3>
            <p>${session.email || ''} · <span class="pill pill-green">${roleLabel}</span></p>
          </div>
        </div>
        <p class="settings-hint">Your account is stored on this device only (demo mode). Use <strong>Log out</strong> in the top bar when you are done.</p>
        <div class="settings-account-actions">
          <button type="button" class="btn btn-outline btn-sm" id="settings-btn-logout">Log out</button>
        </div>
      `;
      document.getElementById('settings-btn-logout')?.addEventListener('click', () => {
        AgriPricePH.PublicAuth?.logout?.();
      });
      return;
    }

    el.innerHTML = `
      <div class="settings-account-status settings-account-status--guest">
        <div class="settings-account-avatar guest">G</div>
        <div>
          <h3>Guest</h3>
          <p>You can browse today’s prices and the forecast without signing in.</p>
        </div>
      </div>
      <p class="settings-hint">Create a free account to unlock <strong>price history</strong> and <strong>charts &amp; stats</strong>.</p>
      <div class="settings-account-actions">
        <button type="button" class="btn btn-outline btn-sm" data-auth-open="login">Log in</button>
        <button type="button" class="btn btn-primary btn-sm" data-auth-open="signup">Create account</button>
      </div>
    `;
  }

  function bindForm() {
    const prefs = getPrefs();
    const themeEl = document.getElementById('set-theme');
    const compactEl = document.getElementById('set-compact');
    const motionEl = document.getElementById('set-reduce-motion');
    const statsEl = document.getElementById('set-stats-view');
    const fallbackEl = document.getElementById('set-sample-fallback');
    const apiEl = document.getElementById('set-api-base');

    if (themeEl) themeEl.value = prefs.theme;
    if (compactEl) compactEl.checked = !!prefs.compact;
    if (motionEl) motionEl.checked = !!prefs.reduceMotion;
    if (statsEl) statsEl.value = prefs.defaultStatsView;
    if (fallbackEl) fallbackEl.checked = prefs.preferSampleFallback !== false;
    if (apiEl) {
      apiEl.value = getApiBase() || AgriPricePH.API?.FLASK_API || 'http://127.0.0.1:5000';
    }

    const onChange = () => {
      savePrefs({
        theme: themeEl?.value || 'system',
        compact: !!compactEl?.checked,
        reduceMotion: !!motionEl?.checked,
        defaultStatsView: statsEl?.value === 'household' ? 'household' : 'vendor',
        preferSampleFallback: fallbackEl?.checked !== false,
      });
      showSavedToast();
    };

    themeEl?.addEventListener('change', onChange);
    compactEl?.addEventListener('change', onChange);
    motionEl?.addEventListener('change', onChange);
    statsEl?.addEventListener('change', onChange);
    fallbackEl?.addEventListener('change', onChange);

    document.getElementById('set-api-save')?.addEventListener('click', () => {
      const url = apiEl?.value?.trim();
      if (!url) {
        AgriPricePH.PublicAlert?.invalid?.('Enter the backend URL (e.g. http://127.0.0.1:5000)');
        return;
      }
      setApiBase(url);
      showSavedToast('API address saved. Reload the page to use it everywhere.');
    });

    document.getElementById('set-api-reset')?.addEventListener('click', () => {
      try { localStorage.removeItem(API_KEY); } catch { /* ignore */ }
      if (apiEl) apiEl.value = AgriPricePH.API?.FLASK_API || 'http://127.0.0.1:5000';
      showSavedToast('Reset to default. Reload the page to apply.');
    });

    document.getElementById('set-api-test')?.addEventListener('click', async () => {
      const btn = document.getElementById('set-api-test');
      const status = document.getElementById('set-api-status');
      const url = (apiEl?.value || '').trim().replace(/\/$/, '');
      if (!url) return;
      if (btn) btn.disabled = true;
      if (status) status.textContent = 'Testing…';
      try {
        const res = await fetch(`${url}/api/health`, { cache: 'no-store' });
        const ok = res.ok;
        if (status) {
          status.className = 'settings-api-status ' + (ok ? 'ok' : 'fail');
          status.textContent = ok ? 'Connected — backend is reachable.' : `Failed (HTTP ${res.status}).`;
        }
        if (ok) {
          AgriPricePH.PublicAlert?.success?.('Backend connection successful.');
        } else {
          AgriPricePH.PublicAlert?.error?.(`Connection failed (HTTP ${res.status}). Check the URL and try again.`);
        }
      } catch {
        if (status) {
          status.className = 'settings-api-status fail';
          status.textContent = 'Cannot reach server. Start run_backend.bat and try again.';
        }
        AgriPricePH.PublicAlert?.error?.('Cannot reach the server. Start run_backend.bat and try again.');
      }
      if (btn) btn.disabled = false;
    });

    document.getElementById('set-reset-prefs')?.addEventListener('click', () => {
      if (!confirm('Reset appearance and preferences to defaults?')) return;
      localStorage.removeItem(PREFS_KEY);
      try { localStorage.removeItem(DARK_KEY); } catch { /* ignore */ }
      applyAll(DEFAULTS);
      bindForm();
      showSavedToast('Preferences reset.');
    });

    document.getElementById('set-clear-data')?.addEventListener('click', () => {
      if (!confirm('Remove saved logins and session on this device? Your settings (theme, API URL) will stay.')) return;
      clearLocalSiteData();
      renderAccountCard();
      showSavedToast('Local accounts and session cleared.');
    });
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
    renderAccountCard();
    bindForm();
    AgriPricePH.PublicAuth?.updateTopbarUser?.();
  }

  return {
    getPrefs,
    savePrefs,
    applyAll,
    getApiBase,
    setApiBase,
    initSettingsPage,
    clearLocalSiteData,
  };
})();
