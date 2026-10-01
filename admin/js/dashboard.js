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
  /** @type {Record<string, {mae_peso?:number, accuracy_pct?:number, per_horizon_accuracy_pct?:number[]}>} */
  let _metricsByTarget = {};
  let _dashMetrics = null;
  /** Last `current_prices` payload, kept so the ticker can be recomputed once
      the historical series arrives (the two API calls race). */
  let _currentPricesApi = null;

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

  // Plain-language grade explainers for admin/IT staff who don't know DA's rice
  // classifications by heart — shown as (i) tooltips on each legend chip. Order
  // matches TREND_SERIES labels (Well Milled, Regular Milled, Premium, Special),
  // which is the same for both local and imported.
  const TREND_LABEL_DESCS = [
    'Mid-tier DA grade — the default retail rice for most households, priced between Regular Milled and Premium.',
    'Entry-level DA grade — the most affordable and least polished of the four grades tracked.',
    'Higher-polish DA grade — priced above Well Milled and Regular Milled.',
    'Top DA grade — the highest quality and typically the highest price of the four.',
  ];

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
    syncStatInfoLabels();
    bindTrendDropdown();
    bindPredFilters();
    _predLoading = true;
    renderPredTable();
    renderPriceTicker();
    renderMarketStats();
    renderMainChart();
    refreshSourceStatus();
    hydrateFromApi();
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
    renderMarketStats();
    renderMainChart();
    // The prices and history calls race; whichever lands second recomputes the
    // ticker so the day-over-day percentages have a real baseline to use.
    syncCurrentPricesFromApi();
    renderPriceTicker();
    return true;
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

    // All-types average, to match the all-types hit rate beside it. `mae_peso` alone is the primary
    // rice type's (Local Well-Milled) error; it is only the fallback for an older backend.
    const maeAll = m.mae_peso_all_types ?? m.mae_peso;
    if (maeAll != null) {
      _setStat('stat-mae', `₱${Number(maeAll).toFixed(2)}`);
    }
    // Headline accuracy = day-1 hit rate within ₱1.00, NOT the legacy `accuracy_pct`
    // (100 − MAE/mean_price), which returns 98–99% for anything and rates the naive
    // "tomorrow = today" baseline above the trained model on all 8 rice types.
    const hit1 = m.hit_rate_pct?.['1.00']?.[0];
    const acc = m.avg_accuracy_pct ?? m.accuracy_pct;
    const label = document.getElementById('stat-accuracy-label');
    if (hit1 != null) {
      _setStat('stat-accuracy', `${Number(hit1).toFixed(1)}%`);
    } else if (acc != null) {
      // Pre-v4 run: no hit rate recorded. Show the legacy number but say what it is.
      _setStat('stat-accuracy', `${Number(acc).toFixed(1)}%`);
      if (label) label.firstChild.textContent = 'Model Accuracy (legacy) ';
    }

    const trends = dm?.trends || {};
    _setStatTrend('stat-mae-change',
      m.mae_peso_all_types != null ? trends.mae_all_types_delta : trends.mae_peso_delta, 'mae');
    // The trend must describe the number on the card: the hit rate's change, not the legacy formula's.
    if (hit1 != null) _setStatTrend('stat-accuracy-change', trends.hit_rate_1p_delta, 'points');
    else _setStatTrend('stat-accuracy-change', trends.accuracy_pct_delta, 'accuracy');

    // Pill thresholds are for the ₱1.00 hit rate, which sits far lower than the legacy
    // accuracy figure — 95/85 there would have read "Excellent" for every possible model.
    const accPill = document.querySelector('#stat-accuracy .pill');
    const pillVal = hit1 ?? acc;
    if (accPill && pillVal != null) {
      const good = hit1 != null ? 90 : 95;
      const ok = hit1 != null ? 80 : 85;
      if (pillVal >= good) {
        accPill.textContent = 'Strong';
        accPill.className = 'pill pill-green';
      } else if (pillVal >= ok) {
        accPill.textContent = 'Fair';
        accPill.className = 'pill pill-green';
      } else {
        accPill.textContent = 'Review';
        accPill.className = 'pill pill-orange';
      }
    }
  }

  function setStatTooltip(icon, text) {
    icon.dataset.tooltip = text;
    // The popover is a CSS ::after, which screen readers ignore — mirror it.
    icon.setAttribute('aria-label', text.replace(/\s*\n+\s*/g, ' ').trim());
  }

  function syncStatInfoLabels() {
    document.querySelectorAll('.stat-info-icon[data-tooltip]').forEach((icon) => {
      if (icon.dataset.tooltip) setStatTooltip(icon, icon.dataset.tooltip);
    });
  }

  function _setStatTrend(elId, delta, kind) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (delta == null || Number.isNaN(Number(delta))) {
      el.className = 'stat-change text-muted';
      el.innerHTML = 'No previous run yet';
      return;
    }
    const d = Number(delta);
    const abs = Math.abs(d);
    // Short form for the card ("▼ ₱0.50 (better)"); what it's compared against
    // and what "better/worse" means is explained in the card's ⓘ tooltip instead
    // of being repeated here.
    const val = kind === 'points' ? `${abs.toFixed(1)} pts`
      : kind === 'accuracy' ? `${abs.toFixed(2)}%` : `₱${abs.toFixed(2)}`;
    const improved = kind === 'accuracy' || kind === 'points' ? d > 0 : d < 0;
    const dir = improved ? 'up' : d === 0 ? 'flat' : 'down';
    const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '→';
    const word = d === 0 ? 'same' : (improved ? 'better' : 'worse');
    el.className = `stat-change ${dir}`;
    el.innerHTML = `<span>${arrow} ${escapeHtml(val)} (${escapeHtml(word)})</span>`;
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
        el.textContent = `${n.toLocaleString()} rows`;
      }
    }
  }

  /**
   * Hold-out accuracy for a rice type. When `dayIdx` is given (0 = day 1) this
   * returns the accuracy measured for *that* forecast step.
   *
   * `accuracy_pct` on its own is pooled across the whole 3-day horizon, so using
   * it for every row made day 1, day 2 and day 3 show an identical number even
   * though day 3 is measurably harder — training records the per-step figures
   * (`per_horizon_accuracy_pct`) precisely so this doesn't have to guess.
   */
  function trainAccuracyForKey(riceKey, dayIdx) {
    const t = _metricsByTarget?.[riceKey];
    if (!t) return null;
    // Preferred: % of that day's forecasts that landed within ₱1.00 — a figure that states its
    // threshold. `per_horizon_accuracy_pct` is the legacy 100−MAE/mean_price formula, which
    // returns 98–99% for any model; it is only a fallback for pre-v4 runs.
    // P0.50, the band the public Price Forecast page shows for the same rice type and day, so both
    // sides print the same number (they used to show P1.00 here and P0.50 there).
    const hit = t.hit_rate_050_pct || t.hit_rate_pct?.['0.50'];
    if (dayIdx != null && Array.isArray(hit) && hit[dayIdx] != null) return Number(hit[dayIdx]);
    const perDay = t.per_horizon_accuracy_pct;
    if (dayIdx != null && Array.isArray(perDay) && perDay[dayIdx] != null) {
      return Number(perDay[dayIdx]);
    }
    if (t.accuracy_pct != null) return Number(t.accuracy_pct);
    return null;
  }

  /** True when the table is showing hit rates rather than the legacy accuracy formula. */
  function usingHitRate(keys) {
    return keys.some(k => Array.isArray(_metricsByTarget?.[k]?.hit_rate_050_pct || _metricsByTarget?.[k]?.hit_rate_pct?.['0.50']));
  }

  function trainMaeForKey(riceKey, dayIdx) {
    const t = _metricsByTarget?.[riceKey];
    if (!t) return null;
    const perDay = t.per_horizon_mae_peso;
    if (dayIdx != null && Array.isArray(perDay) && perDay[dayIdx] != null) {
      return Number(perDay[dayIdx]);
    }
    return t.mae_peso != null ? Number(t.mae_peso) : null;
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

  const TICKER_NAMES = {
    locWellMilled: 'Local Well-Milled',
    locRegular: 'Local Regular',
    locPremium: 'Local Premium',
    locSpecial: 'Local Special',
    impWellMilled: 'Imported Well-Milled',
    impRegular: 'Imported Regular',
    impPremium: 'Imported Premium',
    impSpecial: 'Imported Special',
  };

  /**
   * Yesterday's observed price for a rice type, from the merged daily history.
   *
   * `/api/historical` reads the DB live and `/api/predictions` (the source of
   * `current_prices`) reads from a cached merged frame, so their "last row" isn't
   * always the same calendar day — the history array can end one day ahead of
   * `current_prices`. Blindly taking history[-2] as "yesterday" then compares
   * today against itself whenever that happens, which is why every row in
   * Today's Rice Prices was reading "→ 0.00%". Locating today's actual value in
   * the series first (searching from the end) and stepping back one from there
   * keeps the comparison correct regardless of which side is ahead.
   */
  function previousObservedPrice(riceKey, currentPrice) {
    const series = _predHistSeries?.[riceKey] || AgriPricePH.Data.historical?.[riceKey];
    if (!Array.isArray(series) || series.length < 2) return null;
    const vals = series.map(histPriceAt).filter(v => !Number.isNaN(v) && v > 0);
    if (vals.length < 2) return null;
    if (currentPrice != null) {
      for (let i = vals.length - 1; i >= 1; i--) {
        if (Math.abs(vals[i] - currentPrice) < 0.01) return vals[i - 1];
      }
    }
    return vals[vals.length - 2];
  }

  /**
   * "Today's Rice Prices" day-over-day change.
   *
   * This used to diff the live API price against whatever already sat in
   * AgriPricePH.Data.currentPrices — which, on first paint, is the hardcoded demo
   * data in js/data.js. A real ₱58.94 was being compared with a mock ₱52.50 and
   * reported as "▲ +12.27%", a price move that never happened. The comparison is
   * now against the previous day's actual observation in the merged history, and
   * when that isn't loaded yet the percentage is withheld rather than invented.
   */
  function syncCurrentPricesFromApi(prices) {
    if (prices) _currentPricesApi = prices;
    if (!_currentPricesApi) return;
    const next = {};
    Object.entries(TICKER_NAMES).forEach(([key, name]) => {
      const p = Number(_currentPricesApi[key]);
      if (Number.isNaN(p) || p <= 0) return;
      const prev = previousObservedPrice(key, p);
      const change = prev != null ? p - prev : null;
      const pct = prev ? (change / prev) * 100 : null;
      next[name] = { price: p, change, pct, prev };
    });
    if (Object.keys(next).length) AgriPricePH.Data.currentPrices = next;
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
      // Conformal prediction interval — absent on trend/fallback rows.
      low: f.low,
      high: f.high,
      interval_pct: f.interval_pct,
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

    originToggle?.querySelectorAll('.dash-pred-segment-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        originToggle.querySelectorAll('.dash-pred-segment-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _predOrigin = btn.dataset.origin || 'local';
        renderPredTable();
        updatePredSubtitle();
      });
    });
  }

  // The header line used to carry the whole provenance chain in one breath
  // ("Local rice · Day 1 (Sep 08) · Live · LSTM · hold-out test avg 98.7% ·
  // 8 models · run 20260905-203122"). Visible text is now just the origin the
  // filter is on; the rest moved into the ⓘ popup beside it, one plain-language
  // paragraph per idea. `paras` entries are joined with a blank line between
  // them, so an entry that is null simply drops out of the popup.
  function setPredSubtitle(short, paras) {
    const el = document.getElementById('dash-pred-subtitle');
    if (el) el.textContent = short;
    const icon = document.getElementById('dash-pred-subtitle-info');
    if (!icon) return;
    const body = (Array.isArray(paras) ? paras : [paras]).filter(Boolean).join('\n\n');
    setStatTooltip(icon, body);
  }

  function updatePredSubtitle() {
    const origin = _predOrigin === 'imported' ? 'Imported' : 'Local';
    const originWord = _predOrigin === 'imported' ? 'imported' : 'local';
    if (_predLoading) {
      setPredSubtitle('Loading…', 'Reading the price history out of the database.');
      return;
    }
    if (_predForecastLoading) {
      setPredSubtitle('Loading…', [
        'Running the forecast model for all 8 rice types.',
        'The first load after the server starts can take about 15 seconds.',
      ]);
      return;
    }
    if (!hasForecastPayload() && !isPredOnline()) {
      // Error states keep a self-explanatory visible label: hiding "the server
      // is down" behind a hover would make the one line that matters the one
      // line nobody sees.
      setPredSubtitle('Forecasts offline', [
        'Live forecasts are unavailable because the API server is not responding.',
        'Start it from the project folder with:\npy -3.13 api/app.py',
      ]);
      return;
    }
    const dayLabel = _predApi?.forecast?.[_predDay - 1]?.date || formatDayDate(_predDay);
    const acc = _dashMetrics?.metrics?.avg_accuracy_pct
      ?? _dashMetrics?.metrics?.accuracy_pct
      ?? _predApi?.metrics?.avg_accuracy_pct
      ?? _predApi?.metrics?.accuracy_pct;
    const lstmCount = _predApi?.model_notes?.lstm_count
      || (_predApi?.forecasts_by_key ? Object.keys(_predApi.forecasts_by_key).length : 0);
    const runId = _dashMetrics?.model?.run_id;

    let sourcePara;
    let detailPara = '';
    if (isLstmOnline()) {
      sourcePara = `Forecasts are live from the trained LSTM model${lstmCount ? `, one per rice type (${lstmCount} in total)` : ''}.`;
      detailPara = [
        acc != null ? `Average accuracy on the hold-out test: ${Number(acc).toFixed(1)}%` : '',
        runId ? `Run ID: ${runId}` : '',
      ].filter(Boolean).join('\n');
    } else if (_predApi?.error) {
      sourcePara = `Live forecasts are unavailable — ${friendlyPredError(_predApi.error)}`;
    } else {
      sourcePara = 'Live forecasts are unavailable right now, so the table shows the last known prices.';
    }

    setPredSubtitle(origin, [
      `Showing ${originWord} rice, day ${_predDay} of the 3-day forecast (${dayLabel}).`,
      sourcePara,
      detailPara,
    ]);
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

    // The column now reports the accuracy measured for the selected forecast day,
    // so the heading has to say which day it is.
    const accHead = document.getElementById('dash-pred-acc-head');
    const accInfo = document.getElementById('dash-pred-acc-info');
    const keys = types.map(t => t.key);
    const isHit = usingHitRate(keys);
    if (accHead) {
      const perDay = isHit
        || types.some(t => Array.isArray(_metricsByTarget?.[t.key]?.per_horizon_accuracy_pct));
      // "Day 1 within ₱1" read as jargon to a non-technical admin with no context for what
      // "within ₱1" refers to. "Hit Rate" names the metric (matches hit_rate_pct elsewhere in
      // the app); which day it covers lives in the (i) tooltip instead of the header itself,
      // since the Day 1/2/3 toggle right above the table already makes that obvious.
      accHead.textContent = !perDay
        ? 'Accuracy'
        : isHit ? 'Within ₱0.50' : `Day ${_predDay} accuracy`;
      if (accInfo) {
        setStatTooltip(accInfo, isHit
          ? `How many of the Day ${_predDay} forecasts landed within ₱0.50 of the real price, measured on data the model never saw during training — the same figure the public Price Forecast page shows. Higher is better.`
          : `Day ${_predDay} hold-out test accuracy (legacy formula).`);
      }
    }

    const originKeys = types.map(t => t.key);
    const hasAnyRow = originKeys.some(k => (_allForecasts[k] || []).length);
    if (!hasAnyRow) {
      const err = _predApi?.error ? ` — ${escapeHtml(friendlyPredError(_predApi.error))}` : '';
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
      // A forecast move under 10 centavos is shown as 'steady', not as a rise or fall: the model cannot call direction that small better than a coin flip (PAPER_CORRECTIONS.md, 'Up/down reliability').
      const steady = Math.abs(change) < 0.10;
      const dir = steady ? 'flat' : change > 0 ? 'up' : 'down';
      const arrow = steady ? '→' : change > 0 ? '▲' : '▼';
      const sign = change > 0 ? '+' : '';
      const modelId = (row.model || 'lstm').toLowerCase();
      // 'ensemble' = the LSTM hybrid combined with ARIMA and the weekday Kalman filter (model/ensemble.py).
      const isLstm = modelId === 'lstm' || modelId === 'ensemble';
      const trainAcc = trainAccuracyForKey(key, dayIdx);
      const perDayAcc = Array.isArray(_metricsByTarget?.[key]?.per_horizon_accuracy_pct);
      const confPct = trainAcc != null
        ? Number(trainAcc).toFixed(1)
        : (row.confidence != null ? (Number(row.confidence) * 100).toFixed(1) : '—');
      const maeHint = trainMaeForKey(key, dayIdx);
      const accTitle = trainAcc == null
        ? (isLstm ? 'Estimated from model error' : 'Trend estimate')
        : (isHit
          ? `Share of day-${_predDay} forecasts that landed within ₱0.50 of the real price, on hold-out test data`
          : `${perDayAcc ? `Day ${_predDay}` : 'Whole 3-day'} hold-out test accuracy (legacy formula)`)
          + `${maeHint != null ? ` · average error ₱${Number(maeHint).toFixed(2)}/kg` : ''}`;
      const originLabel = _predOrigin === 'imported' ? 'Imported' : 'Local';
      const modelLabel = modelId === 'ensemble' ? 'Ensemble' : (isLstm ? 'LSTM' : 'Trend est.');
      const pillClass = isLstm ? 'pill-green' : 'pill-gray';

      return `
        <div class="dash-pred-row">
          <span>
            <div class="dash-pred-type">${escapeHtml(originLabel)} ${escapeHtml(label)}</div>
            <div class="dash-pred-type-sub">${escapeHtml(short)} · ${escapeHtml(row.date || `Day ${row.day}`)}</div>
          </span>
          <span class="dash-pred-price">₱${last.toFixed(2)}</span>
          <span class="dash-pred-price">${forecastCellHtml(row)}</span>
          <span class="dash-pred-change ${dir}">${arrow} ${sign}${change.toFixed(2)}</span>
          <span class="dash-pred-conf" title="${escapeHtml(accTitle)}">${confPct}%</span>
          <span><span class="pill ${pillClass}">${modelLabel}</span></span>
        </div>`;
    }).join('');
  }

  /**
   * The forecast cell: a calibrated price RANGE, not a single peso figure.
   *
   * The point estimate used to be the headline with the range as a footnote. That reads as a
   * precision the model does not have — daily rice prices are close to a random walk, so a
   * forecast of exactly ₱47.96 is a number that will essentially never be right. The band is the
   * honest answer, so it is the number shown. `low`/`high` come from conformal calibration in
   * model/predict.py, which measures 90% coverage on held-out data.
   *
   * Note this is deliberately NOT applied to the Last Price column: that is an observed DA figure,
   * not a prediction. Giving it a band would invent uncertainty that does not exist and erase the
   * one distinction that matters here — measured vs forecast.
   *
   * The cell shows the two numbers and nothing else. The coverage level and the central estimate
   * live in the hover title — repeating "90% range" on every row added a line of text that never
   * changes, and the card's ⓘ already explains what the band means.
   */
  function forecastCellHtml(row) {
    const point = `₱${Number(row.price).toFixed(2)}`;
    if (row?.low == null || row?.high == null) {
      return `<span class="dash-pred-price-main">${point}</span>`;
    }
    const pct = row.interval_pct || 90;
    const title = `Model's central estimate is ${point}. `
      + `${pct}% of past forecasts landed inside a band this wide.`;
    return `<span class="dash-pred-price-main" title="${escapeHtml(title)}">`
      + `₱${Number(row.low).toFixed(2)} – ₱${Number(row.high).toFixed(2)}</span>`;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Backend errors (e.g. a raw Keras/TensorFlow exception) shouldn't be dumped verbatim
  // into the dashboard — trim it to a short, readable line instead.
  function friendlyPredError(raw) {
    const msg = String(raw || '').trim();
    if (!msg) return 'unknown error';
    const oneLine = msg.split('\n')[0];
    return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
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
          <span class="dash-legend-swatch" style="background:${TREND_COLORS[i]};"></span>${label}<i class="ti ti-info-circle stat-info-icon tooltip-wide${i === cfg.labels.length - 1 ? ' tooltip-right' : ''}" tabindex="0" role="img" data-tooltip="${escapeHtml(TREND_LABEL_DESCS[i] || '')}"></i>
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
      // pct is null when yesterday's price isn't known yet — show a dash rather
      // than a number the data doesn't support.
      const known = d.pct != null && Number.isFinite(Number(d.pct));
      const trendClass = !known ? 'flat' : d.change > 0 ? 'up' : d.change < 0 ? 'down' : 'flat';
      const arrow = !known ? '' : d.change > 0 ? '▲' : d.change < 0 ? '▼' : '→';
      const sign = d.change > 0 ? '+' : '';
      const trendTxt = known ? `${arrow} ${sign}${Number(d.pct).toFixed(2)}%` : '—';
      const title = known && d.prev != null
        ? `vs ₱${Number(d.prev).toFixed(2)} the previous day`
        : 'No previous-day price to compare against yet';
      container.insertAdjacentHTML('beforeend', `
        <div class="rice-price-row">
          <span class="rice-name">${escapeHtml(name)}</span>
          <span class="rice-price-value">₱${d.price.toFixed(2)}</span>
          <span class="rice-trend ${trendClass}" title="${escapeHtml(title)}">${trendTxt}</span>
        </div>`);
    });
  }

  /**
   * Currency (USD/PHP) and Diesel stat cards. Replaced the old Key Indicators sparkline card —
   * that lived in the same spot Market Drivers already covers in depth, so the dashboard now just
   * shows each rate's latest value and its move since yesterday.
   */
  function renderMarketStats() {
    const hist = AgriPricePH.Data.historical;
    const series = (arr) => (arr || []).filter((v) => typeof v === 'number' && Number.isFinite(v));

    const change = (arr) => {
      const s = series(arr);
      if (!s.length) return null;
      const last = s[s.length - 1];
      const prev = s.length > 1 ? s[s.length - 2] : last;
      const pct = prev ? ((last - prev) / prev) * 100 : 0;
      return { last, pct };
    };
    // Fuel comes from DOE's WEEKLY bulletin, forward-filled to daily rows, so compare with the previous
    // bulletin's value (the last different one within 3 weeks), not with yesterday or "7 days ago" — a
    // bulletin can be carried for more than 7 days until the next one is published.
    const weekChange = (arr) => {
      const s = series(arr);
      if (!s.length) return null;
      const last = s[s.length - 1];
      let prev = last;
      for (let i = s.length - 2; i >= Math.max(0, s.length - 22); i--) {
        if (s[i] !== last) { prev = s[i]; break; }
      }
      return { last, pct: prev ? ((last - prev) / prev) * 100 : 0 };
    };

    const setCard = (valueId, changeId, entry, unit, period) => {
      const valueEl = document.getElementById(valueId);
      const changeEl = document.getElementById(changeId);
      if (valueEl) valueEl.textContent = entry ? `₱${entry.last.toFixed(2)}${unit || ''}` : '—';
      if (!changeEl) return;
      if (!entry || Math.abs(entry.pct) < 0.05) {
        changeEl.textContent = `No change vs. ${period}`;
        changeEl.className = 'stat-change text-muted';
        return;
      }
      const up = entry.pct > 0;
      const arrow = up ? '▲' : '▼';
      changeEl.innerHTML = `<span>${arrow} ${Math.abs(entry.pct).toFixed(1)}% vs. ${period}</span>`;
      // Rising cost is the unwelcome direction here (unlike the ML "lower is better" cards),
      // matching the same red-up/green-down convention the rice price ticker already uses.
      changeEl.className = `stat-change ${up ? 'cost-up' : 'cost-down'}`;
    };

    setCard('stat-currency-value', 'stat-currency-change', change(hist.exchange), null, 'yesterday');
    setCard('stat-diesel-value', 'stat-diesel-change', weekChange(hist.fuel), '/L', 'previous week');
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

  /**
   * Source-status dots. This used to also render a full "Data Sources" table on the dashboard —
   * a straight duplicate of the dedicated Data Sources page — so it now only does the one thing
   * nothing else on this page can: keep the strip's dots honest.
   */
  async function refreshSourceStatus() {
    let sources = null;
    try {
      const ds = await AgriPricePH.API.dataSources();
      if (Array.isArray(ds?.sources) && ds.sources.length) sources = ds.sources;
    } catch (e) {
      console.warn('Dashboard: data-sources API offline', e);
    }
    renderSourceStrip(sources);
  }

  /**
   * The three pills under the stat cards. Their dots were hardcoded `class="dot active"` in
   * dashboard.html, so they showed green even with the scraper down. Now they follow real status.
   */
  function renderSourceStrip(sources) {
    const strip = document.getElementById('dash-source-strip');
    if (!strip) return;
    if (!sources) {
      strip.querySelectorAll('.source-pill .dot').forEach((d) => {
        d.classList.remove('active');
        d.closest('.source-pill')?.setAttribute('title', 'Status unavailable — API offline');
      });
      return;
    }
    const byId = Object.fromEntries(sources.map(s => [s.id, s]));
    strip.querySelectorAll('.source-pill').forEach((pill) => {
      const s = byId[pill.dataset.sourceId];
      const active = (s?.status || '').toLowerCase() === 'active';
      pill.querySelector('.dot')?.classList.toggle('active', active);
      pill.title = s
        ? `${s.name} — ${active ? 'Active' : 'Idle'}, last fetch ${s.lastFetchRelative || s.lastFetch || 'unknown'}`
          + (s.id === 'doe' ? '\nMain: DOE weekly NCR bulletin. Fallback: GasWatch PH (gaswatchph.com) when DOE is unavailable or leaves a price blank.' : '')
        : 'Not reported by the API';
    });
  }

  function applySearchContext() {
    /* dashboard search opens page only */
  }

  return { init, applySearchContext };
})();
