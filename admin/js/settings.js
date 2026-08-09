/* AgriPricePH — System Settings (all tabs) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Settings = (function () {

  const LS_SETTINGS = 'agriprice_settings_cache';
  const LS_DARK = 'agriprice_dark_mode';
  const LS_API = 'agriprice_api_base';
  const LS_CURRENCY = 'agriprice_currency';
  const LS_SYSTEM_NAME = 'agriprice_system_name';

  let _settings = null;
  let _activeTab = 'general';
  let _mounted = false;
  let _idleTimer = null;

  const TAB_IDS = ['general', 'data-sources', 'model', 'notifications', 'security'];

  function init() {
    if (_mounted) {
      switchTab(_activeTab);
      populateForm();
      refreshLiveStatus();
      return;
    }
    _mounted = true;
    bindTabs();
    bindActions();
    loadSettings();
  }

  function destroy() {
    _mounted = false;
  }

  function bindTabs() {
    document.querySelectorAll('#settings-nav .settings-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const tab = item.dataset.tab;
        if (tab) switchTab(tab);
      });
    });
  }

  function switchTab(tab) {
    if (!TAB_IDS.includes(tab)) return;
    _activeTab = tab;
    document.querySelectorAll('#settings-nav .settings-nav-item').forEach(el => {
      const on = el.dataset.tab === tab;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('#settings-panels .settings-panel').forEach(panel => {
      const on = panel.dataset.panel === tab;
      panel.classList.toggle('active', on);
      panel.hidden = !on;
    });
  }

  function bindActions() {
    document.getElementById('settings-save-all-btn')?.addEventListener('click', saveAll);
    document.getElementById('set-test-api-btn')?.addEventListener('click', testApiConnection);
    document.getElementById('set-dark-mode')?.addEventListener('change', (e) => {
      applyDarkMode(e.target.checked, true);
    });
    document.getElementById('set-import-2026-btn')?.addEventListener('click', runImport2026);
    document.getElementById('set-goto-sources')?.addEventListener('click', (e) => {
      e.preventDefault();
      AgriPricePH.Router.navigate('data-sources');
    });
    document.getElementById('set-goto-training')?.addEventListener('click', (e) => {
      e.preventDefault();
      AgriPricePH.Router.navigate('training');
    });
    document.getElementById('set-goto-alerts')?.addEventListener('click', (e) => {
      e.preventDefault();
      AgriPricePH.Router.navigate('alerts');
    });
    document.getElementById('set-reset-defaults-btn')?.addEventListener('click', resetDefaults);
    document.getElementById('set-admin-access-code')?.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    });
    document.getElementById('set-change-password-btn')?.addEventListener('click', openPasswordModal);
    document.getElementById('settings-password-close')?.addEventListener('click', closePasswordModal);
    document.getElementById('settings-password-cancel')?.addEventListener('click', closePasswordModal);
    document.getElementById('settings-password-save')?.addEventListener('click', savePassword);
    document.getElementById('settings-password-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'settings-password-overlay') closePasswordModal();
    });
  }

  async function loadSettings() {
    try {
      const data = await AgriPricePH.API.get('/api/settings');
      if (!data.ready) throw new Error(data.error || 'Settings unavailable');
      _settings = data.settings;
      cacheSettings(_settings);
      if (data.runtime) _settings._runtime = data.runtime;
      populateForm();
      applyAllSideEffects();
      updateLastSaved(data.settings?.updated_at);
      refreshLiveStatus();
    } catch (e) {
      console.warn('Settings API offline:', e);
      _settings = loadCachedSettings() || defaultLocalSettings();
      populateForm();
      applyAllSideEffects();
      updateLastSaved(null, true);
      refreshLiveStatus();
    }
  }

  function defaultLocalSettings() {
    return {
      general: {
        system_name: 'AgriPricePH',
        currency: 'PHP',
        dark_mode: false,
        api_base_url: AgriPricePH.API?.FLASK_API || 'http://127.0.0.1:5000',
        date_format: 'mdy',
      },
      data_sources: {
        auto_scrape: true,
        scrape_interval_hours: 24,
        da_enabled: true,
        fuel_enabled: true,
        exchange_enabled: true,
      },
      model: {
        forecast_horizon: 2,
        sliding_window: 30,
        training_epochs: 100,
        train_all_rice_types: true,
        auto_retrain: true,
        retrain_schedule: 'weekly_sunday',
        target_rice: 'locWellMilled',
      },
      notifications: {
        email_alerts: false,
        alert_email: 'admin@agripriceph.gov.ph',
        browser_notifications: true,
        alert_check_on_startup: true,
      },
      security: {
        session_timeout_minutes: 60,
        lock_after_idle: false,
        admin_display_name: 'Admin User',
        admin_access_code: '123456',
      },
    };
  }

  function cacheSettings(s) {
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
    } catch { /* ignore */ }
  }

  function loadCachedSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function populateForm() {
    if (!_settings) return;
    const g = _settings.general || {};
    const d = _settings.data_sources || {};
    const m = _settings.model || {};
    const n = _settings.notifications || {};
    const s = _settings.security || {};
    const rt = _settings._runtime || {};

    setVal('set-system-name', g.system_name);
    setVal('set-currency', g.currency);
    setVal('set-date-format', g.date_format);
    setChecked('set-dark-mode', g.dark_mode);
    setVal('set-api-url', g.api_base_url || AgriPricePH.API?.BASE);

    setChecked('set-auto-scrape', d.auto_scrape);
    setVal('set-scrape-interval', String(d.scrape_interval_hours || 24));
    setChecked('set-da-enabled', d.da_enabled);
    setChecked('set-fuel-enabled', d.fuel_enabled);
    setChecked('set-exchange-enabled', d.exchange_enabled);

    setVal('set-forecast-horizon', m.forecast_horizon ?? rt.horizon ?? 2);
    setVal('set-sliding-window', m.sliding_window ?? rt.seq_len ?? 30);
    setVal('set-training-epochs', m.training_epochs ?? 100);
    setChecked('set-train-all-rice', m.train_all_rice_types !== false);
    setVal('set-target-rice', m.target_rice || rt.target || 'locWellMilled');
    setChecked('set-auto-retrain', m.auto_retrain);
    setVal('set-retrain-schedule', m.retrain_schedule);

    setChecked('set-email-alerts', n.email_alerts);
    setVal('set-alert-email', n.alert_email);
    setChecked('set-browser-notif', n.browser_notifications);
    setChecked('set-alert-startup', n.alert_check_on_startup);

    setVal('set-admin-name', s.admin_display_name);
    setVal('set-admin-access-code', s.admin_access_code_set ? '******' : '');
    const codeInput = document.getElementById('set-admin-access-code');
    if (codeInput) {
      codeInput.placeholder = s.admin_access_code_set ? 'Leave blank to keep current code' : '123456';
    }
    setVal('set-session-timeout', String(s.session_timeout_minutes || 60));
    setChecked('set-lock-idle', s.lock_after_idle);

    const pill = document.getElementById('set-model-status-pill');
    const desc = document.getElementById('set-model-status-desc');
    if (rt.trained) {
      if (pill) {
        pill.textContent = 'Trained';
        pill.className = 'pill pill-green';
      }
      if (desc) {
        desc.textContent = `${rt.backend || 'model'} · MAE ₱${rt.mae_peso ?? '—'} · data through ${rt.last_data_date || '—'}`;
      }
    } else {
      if (pill) {
        pill.textContent = 'Not trained';
        pill.className = 'pill pill-orange';
      }
      if (desc) desc.textContent = 'Run Training module to create lstm_model.keras';
    }
  }

  function normalizeAccessCode(raw) {
    const digits = String(raw || '').replace(/\D/g, '').slice(0, 6);
    return digits.length === 6 ? digits : '123456';
  }

  function collectForm() {
    return {
      general: {
        system_name: getVal('set-system-name') || 'AgriPricePH',
        currency: getVal('set-currency') || 'PHP',
        date_format: getVal('set-date-format') || 'mdy',
        dark_mode: getChecked('set-dark-mode'),
        api_base_url: (getVal('set-api-url') || '').trim().replace(/\/$/, ''),
      },
      data_sources: {
        auto_scrape: getChecked('set-auto-scrape'),
        scrape_interval_hours: parseInt(getVal('set-scrape-interval'), 10) || 24,
        da_enabled: getChecked('set-da-enabled'),
        fuel_enabled: getChecked('set-fuel-enabled'),
        exchange_enabled: getChecked('set-exchange-enabled'),
      },
      model: {
        forecast_horizon: parseInt(getVal('set-forecast-horizon'), 10) || 2,
        sliding_window: parseInt(getVal('set-sliding-window'), 10) || 30,
        training_epochs: parseInt(getVal('set-training-epochs'), 10) || 100,
        train_all_rice_types: getChecked('set-train-all-rice'),
        auto_retrain: getChecked('set-auto-retrain'),
        retrain_schedule: getVal('set-retrain-schedule') || 'weekly_sunday',
        target_rice: getVal('set-target-rice') || 'locWellMilled',
      },
      notifications: {
        email_alerts: getChecked('set-email-alerts'),
        alert_email: getVal('set-alert-email') || '',
        browser_notifications: getChecked('set-browser-notif'),
        alert_check_on_startup: getChecked('set-alert-startup'),
      },
      security: (() => {
        const sec = {
          session_timeout_minutes: parseInt(getVal('set-session-timeout'), 10) || 60,
          lock_after_idle: getChecked('set-lock-idle'),
          admin_display_name: getVal('set-admin-name') || 'Admin User',
        };
        const v = getVal('set-admin-access-code');
        if (v && v !== '******') {
          sec.admin_access_code = normalizeAccessCode(v);
        }
        return sec;
      })(),
    };
  }

  async function saveAll() {
    const btn = document.getElementById('settings-save-all-btn');
    if (btn) btn.disabled = true;
    const codeRaw = getVal('set-admin-access-code');
    if (codeRaw && !/^\d{6}$/.test(codeRaw.replace(/\D/g, ''))) {
      toast('Access code must be exactly 6 numbers.', true);
      if (btn) btn.disabled = false;
      return;
    }
    const payload = collectForm();
    try {
      const res = await AgriPricePH.API.put('/api/settings', payload);
      if (!res.ok) throw new Error(res.data?.error || 'Save failed');
      _settings = res.data?.settings || payload;
      _settings._runtime = res.data?.runtime;
      cacheSettings(_settings);
      applyAllSideEffects();
      updateLastSaved(_settings.updated_at);
      toast('Settings saved successfully.');
    } catch (e) {
      cacheSettings(payload);
      _settings = payload;
      applyAllSideEffects();
      toast('Saved locally (backend offline).', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function applyAllSideEffects() {
    if (!_settings) return;
    const g = _settings.general || {};
    const n = _settings.notifications || {};
    const s = _settings.security || {};

    applyDarkMode(!!g.dark_mode, false);
    applySystemName(g.system_name);
    applyCurrency(g.currency);
    if (g.api_base_url) AgriPricePH.API.setBase(g.api_base_url);

    try {
      localStorage.setItem(LS_DARK, g.dark_mode ? '1' : '0');
      localStorage.setItem(LS_SYSTEM_NAME, g.system_name || '');
      localStorage.setItem(LS_CURRENCY, g.currency || 'PHP');
    } catch { /* ignore */ }

    AgriPricePH.Data = AgriPricePH.Data || {};
    AgriPricePH.Data.appSettings = _settings;

    applyAdminDisplay(s.admin_display_name);
    setupIdleLock(s.session_timeout_minutes, s.lock_after_idle);

    if (n.browser_notifications === false) {
      document.getElementById('topbar-notif-dot')?.setAttribute('hidden', '');
    }
  }

  function applySystemName(name) {
    const h2 = document.querySelector('.sidebar-logo .logo-text h2');
    if (h2 && name) h2.textContent = name;
    if (name) document.title = `${name} — Prediction System`;
  }

  function applyCurrency(code) {
    document.documentElement.dataset.currency = code || 'PHP';
  }

  function applyDarkMode(on, saveInput) {
    document.documentElement.classList.toggle('theme-dark', on);
    if (saveInput) {
      const inp = document.getElementById('set-dark-mode');
      if (inp) inp.checked = on;
      if (_settings?.general) _settings.general.dark_mode = on;
      try { localStorage.setItem(LS_DARK, on ? '1' : '0'); } catch { /* ignore */ }
    }
  }

  function applyAdminDisplay(name) {
    const h4 = document.querySelector('.topbar-user-info h4');
    if (h4 && name) h4.textContent = name;
  }

  function setupIdleLock(minutes, enabled) {
    clearTimeout(_idleTimer);
    if (!enabled) {
      document.getElementById('settings-idle-overlay')?.remove();
      return;
    }
    const ms = (parseInt(minutes, 10) || 60) * 60 * 1000;
    const reset = () => {
      clearTimeout(_idleTimer);
      document.getElementById('settings-idle-overlay')?.remove();
      _idleTimer = setTimeout(showIdleOverlay, ms);
    };
    ['mousemove', 'keydown', 'click', 'scroll'].forEach(ev => {
      document.removeEventListener(ev, reset);
      document.addEventListener(ev, reset, { passive: true });
    });
    reset();
  }

  function showIdleOverlay() {
    if (document.getElementById('settings-idle-overlay')) return;
    const el = document.createElement('div');
    el.id = 'settings-idle-overlay';
    el.className = 'settings-idle-overlay';
    el.innerHTML = `
      <div class="settings-idle-box card">
        <h3>Session idle</h3>
        <p>Click anywhere to continue working.</p>
      </div>`;
    el.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
  }

  async function testApiConnection() {
    const url = (getVal('set-api-url') || '').trim().replace(/\/$/, '');
    const pill = document.getElementById('set-api-status-pill');
    const desc = document.getElementById('set-api-status-desc');
    if (pill) { pill.textContent = 'Testing…'; pill.className = 'pill pill-gray'; }
    try {
      const res = await fetch(`${url}/api/health`, { cache: 'no-store' });
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        if (pill) { pill.textContent = 'Connected'; pill.className = 'pill pill-green'; }
        if (desc) desc.textContent = `OK · DB ${data.db_exists ? 'found' : 'missing'} · ${data.today || ''}`;
        AgriPricePH.API.setBase(url);
        toast('API connection successful.');
      } else throw new Error('Unhealthy');
    } catch {
      if (pill) { pill.textContent = 'Offline'; pill.className = 'pill pill-red'; }
      if (desc) desc.textContent = `Cannot reach ${url} — start api/app.py`;
      toast('API connection failed.', true);
    }
  }

  async function refreshLiveStatus() {
    testApiConnection();
    try {
      const summary = await AgriPricePH.API.dataSources();
      const active = summary?.summary?.active ?? 0;
      const total = summary?.summary?.total ?? 3;
      const el = document.getElementById('set-sources-live-desc');
      if (el) el.textContent = `${active}/${total} sources active · ${summary?.summary?.last_updated || '—'}`;
    } catch {
      const el = document.getElementById('set-sources-live-desc');
      if (el) el.textContent = 'Start backend to view live source status';
    }
    try {
      const alerts = await AgriPricePH.API.get('/api/alerts');
      const rules = alerts?.rules || [];
      const active = rules.filter(r => r.active).length;
      const el = document.getElementById('set-alerts-rules-desc');
      if (el) el.textContent = `${active} active / ${rules.length} total rules`;
    } catch {
      const el = document.getElementById('set-alerts-rules-desc');
      if (el) el.textContent = 'Configure rules in Price Alerts module';
    }
  }

  async function runImport2026() {
    const btn = document.getElementById('set-import-2026-btn');
    if (btn) btn.disabled = true;
    try {
      const res = await AgriPricePH.API.import2026();
      toast(res.success ? '2026 data import completed.' : (res.error || 'Import failed'), !res.success);
    } catch {
      toast('Import failed — is the backend running?', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function resetDefaults() {
    if (!confirm('Reset all settings to defaults? This cannot be undone.')) return;
    try {
      const res = await AgriPricePH.API.post('/api/settings/reset');
      if (!res.ok) throw new Error(res.data?.error);
      _settings = res.data?.settings;
      _settings._runtime = res.data?.runtime;
      populateForm();
      applyAllSideEffects();
      updateLastSaved(_settings?.updated_at);
      toast('Settings reset to defaults.');
    } catch (e) {
      toast(e.message || 'Reset failed.', true);
    }
  }

  function openPasswordModal() {
    const o = document.getElementById('settings-password-overlay');
    if (o) o.hidden = false;
    ['set-pw-current', 'set-pw-new', 'set-pw-confirm'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  }

  function closePasswordModal() {
    const o = document.getElementById('settings-password-overlay');
    if (o) o.hidden = true;
  }

  async function savePassword() {
    const current = getVal('set-pw-current');
    const newPw = getVal('set-pw-new');
    const confirm = getVal('set-pw-confirm');
    if (newPw !== confirm) {
      toast('New passwords do not match.', true);
      return;
    }
    try {
      const res = await AgriPricePH.API.post('/api/settings/password', { current, new: newPw });
      if (!res.ok) throw new Error(res.data?.error || 'Failed');
      closePasswordModal();
      toast(res.data?.message || 'Password updated.');
    } catch (e) {
      toast(e.message || 'Password update failed.', true);
    }
  }

  function updateLastSaved(iso, offline) {
    const el = document.getElementById('settings-last-saved');
    if (!el) return;
    if (offline) {
      el.textContent = 'Offline mode — using cached settings';
      return;
    }
    if (!iso) {
      el.textContent = 'Default settings';
      return;
    }
    try {
      const d = new Date(iso);
      el.textContent = `Last saved ${d.toLocaleString()}`;
    } catch {
      el.textContent = `Last saved ${iso}`;
    }
  }

  function applySavedTheme() {
    try {
      const dark = localStorage.getItem(LS_DARK) === '1';
      document.documentElement.classList.toggle('theme-dark', dark);
      const name = localStorage.getItem(LS_SYSTEM_NAME);
      if (name) applySystemName(name);
      const cur = localStorage.getItem(LS_CURRENCY);
      if (cur) applyCurrency(cur);
    } catch { /* ignore */ }
  }

  function toast(msg, isError) {
    let el = document.getElementById('settings-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'settings-toast';
      el.style.cssText = 'position:fixed;bottom:24px;left:24px;z-index:1100;padding:12px 18px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:var(--shadow-md);max-width:360px;';
      document.body.appendChild(el);
    }
    el.style.background = isError ? '#FEE2E2' : 'var(--color-accent-light)';
    el.style.color = isError ? '#B91C1C' : 'var(--color-accent-dark, #2D8A50)';
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 3500);
    el.style.opacity = '1';
  }

  function setVal(id, v) {
    const el = document.getElementById(id);
    if (el && v != null) el.value = v;
  }
  function getVal(id) {
    return document.getElementById(id)?.value ?? '';
  }
  function setChecked(id, v) {
    const el = document.getElementById(id);
    if (el) el.checked = !!v;
  }
  function getChecked(id) {
    return !!document.getElementById(id)?.checked;
  }

  return { init, destroy, applySavedTheme };
})();
