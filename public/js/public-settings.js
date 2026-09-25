/* AgriPricePH — Public site settings (logged-in only: Appearance, Preferences, Privacy & data).
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
