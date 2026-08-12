/* AgriPricePH — Public site settings (logged-in retailers only: Account + Appearance) */
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

  const DEFAULTS = {
    theme: 'system',
    compact: false,
    reduceMotion: false,
    defaultStatsView: 'vendor',
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

  function renderAccountCard() {
    const el = document.getElementById('settings-account-card');
    if (!el) return;
    const session = AgriPricePH.PublicAuth?.getSession?.();
    const loggedIn = AgriPricePH.PublicAuth?.isLoggedIn?.();

    if (loggedIn && session) {
      el.innerHTML = `
        <div class="settings-account-status settings-account-status--user">
          <div class="settings-account-avatar">${(session.name || 'U').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</div>
          <div>
            <h3>${session.name || 'Account'}</h3>
            <p>${session.email || ''} · <span class="pill pill-blue">Retailer</span></p>
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

    // Fallback only — the page redirects guests before this renders (see initSettingsPage).
    el.innerHTML = `
      <div class="settings-account-status settings-account-status--guest">
        <div class="settings-account-avatar guest">G</div>
        <div>
          <h3>Guest</h3>
          <p>Please log in to manage your account.</p>
        </div>
      </div>
    `;
  }

  function bindForm() {
    const prefs = getPrefs();
    const themeEl = document.getElementById('set-theme');
    const compactEl = document.getElementById('set-compact');
    const motionEl = document.getElementById('set-reduce-motion');

    if (themeEl) themeEl.value = prefs.theme;
    if (compactEl) compactEl.checked = !!prefs.compact;
    if (motionEl) motionEl.checked = !!prefs.reduceMotion;

    const onChange = () => {
      savePrefs({
        theme: themeEl?.value || 'system',
        compact: !!compactEl?.checked,
        reduceMotion: !!motionEl?.checked,
      });
      showSavedToast();
    };

    themeEl?.addEventListener('change', onChange);
    compactEl?.addEventListener('change', onChange);
    motionEl?.addEventListener('change', onChange);
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
    // Settings is for logged-in users only. Guests (including direct-URL access) are redirected —
    // this enforces the restriction in auth logic, not CSS.
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
