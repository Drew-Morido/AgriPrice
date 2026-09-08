/* AgriPricePH — Predictions (3-day LSTM forecast from API) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Predictions = (function () {

  let _forecast = null;
  let _historical = null;
  let _heroType = 'local';
  let _outlookKey = 'wm';
  /** @type {Record<string, {mae_peso?:number, accuracy_pct?:number}>} */
  let _metricsByTarget = {};
  let _dashMetrics = null;

  const RICE_LABELS = {
    locWellMilled: 'Local Well-Milled',
    locRegular:    'Local Regular',
    locPremium:    'Local Premium',
    locSpecial:    'Local Special',
    impWellMilled: 'Imported Well-Milled',
    impRegular:    'Imported Regular',
    impPremium:    'Imported Premium',
    impSpecial:    'Imported Special',
  };

  const LOCAL_KEYS  = ['locWellMilled', 'locRegular', 'locPremium', 'locSpecial'];
  const IMPORT_KEYS = ['impWellMilled', 'impRegular', 'impPremium', 'impSpecial'];

  /** Dropdown value (wm/rm/pm/sp) → DB column key per hero toggle */
  const OUTLOOK_KEYS = {
    local: {
      wm: 'locWellMilled',
      rm: 'locRegular',
      pm: 'locPremium',
      sp: 'locSpecial',
    },
    imported: {
      wm: 'impWellMilled',
      rm: 'impRegular',
      pm: 'impPremium',
      sp: 'impSpecial',
    },
  };

  /** Mock 2-day forecast field on forecast7d rows */
  const MOCK_OUTLOOK_FIELD = {
    wm: 'wm',
    rm: 'rm',
    pm: 'pm',
    sp: 'sp',
  };

  const LSTM_TARGET_KEY = 'locWellMilled';
  const HIST_TAIL = 30;

  function init() {
    AgriPricePH.Dates?.applyPageDates(null);
    bindHeroToggle();
    initSlider();
    bindOutlookDropdown();
    loadPredictions();
  }

  function getSelectedRiceKey() {
    const map = OUTLOOK_KEYS[_heroType] || OUTLOOK_KEYS.local;
    return map[_outlookKey] || map.wm;
  }

  function getSelectedLabel() {
    const key = getSelectedRiceKey();
    return RICE_LABELS[key] || key;
  }

  function _mergeMetricsByTarget(primary, fallback) {
    const out = { ...(fallback || {}) };
    Object.entries(primary || {}).forEach(([k, v]) => {
      if (v && typeof v === 'object') out[k] = { ...(out[k] || {}), ...v };
    });
    return out;
  }

  /** Hold-out test accuracy % — same source as dashboard (training history / meta). */
  /**
   * Accuracy for a rice type on a specific forecast day.
   *
   * This used to ignore `forecastRow.day` entirely and return the pooled `accuracy_pct`, so
   * "Accuracy by Day" showed the *same* number for Day 1, Day 2 and Day 3 — a card whose whole
   * purpose is to vary by day. The figure was real (measured on hold-out data) but it was one
   * figure averaged over the whole horizon, and day 3 is measurably harder than day 1.
   *
   * It now prefers the per-day hit rate — the share of that day's forecasts that landed within
   * ₱1.00 of the real price — falling back to the legacy per-horizon accuracy, then the pooled
   * figure, for models trained before meta v4.
   */
  function trainAccuracyPct(riceKey, forecastRow) {
    const t = _metricsByTarget?.[riceKey];
    const dayIdx = forecastRow?.day != null ? Number(forecastRow.day) - 1 : null;
    if (t && dayIdx != null && dayIdx >= 0) {
      const hit = t.hit_rate_1p_pct;
      if (Array.isArray(hit) && hit[dayIdx] != null) return Number(hit[dayIdx]);
      const perDay = t.per_horizon_accuracy_pct;
      if (Array.isArray(perDay) && perDay[dayIdx] != null) return Number(perDay[dayIdx]);
    }
    if (t?.accuracy_pct != null) return Number(t.accuracy_pct);
    const avg = _dashMetrics?.metrics?.avg_accuracy_pct ?? _forecast?.metrics?.avg_accuracy_pct;
    if (avg != null && riceKey === LSTM_TARGET_KEY) return Number(avg);
    if (forecastRow?.confidence != null) return Number(forecastRow.confidence) * 100;
    return null;
  }

  /** True when the figures shown are hit rates rather than the legacy accuracy formula. */
  function usingHitRate(riceKey) {
    return Array.isArray(_metricsByTarget?.[riceKey]?.hit_rate_1p_pct);
  }

  // Thresholds are for the ₱1.00 hit rate (typically 80–96%). The legacy accuracy formula sits at
  // 98–99% for any model, so its scale needs its own band or everything reads green.
  function accuracyBarColor(pct, isHit = true) {
    if (pct == null || Number.isNaN(pct)) return '#94a3b8';
    const good = isHit ? 90 : 95;
    const ok = isHit ? 80 : 85;
    if (pct >= good) return '#4CAF6E';
    if (pct >= ok) return '#F59E0B';
    return '#EF4444';
  }

  async function loadPredictions() {
    try {
      const [data, hist, dm] = await Promise.all([
        AgriPricePH.API.predictions(),
        AgriPricePH.API.historical().catch(() => null),
        AgriPricePH.API.dashboardMetrics().catch(() => null),
      ]);
      _dashMetrics = dm;
      if (hist?.historical) {
        _historical = { labels: hist.labels || [], series: hist.historical };
      }
      if (!data.ready) {
        console.warn('Predictions not ready:', data.error);
        renderFromMock();
        return;
      }
      _forecast = data;
      _metricsByTarget = _mergeMetricsByTarget(dm?.metrics?.by_target, data.metrics?.by_target);
      applyMetrics(dm?.metrics || data.metrics, dm);
      renderHeroFromApi(data, _heroType);
      AgriPricePH.Dates?.applyPageDates(data);
      refreshSelectedRiceView();
    } catch (e) {
      console.warn('Predictions API offline:', e);
      renderFromMock();
    }
  }

  function renderFromMock() {
    _historical = {
      labels: (AgriPricePH.Data.historicalLabels || []).slice(-HIST_TAIL),
      series: AgriPricePH.Data.historical,
    };
    AgriPricePH.Dates?.applyPageDates({
      as_of_display: AgriPricePH.Dates.formatDisplay(AgriPricePH.Dates.today()),
      forecast: [
        { date_iso: isoPlusDays(1) },
        { date_iso: isoPlusDays(2) },
      ],
    });
    renderHeroPrices(_heroType);
    setTimeout(() => refreshSelectedRiceView(), 50);
  }

  function applyMetrics(m, dm) {
    if (!m) return;
    const items = document.querySelectorAll('.model-status-item');
    const valAt = (i) => items[i]?.querySelector('.model-status-val');
    const labelAt = (i) => items[i]?.querySelector('.model-status-label');
    if (valAt(1) && m.mae_peso != null) {
      valAt(1).textContent = `₱${Number(m.mae_peso).toFixed(2)}`;
    }
    if (valAt(2) && m.rmse_peso != null) {
      valAt(2).textContent = `₱${Number(m.rmse_peso).toFixed(2)}`;
    }
    // Headline is the day-1 hit rate within ₱1.00, matching the dashboard card and the per-day
    // figures below. The legacy `accuracy_pct` (100 − MAE/mean_price) is only a fallback for
    // models trained before meta v4: it returns 98–99% for any model and rates the naive
    // "tomorrow = today" baseline above the LSTM on all 8 rice types.
    const hit1 = (dm?.metrics?.hit_rate_pct ?? m.hit_rate_pct)?.['1.00']?.[0];
    const legacyAcc = m.avg_accuracy_pct ?? m.accuracy_pct;
    const shown = hit1 ?? legacyAcc;
    if (shown != null && valAt(0)) {
      if (labelAt(0)) {
        labelAt(0).textContent = hit1 != null
          ? 'Forecasts within ₱1.00'
          : 'Avg hold-out accuracy (legacy)';
      }
      valAt(0).textContent = `${Number(shown).toFixed(1)}%`;
      valAt(0).style.color = accuracyBarColor(shown, hit1 != null);
    }
    if (dm?.model?.last_trained && valAt(3)) {
      const d = new Date(dm.model.last_trained);
      valAt(3).textContent = Number.isNaN(d.getTime())
        ? String(dm.model.last_trained)
        : d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }

  function isoPlusDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function formatShortDate(isoOrOffset) {
    if (typeof isoOrOffset === 'number') {
      const d = new Date();
      d.setDate(d.getDate() + isoOrOffset);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    const d = new Date(isoOrOffset);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function getHistoricalSlice(riceKey) {
    if (
      riceKey === LSTM_TARGET_KEY &&
      _forecast?.history?.values?.length
    ) {
      return {
        values: _forecast.history.values.slice(-HIST_TAIL),
        labels: (_forecast.history.labels || []).slice(-HIST_TAIL),
      };
    }
    if (_historical?.series?.[riceKey]) {
      const values = _historical.series[riceKey]
        .map(v => Number(v))
        .filter(v => !Number.isNaN(v));
      const labels = (_historical.labels || []).slice(-values.length);
      return {
        values: values.slice(-HIST_TAIL),
        labels: labels.slice(-HIST_TAIL),
      };
    }
    const mock = AgriPricePH.Data.historical[riceKey]
      || AgriPricePH.Data.historical.locWellMilled
      || [];
    return {
      values: mock.slice(-HIST_TAIL),
      labels: (AgriPricePH.Data.historicalLabels || []).slice(-HIST_TAIL),
    };
  }

  function getLastPrice(riceKey) {
    if (_forecast?.current_prices?.[riceKey] != null) {
      return Number(_forecast.current_prices[riceKey]);
    }
    const hist = getHistoricalSlice(riceKey);
    const tail = hist.values.filter(v => v > 0);
    if (tail.length) return tail[tail.length - 1];
    const label = RICE_LABELS[riceKey];
    const mock = AgriPricePH.Data.currentPrices[label];
    return mock?.price ?? 0;
  }

  /** Forecasts from API (per-type LSTM; trend fallback until all models trained). */
  function getForecastForKey(riceKey) {
    const fromApi = _forecast?.forecasts_by_key?.[riceKey];
    if (Array.isArray(fromApi) && fromApi.length) {
      return fromApi.map(f => ({ ...f, model: f.model || 'lstm' }));
    }
    if (
      _forecast?.ready &&
      Array.isArray(_forecast.forecast) &&
      _forecast.forecast.length &&
      riceKey === LSTM_TARGET_KEY
    ) {
      return _forecast.forecast.map(f => ({ ...f, model: 'lstm' }));
    }
    return [];
  }

  function getMockForecastForKey(riceKey) {
    const field = MOCK_OUTLOOK_FIELD[_outlookKey] || 'wm';
    const rows = AgriPricePH.Data.forecast2d?.length
      ? AgriPricePH.Data.forecast2d
      : (AgriPricePH.Data.forecast7d || []).slice(0, 3);

    const lastPrice = getLastPrice(riceKey);
    return rows.map((d, i) => {
      const price = d[field] ?? d.price ?? d.wm ?? lastPrice;
      const prev = i === 0 ? lastPrice : (rows[i - 1][field] ?? rows[i - 1].price ?? lastPrice);
      return {
        day: i + 1,
        date: d.date || formatShortDate(i + 1),
        date_iso: d.date_iso || isoPlusDays(i + 1),
        price: Number(price),
        change: Number(price) - prev,
        confidence: d.conf ?? 0.85,
      };
    });
  }

  function refreshSelectedRiceView() {
    const riceKey = getSelectedRiceKey();
    const label = getSelectedLabel();
    const hist = getHistoricalSlice(riceKey);
    const lastPrice = getLastPrice(riceKey);

    let forecast;
    if (_forecast?.ready) {
      forecast = getForecastForKey(riceKey);
    } else {
      forecast = getMockForecastForKey(riceKey);
    }

    updateTitles(label, riceKey);
    renderForecastChart(hist, forecast);
    renderForecastTable(forecast, lastPrice, riceKey);
    renderSidebarBars(forecast, label);
    renderConfBars(forecast, riceKey);
    updateTomorrowCard(forecast[0], label, lastPrice, riceKey);
  }

  function updateTitles(label, riceKey) {
    const chartTitle = document.getElementById('forecast-chart-title');
    const tableTitle = document.getElementById('forecast-table-title');
    const fromApi = _forecast?.forecasts_by_key?.[riceKey];
    const modelId = fromApi?.[0]?.model
      || (_forecast?.forecast?.[0]?.model)
      || 'lstm';
    const note = modelId === 'trend' ? ' · trend estimate (retrain for LSTM)' : ' · LSTM model';
    if (chartTitle) chartTitle.textContent = `Forecast vs Historical (${label})${note}`;
    if (tableTitle) tableTitle.textContent = `Daily Forecast Table — ${label}`;
  }

  function updateTomorrowCard(day1, label, lastPrice, riceKey) {
    const slide = document.querySelector('#pred-slider-card .pred-slide[data-slide="0"] .card-body');
    if (!slide || !day1) return;
    const accPct = trainAccuracyPct(riceKey, day1);
    const isHit = usingHitRate(riceKey);
    const accColor = accuracyBarColor(accPct, isHit);
    const pct = lastPrice ? ((day1.change / lastPrice) * 100) : 0;
    const sign = day1.change >= 0 ? '+' : '';
    const color = day1.change >= 0 ? 'var(--color-danger)' : 'var(--color-accent)';
    const hasBand = day1.low != null && day1.high != null;
    // Headline is the range. A 36px "₱52.80" claims a precision the model cannot support; the
    // central estimate drops to a sub-line so the change figure below still has a visible basis.
    const headline = hasBand
      ? `₱${Number(day1.low).toFixed(2)} – ₱${Number(day1.high).toFixed(2)}`
      : `₱${Number(day1.price).toFixed(2)}`;
    const headlineSize = hasBand ? 24 : 36;
    const accLabel = isHit ? 'Forecasts within ₱1.00 (day 1)' : 'Hold-out accuracy (same as dashboard)';
    const barPct = accPct != null
      ? Math.min(100, accPct).toFixed(0)
      : ((day1.confidence || 0) * 100).toFixed(0);
    slide.innerHTML = `
      <div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-bottom:6px;">
        ${escapeAttr(label)} · ${escapeAttr(day1.date || '')}
      </div>
      <div style="font-size:${headlineSize}px;font-weight:700;font-family:var(--font-mono);color:var(--text-primary);letter-spacing:-1px;white-space:nowrap;">
        ${headline}
      </div>
      ${hasBand ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
        ${day1.interval_pct || 90}% range · central estimate ₱${Number(day1.price).toFixed(2)}
      </div>` : ''}
      <div style="font-size:13px;font-weight:600;color:${color};margin-top:6px;">
        ${day1.change >= 0 ? '▲' : '▼'} ${sign}₱${Math.abs(day1.change).toFixed(2)} (${sign}${pct.toFixed(2)}%)
      </div>
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border-color);">
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${accLabel}</div>
        <div style="background:var(--bg-input);border-radius:99px;height:8px;overflow:hidden;">
          <div style="width:${barPct}%;height:100%;background:${accColor};border-radius:99px;"></div>
        </div>
        <div style="font-size:13px;font-weight:700;font-family:var(--font-mono);color:${accColor};margin-top:6px;">
          ${accPct != null ? accPct.toFixed(1) : barPct}%
        </div>
      </div>`;
  }

  function renderHeroFromApi(data, type) {
    const container = document.getElementById('hero-prices');
    if (!container || !data.current_prices) return;
    const keys = type === 'local' ? LOCAL_KEYS : IMPORT_KEYS;
    // Always emit one card per rice type. Returning '' for a missing price left a hole in the
    // 4-column grid, so the remaining cards reflowed and the banner lost its alignment — the
    // "uniform cards" problem. A type with no price now shows "—" and keeps its slot.
    container.innerHTML = keys.map(key => {
      let price = data.current_prices[key];
      if (price == null || Number(price) <= 0) price = getLastPrice(key);
      const known = price != null && Number(price) > 0;
      const label = RICE_LABELS[key] || key;
      return `
        <div class="hero-price-item">
          <div class="hero-price-rice">${escapeAttr(label)}</div>
          <div class="hero-price-val">${known ? `₱${Number(price).toFixed(2)}` : '—'}</div>
          <div class="hero-price-change">${known ? 'Live DB price' : 'No price recorded'}</div>
        </div>`;
    }).join('');
  }

  /**
   * Offline fallback for the hero prices — sample figures from js/data.js.
   *
   * The API-backed cards (renderHeroFromApi) are footed "Live DB price". These were footed with a
   * change and percentage taken straight from the demo data, so a reader could not tell the two
   * apart and would read hardcoded placeholders as today's market. They are now labelled, and the
   * invented change/percentage is dropped — a made-up price is bad enough without a made-up trend.
   */
  function renderHeroPrices(type) {
    const container = document.getElementById('hero-prices');
    if (!container) return;
    const data = AgriPricePH.Data.currentPrices || {};
    const prefix = type === 'local' ? 'Local' : 'Imported';
    const types = ['Well-Milled', 'Regular', 'Premium', 'Special'];
    container.innerHTML = types.map(t => {
      const name = `${prefix} ${t}`;
      const d = data[name] || { price: 0 };
      return `
        <div class="hero-price-item">
          <div class="hero-price-rice">${name}</div>
          <div class="hero-price-val">₱${Number(d.price || 0).toFixed(2)}</div>
          <div class="hero-price-change" title="The API is unreachable, so these are placeholder figures from the bundled sample data — not today's prices.">Sample data — API offline</div>
        </div>`;
    }).join('');
  }

  function renderForecastChart(hist, forecast) {
    const canvas = document.getElementById('forecast-main-chart');
    if (!canvas) return;
    const histVals = hist.values || [];
    const histLabels = hist.labels || [];
    const pred = (forecast || []).map(f => f.price);
    const predLabels = (forecast || []).map(f => f.date);

    // The Forecast series used to be [...histVals, ...pred] — i.e. it duplicated the ENTIRE
    // historical series before appending the forecast. Hovering any historical point therefore
    // listed "Historical" and "Forecast" with the same number, because for that region they were
    // literally the same array. The forecast now exists only where a forecast exists: nulls over
    // the historical span, anchored at the last observed price so the dashed line still joins the
    // solid one, then the predicted days.
    const anchorIdx = histVals.length - 1;
    const forecastSeries = histVals.map((v, i) => (i === anchorIdx ? v : null)).concat(pred);
    // Historical is padded on the right so both series span the same index range and the tooltip's
    // per-index lookup stays aligned with the labels.
    const historicalSeries = histVals.concat(pred.map(() => null));

    AgriPricePH.Charts.lineChart(canvas, [
      // Labels match the legend swatches above the chart.
      { data: forecastSeries, color: '#8B5CF6', fill: false, lineWidth: 1.5, dashed: true, label: 'Predicted' },
      { data: historicalSeries, color: '#4CAF6E', fill: true, lineWidth: 2.5, label: 'Historical' },
    ], { labels: [...histLabels, ...predLabels], padding: { top: 20, right: 20, bottom: 36, left: 54 } });
  }

  function renderForecastTable(forecast, lastPrice, riceKey) {
    const tbody = document.getElementById('forecast-tbody');
    if (!tbody) return;
    let prev = lastPrice;
    tbody.innerHTML = (forecast || []).map((f, i) => {
      const delta = f.price - prev;
      prev = f.price;
      const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
      const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '—';
      const sign = delta > 0 ? '+' : '';
      const acc = trainAccuracyPct(riceKey, f);
      const isHit = usingHitRate(riceKey);
      const accStr = acc != null ? `${acc.toFixed(1)}%` : '—';
      const accTitle = acc == null
        ? 'Accuracy unavailable — retrain model'
        : isHit
          ? `${accStr} of day-${f.day} forecasts landed within ₱1.00 of the real price`
          : 'Hold-out test accuracy (legacy formula)';
      return `
        <div class="forecast-row">
          <span class="forecast-date">Day ${f.day} · ${f.date}</span>
          <canvas class="forecast-chart-cell" id="mini-chart-${i}" style="width:100%;height:28px;"></canvas>
          <span class="forecast-price">${priceRangeHtml(f)}</span>
          <span class="forecast-change ${dir}">${arrow} ${sign}${delta.toFixed(2)}</span>
          <span class="forecast-conf" title="${escapeAttr(accTitle)}" style="color:${accuracyBarColor(acc, isHit)}">${accStr}</span>
        </div>`;
    }).join('');
    drawTrendCells(forecast, riceKey);
  }

  /**
   * The Trend column's mini sparklines.
   *
   * The <canvas> elements were created by renderForecastTable but nothing ever drew into them, so
   * the column had been rendering blank since it was added — there were no values to be accurate
   * or inaccurate. Each row now shows the recent observed prices followed by the forecast path up
   * to and including that row's day, so Day 1 / 2 / 3 are visibly different lines.
   */
  function drawTrendCells(forecast, riceKey) {
    if (!AgriPricePH.Charts?.sparkline) return;
    const hist = getHistoricalSlice(riceKey);
    const tail = (hist.values || []).filter(v => Number.isFinite(v) && v > 0).slice(-10);
    (forecast || []).forEach((f, i) => {
      const el = document.getElementById(`mini-chart-${i}`);
      if (!el) return;
      const upTo = (forecast || []).slice(0, i + 1).map(d => Number(d.price)).filter(Number.isFinite);
      const series = [...tail, ...upTo];
      if (series.length < 2) return;
      // Green when this day's forecast sits at or above the last observed price, red when below —
      // the same up/down convention as the Change column beside it.
      const rising = series[series.length - 1] >= (tail[tail.length - 1] ?? series[0]);
      el.title = `Last ${tail.length} observed prices, then the forecast through day ${f.day}`;
      drawWhenSized(el, () => {
        AgriPricePH.Charts.sparkline(el, series, rising ? '#4CAF6E' : '#EF4444', true);
      });
    });
  }

  /**
   * Run `draw` once the canvas actually has a width.
   *
   * Charts.setupDPI sizes the backing store from getBoundingClientRect(). This table is rendered
   * while its view panel can still be laid out at zero width (the module paints during the router's
   * page swap), and a canvas sized 0×0 silently draws nothing — which is why the Trend column
   * appeared blank even though the sparkline call was being made. Retry across a few frames, then
   * fall back to a ResizeObserver so the cells also repaint when the panel is revealed or the
   * window is resized.
   */
  function drawWhenSized(el, draw, attempt = 0) {
    if (el.getBoundingClientRect().width > 0) { draw(); return; }
    if (attempt < 5) {
      requestAnimationFrame(() => drawWhenSized(el, draw, attempt + 1));
      return;
    }
    if (typeof ResizeObserver === 'undefined' || el._sizeObserver) return;
    el._sizeObserver = new ResizeObserver(() => {
      if (el.getBoundingClientRect().width > 0) {
        el._sizeObserver.disconnect();
        el._sizeObserver = null;
        draw();
      }
    });
    el._sizeObserver.observe(el);
  }

  /**
   * A forecast price, shown as its calibrated range rather than a single figure.
   *
   * `low`/`high` come from conformal calibration in model/predict.py (90% coverage on held-out
   * data). Only forecasts get a range — observed prices stay exact, so that a reader can always
   * tell which numbers were measured and which were predicted.
   */
  function priceRangeHtml(f) {
    const point = `₱${Number(f.price).toFixed(2)}`;
    if (f?.low == null || f?.high == null) return point;
    const pct = f.interval_pct || 90;
    const title = `Central estimate ${point} · ${pct}% of past forecasts landed inside a band this wide`;
    return `<span class="forecast-price-range" title="${escapeAttr(title)}">`
      + `₱${Number(f.low).toFixed(2)} – ₱${Number(f.high).toFixed(2)}</span>`;
  }

  function renderSidebarBars(forecast, label) {
    const container = document.getElementById('pred-sidebar-bars');
    if (!container) return;
    const prices = (forecast || []).map(f => f.price);
    if (!prices.length) return;
    const maxP = Math.max(...prices);
    const minP = Math.min(...prices);
    container.innerHTML = forecast.map(f => {
      const pct = ((f.price - minP) / ((maxP - minP) || 1)) * 55 + 35;
      const hasBand = f.low != null && f.high != null;
      const val = hasBand
        ? `₱${Number(f.low).toFixed(2)} – ₱${Number(f.high).toFixed(2)}`
        : `₱${Number(f.price).toFixed(2)}`;
      const title = hasBand
        ? `Central estimate ₱${Number(f.price).toFixed(2)} · ${f.interval_pct || 90}% range`
        : '';
      // Value sits beside the bar: a range would be clipped by .pred-bar's overflow on a short bar.
      return `
        <div class="pred-day">
          <span class="pred-day-label">Day ${f.day}</span>
          <div class="pred-bar-wrap">
            <div class="pred-bar" style="width:${pct}%"></div>
          </div>
          <span class="pred-bar-out" title="${escapeAttr(title)}">${val}</span>
        </div>`;
    }).join('');
  }

  function renderConfBars(forecast, riceKey) {
    const container = document.getElementById('pred-conf-bars');
    if (!container) return;
    const isHit = usingHitRate(riceKey);
    const caption = document.getElementById('pred-conf-caption');
    if (caption) {
      caption.textContent = isHit
        ? 'Share of forecasts within ₱1.00 of the real price, per forecast day'
        : 'Hold-out test accuracy per forecast day';
    }
    container.innerHTML = (forecast || []).map(f => {
      const acc = trainAccuracyPct(riceKey, f);
      const pctNum = acc != null ? acc : (f.confidence != null ? f.confidence * 100 : null);
      const pct = pctNum != null ? Math.min(100, pctNum).toFixed(0) : '—';
      const color = accuracyBarColor(pctNum, isHit);
      const title = pctNum == null
        ? 'Not available — retrain the model'
        : isHit
          ? `${Number(pctNum).toFixed(1)}% of day-${f.day} forecasts landed within ₱1.00 of the real price, on hold-out test data`
          : `Day ${f.day} hold-out accuracy (legacy formula)`;
      return `
        <div class="pred-conf-row" title="${escapeAttr(title)}">
          <span class="pred-conf-label">Day ${f.day}</span>
          <div class="pred-conf-track">
            <div class="pred-conf-fill" style="width:${pct}%;background:${color};"></div>
          </div>
          <span class="pred-conf-pct" style="color:${color};">${pctNum != null ? `${Number(pctNum).toFixed(1)}%` : '—'}</span>
        </div>`;
    }).join('');
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function bindHeroToggle() {
    const toggle = document.getElementById('hero-toggle');
    if (!toggle) return;
    toggle.querySelectorAll('.hero-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        toggle.querySelectorAll('.hero-toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _heroType = btn.dataset.type || 'local';
        if (_forecast?.current_prices) {
          renderHeroFromApi(_forecast, _heroType);
        } else {
          renderHeroPrices(_heroType);
        }
        updateOutlookDropdown(_heroType);
        refreshSelectedRiceView();
      });
    });
  }

  function bindOutlookOptionClick(opt) {
    const dropdown = document.getElementById('outlook-dropdown');
    const label = document.getElementById('outlook-select-label');
    if (!dropdown || !label) return;
    opt.addEventListener('click', () => {
      dropdown.querySelectorAll('.outlook-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      label.textContent = opt.textContent;
      _outlookKey = opt.dataset.value || 'wm';
      closeOutlookDropdown();
      refreshSelectedRiceView();
    });
  }

  function updateOutlookDropdown(type) {
    const dropdown = document.getElementById('outlook-dropdown');
    const label    = document.getElementById('outlook-select-label');
    if (!dropdown || !label) return;
    const options = type === 'local' ? [
      { value: 'wm', label: 'Local Well-Milled' },
      { value: 'rm', label: 'Local Regular' },
      { value: 'pm', label: 'Local Premium' },
      { value: 'sp', label: 'Local Special' },
    ] : [
      { value: 'wm', label: 'Imported Well-Milled' },
      { value: 'rm', label: 'Imported Regular' },
      { value: 'pm', label: 'Imported Premium' },
      { value: 'sp', label: 'Imported Special' },
    ];
    _outlookKey = 'wm';
    dropdown.innerHTML = options.map(o =>
      `<div class="outlook-option${o.value === 'wm' ? ' active' : ''}" data-value="${o.value}">${o.label}</div>`
    ).join('');
    label.textContent = options[0].label;
    dropdown.querySelectorAll('.outlook-option').forEach(bindOutlookOptionClick);
  }

  function closeOutlookDropdown() {
    document.getElementById('outlook-select-wrap')?.classList.remove('open');
  }

  function bindOutlookDropdown() {
    const wrap = document.getElementById('outlook-select-wrap');
    const trigger = document.getElementById('outlook-select-trigger');
    if (!wrap || !trigger) return;
    document.querySelectorAll('#outlook-dropdown .outlook-option').forEach(bindOutlookOptionClick);
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      wrap.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) closeOutlookDropdown();
    });
  }

  function initSlider() {
    let current = 0;
    const slides = document.querySelectorAll('#pred-slider-card .pred-slide');
    const dots   = document.querySelectorAll('#pred-slider-card .pred-dot');
    const total  = slides.length;
    function goTo(index) {
      if (index === current) return;
      slides[current].classList.remove('active');
      slides[current].classList.add('fade-out');
      setTimeout(() => slides[current].classList.remove('fade-out'), 350);
      current = (index + total) % total;
      slides[current].classList.add('fade-in');
      setTimeout(() => {
        slides[current].classList.remove('fade-in');
        slides[current].classList.add('active');
      }, 10);
      dots.forEach((d, i) => d.classList.toggle('active', i === current));
    }
    document.getElementById('pred-zone-left')?.addEventListener('click', () => goTo(current - 1));
    document.getElementById('pred-zone-right')?.addEventListener('click', () => goTo(current + 1));
    dots.forEach(dot => dot.addEventListener('click', () => goTo(parseInt(dot.dataset.dot))));
  }

  function applySearchContext(ctx) {
    if (!ctx) return;
    if (ctx.heroType) {
      _heroType = ctx.heroType;
      const toggle = document.getElementById('hero-toggle');
      toggle?.querySelectorAll('.hero-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === _heroType);
      });
      if (_forecast?.current_prices) renderHeroFromApi(_forecast, _heroType);
      else renderHeroPrices(_heroType);
      updateOutlookDropdown(_heroType);
    }
    if (ctx.outlookKey) {
      _outlookKey = ctx.outlookKey;
      const dropdown = document.getElementById('outlook-dropdown');
      const label = document.getElementById('outlook-select-label');
      const opt = dropdown?.querySelector(`.outlook-option[data-value="${ctx.outlookKey}"]`);
      if (opt && label) {
        dropdown.querySelectorAll('.outlook-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        label.textContent = opt.textContent;
      }
    }
    refreshSelectedRiceView();
  }

  return { init, applySearchContext };
})();
