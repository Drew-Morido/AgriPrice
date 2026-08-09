/* AgriPricePH — Dashboard Module */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Dashboard = (function () {

  let _trendRiceType = 'local';
  let _predApi = null;
  let _predHistSeries = null;
  let _predLoading = false;
  let _predForecastLoading = false;
  let _predOrigin = 'local';
  let _predDay = 1;
  /** @type {Record<string, Array<{day:number,price:number,change:number,confidence:number,date:string}>>} */
  let _allForecasts = {};
  /** @type {Record<string, {mae_peso?:number, accuracy_pct?:number}>} */
  let _metricsByTarget = {};
  let _dashMetrics = null;

  const LSTM_TARGET = 'locWellMilled';

  const RICE_TYPES = {
    local: [
      { key: 'locWellMilled', label: 'Well-Milled', short: 'WM' },
      { key: 'locRegular', label: 'Regular Milled', short: 'RM' },
      { key: 'locPremium', label: 'Premium', short: 'PM' },
      { key: 'locSpecial', label: 'Special', short: 'SP' },
    ],
    imported: [
      { key: 'impWellMilled', label: 'Well-Milled', short: 'WM' },
      { key: 'impRegular', label: 'Regular Milled', short: 'RM' },
      { key: 'impPremium', label: 'Premium', short: 'PM' },
      { key: 'impSpecial', label: 'Special', short: 'SP' },
    ],
  };

  const TREND_SERIES = {
    local: {
      title: 'Local',
      keys: {
        wm: 'locWellMilled',
        rm: 'locRegular',
        pm: 'locPremium',
        sp: 'locSpecial',
      },
      labels: ['Well Milled', 'Regular Milled', 'Premium', 'Special'],
    },
    imported: {
      title: 'Imported',
      keys: {
        wm: 'impWellMilled',
        rm: 'impRegular',
        pm: 'impPremium',
        sp: 'impSpecial',
      },
      labels: ['Well Milled', 'Regular Milled', 'Premium', 'Special'],
    },
  };

  const TREND_COLORS = ['#4CAF6E', '#3B82F6', '#8B5CF6', '#F59E0B'];

  function isPredOnline() {
    return !!_predHistSeries;
  }

  function isLstmOnline() {
    const fb = _predApi?.forecasts_by_key;
    if (_predApi?.ready && fb && typeof fb === 'object') {
      return Object.values(fb).some(arr => Array.isArray(arr) && arr.length);
    }
    return !!(_predApi?.ready && Array.isArray(_predApi.forecast) && _predApi.forecast.length);
  }

  function histPriceAt(point) {
    if (point == null) return NaN;
    if (typeof point === 'object' && point.price != null) return Number(point.price);
    return Number(point);
  }

  function init() {
    bindTrendDropdown();
    bindPredFilters();
    _predLoading = true;
    renderPredTable();
    renderPriceTicker();
    renderSparklines();
    renderMainChart();
    renderPredBar();
    renderSourcesTable();
    hydrateFromApi();
    loadRecentAlerts();
    document.getElementById('dash-pred-view-more')?.addEventListener('click', (e) => {
      e.preventDefault();
      AgriPricePH.Router.navigate('predictions');
    });
  }

  function getTrendConfig() {
    return TREND_SERIES[_trendRiceType] || TREND_SERIES.local;
  }

  function getTrendSeriesData(hist, cfg) {
    const k = cfg.keys;
    return [
      hist[k.wm] || hist.wellMilled,
      hist[k.rm] || hist.regularMilled,
      hist[k.pm] || hist.premium,
      hist[k.sp],
    ];
  }

  function applyHistoricalPayload(hist) {
    if (!hist?.historical) return false;
    const h = hist.historical;
    const labels = hist.labels || [];
    const slice = -90;
    AgriPricePH.Data.historicalLabels = labels.slice(slice);
    const keys = [
      'locWellMilled', 'locRegular', 'locPremium', 'locSpecial',
      'impWellMilled', 'impRegular', 'impPremium', 'impSpecial',
      'fuel', 'exchange',
    ];
    _predHistSeries = h;
    keys.forEach(key => {
      if (h[key]) AgriPricePH.Data.historical[key] = (h[key] || []).slice(slice);
    });
    AgriPricePH.Data.historical.wellMilled = AgriPricePH.Data.historical.locWellMilled;
    AgriPricePH.Data.historical.regularMilled = AgriPricePH.Data.historical.locRegular;
    AgriPricePH.Data.historical.premium = AgriPricePH.Data.historical.locPremium;
    renderSparklines();
    renderMainChart();
    return true;
  }

  function _fmtTrainDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function _mergeMetricsByTarget(primary, fallback) {
    const out = { ...(fallback || {}) };
    Object.entries(primary || {}).forEach(([k, v]) => {
      if (v && typeof v === 'object') out[k] = { ...(out[k] || {}), ...v };
    });
    return out;
  }

  function applyDashboardMetrics(dm) {
    _dashMetrics = dm || null;
    const m = dm?.metrics || {};
    _metricsByTarget = _mergeMetricsByTarget(m.by_target, _predApi?.metrics?.by_target);

    if (m.mae_peso != null) {
      _setStat('stat-mae', `₱${Number(m.mae_peso).toFixed(2)}`);
    }
    if (m.rmse_peso != null) {
      _setStat('stat-rmse', `₱${Number(m.rmse_peso).toFixed(2)}`);
    }
    const acc = m.avg_accuracy_pct ?? m.accuracy_pct;
    if (acc != null) {
      _setStat('stat-accuracy', `${Number(acc).toFixed(1)}%`);
    }

    const trends = dm?.trends || {};
    _setStatTrend('stat-mae-change', trends.mae_peso_delta, 'mae');
    _setStatTrend('stat-rmse-change', trends.rmse_peso_delta, 'rmse');
    _setStatTrend('stat-accuracy-change', trends.accuracy_pct_delta, 'accuracy');

    const runId = dm?.model?.run_id;
    const trained = _fmtTrainDate(dm?.model?.last_trained);
    const src = dm?.source === 'training_history' ? 'Training History' : 'Saved model';
    const foot = runId && trained
      ? `${src} · run ${runId} · ${trained}`
      : trained
        ? `${src} · ${trained}`
        : (dm?.ready ? src : 'Train a model in Model Training');
    _setStatFootnote('stat-mae', foot);
    _setStatFootnote('stat-rmse', foot);
    _setStatFootnote('stat-accuracy', foot);

    const accPill = document.querySelector('#stat-accuracy .pill');
    if (accPill && acc != null) {
      if (acc >= 95) {
        accPill.textContent = 'Excellent';
        accPill.className = 'pill pill-green';
      } else if (acc >= 85) {
        accPill.textContent = 'Good';
        accPill.className = 'pill pill-green';
      } else {
        accPill.textContent = 'Review';
        accPill.className = 'pill pill-orange';
      }
    }
  }

  function _setStatFootnote(statId, text) {
    const card = document.getElementById(statId);
    if (!card || !text) return;
    let el = card.querySelector('.stat-footnote');
    if (!el) {
      el = document.createElement('div');
      el.className = 'stat-footnote text-xs text-muted';
      el.style.marginTop = '4px';
      card.querySelector('.stat-label')?.after(el);
    }
    el.textContent = text;
  }

  function _setStatTrend(elId, delta, kind) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (delta == null || Number.isNaN(Number(delta))) {
      el.className = 'stat-change text-muted';
      el.innerHTML = 'No previous completed run to compare';
      return;
    }
    const d = Number(delta);
    const abs = Math.abs(d);
    const fmt = kind === 'accuracy'
      ? `${d > 0 ? '+' : ''}${d.toFixed(2)}% vs previous run`
      : `${d > 0 ? '+' : ''}₱${abs.toFixed(2)} vs previous run`;
    const improved = kind === 'accuracy' ? d > 0 : d < 0;
    const dir = improved ? 'up' : d === 0 ? 'flat' : 'down';
    const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '→';
    const label = improved
      ? (kind === 'accuracy' ? 'improved' : 'lower error')
      : (d === 0 ? 'unchanged' : (kind === 'accuracy' ? 'lower' : 'higher error'));
    el.className = `stat-change ${dir}`;
    el.innerHTML = `<span>${arrow} ${escapeHtml(fmt)} (${escapeHtml(label)})</span>`;
  }

  function applyRecordCount(hist) {
    const labels = hist?.labels || [];
    const n = labels.length;
    if (n > 0) {
      const txt = n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
      _setStat('stat-records', txt);
      const el = document.getElementById('stat-records-change');
      if (el) {
        el.className = 'stat-change text-muted';
        el.textContent = `${n.toLocaleString()} merged daily rows (rice + fuel + FX)`;
      }
    }
  }

  function trainAccuracyForKey(riceKey) {
    const t = _metricsByTarget?.[riceKey];
    if (t?.accuracy_pct != null) return Number(t.accuracy_pct);
    return null;
  }

  async function hydrateFromApi() {
    _predLoading = true;
    _predForecastLoading = true;
    _allForecasts = {};
    _metricsByTarget = {};
    renderPredTable();
    updatePredSubtitle();

    const histPromise = AgriPricePH.API.historical().catch(e => {
      console.warn('Dashboard: historical API failed', e);
      return null;
    });
    const metricsPromise = AgriPricePH.API.dashboardMetrics().catch(e => {
      console.warn('Dashboard: dashboard-metrics failed', e);
      return null;
    });

    const hist = await histPromise;
    if (hist) {
      applyHistoricalPayload(hist);
      applyRecordCount(hist);
    }

    const dm = await metricsPromise;
    if (dm?.ready) applyDashboardMetrics(dm);

    _predLoading = false;
    renderPredTable();
    updatePredSubtitle();

    try {
      const pred = await AgriPricePH.API.predictions();
      _predApi = pred || null;
      if (pred?.ready) {
        _metricsByTarget = _mergeMetricsByTarget(_metricsByTarget, pred.metrics?.by_target);
        if (!_dashMetrics?.ready && pred.metrics) {
          applyDashboardMetrics({
            ready: true,
            source: 'meta.json',
            metrics: {
              mae_peso: pred.metrics.mae_peso,
              rmse_peso: pred.metrics.rmse_peso,
              accuracy_pct: pred.metrics.accuracy_pct,
              avg_accuracy_pct: pred.metrics.avg_accuracy_pct,
              by_target: pred.metrics.by_target,
            },
            trends: {},
            model: { last_trained: pred.last_data_date },
          });
        }
        if (pred.forecast?.length) {
          AgriPricePH.Data.forecast2d = pred.forecast;
          renderPredBar(pred.forecast);
        }
        if (pred.current_prices) {
          syncCurrentPricesFromApi(pred.current_prices);
          renderPriceTicker();
        }
      } else if (pred?.error) {
        console.warn('Dashboard: predictions API:', pred.error);
      }
    } catch (e) {
      console.warn('Dashboard: predictions API failed', e);
      _predApi = null;
    }

    _predForecastLoading = false;
    buildAllForecasts();
    renderPredTable();
    updatePredSubtitle();
  }

  function hasForecastPayload() {
    const fb = _predApi?.forecasts_by_key;
    if (_predApi?.ready && fb && typeof fb === 'object') {
      return Object.values(fb).some(arr => Array.isArray(arr) && arr.length);
    }
    return !!(
      _predApi?.ready &&
      Array.isArray(_predApi.forecast) &&
      _predApi.forecast.length
    );
  }

  function syncCurrentPricesFromApi(prices) {
    const map = {
      locWellMilled: 'Local Well-Milled',
      locRegular: 'Local Regular',
      locPremium: 'Local Premium',
      locSpecial: 'Local Special',
      impWellMilled: 'Imported Well-Milled',
      impRegular: 'Imported Regular',
      impPremium: 'Imported Premium',
      impSpecial: 'Imported Special',
    };
    AgriPricePH.Data.currentPrices = AgriPricePH.Data.currentPrices || {};
    Object.entries(map).forEach(([key, name]) => {
      const p = Number(prices[key]);
      if (!Number.isNaN(p) && p > 0) {
        const prev = AgriPricePH.Data.currentPrices[name];
        const change = prev ? p - prev.price : 0;
        const pct = prev?.price ? (change / prev.price) * 100 : 0;
        AgriPricePH.Data.currentPrices[name] = { price: p, change, pct };
      }
    });
  }

  function getHistValues(riceKey) {
    if (riceKey === LSTM_TARGET && _predApi?.history?.values?.length) {
      return _predApi.history.values.map(Number).filter(v => !Number.isNaN(v) && v > 0);
    }
    const series = _predHistSeries?.[riceKey]
      || AgriPricePH.Data.historical?.[riceKey]
      || [];
    return (Array.isArray(series) ? series : [])
      .map(histPriceAt)
      .filter(v => !Number.isNaN(v) && v > 0);
  }

  /** Fallback 2-day forecast from recent history when API row is missing. */
  function clientTrendForecast(riceKey) {
    const vals = getHistValues(riceKey);
    if (vals.length < 2) return [];
    const tail = vals.slice(-14);
    const n = tail.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = tail.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((a, i) => a + i * tail[i], 0);
    const sumXX = x.reduce((a, i) => a + i * i, 0);
    const denom = n * sumXX - sumX * sumX;
    const slope = denom ? (n * sumXY - sumX * sumY) / denom : 0;
    const base = tail[n - 1];
    let prev = vals[vals.length - 1];
    const out = [];
    for (let i = 0; i < 2; i++) {
      const price = Math.max(0.01, base + slope * (i + 1));
      const d = new Date();
      d.setDate(d.getDate() + i + 1);
      out.push({
        day: i + 1,
        date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        price,
        change: price - prev,
        confidence: 0.75,
        model: 'trend',
      });
      prev = price;
    }
    return out;
  }

  function getLastPrice(riceKey) {
    if (_predApi?.current_prices?.[riceKey] != null) {
      return Number(_predApi.current_prices[riceKey]);
    }
    const hist = getHistValues(riceKey);
    if (hist.length) return hist[hist.length - 1];
    return 0;
  }

  function mapForecastRows(rows) {
    return rows.map(f => ({
      day: f.day,
      date: f.date,
      price: f.price,
      change: f.change,
      confidence: f.confidence,
      model: (f.model || 'lstm').toLowerCase(),
    }));
  }

  function forecastForKey(riceKey) {
    const fromApi = _predApi?.forecasts_by_key?.[riceKey];
    if (Array.isArray(fromApi) && fromApi.length) {
      return mapForecastRows(fromApi);
    }
    if (
      riceKey === LSTM_TARGET &&
      _predApi?.ready &&
      Array.isArray(_predApi.forecast) &&
      _predApi.forecast.length
    ) {
      return mapForecastRows(_predApi.forecast);
    }
    return [];
  }

  function buildAllForecasts() {
    _allForecasts = {};
    const allTypes = [...RICE_TYPES.local, ...RICE_TYPES.imported];
    const fb = _predApi?.forecasts_by_key;

    if (_predApi?.ready && fb && typeof fb === 'object') {
      allTypes.forEach(({ key }) => {
        if (Array.isArray(fb[key]) && fb[key].length) {
          _allForecasts[key] = mapForecastRows(fb[key]);
        }
      });
    }

    allTypes.forEach(({ key }) => {
      if (!_allForecasts[key]?.length) {
        const rows = forecastForKey(key);
        if (rows.length) _allForecasts[key] = rows;
      }
    });
  }

  function bindPredFilters() {
    const originToggle = document.getElementById('dash-pred-origin-toggle');
    const dayToggle = document.getElementById('dash-pred-day-toggle');

    originToggle?.querySelectorAll('.dash-pred-segment-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        originToggle.querySelectorAll('.dash-pred-segment-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _predOrigin = btn.dataset.origin || 'local';
        renderPredTable();
        updatePredSubtitle();
      });
    });

    dayToggle?.querySelectorAll('.dash-pred-segment-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        dayToggle.querySelectorAll('.dash-pred-segment-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _predDay = parseInt(btn.dataset.day, 10) || 1;
        renderPredTable();
        updatePredSubtitle();
      });
    });
  }

  function updatePredSubtitle() {
    const el = document.getElementById('dash-pred-subtitle');
    if (!el) return;
    const origin = _predOrigin === 'imported' ? 'Imported' : 'Local';
    if (_predLoading) {
      el.textContent = 'Loading historical prices…';
      return;
    }
    if (_predForecastLoading) {
      el.textContent = 'Running LSTM inference (8 rice types) — first load may take ~15s…';
      return;
    }
    if (!hasForecastPayload() && !isPredOnline()) {
      el.textContent = 'Live forecasts unavailable — start API server (python api/app.py)';
      return;
    }
    const dayLabel = _predApi?.forecast?.[_predDay - 1]?.date || formatDayDate(_predDay);
    const acc = _dashMetrics?.metrics?.avg_accuracy_pct
      ?? _dashMetrics?.metrics?.accuracy_pct
      ?? _predApi?.metrics?.avg_accuracy_pct
      ?? _predApi?.metrics?.accuracy_pct;
    const lstmCount = _predApi?.model_notes?.lstm_count
      || (_predApi?.forecasts_by_key ? Object.keys(_predApi.forecasts_by_key).length : 0);
    const runNote = _dashMetrics?.model?.run_id
      ? ` · run ${_dashMetrics.model.run_id}`
      : '';
    const lstmNote = isLstmOnline()
      ? `LSTM · hold-out test${acc != null ? ` avg ${Number(acc).toFixed(1)}%` : ''}${lstmCount ? ` · ${lstmCount} models` : ''}${runNote}`
      : (_predApi?.error ? `unavailable — ${_predApi.error}` : 'estimates unavailable');
    el.textContent = `${origin} rice · Day ${_predDay} (${dayLabel}) · Live · ${lstmNote}`;
  }

  function formatDayDate(dayNum) {
    const d = new Date();
    d.setDate(d.getDate() + dayNum);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function renderPredTable() {
    const container = document.getElementById('dash-pred-rows');
    if (!container) return;

    if (_predLoading) {
      container.innerHTML = '<div class="dash-pred-loading text-muted">Loading historical data…</div>';
      return;
    }

    if (_predForecastLoading) {
      const types = RICE_TYPES[_predOrigin] || RICE_TYPES.local;
      container.innerHTML = types.map(({ key, label }) => {
        const last = getLastPrice(key);
        const lastTxt = last > 0 ? `₱${last.toFixed(2)}` : '—';
        return `<div class="dash-pred-row">
          <span><div class="dash-pred-type">${escapeHtml(label)}</div></span>
          <span class="dash-pred-price">${lastTxt}</span>
          <span colspan="4" class="text-muted">LSTM inference…</span>
        </div>`;
      }).join('');
      return;
    }

    if (!hasForecastPayload() && !isPredOnline()) {
      container.innerHTML = '<div class="dash-pred-loading text-muted">Live forecasts unavailable. Run <strong>python api/app.py</strong> and ensure the database has historical data.</div>';
      return;
    }

    const types = RICE_TYPES[_predOrigin] || RICE_TYPES.local;
    const dayIdx = _predDay - 1;

    const originKeys = types.map(t => t.key);
    const hasAnyRow = originKeys.some(k => (_allForecasts[k] || []).length);
    if (!hasAnyRow) {
      const err = _predApi?.error ? ` — ${_predApi.error}` : '';
      container.innerHTML = `<div class="dash-pred-loading text-muted">No LSTM forecasts returned${err}. Restart API and hard-refresh (Ctrl+Shift+R).</div>`;
      return;
    }

    container.innerHTML = types.map(({ key, label, short }) => {
      const days = _allForecasts[key] || [];
      const row = days[dayIdx];
      const last = getLastPrice(key);
      if (!row) {
        const lastTxt = last > 0 ? `₱${last.toFixed(2)}` : '—';
        return `<div class="dash-pred-row">
          <span><div class="dash-pred-type">${escapeHtml(label)}</div></span>
          <span class="dash-pred-price">${lastTxt}</span>
          <span colspan="4" class="text-muted">No forecast — retrain models</span>
        </div>`;
      }

      const prev = dayIdx === 0 ? last : (days[dayIdx - 1]?.price ?? last);
      const change = row.change != null ? row.change : row.price - prev;
      const dir = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
      const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '→';
      const sign = change > 0 ? '+' : '';
      const modelId = (row.model || 'lstm').toLowerCase();
      const isLstm = modelId === 'lstm';
      const trainAcc = trainAccuracyForKey(key);
      const confPct = trainAcc != null
        ? Number(trainAcc).toFixed(1)
        : (row.confidence != null ? (Number(row.confidence) * 100).toFixed(1) : '—');
      const maeHint = _metricsByTarget?.[key]?.mae_peso;
      const accTitle = trainAcc != null
        ? `Hold-out test accuracy (2024–2025)${maeHint != null ? ` · MAE ₱${Number(maeHint).toFixed(2)}/kg` : ''}`
        : (isLstm ? 'Estimated from model error' : 'Trend estimate');
      const originLabel = _predOrigin === 'imported' ? 'Imported' : 'Local';
      const modelLabel = isLstm ? 'LSTM' : 'Trend est.';
      const pillClass = isLstm ? 'pill-green' : 'pill-gray';

      return `
        <div class="dash-pred-row">
          <span>
            <div class="dash-pred-type">${escapeHtml(originLabel)} ${escapeHtml(label)}</div>
            <div class="dash-pred-type-sub">${escapeHtml(short)} · ${escapeHtml(row.date || `Day ${row.day}`)}</div>
          </span>
          <span class="dash-pred-price">₱${last.toFixed(2)}</span>
          <span class="dash-pred-price">₱${row.price.toFixed(2)}</span>
          <span class="dash-pred-change ${dir}">${arrow} ${sign}${change.toFixed(2)}</span>
          <span class="dash-pred-conf" title="${escapeHtml(accTitle)}">${confPct}%</span>
          <span><span class="pill ${pillClass}">${modelLabel}</span></span>
        </div>`;
    }).join('');
  }

  async function loadRecentAlerts() {
    const container = document.getElementById('dash-recent-alerts');
    const badge = document.getElementById('dash-alerts-badge');
    if (!container) return;

    const dotClass = { danger: 'red', warning: 'orange', info: 'blue', success: 'blue' };

    try {
      const summary = await AgriPricePH.API.alertsSummary();
      const recent = summary?.recent || [];
      const today = summary?.triggered_today ?? 0;
      if (badge) badge.textContent = today > 0 ? `${today} today` : 'OK';

      if (recent.length) {
        AgriPricePH.Data.notifLog = recent.map(n => ({
          type: n.type,
          title: n.title,
          desc: n.desc,
          time: n.time,
        }));
      }

      renderRecentAlerts(
        container,
        recent.length ? recent : (AgriPricePH.Data.notifLog?.slice(0, 5) || []),
        dotClass
      );
    } catch (e) {
      console.warn('Dashboard: alerts API offline', e);
      renderRecentAlerts(
        container,
        AgriPricePH.Data.notifLog?.slice(0, 5) || [],
        dotClass
      );
      if (badge) badge.textContent = 'Offline';
    }
  }

  function renderRecentAlerts(container, items, dotClass) {
    if (!items.length) {
      container.innerHTML = `
        <div class="text-muted" style="font-size:12px;line-height:1.5;">
          No price alerts triggered yet.
          <a href="#alerts" style="color:var(--color-accent);font-weight:600;">Configure rules →</a>
        </div>`;
      return;
    }
    container.innerHTML = items.map(n => {
      const dot = dotClass[n.type] || 'blue';
      const text = n.desc || n.title || '';
      const title = n.title && n.desc ? `<strong>${escapeHtml(n.title)}</strong> — ` : '';
      return `
        <div class="alert-item">
          <span class="alert-dot ${dot}"></span>
          <div>
            <div class="alert-text">${title}${escapeHtml(text)}</div>
            <div class="alert-time">${escapeHtml(n.time || '—')}</div>
          </div>
        </div>`;
    }).join('');
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _setStat(id, value) {
    if (value == null) return;
    const el = document.getElementById(id);
    if (el) {
      const valEl = el.querySelector('.stat-value');
      if (valEl) valEl.textContent = value;
    }
  }

  function updateTrendHeader() {
    const cfg = getTrendConfig();
    const titleEl = document.getElementById('dash-trend-title');
    const legendEl = document.getElementById('dash-trend-legend');
    if (titleEl) {
      titleEl.textContent = `Rice Price Trend — Last 90 Days (${cfg.title})`;
    }
    if (legendEl) {
      legendEl.innerHTML = cfg.labels.map((label, i) => `
        <span class="dash-legend-item">
          <span class="dash-legend-swatch" style="background:${TREND_COLORS[i]};"></span>${label}
        </span>`).join('');
    }
  }

  function bindTrendDropdown() {
    const wrap = document.getElementById('dash-trend-select-wrap');
    const trigger = document.getElementById('dash-trend-select-trigger');
    const dropdown = document.getElementById('dash-trend-dropdown');
    const label = document.getElementById('dash-trend-select-label');
    if (!wrap || !trigger || !dropdown || !label) return;

    const close = () => wrap.classList.remove('open');

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      wrap.classList.toggle('open');
    });

    dropdown.querySelectorAll('.outlook-option').forEach(opt => {
      opt.addEventListener('click', () => {
        dropdown.querySelectorAll('.outlook-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        _trendRiceType = opt.dataset.value || 'local';
        label.textContent = opt.textContent.trim();
        close();
        updateTrendHeader();
        renderMainChart();
      });
    });

    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });
  }

  function renderPriceTicker() {
    const container = document.getElementById('dash-price-list');
    if (!container) return;
    const data = AgriPricePH.Data.currentPrices;
    container.innerHTML = '';
    Object.entries(data).forEach(([name, d]) => {
      const trendClass = d.change > 0 ? 'up' : d.change < 0 ? 'down' : 'flat';
      const arrow = d.change > 0 ? '▲' : d.change < 0 ? '▼' : '→';
      const sign  = d.change > 0 ? '+' : '';
      container.insertAdjacentHTML('beforeend', `
        <div class="rice-price-row">
          <span class="rice-name">${name}</span>
          <span class="rice-price-value">₱${d.price.toFixed(2)}</span>
          <span class="rice-trend ${trendClass}">${arrow} ${sign}${d.pct.toFixed(2)}%</span>
        </div>`);
    });
  }

  function renderSparklines() {
    const hist = AgriPricePH.Data.historical;
    const sparkData = {
      'spark-wm':   { data: hist.locWellMilled || hist.wellMilled, color: '#4CAF6E' },
      'spark-rm':   { data: hist.locRegular || hist.regularMilled, color: '#3B82F6' },
      'spark-fuel': { data: hist.fuel, color: '#F59E0B' },
      'spark-usd':  { data: hist.exchange, color: '#8B5CF6' },
    };
    Object.entries(sparkData).forEach(([id, cfg]) => {
      const el = document.getElementById(id);
      if (el && cfg.data?.length) AgriPricePH.Charts.sparkline(el, cfg.data, cfg.color, true);
    });
  }

  function renderMainChart() {
    const canvas = document.getElementById('main-price-chart');
    if (!canvas) return;
    const hist = AgriPricePH.Data.historical;
    const labels = AgriPricePH.Data.historicalLabels;
    const cfg = getTrendConfig();
    const [wm, rm, pm, sp] = getTrendSeriesData(hist, cfg);

    updateTrendHeader();

    if (!wm?.length) return;

    const series = [
      { data: wm, color: TREND_COLORS[0], fill: true, lineWidth: 2.5, label: cfg.labels[0] },
      { data: rm, color: TREND_COLORS[1], fill: false, lineWidth: 2, label: cfg.labels[1] },
      { data: pm, color: TREND_COLORS[2], fill: false, lineWidth: 2, label: cfg.labels[2] },
    ];
    if (sp?.length) {
      series.push({ data: sp, color: TREND_COLORS[3], fill: false, lineWidth: 2, label: cfg.labels[3] });
    }

    AgriPricePH.Charts.lineChart(canvas, series, {
      labels,
      padding: { top: 20, right: 20, bottom: 36, left: 54 },
    });
  }

  function renderPredBar(forecast) {
    const container = document.getElementById('dash-pred-bars');
    if (!container) return;
    const data = forecast || AgriPricePH.Data.forecast2d || AgriPricePH.Data.forecast7d?.slice(0, 2) || [];
    const prices = data.map(d => d.price ?? d.wm);
    const maxP = Math.max(...prices);
    const minP = Math.min(...prices);
    container.innerHTML = data.map((d, i) => {
      const price = d.price ?? d.wm;
      const label = d.date?.split?.(' ')?.[1] || `Day ${d.day || i + 1}`;
      const pct = ((price - minP) / ((maxP - minP) || 1)) * 60 + 35;
      return `
        <div class="pred-day">
          <span class="pred-day-label">${label}</span>
          <div class="pred-bar-wrap">
            <div class="pred-bar" style="width:${pct}%">
              <span class="pred-bar-val">₱${Number(price).toFixed(2)}</span>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function renderSourcesTable() {
    const container = document.getElementById('dash-sources-table');
    if (!container) return;
    const sources = AgriPricePH.Data.dataSources;
    const header = `
      <div class="ds-row ds-header">
        <span>Source</span><span>Type</span><span>Last Fetch</span><span>Today</span><span>Status</span>
      </div>`;
    const rows = sources.map(s => {
      const statusClass = s.status === 'active' ? 'pill-green' : 'pill-gray';
      return `
        <div class="ds-row">
          <span class="ds-name" style="color:${s.color};">${s.name.split('–')[0].trim()}</span>
          <span class="ds-type">${s.type}</span>
          <span class="ds-fetch">${s.lastFetch}</span>
          <span class="ds-today">+${s.recordsToday}</span>
          <span><span class="pill ${statusClass}">${s.status === 'active' ? 'Active' : 'Idle'}</span></span>
        </div>`;
    }).join('');
    container.innerHTML = header + rows;
  }

  function applySearchContext() {
    /* dashboard search opens page only */
  }

  return { init, applySearchContext };
})();
