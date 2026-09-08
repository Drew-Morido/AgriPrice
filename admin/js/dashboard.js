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
  // Key Indicators / 3-Day Forecast card filters (independent of the
  // predictions-table filter above, which has its own controls).
  let _kiOrigin = 'local';
  let _kiType = 'WellMilled';
  let _fcOrigin = 'local';
  let _fcType = 'WellMilled';

  const ALERTS_PREVIEW_LIMIT = 3;

  const LSTM_TARGET = 'locWellMilled';

  const TYPE_LABELS = {
    WellMilled: 'Well-Milled',
    Regular: 'Regular Milled',
    Premium: 'Premium',
    Special: 'Special',
  };

  /** 'local' + 'WellMilled' → 'locWellMilled' (the key used everywhere else). */
  function riceKeyOf(origin, type) {
    return `${origin === 'imported' ? 'imp' : 'loc'}${type}`;
  }

  function riceLabelOf(origin, type) {
    return `${origin === 'imported' ? 'Imported' : 'Local'} ${TYPE_LABELS[type] || type}`;
  }

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
    syncStatInfoLabels();
    bindTrendDropdown();
    bindPredFilters();
    bindCardFilters();
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
    document.getElementById('dash-alerts-view-all')?.addEventListener('click', (e) => {
      e.preventDefault();
      AgriPricePH.Router.navigate('alerts');
    });
  }

  /** Origin + rice-type filters on the Key Indicators and 3-Day Forecast cards. */
  function bindCardFilters() {
    const bindOrigin = (id, onPick) => {
      const group = document.getElementById(id);
      if (!group) return;
      group.querySelectorAll('.dash-pred-segment-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          group.querySelectorAll('.dash-pred-segment-btn')
            .forEach(b => b.classList.toggle('active', b === btn));
          onPick(btn.dataset.origin || 'local');
        });
      });
    };

    bindOrigin('ki-origin-toggle', (origin) => { _kiOrigin = origin; renderSparklines(); });
    document.getElementById('ki-type-select')?.addEventListener('change', (e) => {
      _kiType = e.target.value || 'WellMilled';
      renderSparklines();
    });

    bindOrigin('fc-origin-toggle', (origin) => { _fcOrigin = origin; renderPredBar(); });
    document.getElementById('fc-type-select')?.addEventListener('change', (e) => {
      _fcType = e.target.value || 'WellMilled';
      renderPredBar();
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
    // The prices and history calls race; whichever lands second recomputes the
    // ticker so the day-over-day percentages have a real baseline to use.
    syncCurrentPricesFromApi();
    renderPriceTicker();
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
    _setStatTrend('stat-mae-change', trends.mae_peso_delta, 'mae');
    _setStatTrend('stat-rmse-change', trends.rmse_peso_delta, 'rmse');
    _setStatTrend('stat-accuracy-change', trends.accuracy_pct_delta, 'accuracy');

    const runId = dm?.model?.run_id;
    const trained = _fmtTrainDate(dm?.model?.last_trained);
    const src = dm?.source === 'training_history' ? 'Training History' : 'Saved model';
    // Two short labelled lines, not one long "src · run 20260905-203122 · date"
    // string — the run id is a timestamp token that wraps badly inside a tooltip.
    const provenance = !dm?.ready && !trained
      ? ['No trained model yet — start one in Model Training.']
      : [
        `Measured on: ${src}${trained ? `, ${trained}` : ''}`,
        runId ? `Run ID: ${runId}` : '',
      ].filter(Boolean);
    const whyMoved = _baselineNote(trends);
    _setStatSource('stat-mae', [provenance.join('\n'), whyMoved]);
    _setStatSource('stat-rmse', [provenance.join('\n'), whyMoved]);
    _setStatSource('stat-accuracy', [provenance.join('\n'), whyMoved, _honestyNote(m)]);

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

  /**
   * The one line that stops the headline number being over-read.
   *
   * A hit rate of ~90% looks like a strong result until you know the naive "tomorrow = today"
   * forecast scores the same, because daily rice prices are close to a random walk (ADF p > 0.05
   * on all 8 types). Skill is the model's error measured against that baseline: 0% means tied.
   */
  function _honestyNote(m) {
    const skill = m?.skill_vs_baseline_pct;
    const move = m?.movement_ratio;
    if (skill == null && move == null) return '';
    const parts = [];
    if (skill != null) {
      const s = Number(skill);
      parts.push(
        `Skill vs the naive "tomorrow = today" forecast: ${s > 0 ? '+' : ''}${s.toFixed(2)}% `
        + `(${s > 0.5 ? 'the model beats it' : s < -0.5 ? 'the naive forecast is slightly ahead' : 'effectively tied'}).`
      );
    }
    if (move != null) {
      parts.push(`The model's forecasts move ${(Number(move) * 100).toFixed(0)}% as far as prices really move.`);
    }
    return parts.join('\n');
  }

  /**
   * Explains a run-over-run move in MAE/RMSE/accuracy.
   *
   * A rise in MAE reads as "the model got worse", but that is only one of two
   * possible causes. The naive persistence baseline ("tomorrow = today") has no
   * parameters and nothing to learn, so it can only move when the test window
   * itself changes. When the baseline moves alongside the model, the run-over-run
   * difference is the prices becoming more (or less) volatile — a property of the
   * data, not a regression — and the card says so rather than leaving "(worse)"
   * to imply something that isn't true.
   */
  function _baselineNote(trends) {
    const now = trends?.baseline_mae_peso;
    const prev = trends?.baseline_mae_peso_prev;
    const bDelta = trends?.baseline_mae_peso_delta;
    const mDelta = trends?.mae_peso_delta;
    if (now == null || prev == null || bDelta == null || mDelta == null) return '';
    const line = `Reference: the naive "tomorrow = today" baseline moved from `
      + `₱${Number(prev).toFixed(2)} to ₱${Number(now).toFixed(2)} across the same two runs.`;
    const sameDirection = (bDelta > 0) === (mDelta > 0);
    const largeEnough = Math.abs(mDelta) > 0 && Math.abs(bDelta) >= Math.abs(mDelta) * 0.5;
    if (!sameDirection || !largeEnough) return line;
    return `${line}\nThat baseline has nothing to learn, so most of this change comes from prices `
      + `becoming ${bDelta > 0 ? 'more' : 'less'} volatile between the two training sets — `
      + `not from the model itself getting ${bDelta > 0 ? 'worse' : 'better'}.`;
  }

  // A stat card shows only two things: the headline number and the one-line
  // trend ("▼ ₱0.50 (better)"). Everything else — what the metric means and
  // where the number came from — lives in the card's ⓘ tooltip, so the card stays
  // scannable instead of stacking three grey lines of prose under the label.
  // `blocks` entries are separate paragraphs; each may contain its own newlines.
  function _setStatSource(statId, blocks) {
    const card = document.getElementById(statId);
    if (!card) return;
    // Older builds rendered this as a visible footnote line; drop it if present.
    card.querySelector('.stat-footnote')?.remove();
    const icon = card.querySelector('.stat-info-icon');
    const body = (Array.isArray(blocks) ? blocks : [blocks]).filter(Boolean).join('\n\n');
    if (!icon || !body) return;
    // Keep the hand-written explanation from the HTML as the base so repeated
    // refreshes replace the source block instead of appending to it.
    if (icon.dataset.tooltipBase == null) icon.dataset.tooltipBase = icon.dataset.tooltip || '';
    setStatTooltip(icon, `${icon.dataset.tooltipBase}\n\n${body}`);
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
    const val = kind === 'accuracy' ? `${abs.toFixed(2)}%` : `₱${abs.toFixed(2)}`;
    const improved = kind === 'accuracy' ? d > 0 : d < 0;
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
      const latest = _fmtTrainDate(labels[labels.length - 1]);
      _setStatSource('stat-records', [
        [
          `In the database: ${n.toLocaleString()} merged daily rows (rice + fuel + FX)`,
          latest ? `Newest row: ${latest}` : '',
        ].filter(Boolean).join('\n'),
      ]);
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
    const hit = t.hit_rate_1p_pct;
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
    return keys.some(k => Array.isArray(_metricsByTarget?.[k]?.hit_rate_1p_pct));
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
    // renderPredBar reads _allForecasts, so it has to come after this.
    buildAllForecasts();
    renderPredBar();
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

  /** Yesterday's observed price for a rice type, from the merged daily history. */
  function previousObservedPrice(riceKey) {
    const series = _predHistSeries?.[riceKey] || AgriPricePH.Data.historical?.[riceKey];
    if (!Array.isArray(series) || series.length < 2) return null;
    const vals = series.map(histPriceAt).filter(v => !Number.isNaN(v) && v > 0);
    return vals.length >= 2 ? vals[vals.length - 2] : null;
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
      const prev = previousObservedPrice(key);
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
    const keys = types.map(t => t.key);
    const isHit = usingHitRate(keys);
    if (accHead) {
      const perDay = isHit
        || types.some(t => Array.isArray(_metricsByTarget?.[t.key]?.per_horizon_accuracy_pct));
      accHead.textContent = !perDay
        ? 'Accuracy'
        : isHit ? `Day ${_predDay} within ₱1` : `Day ${_predDay} accuracy`;
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
      const dir = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
      const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '→';
      const sign = change > 0 ? '+' : '';
      const modelId = (row.model || 'lstm').toLowerCase();
      const isLstm = modelId === 'lstm';
      const trainAcc = trainAccuracyForKey(key, dayIdx);
      const perDayAcc = Array.isArray(_metricsByTarget?.[key]?.per_horizon_accuracy_pct);
      const confPct = trainAcc != null
        ? Number(trainAcc).toFixed(1)
        : (row.confidence != null ? (Number(row.confidence) * 100).toFixed(1) : '—');
      const maeHint = trainMaeForKey(key, dayIdx);
      const accTitle = trainAcc == null
        ? (isLstm ? 'Estimated from model error' : 'Trend estimate')
        : (isHit
          ? `Share of day-${_predDay} forecasts that landed within ₱1.00 of the real price, on hold-out test data`
          : `${perDayAcc ? `Day ${_predDay}` : 'Whole 3-day'} hold-out test accuracy (legacy formula)`)
          + `${maeHint != null ? ` · average error ₱${Number(maeHint).toFixed(2)}/kg` : ''}`;
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
        recent.length ? recent : (AgriPricePH.Data.notifLog || []),
        dotClass
      );
    } catch (e) {
      console.warn('Dashboard: alerts API offline', e);
      renderRecentAlerts(container, AgriPricePH.Data.notifLog || [], dotClass);
      if (badge) badge.textContent = 'Offline';
    }
  }

  function renderRecentAlerts(container, items, dotClass) {
    const footer = document.getElementById('dash-alerts-footer');
    const more = document.getElementById('dash-alerts-more');
    if (!items.length) {
      if (footer) footer.hidden = true;
      container.innerHTML = `
        <div class="text-muted" style="font-size:12px;line-height:1.5;">
          No price alerts triggered yet.
          <a href="#alerts" style="color:var(--color-accent);font-weight:600;">Configure rules →</a>
        </div>`;
      return;
    }
    // Preview the newest few only — the full log lives in the Alerts module.
    const shown = items.slice(0, ALERTS_PREVIEW_LIMIT);
    const hidden = items.length - shown.length;
    if (footer) footer.hidden = false;
    if (more) {
      more.textContent = hidden > 0
        ? `${hidden} more alert${hidden === 1 ? '' : 's'} not shown`
        : `Showing all ${items.length}`;
    }
    container.innerHTML = shown.map(n => {
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

  function renderSparklines() {
    const hist = AgriPricePH.Data.historical;
    const riceKey = riceKeyOf(_kiOrigin, _kiType);
    const riceLabelEl = document.getElementById('ki-rice-label');
    if (riceLabelEl) riceLabelEl.textContent = riceLabelOf(_kiOrigin, _kiType);
    const sparkData = {
      'spark-rice': { data: hist[riceKey], color: '#4CAF6E', valueEl: 'ki-rice' },
      'spark-fuel': { data: hist.fuel, color: '#F59E0B', valueEl: 'ki-fuel' },
      'spark-usd':  { data: hist.exchange, color: '#8B5CF6', valueEl: 'ki-usd' },
    };
    Object.entries(sparkData).forEach(([id, cfg]) => {
      const el = document.getElementById(id);
      if (el && cfg.data?.length) AgriPricePH.Charts.sparkline(el, cfg.data, cfg.color, true);
      // Key Indicators: show the latest real value of the same series the sparkline draws.
      // These used to be hardcoded in dashboard.html with no id, so they never updated.
      const valEl = cfg.valueEl && document.getElementById(cfg.valueEl);
      if (valEl) {
        const series = (cfg.data || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
        valEl.textContent = series.length ? `₱${series[series.length - 1].toFixed(2)}` : '—';
      }
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

  function renderPredBar() {
    const container = document.getElementById('dash-pred-bars');
    if (!container) return;
    const key = riceKeyOf(_fcOrigin, _fcType);
    const sub = document.getElementById('dash-fc-subtitle');
    if (sub) sub.textContent = `${riceLabelOf(_fcOrigin, _fcType)} · LSTM Model`;
    // Live per-type forecast when we have one. The mock series stands in only
    // while the API is unreachable — once any real forecast has arrived, falling
    // back would label another rice type's numbers as this one's.
    const live = _allForecasts[key];
    const apiHasForecasts = Object.values(_allForecasts).some(a => a?.length);
    const data = (live?.length && live)
      || (apiHasForecasts ? [] : (AgriPricePH.Data.forecast2d || AgriPricePH.Data.forecast7d?.slice(0, 3) || []));
    if (!data.length) {
      container.innerHTML = '<div class="text-muted" style="font-size:12px;">No forecast for this rice type yet.</div>';
      return;
    }
    const prices = data.map(d => d.price ?? d.wm);
    const maxP = Math.max(...prices);
    const minP = Math.min(...prices);
    container.innerHTML = data.map((d, i) => {
      const price = d.price ?? d.wm;
      const label = d.date?.split?.(' ')?.[1] || `Day ${d.day || i + 1}`;
      const pct = ((price - minP) / ((maxP - minP) || 1)) * 60 + 35;
      // The bar's own value is the range; the point estimate stays only as a hover, for the same
      // reason as the predictions table — the band is what the model can actually support.
      const hasBand = d.low != null && d.high != null;
      const barVal = hasBand
        ? `₱${Number(d.low).toFixed(2)} – ₱${Number(d.high).toFixed(2)}`
        : `₱${Number(price).toFixed(2)}`;
      const barTitle = hasBand
        ? `Central estimate ₱${Number(price).toFixed(2)} · ${d.interval_pct || 90}% range`
        : '';
      // The value sits OUTSIDE the bar: a range is roughly twice as wide as a single price and
      // would be clipped by the bar's `overflow:hidden` on a short bar or a narrow column.
      return `
        <div class="pred-day">
          <span class="pred-day-label">${label}</span>
          <div class="pred-bar-wrap">
            <div class="pred-bar" style="width:${pct}%"></div>
          </div>
          <span class="pred-bar-out" title="${escapeHtml(barTitle)}">${barVal}</span>
        </div>`;
    }).join('');
    const note = document.getElementById('dash-fc-note');
    if (note) {
      const pct = data.find(d => d.interval_pct)?.interval_pct;
      note.textContent = pct ? `Shaded range = ${pct}% of past forecasts landed inside a band this wide.` : '';
      note.hidden = !pct;
    }
  }

  /**
   * Data Sources card.
   *
   * This used to render `AgriPricePH.Data.dataSources` — a hardcoded array in js/data.js that
   * nothing in the codebase ever writes to. Every visit therefore reported all three sources
   * "Active", last fetched "2 mins ago", "+128 today", whether or not the scraper had ever run.
   * Fabricated operational status is worse than no status, so the card now reads /api/data-sources
   * (the same endpoint the Data Sources module uses) and says so plainly when it cannot.
   */
  async function renderSourcesTable() {
    const container = document.getElementById('dash-sources-table');
    if (!container) return;
    const header = `
      <div class="ds-row ds-header">
        <span>Source</span><span>Type</span><span>Last Fetch</span><span>Today</span><span>Status</span>
      </div>`;
    container.innerHTML = `${header}<div class="ds-row"><span class="text-muted">Loading sources…</span></div>`;

    let sources = null;
    try {
      const ds = await AgriPricePH.API.dataSources();
      if (Array.isArray(ds?.sources) && ds.sources.length) sources = ds.sources;
    } catch (e) {
      console.warn('Dashboard: data-sources API offline', e);
    }

    if (!sources) {
      container.innerHTML = `${header}
        <div class="ds-row"><span class="text-muted" style="font-size:12px;">
          Source status unavailable — start the API server to see it.
        </span></div>`;
      renderSourceStrip(null);
      return;
    }

    const rows = sources.map(s => {
      const active = (s.status || '').toLowerCase() === 'active';
      const name = String(s.name || '').split('–')[0].trim();
      const fetched = s.lastFetchRelative || s.lastFetch || '—';
      const today = s.recordsToday;
      return `
        <div class="ds-row">
          <span class="ds-name" style="color:${escapeHtml(s.color || 'inherit')};">${escapeHtml(name)}</span>
          <span class="ds-type">${escapeHtml(s.type || '—')}</span>
          <span class="ds-fetch">${escapeHtml(String(fetched))}</span>
          <span class="ds-today">${today == null ? '—' : `+${escapeHtml(String(today))}`}</span>
          <span><span class="pill ${active ? 'pill-green' : 'pill-gray'}">${active ? 'Active' : 'Idle'}</span></span>
        </div>`;
    }).join('');
    container.innerHTML = header + rows;
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
        : 'Not reported by the API';
    });
  }

  function applySearchContext() {
    /* dashboard search opens page only */
  }

  return { init, applySearchContext };
})();
