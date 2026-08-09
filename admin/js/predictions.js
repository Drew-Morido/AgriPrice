/* AgriPricePH — Predictions (2-day LSTM forecast from API) */
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
  function trainAccuracyPct(riceKey, forecastRow) {
    const acc = _metricsByTarget?.[riceKey]?.accuracy_pct;
    if (acc != null) return Number(acc);
    const avg = _dashMetrics?.metrics?.avg_accuracy_pct ?? _forecast?.metrics?.avg_accuracy_pct;
    if (avg != null && riceKey === LSTM_TARGET_KEY) return Number(avg);
    if (forecastRow?.confidence != null) return Number(forecastRow.confidence) * 100;
    return null;
  }

  function accuracyBarColor(pct) {
    if (pct == null || Number.isNaN(pct)) return '#94a3b8';
    if (pct >= 95) return '#4CAF6E';
    if (pct >= 85) return '#F59E0B';
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
    const acc = m.avg_accuracy_pct ?? m.accuracy_pct;
    if (acc != null && valAt(0)) {
      if (labelAt(0)) labelAt(0).textContent = 'Avg hold-out accuracy';
      valAt(0).textContent = `${Number(acc).toFixed(1)}%`;
      valAt(0).style.color = acc >= 95 ? '#4CAF6E' : acc >= 85 ? '#F59E0B' : 'var(--text-primary)';
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
    const pct = lastPrice ? ((day1.change / lastPrice) * 100) : 0;
    const sign = day1.change >= 0 ? '+' : '';
    const color = day1.change >= 0 ? 'var(--color-danger)' : 'var(--color-accent)';
    slide.innerHTML = `
      <div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-bottom:6px;">
        ${label} · ${day1.date}
      </div>
      <div style="font-size:36px;font-weight:700;font-family:var(--font-mono);color:var(--text-primary);letter-spacing:-1px;">
        ₱${day1.price.toFixed(2)}
      </div>
      <div style="font-size:13px;font-weight:600;color:${color};margin-top:6px;">
        ${day1.change >= 0 ? '▲' : '▼'} ${sign}₱${Math.abs(day1.change).toFixed(2)} (${sign}${pct.toFixed(2)}%)
      </div>
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border-color);">
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">Hold-out accuracy (same as dashboard)</div>
        <div style="background:var(--bg-input);border-radius:99px;height:8px;overflow:hidden;">
          <div style="width:${accPct != null ? Math.min(100, accPct).toFixed(0) : (day1.confidence * 100).toFixed(0)}%;height:100%;background:${accuracyBarColor(accPct)};border-radius:99px;"></div>
        </div>
        <div style="font-size:13px;font-weight:700;font-family:var(--font-mono);color:${accuracyBarColor(accPct)};margin-top:6px;">
          ${accPct != null ? accPct.toFixed(1) : (day1.confidence * 100).toFixed(0)}%
        </div>
      </div>`;
  }

  function renderHeroFromApi(data, type) {
    const container = document.getElementById('hero-prices');
    if (!container || !data.current_prices) return;
    const keys = type === 'local' ? LOCAL_KEYS : IMPORT_KEYS;
    container.innerHTML = keys.map(key => {
      let price = data.current_prices[key];
      if (price == null || Number(price) <= 0) {
        price = getLastPrice(key);
      }
      if (price == null || Number(price) <= 0) return '';
      const label = RICE_LABELS[key] || key;
      return `
        <div class="hero-price-item">
          <div class="hero-price-rice">${label}</div>
          <div class="hero-price-val">₱${Number(price).toFixed(2)}</div>
          <div class="hero-price-change">Live DB price</div>
        </div>`;
    }).join('');
  }

  function renderHeroPrices(type) {
    const container = document.getElementById('hero-prices');
    if (!container) return;
    const data = AgriPricePH.Data.currentPrices;
    const prefix = type === 'local' ? 'Local' : 'Imported';
    const types = ['Well-Milled', 'Regular', 'Premium', 'Special'];
    container.innerHTML = types.map(t => {
      const name = `${prefix} ${t}`;
      const d = data[name] || { price: 0, change: 0, pct: 0 };
      const isNeg = d.change < 0;
      const arrow = d.change > 0 ? '▲' : d.change < 0 ? '▼' : '→';
      const sign  = d.change > 0 ? '+' : '';
      return `
        <div class="hero-price-item">
          <div class="hero-price-rice">${name}</div>
          <div class="hero-price-val">₱${d.price.toFixed(2)}</div>
          <div class="hero-price-change${isNeg ? ' neg' : ''}">${arrow} ${sign}₱${Math.abs(d.change).toFixed(2)} (${sign}${d.pct.toFixed(2)}%)</div>
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
    AgriPricePH.Charts.lineChart(canvas, [
      { data: [...histVals, ...pred], color: '#8B5CF6', fill: false, lineWidth: 1.5, dashed: true, label: 'Forecast' },
      { data: histVals, color: '#4CAF6E', fill: true, lineWidth: 2.5, label: 'Historical' },
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
      const accStr = acc != null ? `${acc.toFixed(1)}%` : '—';
      const accTitle = acc != null
        ? 'Hold-out test accuracy (2024–2025) — matches dashboard'
        : 'Accuracy unavailable — retrain model';
      return `
        <div class="forecast-row">
          <span class="forecast-date">Day ${f.day} · ${f.date}</span>
          <canvas class="forecast-chart-cell" id="mini-chart-${i}" style="width:100%;height:28px;"></canvas>
          <span class="forecast-price">₱${f.price.toFixed(2)}</span>
          <span class="forecast-change ${dir}">${arrow} ${sign}${delta.toFixed(2)}</span>
          <span class="forecast-conf" title="${accTitle}" style="color:${accuracyBarColor(acc)}">${accStr}</span>
        </div>`;
    }).join('');
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
      return `
        <div class="pred-day">
          <span class="pred-day-label">Day ${f.day}</span>
          <div class="pred-bar-wrap">
            <div class="pred-bar" style="width:${pct}%">
              <span class="pred-bar-val">₱${f.price.toFixed(2)}</span>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function renderConfBars(forecast, riceKey) {
    const container = document.getElementById('pred-conf-bars');
    if (!container) return;
    container.innerHTML = (forecast || []).map(f => {
      const acc = trainAccuracyPct(riceKey, f);
      const pctNum = acc != null ? acc : (f.confidence != null ? f.confidence * 100 : null);
      const pct = pctNum != null ? Math.min(100, pctNum).toFixed(0) : '—';
      const color = accuracyBarColor(pctNum);
      return `
        <div class="pred-conf-row">
          <span class="pred-conf-label">Day ${f.day}</span>
          <div class="pred-conf-track">
            <div class="pred-conf-fill" style="width:${pct}%;background:${color};"></div>
          </div>
          <span class="pred-conf-pct" style="color:${color};">${pctNum != null ? `${Number(pctNum).toFixed(1)}%` : '—'}</span>
        </div>`;
    }).join('');
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
