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
    bindOutlookDropdown();
    bindBackToTop();
    loadPredictions();
  }

  /**
   * Back-to-top button — same behavior as public/current-prices.html's.
   *
   * This page's DOM gets replaced wholesale by the SPA router on every navigation, but a
   * `window` scroll listener doesn't die with it — without the `isConnected` check this would
   * leak a listener (referencing a detached button) every time a visitor left and came back to
   * this page.
   */
  function bindBackToTop() {
    const btn = document.getElementById('pred-back-to-top');
    if (!btn) return;
    const onScroll = () => {
      if (!btn.isConnected) {
        window.removeEventListener('scroll', onScroll);
        return;
      }
      btn.classList.toggle('show', window.scrollY > 400);
    };
    window.addEventListener('scroll', onScroll);
    btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    onScroll();
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
    renderForecastChart(hist, forecast, riceKey);
    renderForecastTable(forecast, lastPrice, riceKey);
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
    const slide = document.querySelector('#pred-next-day-card .card-body');
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

  function isoToMdy(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split('-');
    return `${m}/${d}/${y}`;
  }

  function renderForecastChart(hist, forecast, riceKey) {
    const canvas = document.getElementById('forecast-main-chart');
    if (!canvas) return;
    const histVals = hist.values || [];
    const histLabels = hist.labels || [];
    const pred = (forecast || []).map(f => f.price);
    const predLabels = (forecast || []).map(f => f.date);
    const anchorIdx = histVals.length - 1;

    // Walk-forward backtest from the API (model/predict.py::_backtest_recent_days) — what the
    // currently-deployed model would have predicted for each past day, using only data available
    // up to the day before. Real, measured figures, not a fabrication: matched onto the chart's
    // date labels so the "Predicted" line runs continuously across past AND future days instead
    // of only appearing for the 3 upcoming ones, which is what makes "Forecast VS Historical"
    // actually comparable on a past date.
    const backtest = _forecast?.history_backtest?.[riceKey] || [];
    const backtestByLabel = new Map(backtest.map(p => [isoToMdy(p.date_iso), p]));
    const historicalPredicted = histLabels.map(lb => backtestByLabel.get(lb)?.predicted ?? null);

    // The Forecast series used to be [...histVals, ...pred] — i.e. it duplicated the ENTIRE
    // historical series before appending the forecast. Hovering any historical point therefore
    // listed "Historical" and "Forecast" with the same number, because for that region they were
    // literally the same array. It's now the backtested prediction for each past day, joined to
    // the future forecast at the anchor (today's actual price, so the two segments meet without a
    // visible seam) rather than duplicating the historical series.
    const forecastSeries = historicalPredicted.slice();
    forecastSeries[anchorIdx] = histVals[anchorIdx];
    const combinedPredicted = forecastSeries.concat(pred);
    // Historical is padded on the right so both series span the same index range and the tooltip's
    // per-index lookup stays aligned with the labels.
    const historicalSeries = histVals.concat(pred.map(() => null));

    // Hover notes: a past day with a backtested prediction shows how far off that prediction was;
    // an upcoming forecast day shows the model's measured hold-out accuracy instead (there's no
    // backtest for a day that hasn't happened yet).
    const pointNotes = new Array(histLabels.length + predLabels.length).fill(null);
    histLabels.forEach((lb, i) => {
      const p = backtestByLabel.get(lb);
      if (!p) return;
      const err = Math.abs(p.predicted - p.actual);
      pointNotes[i] = `Predicted that day: ₱${p.predicted.toFixed(2)} · off by ₱${err.toFixed(2)}${err <= 1 ? ' (within ₱1.00)' : ''}`;
    });
    (forecast || []).forEach((f, i) => {
      const acc = trainAccuracyPct(riceKey, f);
      const isHit = usingHitRate(riceKey);
      pointNotes[histLabels.length + i] = acc != null
        ? `Accuracy (day ${f.day}): ${acc.toFixed(1)}%${isHit ? ' of forecasts land within ₱1.00' : ' hold-out accuracy'}`
        : `Accuracy (day ${f.day}): not available`;
    });

    AgriPricePH.Charts.lineChart(canvas, [
      // Labels match the legend swatches above the chart.
      { data: combinedPredicted, color: '#8B5CF6', fill: false, lineWidth: 1.5, dashed: true, label: 'Predicted' },
      { data: historicalSeries, color: '#4CAF6E', fill: true, lineWidth: 2.5, label: 'Historical (actual)' },
    ], {
      labels: [...histLabels, ...predLabels],
      padding: { top: 20, right: 20, bottom: 36, left: 54 },
      yAxisLabel: '₱ per kg',
      pointNotes,
    });
  }

  function renderForecastTable(forecast, lastPrice, riceKey) {
    const tbody = document.getElementById('forecast-tbody');
    if (!tbody) return;
    const hist = getHistoricalSlice(riceKey);
    const tail = (hist.values || []).filter(v => Number.isFinite(v) && v > 0).slice(-10);
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
      const upTo = (forecast || []).slice(0, i + 1).map(d => Number(d.price)).filter(Number.isFinite);
      return `
        <div class="forecast-row">
          <span class="forecast-date">Day ${f.day} · ${f.date}</span>
          ${trendCellHtml([...tail, ...upTo], tail.length, f.day)}
          <span class="forecast-price">${priceRangeHtml(f)}</span>
          <span class="forecast-change ${dir}">${arrow} ${sign}${delta.toFixed(2)}</span>
          <span class="forecast-conf" title="${escapeAttr(accTitle)}" style="color:${accuracyBarColor(acc, isHit)}">${accStr}</span>
        </div>`;
    }).join('');
  }

  /**
   * The Trend column, as a number rather than a mini sparkline.
   *
   * The average day-over-day price change across the last 10 observed days plus the forecast path
   * up to and including this row's day — the same window the old sparkline plotted, just reduced to
   * its one summary number instead of a chart a reader had to eyeball the slope of. Plain text, not
   * red/green: the Change column beside it already carries the up/down color for this row, so
   * coloring Trend too was a second, sometimes-conflicting signal rather than a clarifying one.
   */
  function trendCellHtml(series, observedCount, day) {
    if (series.length < 2) return '<span class="forecast-trend">—</span>';
    const perDay = (series[series.length - 1] - series[0]) / (series.length - 1);
    const flat = Math.abs(perDay) < 0.005;
    const arrow = flat ? '—' : perDay > 0 ? '▲' : '▼';
    const sign = perDay > 0 ? '+' : '';
    const title = `Average day-over-day change across the last ${observedCount} observed days through day ${day}'s forecast`;
    return `<span class="forecast-trend" title="${escapeAttr(title)}">${arrow} ${sign}₱${perDay.toFixed(2)}/day</span>`;
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
