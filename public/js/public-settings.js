/* AgriPricePH — Public site settings (logged-in only: Appearance, Preferences, This device).
   Account/profile editing lives in public/profile.html + public-profile.js instead — this file's
   applyThemeBoot() IIFE below still needs to stay here and stay a <head> script on every page that
   wants theme-dark/compact/reduce-motion applied (see the <script> tag comment in those pages). */
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
  const USERS_KEY = 'agriprice_public_users';

  const DEFAULTS = {
    theme: 'system',
    compact: false,
    reduceMotion: false,
    defaultStatsView: 'vendor',
    defaultPage: 'current-prices.html',
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

  function exportData() {
    const dump = { exported_at: new Date().toISOString(), preferences: getPrefs() };
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    a.href = url; a.download = `agriprice-preferences-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showSavedToast('Preferences exported.');
  }

  function resetPrefs() {
    if (!confirm('Reset appearance and preferences to defaults? Your account is not affected.')) return;
    try {
      localStorage.removeItem(PREFS_KEY);
      localStorage.removeItem(DARK_KEY);
    } catch { /* ignore */ }
    applyAll(DEFAULTS);
    bindForm();
    showSavedToast('Preferences reset.');
  }

  function clearData() {
    if (!confirm('Remove saved accounts and log out on this device? Your preferences (theme, etc.) stay.')) return;
    const token = AgriPricePH.PublicAuth?.getSession?.()?.token;
    if (token) AgriPricePH.API?.authLogout?.(token).catch(() => {});
    AgriPricePH.PublicAuth?.clearSession?.();
    try {
      localStorage.removeItem(USERS_KEY);
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

    if (themeEl) themeEl.value = prefs.theme;
    if (compactEl) compactEl.checked = !!prefs.compact;
    if (motionEl) motionEl.checked = !!prefs.reduceMotion;
    if (dpEl) dpEl.value = prefs.defaultPage;

    const onChange = () => {
      savePrefs({
        theme: themeEl?.value || 'system',
        compact: !!compactEl?.checked,
        reduceMotion: !!motionEl?.checked,
        defaultPage: dpEl?.value || 'current-prices.html',
      });
      showSavedToast();
    };

    themeEl?.addEventListener('change', onChange);
    compactEl?.addEventListener('change', onChange);
    motionEl?.addEventListener('change', onChange);
    dpEl?.addEventListener('change', onChange);

    document.getElementById('set-export-data')?.addEventListener('click', exportData);
    document.getElementById('set-reset-prefs')?.addEventListener('click', resetPrefs);
    document.getElementById('set-clear-data')?.addEventListener('click', clearData);
  }

  /* Settings save on every change, so the confirmation is a toast that fades on its own. The
     shared alert is a modal with an OK button, which made each toggle stop and wait for a click. */
  function showSavedToast(msg) {
    const text = msg || 'Saved';
    const el = document.getElementById('settings-toast');
    if (!el) {
      AgriPricePH.PublicAlert?.success?.(text, { autoCloseMs: 1500 });
      return;
    }
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
