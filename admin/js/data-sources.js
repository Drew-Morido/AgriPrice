/* ============================================
   AgriPricePH - Data Sources (live DB only — no mock fallback)
   ============================================ */

window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.DataSources = (function () {

  const POLL_MS = 5_000;
  const POLL_RUN_MS = 2_000;
  const CONFIG_KEY = 'agriprice_ds_config';

  const SOURCE_DEFS = [
    { id: 'da', key: 'rice', preview: 'preview_rice', name: 'DA – Dept. of Agriculture',
      type: 'Web Scraper (BeautifulSoup + PDF)', dataType: 'Daily Rice Prices (8 types)',
      url: 'https://www.da.gov.ph/price-monitoring/', color: '#4CAF6E', bgColor: 'rgba(76,175,110,0.12)' },
    { id: 'doe', key: 'fuel', preview: 'preview_fuel', name: 'DOE – Dept. of Energy',
      type: 'Web Scraper (BeautifulSoup)', dataType: 'Diesel & Fuel Prices (Weekly)',
      url: 'https://www.zigwheels.ph/fuel-price', color: '#F59E0B', bgColor: 'rgba(245,158,11,0.12)' },
    { id: 'api', key: 'rates', preview: 'preview_rates', name: 'ExchangeRate API',
      type: 'REST API (JSON)', dataType: 'USD/PHP, THB/PHP, VND/PHP',
      url: 'https://open.er-api.com/v6/latest/USD', color: '#3B82F6', bgColor: 'rgba(59,130,246,0.12)' },
  ];

  const LIVE_IDS = ['da', 'doe', 'api'];
  const RICE_FIELDS = [
    'Local Special', 'Local Premium', 'Local Well Milled', 'Local Regular Milled',
    'Imported Special', 'Imported Premium', 'Imported Well Milled', 'Imported Regular Milled',
  ];

  let _mounted = false;
  let _pollTimer = null;
  let _bound = false;
  let _sources = [];
  let _live = false;
  let _scraperRunning = false;
  let _apiOk = false;

  function _formatCount(val) {
    if (val == null || val === '') return '0';
    if (typeof val === 'number' && Number.isFinite(val)) return val.toLocaleString();
    const n = parseInt(String(val).replace(/,/g, ''), 10);
    return Number.isFinite(n) ? n.toLocaleString() : '0';
  }

  function _relativeFromIso(iso) {
    if (!iso) return null;
    const ts = new Date(iso);
    if (Number.isNaN(ts.getTime())) return null;
    const secs = Math.floor((Date.now() - ts.getTime()) / 1000);
    if (secs < 0) return 'Just now';
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)} hr ago`;
    return `${Math.floor(secs / 86400)} day ago`;
  }

  function _displayLastFetch(s) {
    if (s.lastFetchAt) {
      return _relativeFromIso(s.lastFetchAt) || s.lastFetchRelative || 'Never';
    }
    if (s.lastFetchRelative) return s.lastFetchRelative;
    const lf = (s.lastFetch || '').trim();
    if (!lf || lf === 'Never' || lf === 'Not connected') return lf || 'Never';
    if (/ago$/i.test(lf) || lf === 'Just now') return lf;
    return lf;
  }

  function _displayRecordsToday(s) {
    if (s.hasDataToday === true) return _formatCount(s.recordsToday);
    if (s.hasDataToday === false) return '0';
    return _formatCount(s.recordsToday);
  }

  function _esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _rowToSummary(row) {
    if (!row || typeof row !== 'object') return [];
    return Object.entries(row)
      .filter(([k, v]) => k !== '_sort' && v != null && v !== '')
      .map(([label, value]) => ({ label, value }));
  }

  function _riceFilledCount(summary) {
    return summary.filter((r) => RICE_FIELDS.includes(r.label)).length;
  }

  /** Fix DA + drop PSA/PAGASA — works even if API returns old payload */
  function _normalizeSources(list) {
    return list
      .filter((s) => LIVE_IDS.includes(s.id))
      .map((s) => {
        if (s.id !== 'da') return s;
        const summary = (s.dataSummary && s.dataSummary.length)
          ? s.dataSummary
          : (s.todaySummary || []);
        const riceN = _riceFilledCount(summary) || Number(s.recordsToday) || 0;
        if (riceN >= 6) {
          return {
            ...s,
            hasDataToday: true,
            recordsToday: riceN,
            todaySummary: summary,
            dataSummary: summary,
          };
        }
        return s;
      });
  }

  function _summaryTableHtml(summary, title) {
    if (!summary || !summary.length) {
      return '<p class="ds-summary-empty">No row details in database yet.</p>';
    }
    const rows = summary.map(item => `
      <tr><td>${_esc(item.label)}</td><td>${_esc(item.value)}</td></tr>`).join('');
    return `
      ${title ? `<p class="ds-summary-title">${_esc(title)}</p>` : ''}
      <table class="ds-summary-table"><tbody>${rows}</tbody></table>`;
  }

  function showModal(opts) {
    const overlay = document.createElement('div');
    overlay.className = 'ds-modal-overlay';
    const wide = opts.wide ? ' ds-modal-wide ds-modal-summary' : '';
    const box = document.createElement('div');
    box.className = `ds-modal-box${wide}`;
    box.innerHTML = `
      ${opts.icon ? `<div class="ds-modal-icon">${opts.icon}</div>` : ''}
      <h3 class="ds-modal-title">${_esc(opts.title)}</h3>
      <div class="ds-modal-text">${opts.html || _esc(opts.text || '')}</div>
      <div class="ds-modal-actions">
        ${opts.showCancel ? '<button type="button" class="btn btn-ghost btn-sm" data-modal="cancel">Cancel</button>' : ''}
        <button type="button" class="btn btn-primary btn-sm" data-modal="confirm">${_esc(opts.confirmText || 'OK')}</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const close = () => {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 200);
    };
    box.querySelector('[data-modal="confirm"]').onclick = () => { close(); if (opts.onConfirm) opts.onConfirm(); };
    const cancelBtn = box.querySelector('[data-modal="cancel"]');
    if (cancelBtn) cancelBtn.onclick = () => { close(); if (opts.onCancel) opts.onCancel(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay && opts.closeOnBackdrop !== false) close(); });
  }

  function _buildFromScrapeStatus(data) {
    const st = data.stats || {};
    const lastRun = st.last_run || null;

    return SOURCE_DEFS.map(def => {
      const block = st[def.key] || {};
      const preview = (data[def.preview] || [])[0];
      const summary = _rowToSummary(preview);
      const filled = block.count || (def.id === 'da'
        ? _riceFilledCount(summary)
        : summary.filter(r => r.label !== 'Date').length);
      let hasToday = !!block.is_today;
      const isEstimated = def.id === 'da' && !!block.is_estimated;
      if (def.id === 'da' && filled >= 6) hasToday = true;
      else if (def.id !== 'da' && filled >= 3) hasToday = true;
      const countKey = { rice: 'rice_count', fuel: 'fuel_count', rates: 'rates_count' }[def.key];
      const total = st[countKey] ?? 0;

      let status = 'idle';
      if (st.running) status = 'running';
      else if (hasToday || total > 0) status = 'active';

      return {
        id: def.id, name: def.name, type: def.type, dataType: def.dataType,
        status,
        lastFetch: block.latest_date ? (hasToday ? `Today (${block.latest_date})` : block.latest_date) : 'Never',
        lastFetchRelative: lastRun ? _relativeFromIso(lastRun) : null,
        lastFetchAt: lastRun,
        hasDataToday: hasToday,
        recordsToday: hasToday ? (def.id === 'da' ? _riceFilledCount(summary) || filled : filled) : 0,
        todaySummary: hasToday ? summary : [],
        dataSummary: summary,
        hasCalendarToday: !!block.is_today,
        isEstimated,
        totalRecords: total,
        historicalRecords: null,
        scrapedRecords: total,
        url: def.url, color: def.color, bgColor: def.bgColor,
        live: true, implemented: true,
      };
    });
  }

  function init() {
    if (_mounted) { _fetch(); return; }
    _mounted = true;
    _renderLoading();
    _updateSubtitle(null, 'connecting');
    _bindActions();
    _fetch();
    _poll();
  }

  function destroy() {
    clearTimeout(_pollTimer);
    _mounted = false;
    if (_bound) {
      document.removeEventListener('click', _onClick);
      _bound = false;
    }
  }

  function _poll() {
    clearTimeout(_pollTimer);
    _fetch().finally(() => {
      if (!_mounted) return;
      _pollTimer = setTimeout(_poll, _scraperRunning ? POLL_RUN_MS : POLL_MS);
    });
  }

  async function _fetch() {
    if (!AgriPricePH.API) return;

    try {
      const data = await AgriPricePH.API.dataSources();
      if (data.sources && data.sources.length) {
        _sources = _normalizeSources(data.sources);
        _live = true;
        _apiOk = true;
        _scraperRunning = !!(data.summary && data.summary.scraper_running);
        _updateSubtitle(_mergeSummary(data.summary), 'live');
        _render();
        return;
      }
    } catch { /* try scrape-status */ }

    try {
      const status = await AgriPricePH.API.scrapeStatus();
      _sources = _normalizeSources(_buildFromScrapeStatus(status));
      _live = true;
      _apiOk = true;
      _scraperRunning = !!status.stats?.running;
      _updateSubtitle({
        total: _sources.length,
        active: _sources.filter(s => s.status === 'active' || s.status === 'running').length,
        last_updated: status.stats?.last_run ? _relativeFromIso(status.stats.last_run) : '—',
        scraper_running: _scraperRunning,
      }, 'live');
      _render();
      return;
    } catch { /* API down */ }

    _live = false;
    _apiOk = false;
    _scraperRunning = false;
    _updateSubtitle(null, 'error');
    if (!_sources.length) _renderLoading();
    else _render();
  }

  function _mergeSummary(apiSummary) {
    const active = _sources.filter(s => s.status === 'active' || s.status === 'running').length;
    return {
      ...(apiSummary || {}),
      total: _sources.length,
      active,
    };
  }

  function _updateSubtitle(summary, mode) {
    const el = document.getElementById('data-sources-subtitle');
    if (!el) return;

    if (mode === 'connecting') {
      el.textContent = 'Connecting to database…';
      el.style.color = 'var(--text-muted)';
      return;
    }
    if (mode === 'error') {
      const api = AgriPricePH.API?.BASE || 'http://127.0.0.1:5000';
      el.textContent = `Cannot reach API at ${api} — start the server (run_backend.bat), then refresh`;
      el.style.color = 'var(--warning, #d97706)';
      return;
    }

    el.style.color = '#2D8A50';
    const updated = (summary && summary.last_updated) || '—';
    const tag = summary && summary.scraper_running ? ' · Scraper running…' : ' · Live from database';
    el.textContent = `${summary.total} sources · ${summary.active} active · ${updated}${tag}`;
  }

  function _renderLoading() {
    const grid = document.getElementById('source-cards-grid');
    if (!grid) return;
    grid.innerHTML = Array(3).fill(0).map(() => `
      <div class="source-card source-card-loading">
        <div class="source-loading-bar"></div>
        <div class="source-loading-bar short"></div>
        <p style="font-size:12px;color:var(--text-muted);margin-top:12px;">Querying database…</p>
      </div>`).join('');
  }

  function _findSource(id) {
    return _sources.find(s => s.id === id);
  }

  function _bindActions() {
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick);
  }

  function _onClick(e) {
    const fetchBtn = e.target.closest('[data-action="fetch-now"]');
    const cfgBtn = e.target.closest('[data-action="configure"]');
    if (fetchBtn) { e.preventDefault(); _handleFetchNow(fetchBtn.dataset.sourceId); }
    else if (cfgBtn) { e.preventDefault(); _handleConfigure(cfgBtn.dataset.sourceId); }
  }

  function _showTodaySummaryModal(source) {
    const summary = source.todaySummary?.length ? source.todaySummary : (source.dataSummary || []);
    const daNote = source.id === 'da' && source.hasCalendarToday === false
      ? '<p style="font-size:12px;color:var(--text-muted);">Latest DA bulletin prices are in the database (8 rice types). Date shown is the official price bulletin date.</p>'
      : '';
    const estNote = source.id === 'da' && source.isEstimated
      ? '<p style="font-size:12px;color:var(--text-muted);">Temporary estimate from recent DA prices — auto-replaces when da.gov.ph posts today\'s bulletin.</p>'
      : '';
    const daNoteBlock = daNote || estNote
      ? (daNote + estNote)
      : '';
    const html = `
      <p>Data already available for <strong>${_esc(source.name)}</strong> — no need to scrape again.</p>
      ${daNoteBlock}
      ${_summaryTableHtml(summary, 'Price summary (from database)')}
      <p style="font-size:12px;margin-top:12px;color:var(--text-muted);">Last fetch: <strong>${_esc(_displayLastFetch(source))}</strong></p>`;
    showModal({
      title: 'Data Already Available Today',
      html,
      wide: true,
      confirmText: 'OK',
      icon: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4CAF6E" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    });
  }

  async function _handleFetchNow(sourceId) {
    await _fetch();
    const source = _findSource(sourceId);
    if (!source) return;

    if (source.implemented === false || source.live === false) {
      showModal({
        title: 'Not Available',
        text: `<strong>${_esc(source.name)}</strong> scraper is not implemented yet.`,
        confirmText: 'OK',
      });
      return;
    }

    if (!_apiOk) {
      showModal({
        title: 'API Not Reachable',
        html: `Start <strong>run_backend.bat</strong>, then refresh. API target: <strong>${AgriPricePH.API?.BASE || 'http://127.0.0.1:5000'}</strong>`,
        confirmText: 'OK',
      });
      return;
    }

    if (source.hasDataToday) {
      _showTodaySummaryModal(source);
      return;
    }

    showModal({
      title: 'Confirm Web Scrape',
      html: `Run web scraper now for <strong>${_esc(source.name)}</strong>?<br><br><span style="font-size:12px;color:#94a3b8;">${_esc(source.url)}</span>`,
      confirmText: 'Run Scraper',
      showCancel: true,
      onConfirm: () => _runScrape(sourceId, source.name),
    });
  }

  function _showLoading(text) {
    const overlay = document.createElement('div');
    overlay.className = 'ds-modal-overlay visible';
    overlay.innerHTML = `<div class="ds-modal-box"><h3 class="ds-modal-title">Scraping…</h3><p class="ds-modal-text">${text}</p><div class="ds-modal-spinner"></div></div>`;
    document.body.appendChild(overlay);
    return () => overlay.remove();
  }

  async function _runScrape(sourceId, name) {
    const hideLoading = _showLoading(`Fetching <strong>${_esc(name)}</strong>…`);
    try {
      const { ok, data } = await AgriPricePH.API.runScraper(sourceId);
      hideLoading();
      if (!ok) {
        showModal({ title: 'Scrape Failed', text: data.message || 'Could not start scraper.', confirmText: 'OK' });
        return;
      }
      _scraperRunning = true;
      await _waitForScrape();
      _scraperRunning = false;
      await _fetch();
      const updated = _findSource(sourceId);
      const summary = updated?.dataSummary || updated?.todaySummary || [];
      showModal({
        title: 'Scrape Complete',
        html: `<p>Finished <strong>${_esc(name)}</strong>. Saved to database:</p>${_summaryTableHtml(summary, 'Fetched data')}`,
        wide: true,
        confirmText: 'OK',
        icon: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4CAF6E" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      });
    } catch {
      hideLoading();
      showModal({ title: 'Connection Error', text: 'Lost connection to API while scraping.', confirmText: 'OK' });
    }
  }

  function _waitForScrape(maxMs = 120000) {
    const start = Date.now();
    return new Promise((resolve) => {
      const tick = async () => {
        try {
          const status = await AgriPricePH.API.scrapeStatus();
          if (!status.stats?.running) { resolve(); return; }
          _scraperRunning = true;
          await _fetch();
        } catch { /* retry */ }
        if (Date.now() - start > maxMs) { resolve(); return; }
        setTimeout(tick, POLL_RUN_MS);
      };
      tick();
    });
  }

  function _getConfig(id) {
    try {
      return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}')[id] || {};
    } catch { return {}; }
  }

  function _saveConfig(id, patch) {
    try {
      const all = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      all[id] = { ...(_getConfig(id)), ...patch };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(all));
    } catch { /* ignore */ }
  }

  function _handleConfigure(sourceId) {
    const source = _findSource(sourceId);
    if (!source) return;
    const cfg = _getConfig(sourceId);

    const overlay = document.createElement('div');
    overlay.className = 'ds-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ds-modal-box ds-modal-wide';
    box.innerHTML = `
      <h3 class="ds-modal-title">Configure — ${_esc(source.name)}</h3>
      <div class="ds-config-form">
        <label class="ds-config-label">Endpoint URL</label>
        <input class="ds-config-input" type="text" readonly value="${_esc(source.url)}" />
        <label class="ds-config-label">Auto-fetch</label>
        <label class="ds-config-check"><input type="checkbox" id="ds-cfg-enabled" ${cfg.enabled !== false ? 'checked' : ''} /> Enable scheduled fetch</label>
        <label class="ds-config-label">Schedule</label>
        <select class="ds-config-input" id="ds-cfg-schedule">
          <option value="daily" ${(cfg.schedule || 'daily') === 'daily' ? 'selected' : ''}>Daily</option>
          <option value="weekly" ${cfg.schedule === 'weekly' ? 'selected' : ''}>Weekly</option>
          <option value="hourly" ${cfg.schedule === 'hourly' ? 'selected' : ''}>Hourly</option>
        </select>
        <label class="ds-config-label">Notes</label>
        <textarea class="ds-config-input" id="ds-cfg-notes" rows="3">${_esc(cfg.notes || '')}</textarea>
      </div>
      <div class="ds-modal-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-modal="cancel">Cancel</button>
        <button type="button" class="btn btn-primary btn-sm" data-modal="save">Save</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
    const close = () => { overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 200); };
    box.querySelector('[data-modal="cancel"]').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    box.querySelector('[data-modal="save"]').onclick = () => {
      _saveConfig(sourceId, {
        enabled: box.querySelector('#ds-cfg-enabled').checked,
        schedule: box.querySelector('#ds-cfg-schedule').value,
        notes: box.querySelector('#ds-cfg-notes').value,
      });
      close();
      showModal({ title: 'Saved', text: `Settings saved for ${_esc(source.name)}.`, confirmText: 'OK' });
    };
  }

  function _render() {
    const grid = document.getElementById('source-cards-grid');
    if (!grid || !_sources.length) return;

    const icons = { da: svgLeaf(), doe: svgFuel(), api: svgGlobe() };
    const pillClass = (s) => s === 'active' ? 'pill-green' : s === 'running' ? 'pill-orange' : 'pill-gray';
    const pillLabel = (s) => s === 'active' ? 'Active' : s === 'running' ? 'Running' : 'Idle';

    grid.innerHTML = _sources.map(s => {
      const endpoint = (s.url || '').replace(/^https?:\/\//, '');
      const planned = !s.implemented || s.live === false;
      const hist = s.historicalRecords != null ? _formatCount(s.historicalRecords) : null;
      const scraped = s.scrapedRecords != null ? _formatCount(s.scrapedRecords) : null;
      const totalHint = _live && !planned && hist != null
        ? `<div class="source-stat-hint">${hist} hist · ${scraped} scraped</div>` : '';
      const todayBadge = s.hasDataToday
        ? `<span class="pill ${s.isEstimated ? 'pill-orange' : 'pill-green'}" style="font-size:9px;margin-left:4px;">${s.isEstimated ? 'Estimated' : (s.id === 'da' && s.hasCalendarToday === false ? 'Data OK' : 'Today OK')}</span>`
        : '';

      return `
      <div class="source-card" data-source-card="${s.id}">
        <div class="source-card-header">
          <div class="source-icon" style="background:${s.bgColor};color:${s.color}">${icons[s.id] || svgGlobe()}</div>
          <div>
            <div class="source-name">${_esc(s.name)}${planned ? ' <span class="pill pill-gray" style="font-size:10px;">Planned</span>' : ''}</div>
            <div class="source-type">${_esc(s.type)}</div>
          </div>
          <span class="pill ${pillClass(s.status)}" style="margin-left:auto">${pillLabel(s.status)}</span>
        </div>
        <div class="source-data-type">${_esc(s.dataType)}${todayBadge}</div>
        <div class="source-stat-row">
          <div class="source-stat-item"><label>Last Fetch</label><div class="val">${_esc(_displayLastFetch(s))}</div></div>
          <div class="source-stat-item"><label>Records Today</label><div class="val">${_esc(_displayRecordsToday(s))}</div></div>
          <div class="source-stat-item">
            <label>Total Records</label>
            <div class="val">${_formatCount(s.totalRecords)}</div>${totalHint}
          </div>
          <div class="source-stat-item"><label>Endpoint</label><div class="val endpoint-val">${_esc(endpoint)}</div></div>
        </div>
        <div class="source-card-actions">
          <button class="btn btn-outline btn-sm" data-action="fetch-now" data-source-id="${s.id}" type="button">${svgRefresh()} Fetch Now</button>
          <button class="btn btn-ghost btn-sm" data-action="configure" data-source-id="${s.id}" type="button">Configure</button>
        </div>
      </div>`;
    }).join('');
  }

  return { init, destroy };
})();
