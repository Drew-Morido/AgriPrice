/* ============================================
   AgriPricePH - Data Sources (live DB only — no mock fallback)
   ============================================
   Layout: a health summary row, then a source list (left) beside the selected source's detail
   (right): freshness status, key facts (what it provides, cadence, which part of the system uses
   it), the latest values it brought in, and a Fetch Now action.

   Everything shown comes from GET /api/data-sources (or /api/scrape-status as a fallback). The
   old per-source "Configure" dialog was removed on purpose: it only saved to this browser's
   localStorage and never changed the backend, which checks every source on one 24-hour
   auto-scrape cycle (api/app.py) — showing it implied control the admin didn't actually have. */

window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.DataSources = (function () {

  const POLL_MS = 5_000;
  const POLL_RUN_MS = 2_000;

  const SOURCE_DEFS = [
    { id: 'da', key: 'rice', preview: 'preview_rice', name: 'DA – Dept. of Agriculture',
      type: 'Web Scraper (BeautifulSoup + PDF)', dataType: 'Daily Rice Prices (8 types)',
      url: 'https://www.da.gov.ph/price-monitoring/', color: '#4CAF6E', bgColor: 'rgba(76,175,110,0.12)' },
    { id: 'doe', key: 'fuel', preview: 'preview_fuel', name: 'DOE – NCR Pump Prices (Fuel)',
      type: 'Web Scraper (weekly DOE PDF)', dataType: 'RON95 & Diesel common price, NCR (Weekly)',
      url: 'https://doe.gov.ph/data-and-prices/liquid-fuels/retail-pump-prices/ncr-pump-prices', color: '#F59E0B', bgColor: 'rgba(245,158,11,0.12)' },
    { id: 'api', key: 'rates', preview: 'preview_rates', name: 'ExchangeRate API',
      type: 'REST API (JSON)', dataType: 'USD/PHP, THB/PHP, VND/PHP',
      url: 'https://open.er-api.com/v6/latest/USD', color: '#3B82F6', bgColor: 'rgba(59,130,246,0.12)' },
    // Only ever stages a candidate rate for admin review (see Taxes & Import Charges) — never
    // writes a live value on its own. These fields are only the fallback used when
    // /api/data-sources is unreachable; the primary path gets real data from _build_tariff_source().
    { id: 'tc', key: 'tariff', preview: null, name: 'Tariff Commission (PH Tariff Finder)',
      type: 'REST API (JSON)', dataType: 'Rice Import Tariff Rate (Quarterly, admin-approved)',
      url: 'https://finder.tariffcommission.gov.ph', color: '#8B5CF6', bgColor: 'rgba(139,92,246,0.12)' },
  ];

  /* Facts that aren't in the API payload. "usedBy" must stay true to the code: the DA prices are
     the 8 forecast targets; diesel, USD/PHP, PSA stocks & farmgate, core inflation and the world rice
     price are model input features (model/data_pipeline.py FEATURE_COLUMNS; RON 95 was dropped on
     2026-10-07 because it moves with diesel); the tariff only feeds imported-rice consumer prices
     after an admin approves it. */
  const SOURCE_FACTS = {
    da:  { short: 'Rice prices', cadence: 'Daily price bulletin (business days)',
           usedBy: 'Forecast targets — all 8 rice types', unit: '/kg', route: 'predictions', routeLabel: 'Price Forecast' },
    doe: { short: 'Fuel prices', cadence: 'Weekly DOE bulletin (NCR common price)',
           usedBy: 'Forecast input — diesel (RON 95 shown for reference)', unit: '/L', route: 'correlation', routeLabel: 'Market Drivers',
           // Shown behind the (i) icon next to the source name.
           info: 'Main source: DOE’s weekly “Price Monitoring of Liquid Fuels — NCR” PDF (the price most NCR stations charge).\n'
             + 'Fallback: GasWatch PH (gaswatchph.com), which republishes DOE advisories with station reports. It is used when DOE can’t be reached or has no new bulletin for 14 days, and to fill a price DOE leaves blank (#N/A) for the same week — those values are marked “Filled from GasWatch PH”.' },
    api: { short: 'Exchange rates', cadence: 'Daily reference rates',
           usedBy: 'Forecast input — USD/PHP rate', unit: '', route: 'correlation', routeLabel: 'Market Drivers' },
    psa: { short: 'Stocks & farmgate', cadence: 'Monthly (PSA publishes about the 7th–15th of the next month)',
           usedBy: 'Forecast inputs — rice stock & palay farmgate; rice price history Jan 2015 – Sep 2018', unit: '', route: 'correlation', routeLabel: 'Market Drivers',
           info: 'Philippine Statistics Authority, OpenSTAT (the source PhilRice Ricelytics cites).\n'
             + 'Rice stocks: “Monthly Total Stocks Inventory by Sector” (household, commercial, NFA; metric tons). '
             + 'Farmgate: “Cereals: Farmgate Prices”, palay other variety and fancy, Philippines.\n'
             + 'The whole 2015-onward series is refreshed each sync because PSA revises past months. A month’s figure '
             + 'is used by the model from the 15th of the following month — when PSA has actually published it.\n'
             + 'Rice prices Jan 2015 – Sep 2018: “Cereals: Retail Prices of Agricultural Commodities” (Old Series), NCR, monthly — '
             + 'one figure per month, repeated on each day of the month; PSA has no local/imported split. DA daily bulletins take '
             + 'over from Oct 2018 (datasets/scripts/rebuild_verified_rice_history.py).' },
    cpi: { short: 'Core inflation', cadence: 'Monthly (PSA releases the CPI about the 5th of the next month)',
           usedBy: 'Forecast input — core inflation', unit: '', route: 'correlation', routeLabel: 'Market Drivers',
           info: 'Philippine Statistics Authority, OpenSTAT: “Core Consumer Price Index (2018=100)”, Philippines, monthly.\n'
             + 'Core inflation leaves out selected food and energy items, so it measures the general rise in prices without '
             + 'repeating the rice price itself or the diesel price (both are separate inputs). The year-on-year % is computed '
             + 'from the index, joining PSA’s 2018-based series with its backcast for 2015–2017; it matches PSA’s published rates.\n'
             + 'The whole 2015-onward series is refreshed each sync (PSA revises past months); a refresh that looks incomplete is '
             + 'refused and the stored copy kept. A month’s figure is used by the model from the 15th of the following month.' },
    wb:  { short: 'World rice price', cadence: 'Monthly (World Bank Pink Sheet, about the 2nd business day of the next month)',
           usedBy: 'Forecast input — international rice price', unit: '', route: 'correlation', routeLabel: 'Market Drivers',
           info: 'World Bank Commodity Price Data (“Pink Sheet”), monthly: Rice, Viet Namese 5% broken, US$ per metric ton. '
             + 'Viet Nam is the Philippines’ main rice supplier, so this is the import price that matters most here. '
             + 'Thai 5% is stored for comparison only.\n'
             + 'Kept in US dollars on purpose — converting to pesos would repeat the USD/PHP rate, which is already a separate input.\n'
             + 'The workbook link changes with each release, so it is found on the World Bank commodity-markets page each sync. '
             + 'A month’s figure is used by the model from the 15th of the following month.' },
    tc:  { short: 'Rice import tariff', cadence: 'Quarterly rate (checked daily)',
           usedBy: 'Imported-rice consumer prices, after admin approval', unit: '', route: 'taxes', routeLabel: 'Taxes & Import Charges' },
  };

  const LIVE_IDS = ['da', 'doe', 'api', 'tc', 'psa', 'cpi', 'wb'];
  // Monthly/quarterly sources: "fresh" means the source has nothing newer, not a row dated today.
  const MONTHLY_IDS = ['psa', 'cpi', 'wb'];
  const RICE_FIELDS = [
    'Local Special', 'Local Premium', 'Local Well Milled', 'Local Regular Milled',
    'Imported Special', 'Imported Premium', 'Imported Well Milled', 'Imported Regular Milled',
  ];

  let _mounted = false;
  let _pollTimer = null;
  let _sources = [];
  let _summary = null;
  let _scraperRunning = false;
  let _apiOk = false;
  let _selected = 'da';
  let _lastRenderKey = '';

  // ── formatting helpers ──────────────────────────────────────────────────

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
    if (secs < 60) return 'Just now';
    if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
    if (secs < 86400) { const h = Math.floor(secs / 3600); return `${h} hr${h === 1 ? '' : 's'} ago`; }
    const d = Math.floor(secs / 86400);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }

  function _displayLastFetch(s) {
    if (s.lastFetchAt) return _relativeFromIso(s.lastFetchAt) || s.lastFetchRelative || 'Never';
    if (s.lastFetchRelative) return s.lastFetchRelative;
    const lf = (s.lastFetch || '').trim();
    return lf || 'Never';
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

  /** Fix DA + keep only implemented sources (PSA OpenSTAT is real now: rice stocks + farmgate) */
  function _normalizeSources(list) {
    return list
      .filter((s) => LIVE_IDS.includes(s.id))
      .map((s) => {
        if (s.id !== 'da') return s;
        const summary = (s.dataSummary && s.dataSummary.length) ? s.dataSummary : (s.todaySummary || []);
        const riceN = _riceFilledCount(summary) || Number(s.recordsToday) || 0;
        if (riceN >= 6) return { ...s, hasDataToday: true, recordsToday: riceN, todaySummary: summary, dataSummary: summary };
        return s;
      });
  }

  function _buildFromScrapeStatus(data) {
    const st = data.stats || {};
    const lastRun = st.last_run || null;
    return SOURCE_DEFS.map(def => {
      const block = st[def.key] || {};
      const preview = def.preview ? (data[def.preview] || [])[0] : null;
      const summary = _rowToSummary(preview);
      const filled = block.count || (def.id === 'da' ? _riceFilledCount(summary) : summary.filter(r => r.label !== 'Date').length);
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
        id: def.id, name: def.name, type: def.type, dataType: def.dataType, status,
        lastFetch: block.latest_date || 'Never',
        lastFetchRelative: lastRun ? _relativeFromIso(lastRun) : null,
        lastFetchAt: lastRun,
        hasDataToday: hasToday,
        recordsToday: hasToday ? (def.id === 'da' ? _riceFilledCount(summary) || filled : filled) : 0,
        todaySummary: hasToday ? summary : [], dataSummary: summary,
        hasCalendarToday: !!block.is_today, isEstimated,
        totalRecords: total, historicalRecords: null, scrapedRecords: total,
        url: def.url, color: def.color, bgColor: def.bgColor, live: true, implemented: true,
      };
    });
  }

  // ── lifecycle / data ─────────────────────────────────────────────────────

  function init() {
    _mounted = true;
    _lastRenderKey = '';
    _bind();
    if (_sources.length) _render(true);
    _poll();
  }

  function destroy() {
    clearTimeout(_pollTimer);
    _mounted = false;
    document.getElementById('ds-ready-overlay')?.remove();   // the popup lives on <body>, not in the page
  }

  function _poll() {
    clearTimeout(_pollTimer);
    _fetch().finally(() => {
      if (!_mounted) return;
      _pollTimer = setTimeout(_poll, _scraperRunning ? POLL_RUN_MS : POLL_MS);
    });
  }

  // ── model input checklist ────────────────────────────────────────────────
  let _readiness = null;

  async function _fetchReadiness() {
    try {
      _readiness = await AgriPricePH.API.dataReadiness();
    } catch {
      _readiness = { ready: false };
    }
    _renderKpis();          // the "Fresh today" card shows which day the model uses
    _renderReadiness();     // refresh the popup if it is open
  }

  /** Opens the Model input checklist as a popup (from the "Fresh today" card). */
  function _openReadiness() {
    if (document.getElementById('ds-ready-overlay')) return;
    const overlay = document.createElement('div');
    overlay.className = 'ds-modal-overlay';
    overlay.id = 'ds-ready-overlay';
    overlay.innerHTML = `
      <div class="ds-modal-box ds-ready-modal" role="dialog" aria-modal="true" aria-labelledby="ds-ready-heading">
        <button type="button" class="ds-ready-close" aria-label="Close">×</button>
        <div id="ds-ready" aria-live="polite"></div>
      </div>`;
    document.body.appendChild(overlay);
    _renderReadiness();
    requestAnimationFrame(() => overlay.classList.add('visible'));
    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 200);
      document.querySelector('#ds-kpis [data-action="readiness"]')?.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('.ds-ready-close')) close(); });
    overlay.querySelector('.ds-ready-close').focus();
  }

  function _fmtDay(iso) {
    if (!iso) return '—';
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /** Which days the forecast is built from, and what each newer day is still missing. */
  function _renderReadiness() {
    const el = document.getElementById('ds-ready');
    if (!el) return;
    const r = _readiness;
    if (!r || !r.ready) {
      el.innerHTML = `<div class="ds-ready-empty">${r ? 'Could not check the model inputs — is the backend running?' : 'Checking which days the model can use…'}</div>`;
      return;
    }
    const mark = (c) => `<span class="ds-ready-mark ${c.ok ? 'ok' : (c.blocking ? 'bad' : 'warn')}" aria-hidden="true">${c.ok ? '✓' : '✕'}</span>`;
    const row = (c) => `
      <li class="ds-ready-item">
        ${mark(c)}
        <span class="ds-ready-label">${_esc(c.label)}${c.blocking ? '' : ' <em>(info only)</em>'}</span>
        <span class="ds-ready-detail">${_esc(c.detail)}</span>
      </li>`;
    const held = (r.held || []);
    const waiting = held.length
      ? `<div class="ds-ready-sub">Waiting — not given to the model yet</div>
         ${held.map(h => `
           <div class="ds-ready-day is-held">
             <div class="ds-ready-date">${_esc(_fmtDay(h.date))}</div>
             <ul class="ds-ready-list">${h.checks.filter(c => c.blocking).map(row).join('')}</ul>
           </div>`).join('')}`
      : '';
    el.innerHTML = `
      <div class="ds-ready-head">
        <div>
          <div class="ds-ready-title" id="ds-ready-heading">Model input checklist
            <i class="ti ti-info-circle stat-info-icon tooltip-wide" tabindex="0" role="img"
               aria-label="A day is given to the forecasting model only when its DA rice bulletin is verified (never a temporary estimate) and the fuel and exchange-rate inputs are current. Newer days wait here until every check passes, then enter automatically."
               data-tooltip="A day is given to the forecasting model only when its DA rice bulletin is verified (never a temporary estimate) and the fuel and exchange-rate inputs are current.
Newer days wait here until every check passes, then enter automatically."></i>
          </div>
          <div class="ds-ready-caption">The forecast is built from verified data only.</div>
        </div>
        <span class="ds-ready-chip ${held.length ? 'warn' : 'ok'}">Model uses data through <b>${_esc(_fmtDay(r.ready_through))}</b></span>
      </div>
      <div class="ds-ready-day">
        <div class="ds-ready-date">${_esc(_fmtDay(r.ready_through))} <span class="ds-ready-pass">all checks passed</span></div>
        <ul class="ds-ready-list">${(r.ready_checks || []).map(row).join('')}</ul>
      </div>
      ${waiting}`;
  }

  async function _fetch() {
    if (!AgriPricePH.API) return;
    _fetchReadiness();
    try {
      const data = await AgriPricePH.API.dataSources();
      if (data.sources && data.sources.length) {
        _sources = _normalizeSources(data.sources);
        _summary = data.summary || {};
        _scraperRunning = !!_summary.scraper_running;
        _apiOk = true;
        _render();
        return;
      }
    } catch { /* fall back to scrape-status */ }

    try {
      const status = await AgriPricePH.API.scrapeStatus();
      _sources = _normalizeSources(_buildFromScrapeStatus(status));
      _scraperRunning = !!status.stats?.running;
      _summary = {
        last_updated: status.stats?.last_run ? _relativeFromIso(status.stats.last_run) : '—',
        scraper_running: _scraperRunning,
      };
      _apiOk = true;
      _render();
      return;
    } catch { /* API down */ }

    _apiOk = false;
    _scraperRunning = false;
    _render(true);
  }

  // ── derived status ───────────────────────────────────────────────────────

  function _isActive(s) { return s.status === 'active' || s.status === 'running'; }

  /* One freshness verdict per source, used by the list badge and the detail banner. */
  function _freshness(s) {
    if (s.status === 'running' || (_scraperRunning && _isActive(s))) {
      return { tone: 'info', badge: 'Syncing', title: 'Fetching now…', text: 'The scraper is running — values update here as soon as it finishes.' };
    }
    if (s.id === 'tc') {
      const rate = (s.dataSummary || []).find(r => r.label === 'Current rate')?.value;
      const q = (s.dataSummary || []).find(r => r.label === 'Quarter')?.value;
      return s.hasDataToday
        ? { tone: 'info', badge: 'Review', title: 'New rate waiting for approval', text: 'A rate was detected on the Tariff Finder. It won’t be used until an admin approves it in Taxes & Import Charges.', action: true }
        : { tone: 'ok', badge: 'Current', title: `In effect: ${rate || '—'}${q ? ` (${q})` : ''}`, text: 'The confirmed quarterly rate is in the database. New quarters are detected automatically and staged for approval.' };
    }
    const asOf = (s.dataSummary || []).find(r => r.label === 'Date')?.value;
    if (s.id === 'psa') {
      // Monthly source: current when PSA's latest month is last month or the one before (it publishes ~2 weeks after).
      return s.hasDataToday
        ? { tone: 'ok', badge: 'Up to date', title: `Latest PSA month: ${asOf || '—'}`, text: 'New months and revisions are picked up automatically.' }
        : { tone: 'warn', badge: 'Behind', title: `Latest PSA month: ${asOf || '—'}`, text: 'PSA has not published a newer month yet, or the last refresh failed — see the Web Scraper log.' };
    }
    if (s.id === 'cpi' || s.id === 'wb') {
      const who = s.id === 'cpi' ? 'PSA' : 'The World Bank';
      const used = (s.dataSummary || []).find(r => r.label === 'Used by the model from')?.value;
      return s.hasDataToday
        ? { tone: 'ok', badge: 'Up to date', title: `Latest month: ${asOf || '—'}`, text: `New months and revisions are picked up automatically.${used ? ` The model uses this month from ${used}.` : ''}` }
        : { tone: 'warn', badge: 'Behind', title: `Latest month: ${asOf || '—'}`, text: `${who} has not published a newer month yet, or the last refresh failed — see the Web Scraper log.` };
    }
    if (s.id === 'doe') {
      // Weekly source: "up to date" means this week's bulletin, not a row dated today.
      const src = String((s.dataSummary || []).find(r => r.label === 'Source')?.value || '');
      const age = asOf ? (Date.now() - new Date(asOf).getTime()) / 86400000 : null;
      if (/gaswatch/i.test(src)) {
        return { tone: 'warn', badge: 'Fallback', title: `Using GasWatch PH — week of ${asOf || '—'}`, text: 'DOE could not be read or has no new bulletin, so this week comes from gaswatchph.com. The next DOE bulletin replaces it automatically.' };
      }
      if (age != null && age <= 14) {
        return { tone: 'ok', badge: 'Up to date', title: `DOE bulletin — week of ${asOf}`, text: 'DOE publishes NCR pump prices once a week; the next bulletin is picked up automatically.' };
      }
      if (_isActive(s)) {
        return { tone: 'warn', badge: 'Behind', title: `Latest DOE week: ${asOf || '—'}`, text: 'No bulletin for the last two weeks. The next check tries DOE, then GasWatch PH.' };
      }
    }
    if (s.id === 'da' && s.isEstimated) {
      return { tone: 'warn', badge: 'Estimated', title: `Estimated for ${asOf || 'today'}`, text: 'DA hasn’t published today’s bulletin yet. This temporary estimate is replaced automatically when it is.' };
    }
    if (s.hasDataToday) {
      return { tone: 'ok', badge: 'Up to date', title: `Up to date${asOf ? ` — ${asOf}` : ''}`, text: 'The latest data from this source is already in the database.' };
    }
    if (!_isActive(s)) {
      return { tone: 'bad', badge: 'Offline', title: 'No data received', text: 'This source hasn’t returned data yet. Try Fetch Now, or check the Web Scraper log.' };
    }
    return { tone: 'warn', badge: 'Not today', title: 'No data for today yet', text: 'The next automatic check runs within 24 hours — or fetch it now.' };
  }

  // ── rendering ────────────────────────────────────────────────────────────

  function _render(force) {
    const key = JSON.stringify([_sources, _summary, _scraperRunning, _apiOk, _selected]);
    if (!force && key === _lastRenderKey) return;
    _lastRenderKey = key;
    if (!_sources.some(s => s.id === _selected) && _sources.length) _selected = _sources[0].id;
    _renderHeader();
    _renderKpis();
    _renderList();
    _renderDetail();
  }

  function _renderHeader() {
    const sub = document.getElementById('data-sources-subtitle');
    const chip = document.getElementById('ds-live-chip');
    const chipText = document.getElementById('ds-live-text');
    if (!sub || !chip) return;
    if (!_apiOk) {
      const api = AgriPricePH.API?.BASE || 'http://127.0.0.1:5000';
      sub.textContent = `Cannot reach the API at ${api} — start the backend (run_backend.bat), then refresh.`;
      chip.className = 'ds-live-chip is-down';
      chipText.textContent = 'Offline';
      return;
    }
    sub.textContent = 'Where AgriPricePH’s data comes from, how fresh it is, and what each source feeds.';
    chip.className = `ds-live-chip ${_scraperRunning ? 'is-running' : 'is-live'}`;
    chipText.textContent = _scraperRunning ? 'Scraper running…' : 'Live from database';
  }

  function _renderKpis() {
    const wrap = document.getElementById('ds-kpis');
    if (!wrap) return;
    if (!_apiOk && !_sources.length) {
      wrap.innerHTML = '';
      return;
    }
    const total = _sources.length;
    const active = _sources.filter(_isActive).length;
    const daily = _sources.filter(s => s.id !== 'tc' && !MONTHLY_IDS.includes(s.id));   // monthly/quarterly sources aren't "today" feeds
    const fresh = daily.filter(s => s.hasDataToday && !(s.id === 'da' && s.isEstimated)).length;
    const estimated = daily.filter(s => s.id === 'da' && s.isEstimated).length;
    const records = _sources.reduce((n, s) => n + (Number(s.totalRecords) || 0), 0);
    const kpi = (icon, tone, label, value, sub, action) => `
      <${action ? `button type="button" class="ds-kpi is-clickable" data-action="${action}" aria-haspopup="dialog"` : 'div class="ds-kpi"'}>
        <span class="ds-kpi-icon ${tone}">${icon}</span>
        <div class="ds-kpi-body">
          <div class="ds-kpi-label">${label}${action ? ' <span class="ds-kpi-more" aria-hidden="true">›</span>' : ''}</div>
          <div class="ds-kpi-value">${value}</div>
          <div class="ds-kpi-sub">${sub}</div>
        </div>
      </${action ? 'button' : 'div'}>`;
    const r = _readiness && _readiness.ready ? _readiness : null;
    const I = {
      plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>',
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>',
      db: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
      clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    };
    wrap.innerHTML =
      kpi(I.plug, active === total ? 'ok' : 'warn', 'Connected sources', `${active}<small>/${total}</small>`,
        active === total ? 'All sources responding' : `${total - active} not responding`) +
      kpi(I.check, fresh === daily.length ? 'ok' : 'warn', 'Fresh today', `${fresh}<small>/${daily.length}</small>`,
        r ? `Model uses data through ${_esc(_fmtDay(r.ready_through))}`
          : (estimated ? `${estimated} estimated, awaiting DA` : (fresh === daily.length ? 'Rice, fuel & exchange feeds' : 'Some feeds not updated yet')),
        'readiness') +
      kpi(I.db, 'info', 'Records in database', _formatCount(records), 'Across all sources') +
      kpi(I.clock, _scraperRunning ? 'info' : 'neutral', 'Last sync', _esc((_summary && _summary.last_updated) || '—'),
        _scraperRunning ? 'Scraper running now' : 'Auto-sync every 24 hours');
  }

  function _icon(id) {
    const map = { da: svgLeaf, doe: svgFuel, api: svgGlobe, tc: svgPercent, psa: svgChart, cpi: _svgInflation, wb: _svgShip };
    return (map[id] || svgGlobe)();
  }

  function _svgInflation() {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/><line x1="3" y1="21" x2="21" y2="21"/></svg>';
  }

  function _svgShip() {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20c2 1.2 4 1.2 6 0s4-1.2 6 0 4 1.2 6 0"/><path d="M4 17l-1-5h18l-2 5"/><path d="M12 12V4"/><path d="M12 5l5 3-5 2"/></svg>';
  }

  function _renderList() {
    const list = document.getElementById('ds-list');
    if (!list) return;
    if (!_sources.length) {
      list.innerHTML = `<div class="ds-list-empty">${_apiOk ? 'No sources configured.' : 'Waiting for the backend…'}</div>`;
      return;
    }
    list.innerHTML = _sources.map(s => {
      const f = _freshness(s);
      const facts = SOURCE_FACTS[s.id] || {};
      const on = s.id === _selected;
      return `
        <button type="button" class="ds-item ${on ? 'active' : ''}" data-source="${s.id}" role="tab" aria-selected="${on}">
          <span class="ds-item-icon" style="background:${s.bgColor};color:${s.color}">${_icon(s.id)}</span>
          <span class="ds-item-text">
            <span class="ds-item-name">${_esc(facts.short || s.name)}</span>
            <span class="ds-item-sub">${_esc(s.name)}</span>
          </span>
          <span class="ds-item-meta">
            <span class="ds-badge ${f.tone}">${f.badge}</span>
            <span class="ds-item-time">${_esc(_displayLastFetch(s))}</span>
          </span>
        </button>`;
    }).join('');
  }

  // DOE reports RON 97 and RON 100 as one grade ("Gasoline (RON97/100)"), stored as RON_97.
  const FUEL_LABELS = { RON_97: 'RON 97/100', RON_95: 'RON 95', RON_91: 'RON 91', Diesel_Plus: 'Diesel Plus' };

  function _prettyLabel(label) {
    if (FUEL_LABELS[label]) return FUEL_LABELS[label];
    return String(label)
      .replace(/_to_/g, ' → ')
      .replace(/^RON_/, 'RON ')
      .replace(/_/g, ' ');
  }

  function _prettyValue(s, item) {
    const v = item.value;
    if (typeof v !== 'number') return _esc(v);
    if (s.id === 'api') return `₱${v.toFixed(v < 1 ? 4 : 2)}`;
    if (MONTHLY_IDS.includes(s.id)) return _esc(v.toLocaleString());
    const unit = (SOURCE_FACTS[s.id] || {}).unit || '';
    return `₱${v.toFixed(2)}<small>${unit}</small>`;
  }

  function _renderValues(s) {
    const rows = (s.dataSummary && s.dataSummary.length ? s.dataSummary : s.todaySummary) || [];
    const meta = rows.filter(r => ['Date', 'Source'].includes(r.label));
    const vals = rows.filter(r => !['Date', 'Source'].includes(r.label));
    if (!vals.length) return '<div class="ds-values-empty">No values in the database yet.</div>';
    const metaLine = meta.length
      ? `<span class="ds-values-meta">${meta.map(m => `${_esc(m.label === 'Date' ? 'As of' : m.label)} ${_esc(m.value)}`).join(' · ')}</span>` : '';

    // The 8 DA rice prices read best as a 2×4 matrix (origin × grade) — the same structure the
    // forecast uses — and it's far more compact than eight separate tiles.
    const byLabel = Object.fromEntries(vals.map(r => [r.label, r.value]));
    if (s.id === 'da' && RICE_FIELDS.every(f => f in byLabel)) {
      const grades = [['Special', 'Special'], ['Premium', 'Premium'], ['Well Milled', 'Well-Milled'], ['Regular Milled', 'Regular']];
      const cell = (v) => typeof v === 'number' ? `₱${v.toFixed(2)}` : _esc(v);
      return `
        <div class="ds-section-head"><span>Latest values · ₱ per kg</span>${metaLine}</div>
        <table class="ds-matrix">
          <thead><tr><th></th>${grades.map(([, short]) => `<th>${short}</th>`).join('')}</tr></thead>
          <tbody>
            ${['Local', 'Imported'].map(origin => `
              <tr><th scope="row">${origin}</th>${grades.map(([g]) => `<td>${cell(byLabel[`${origin} ${g}`])}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>`;
    }
    return `
      <div class="ds-section-head"><span>Latest values</span>${metaLine}</div>
      <div class="ds-values ${s.id === 'psa' ? 'is-six' : (vals.length > 3 ? 'is-grid' : '')}">
        ${vals.map(r => `
          <div class="ds-value">
            <span class="ds-value-label" title="${_esc(_prettyLabel(r.label))}">${_esc(_prettyLabel(r.label))}</span>
            <span class="ds-value-num">${_prettyValue(s, r)}</span>
          </div>`).join('')}
      </div>`;
  }

  function _renderDetail() {
    const el = document.getElementById('ds-detail');
    if (!el) return;
    const s = _sources.find(x => x.id === _selected);
    if (!s) {
      el.innerHTML = `<div class="ds-detail-empty">${_apiOk ? 'Select a source.' : 'Can’t reach the backend. Start run_backend.bat, then refresh this page.'}</div>`;
      return;
    }
    const f = _freshness(s);
    const facts = SOURCE_FACTS[s.id] || {};
    const host = (s.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const hist = s.historicalRecords != null ? _formatCount(s.historicalRecords) : null;
    const scraped = s.scrapedRecords != null ? _formatCount(s.scrapedRecords) : null;
    const breakdown = hist != null
      ? (s.id === 'tc' ? `${hist} confirmed · ${scraped} detected`
        : s.id === 'psa' ? `${hist} stock months · ${scraped} farmgate months`
        : (s.id === 'cpi' || s.id === 'wb') ? `${_esc(s.firstMonth || '—')} – ${_esc(s.latestMonth || '—')}`
        : `${hist} historical · ${scraped} scraped`) : 'Total stored';
    // `note` is secondary detail (exact timestamp, record breakdown): it's also the tooltip, so
    // the CSS can hide the visible line on tight screens without losing it.
    const fact = (label, value, sub, note) => `
      <div class="ds-fact"${note ? ` title="${note}"` : ''}>
        <span class="ds-fact-label">${label}</span>
        <span class="ds-fact-value">${value}</span>
        ${sub ? `<span class="ds-fact-sub">${sub}</span>` : ''}
        ${note ? `<span class="ds-fact-sub ds-fact-note">${note}</span>` : ''}
      </div>`;
    const fetchIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
    const extIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    const toneIcon = {
      ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>',
      warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
      info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
      bad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    };
    const lastAbs = s.lastFetchAt
      ? new Date(s.lastFetchAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '';

    el.innerHTML = `
      <div class="ds-detail-head">
        <span class="ds-detail-icon" style="background:${s.bgColor};color:${s.color}">${_icon(s.id)}</span>
        <div class="ds-detail-title">
          <div class="ds-detail-name"><h3>${_esc(s.name)}</h3>${facts.info ? `<i class="ti ti-info-circle stat-info-icon tooltip-wide tooltip-right" tabindex="0" role="img" aria-label="${_esc(facts.info)}" data-tooltip="${_esc(facts.info)}"></i>` : ''}</div>
          <div class="ds-detail-sub">${_esc(s.type)} · <a href="${_esc(s.url)}" target="_blank" rel="noopener noreferrer">${_esc(host)}</a></div>
        </div>
        <div class="ds-detail-actions">
          <a class="btn btn-outline btn-sm" href="${_esc(s.url)}" target="_blank" rel="noopener noreferrer" title="Open ${_esc(host)}">${extIcon}<span class="ds-btn-label">Visit</span></a>
          <button type="button" class="btn btn-primary btn-sm" data-action="fetch-now" data-source-id="${s.id}" ${_scraperRunning ? 'disabled' : ''}>${fetchIcon}<span>${_scraperRunning ? 'Fetching…' : 'Fetch Now'}</span></button>
        </div>
      </div>

      <div class="ds-banner ${f.tone}" title="${_esc(f.title + ' — ' + f.text)}">
        <span class="ds-banner-icon">${toneIcon[f.tone] || toneIcon.info}</span>
        <div class="ds-banner-text"><b>${_esc(f.title)}</b><span>${_esc(f.text)}</span></div>
        ${f.action ? '<button type="button" class="btn btn-outline btn-sm" data-goto="taxes">Review rate</button>' : ''}
      </div>

      <div class="ds-facts">
        ${fact('Provides', _esc(s.dataType))}
        ${fact('Update cadence', _esc(facts.cadence || '—'))}
        ${fact('Last fetched', _esc(_displayLastFetch(s)), '', _esc(lastAbs))}
        ${fact(s.id === 'tc' ? 'Quarters tracked' : MONTHLY_IDS.includes(s.id) ? 'Months stored' : 'Records in database', _formatCount(s.totalRecords), '', breakdown)}
        ${fact('Used by', _esc(facts.usedBy || '—'), facts.route ? `<button type="button" class="ds-link" data-goto="${facts.route}">Open ${_esc(facts.routeLabel)} →</button>` : '')}
      </div>

      ${_renderValues(s)}`;
  }

  // ── actions ──────────────────────────────────────────────────────────────

  let _bound = false;
  function _bind() {
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', (e) => {
      if (!_mounted) return;
      const item = e.target.closest('#ds-list [data-source]');
      if (item) {
        _selected = item.dataset.source;
        _render(true);
        // Stacked layout (tablet/phone): the detail sits below the list, so bring it into view.
        if (window.innerWidth <= 860) document.getElementById('ds-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (e.target.closest('#ds-kpis [data-action="readiness"]')) { _openReadiness(); return; }
      const fetchBtn = e.target.closest('#ds-detail [data-action="fetch-now"]');
      if (fetchBtn) { _handleFetchNow(fetchBtn.dataset.sourceId); return; }
      const go = e.target.closest('#ds-detail [data-goto]');
      if (go) AgriPricePH.Router?.navigate(go.dataset.goto);
    });
    document.addEventListener('keydown', (e) => {
      if (!_mounted || !e.target.closest?.('#ds-list')) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = _sources.findIndex(s => s.id === _selected);
      const next = _sources[(i + (e.key === 'ArrowDown' ? 1 : -1) + _sources.length) % _sources.length];
      if (!next) return;
      _selected = next.id;
      _render(true);
      document.querySelector(`#ds-list [data-source="${next.id}"]`)?.focus();
    });
  }

  async function _handleFetchNow(sourceId) {
    const M = AgriPricePH.Modals;
    await _fetch();
    const source = _sources.find(s => s.id === sourceId);
    if (!source) return;
    if (!_apiOk) {
      await M.alert({ title: 'Backend not reachable', text: `Start run_backend.bat, then refresh. API target: ${AgriPricePH.API?.BASE || 'http://127.0.0.1:5000'}`, type: 'danger' });
      return;
    }
    const upToDate = source.hasDataToday && !(source.id === 'da' && source.isEstimated) && source.id !== 'tc';
    const latest = MONTHLY_IDS.includes(source.id) ? 'The latest published month' : 'Today\'s data';
    const ok = await M.confirm(upToDate
      ? { title: 'Already up to date', text: `${latest} from ${source.name} is already in the database. Fetch again anyway?`, type: 'info', okText: 'Fetch again' }
      : { title: `Fetch from ${source.name}?`, text: `Runs the scraper for this source now (${(source.url || '').replace(/^https?:\/\//, '')}). This can take up to a minute.`, type: 'info', okText: 'Fetch now' });
    if (!ok) return;
    await _runScrape(sourceId, source.name);
  }

  async function _runScrape(sourceId, name) {
    const M = AgriPricePH.Modals;
    M.loading(`Fetching from ${name}…`);
    try {
      const { ok, data } = await AgriPricePH.API.runScraper(sourceId);
      if (!ok) {
        M.hideLoading();
        await M.alert({ title: 'Couldn’t start the scraper', text: data?.message || data?.error || 'The backend refused the request.', type: 'danger' });
        return;
      }
      _scraperRunning = true;
      _render(true);
      await _waitForScrape();
      _scraperRunning = false;
      await _fetch();
      M.hideLoading();
      const s = _sources.find(x => x.id === sourceId);
      const f = s ? _freshness(s) : null;
      await M.alert({
        title: 'Fetch complete',
        text: f ? `${name}: ${f.title}. The latest values are shown on this page.` : `${name} finished.`,
        type: f && f.tone === 'bad' ? 'warning' : 'success',
      });
    } catch {
      M.hideLoading();
      await M.alert({ title: 'Connection lost', text: 'Lost connection to the backend while fetching.', type: 'danger' });
    }
  }

  function _waitForScrape(maxMs = 120000) {
    const start = Date.now();
    return new Promise((resolve) => {
      const tick = async () => {
        try {
          const status = await AgriPricePH.API.scrapeStatus();
          if (!status.stats?.running) { resolve(); return; }
        } catch { /* retry */ }
        if (Date.now() - start > maxMs) { resolve(); return; }
        setTimeout(tick, POLL_RUN_MS);
      };
      tick();
    });
  }

  return { init, destroy };
})();
