/* AgriPricePH — Global topbar: search, notifications, info */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Navigation = {
  _pending: {},
  setContext(route, params) {
    if (route) this._pending[route] = params || {};
  },
  consumeContext(route) {
    const ctx = this._pending[route];
    delete this._pending[route];
    return ctx || null;
  },
};

AgriPricePH.Topbar = (function () {

  const MAX_SUGGESTIONS = 8;
  const COLORS = { danger: '#EF4444', warning: '#F59E0B', info: '#3B82F6', success: '#4CAF6E' };

  /** @type {Array<{id:string,label:string,group:string,route:string,keywords:string[],params?:object}>} */
  const SEARCH_INDEX = [
    { id: 'hist-loc-special', group: 'Rice Prices', label: 'Local Special — Historical Data', route: 'historical',
      keywords: ['local special', 'local rice special', 'loc special', 'special local'], params: { category: 'local', riceType: 'special' } },
    { id: 'hist-loc-premium', group: 'Rice Prices', label: 'Local Premium — Historical Data', route: 'historical',
      keywords: ['local premium', 'loc premium', 'premium local'], params: { category: 'local', riceType: 'premium' } },
    { id: 'hist-loc-wm', group: 'Rice Prices', label: 'Local Well Milled — Historical Data', route: 'historical',
      keywords: ['local well milled', 'local well-milled', 'well milled', 'loc well milled', 'local wm'], params: { category: 'local', riceType: 'well_milled' } },
    { id: 'hist-loc-regular', group: 'Rice Prices', label: 'Local Regular — Historical Data', route: 'historical',
      keywords: ['local regular', 'loc regular', 'regular milled local'], params: { category: 'local', riceType: 'regular' } },
    { id: 'hist-imp-special', group: 'Rice Prices', label: 'Imported Special — Historical Data', route: 'historical',
      keywords: ['imported special', 'imp special', 'special imported'], params: { category: 'imported', riceType: 'special' } },
    { id: 'hist-imp-premium', group: 'Rice Prices', label: 'Imported Premium — Historical Data', route: 'historical',
      keywords: ['imported premium', 'imp premium'], params: { category: 'imported', riceType: 'premium' } },
    { id: 'hist-imp-wm', group: 'Rice Prices', label: 'Imported Well Milled — Historical Data', route: 'historical',
      keywords: ['imported well milled', 'imported well-milled', 'imp well milled'], params: { category: 'imported', riceType: 'well_milled' } },
    { id: 'hist-imp-regular', group: 'Rice Prices', label: 'Imported Regular — Historical Data', route: 'historical',
      keywords: ['imported regular', 'imp regular'], params: { category: 'imported', riceType: 'regular' } },
    { id: 'hist-fuel', group: 'Indicators', label: 'Diesel / Fuel — Historical Data', route: 'historical',
      keywords: ['fuel', 'diesel', 'fuel price', 'doe fuel'], params: { category: 'local' } },
    { id: 'hist-exchange', group: 'Indicators', label: 'USD/PHP — Historical Data', route: 'historical',
      keywords: ['usd', 'php', 'exchange', 'exchange rate', 'usd php', 'forex'], params: { category: 'local' } },
    { id: 'hist-page', group: 'Modules', label: 'Historical Data', route: 'historical',
      keywords: ['historical', 'history', 'historical data', 'price history', 'charts history'] },

    { id: 'pred-loc-wm', group: 'Forecast', label: 'Local Well-Milled — 3-Day Forecast', route: 'predictions',
      keywords: ['forecast', 'prediction', 'predictions', '2 day', '2-day', 'outlook', 'local well milled forecast'], params: { heroType: 'local', outlookKey: 'wm' } },
    { id: 'pred-loc-special', group: 'Forecast', label: 'Local Special — 3-Day Forecast', route: 'predictions',
      keywords: ['local special forecast', 'special forecast'], params: { heroType: 'local', outlookKey: 'sp' } },
    { id: 'pred-imp-wm', group: 'Forecast', label: 'Imported Well-Milled — 3-Day Forecast', route: 'predictions',
      keywords: ['imported forecast', 'imported well milled forecast'], params: { heroType: 'imported', outlookKey: 'wm' } },
    { id: 'pred-page', group: 'Modules', label: 'Live Predictions', route: 'predictions',
      keywords: ['live predictions', 'rice forecast', 'lstm forecast'] },

    { id: 'dash', group: 'Modules', label: 'Dashboard Overview', route: 'dashboard',
      keywords: ['dashboard', 'overview', 'home', 'main'] },
    { id: 'train', group: 'Modules', label: 'Model Training', route: 'training',
      keywords: ['training', 'train', 'train model', 'lstm training', 'epoch'] },
    { id: 'model-dashboard', group: 'Modules', label: 'Model Dashboard', route: 'model-dashboard',
      keywords: ['lstm', 'lstm model', 'neural network', 'model architecture', 'metrics', 'mae', 'rmse', 'accuracy', 'performance', 'model dashboard'] },
    { id: 'corr', group: 'Modules', label: 'Market Drivers', route: 'correlation',
      keywords: ['market drivers', 'correlation analysis', 'correlation', 'drivers', 'diesel', 'usd/php', 'drift'] },
    { id: 'sources', group: 'Modules', label: 'Data Sources', route: 'data-sources',
      keywords: ['data sources', 'data source', 'da', 'department of agriculture'] },
    { id: 'scraper', group: 'Modules', label: 'Web Scraper', route: 'web-scraper',
      keywords: ['scraper', 'web scraper', 'scrape', 'scraping', 'da price monitoring', 'zigwheels'] },
    { id: 'alerts', group: 'Modules', label: 'Price Alerts', route: 'alerts',
      keywords: ['alerts', 'price alert', 'alert rules', 'notification', 'notifications'] },
    { id: 'reports', group: 'Modules', label: 'Reports & Export', route: 'reports',
      keywords: ['reports', 'export', 'csv export', 'download'] },
    { id: 'settings', group: 'Modules', label: 'System Settings', route: 'settings',
      keywords: ['settings', 'config', 'configuration', 'email alerts'] },
    { id: 'logs', group: 'Modules', label: 'System Logs', route: 'logs',
      keywords: ['logs', 'system logs', 'log viewer', 'activity log'] },
  ];

  let _alertsCache = [];
  let _panelOpen = false;
  let _activeIndex = -1;
  let _filtered = [];

  function init() {
    bindSearch();
    bindAlertPanels();
    refreshAlertBadge();
    setInterval(refreshAlertBadge, 60_000);
    refreshSidebarBadges();
    setInterval(refreshSidebarBadges, 120_000);
  }

  /* Sidebar nav counters. These were hardcoded in admin/index.html ("2" alerts, "3" sources,
     "87%" accuracy) with no ids, so they never changed and the accuracy one disagreed with the
     real trained model. Each is now filled from the same API the corresponding page uses, and
     falls back to "—" rather than showing a stale/invented number. */
  async function refreshSidebarBadges() {
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    try {
      const alerts = await AgriPricePH.API.alerts();
      const active = alerts?.summary?.active_rules
        ?? (alerts?.rules || []).filter((r) => r.active).length;
      set('nav-badge-alerts', Number.isFinite(active) ? String(active) : '—');
    } catch { set('nav-badge-alerts', '—'); }

    try {
      const ds = await AgriPricePH.API.dataSources();
      const active = ds?.summary?.active
        ?? (ds?.sources || []).filter((s) => (s.status || '').toLowerCase() === 'active').length;
      set('nav-badge-sources', Number.isFinite(active) ? String(active) : '—');
    } catch { set('nav-badge-sources', '—'); }

    try {
      // dashboard-metrics, not training-history: it describes the model actually loaded by
      // predict.py, including one trained from the command line (which never reaches the run log).
      const dm = await AgriPricePH.API.dashboardMetrics();
      const m = dm?.metrics || {};
      // Day-1 hit rate within P1.00. Falls back to the legacy accuracy figure only for models
      // trained before meta v4 — that formula rates the naive baseline above the model.
      const acc = m.hit_rate_pct?.['1.00']?.[0] ?? m.avg_accuracy_pct ?? m.accuracy_pct;
      set('nav-badge-accuracy', Number.isFinite(acc) ? `${Number(acc).toFixed(1)}%` : '—');
    } catch { set('nav-badge-accuracy', '—'); }
  }

  function normalizeQuery(q) {
    return q.toLowerCase().replace(/[₱,]/g, '').replace(/\s+/g, ' ').trim();
  }

  function scoreItem(item, query) {
    const q = normalizeQuery(query);
    if (!q) return 0;
    const label = item.label.toLowerCase();
    if (label === q) return 100;
    if (label.includes(q)) return 85;
    for (const kw of item.keywords) {
      const k = kw.toLowerCase();
      if (k === q) return 95;
      if (k.includes(q) || q.includes(k)) return 75;
      const qTokens = q.split(' ');
      const kTokens = k.split(' ');
      const matched = qTokens.filter(t => t.length > 1 && k.includes(t)).length;
      if (matched >= 2) return 70 + matched * 5;
      if (matched === 1 && qTokens.length <= 2) return 55;
    }
    const routeName = item.route.replace('-', ' ');
    if (routeName.includes(q)) return 40;
    return 0;
  }

  function search(query) {
    if (!query || query.length < 1) return [];
    return SEARCH_INDEX
      .map(item => ({ item, score: scoreItem(item, query) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTIONS)
      .map(x => x.item);
  }

  function bindSearch() {
    const input = document.getElementById('global-search-input');
    const list = document.getElementById('global-search-suggestions');
    const wrap = document.getElementById('global-search-wrap');
    if (!input || !list) return;

    const render = () => {
      const q = input.value.trim();
      _filtered = search(q);
      _activeIndex = _filtered.length ? 0 : -1;
      if (!q || !_filtered.length) {
        list.hidden = true;
        list.innerHTML = '';
        return;
      }
      let lastGroup = '';
      list.innerHTML = _filtered.map((item, i) => {
        const groupHeader = item.group !== lastGroup
          ? `<div class="search-suggest-group">${escapeHtml(item.group)}</div>` : '';
        lastGroup = item.group;
        return `${groupHeader}
          <button type="button" class="search-suggest-item${i === _activeIndex ? ' active' : ''}" data-idx="${i}">
            <span class="search-suggest-label">${escapeHtml(item.label)}</span>
            <span class="search-suggest-route">${escapeHtml(item.route)}</span>
          </button>`;
      }).join('');
      list.hidden = false;
      list.querySelectorAll('.search-suggest-item').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectItem(_filtered[parseInt(btn.dataset.idx, 10)]);
        });
      });
    };

    input.addEventListener('input', render);
    input.addEventListener('focus', render);

    input.addEventListener('keydown', (e) => {
      if (list.hidden || !_filtered.length) {
        if (e.key === 'Enter' && input.value.trim()) {
          const first = search(input.value.trim())[0];
          if (first) { e.preventDefault(); selectItem(first); }
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        _activeIndex = (_activeIndex + 1) % _filtered.length;
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _activeIndex = (_activeIndex - 1 + _filtered.length) % _filtered.length;
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_activeIndex >= 0) selectItem(_filtered[_activeIndex]);
      } else if (e.key === 'Escape') {
        list.hidden = true;
        input.blur();
      }
    });

    document.addEventListener('click', (e) => {
      if (!wrap?.contains(e.target)) list.hidden = true;
    });
  }

  function selectItem(item) {
    if (!item) return;
    const input = document.getElementById('global-search-input');
    const list = document.getElementById('global-search-suggestions');
    if (input) input.value = '';
    if (list) { list.hidden = true; list.innerHTML = ''; }
    closeAlertsPanel();
    AgriPricePH.Navigation.setContext(item.route, item.params || {});
    AgriPricePH.Router.navigate(item.route);
  }

  function bindAlertPanels() {
    const notifBtn = document.getElementById('topbar-notif-btn');
    const infoBtn = document.getElementById('topbar-info-btn');
    const panel = document.getElementById('topbar-alerts-panel');
    const closeBtn = document.getElementById('topbar-alerts-close');

    notifBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAlertsPanel('notifications');
    });
    infoBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAlertsPanel('info');
    });
    closeBtn?.addEventListener('click', closeAlertsPanel);
    document.getElementById('topbar-alerts-view-all')?.addEventListener('click', () => {
      closeAlertsPanel();
      AgriPricePH.Router.navigate('alerts');
    });

    document.addEventListener('click', (e) => {
      if (!_panelOpen) return;
      const wrap = document.getElementById('topbar-alerts-anchor');
      if (wrap && !wrap.contains(e.target)) closeAlertsPanel();
    });
  }

  async function toggleAlertsPanel(mode) {
    const panel = document.getElementById('topbar-alerts-panel');
    const title = document.getElementById('topbar-alerts-panel-title');
    if (!panel) return;

    if (_panelOpen && panel.dataset.mode === mode) {
      closeAlertsPanel();
      return;
    }

    _panelOpen = true;
    panel.dataset.mode = mode;
    panel.hidden = false;
    if (title) {
      title.textContent = mode === 'info' ? 'Alerts & System Info' : 'Notifications';
    }
    panel.querySelector('.topbar-alerts-body').innerHTML =
      '<div class="text-muted" style="padding:16px;font-size:12px;">Loading alerts…</div>';
    await loadAlertsPanel();
  }

  function closeAlertsPanel() {
    const panel = document.getElementById('topbar-alerts-panel');
    _panelOpen = false;
    if (panel) panel.hidden = true;
  }

  async function loadAlertsPanel() {
    const body = document.querySelector('#topbar-alerts-panel .topbar-alerts-body');
    const footer = document.getElementById('topbar-alerts-footer-hint');
    if (!body) return;

    try {
      const summary = await AgriPricePH.API.alertsSummary();
      if (summary?.error && summary.ready === false) throw new Error(summary.error);
      _alertsCache = summary?.recent || [];
      if (!_alertsCache.length) {
        const full = await AgriPricePH.API.alerts();
        if (full?.error && full.ready === false) throw new Error(full.error);
        _alertsCache = full?.log || [];
      }
      AgriPricePH.Data.notifLog = _alertsCache.map(n => ({
        type: n.type, title: n.title, desc: n.desc, time: n.time,
      }));
      updateBadge(summary?.triggered_today ?? _alertsCache.length);
    } catch {
      _alertsCache = AgriPricePH.Data.notifLog || [];
    }

    if (!_alertsCache.length) {
      body.innerHTML = `
        <div class="topbar-alerts-empty">
          <p>No price alerts triggered yet.</p>
          <button type="button" class="btn btn-primary btn-sm" id="topbar-goto-alerts">Set up alert rules</button>
        </div>`;
      document.getElementById('topbar-goto-alerts')?.addEventListener('click', () => {
        closeAlertsPanel();
        AgriPricePH.Router.navigate('alerts');
      });
    } else {
      body.innerHTML = _alertsCache.map(n => renderAlertRow(n)).join('');
    }

    if (footer) {
      footer.textContent = document.getElementById('topbar-alerts-panel')?.dataset.mode === 'info'
        ? 'Price alerts from your active rules. Open Price Alerts to manage rules.'
        : 'Latest triggered price alerts from the notification log.';
    }
  }

  function renderAlertRow(n) {
    const c = COLORS[n.type] || COLORS.info;
    const dot = n.type === 'danger' ? 'red' : n.type === 'warning' ? 'orange' : 'blue';
    return `
      <div class="topbar-alert-row">
        <span class="alert-dot ${dot}"></span>
        <div class="topbar-alert-text">
          <div class="topbar-alert-title">${escapeHtml(n.title || 'Alert')}</div>
          <div class="topbar-alert-desc">${escapeHtml(n.desc || '')}</div>
        </div>
        <span class="topbar-alert-time">${escapeHtml(n.time || '—')}</span>
      </div>`;
  }

  async function refreshAlertBadge() {
    try {
      const summary = await AgriPricePH.API.alertsSummary();
      updateBadge(summary?.triggered_today ?? 0, summary?.recent?.length);
    } catch {
      const n = (AgriPricePH.Data.notifLog || []).length;
      updateBadge(0, n);
    }
  }

  function updateBadge(triggeredToday, recentCount) {
    const dot = document.getElementById('topbar-notif-dot');
    if (!dot) return;
    const show = (triggeredToday > 0) || (recentCount > 0);
    dot.hidden = !show;
    dot.title = triggeredToday > 0 ? `${triggeredToday} alert(s) today` : 'Recent alerts';
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { init, refreshAlertBadge, closeAlertsPanel };
})();
