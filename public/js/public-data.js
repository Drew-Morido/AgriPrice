/* AgriPricePH — Public pages data & charts */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.PublicData = (function () {
  const RICE = AgriPricePH.RiceTypes || [];

  let charts = {};
  let histData = null;
  let forecastByKey = {};
  let selectedForecastKey = 'locWellMilled';

  function formatIsoDateLabel(isoOrText) {
    const s = String(isoOrText || '');
    const d = parseDateLabel(s);
    if (!d) return s;
    const year = d.getFullYear();
    const monthNum = d.getMonth() + 1;
    const day = d.getDate();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const month = months[monthNum - 1] || String(monthNum);
    return `${month} ${day}, ${year}`;
  }

  function parseDateLabel(label) {
    const s = String(label || '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); // YYYY-MM-DD
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); // MM/DD/YYYY
    if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function toIsoDateString(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function normalizeHistoricalPayload(payload) {
    const labelsRaw = Array.isArray(payload?.labels) ? payload.labels : [];
    const histRaw = payload?.historical || {};
    if (!labelsRaw.length) return { labels: [], historical: {} };

    const parsed = labelsRaw
      .map((l, idx) => ({ idx, date: parseDateLabel(l) }))
      .filter((x) => x.date);
    if (!parsed.length) return { labels: labelsRaw.slice(), historical: histRaw };

    parsed.sort((a, b) => a.date - b.date);
    const latestDate = parsed[parsed.length - 1].date;
    const earliestAvailable = parsed[0].date;
    const ninetyDaysAgo = new Date(latestDate);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 89);
    const startDate = earliestAvailable < ninetyDaysAgo ? earliestAvailable : ninetyDaysAgo;

    const labelToIndex = new Map();
    labelsRaw.forEach((label, i) => {
      const d = parseDateLabel(label);
      if (!d) return;
      labelToIndex.set(toIsoDateString(d), i);
    });

    const normalizedLabels = [];
    const normalizedHistorical = {};
    Object.keys(histRaw).forEach((k) => { normalizedHistorical[k] = []; });

    const cursor = new Date(startDate);
    while (cursor <= latestDate) {
      const iso = toIsoDateString(cursor);
      normalizedLabels.push(iso);
      const sourceIdx = labelToIndex.get(iso);
      Object.entries(histRaw).forEach(([k, arr]) => {
        const out = normalizedHistorical[k];
        const sourceVal = sourceIdx != null ? arr?.[sourceIdx] : undefined;
        if (sourceVal != null && Number.isFinite(Number(sourceVal))) {
          out.push(Number(sourceVal));
        } else {
          const prev = out.length ? out[out.length - 1] : null;
          out.push(prev != null ? prev : 0);
        }
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    return { labels: normalizedLabels, historical: normalizedHistorical };
  }

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return [...document.querySelectorAll(sel)]; }

  async function checkApiStatus() {
    const el = $('#lp-api-status');
    if (!el) return;
    const ok = await (AgriPricePH.API?.health?.() ?? Promise.resolve(false));
    el.className = 'lp-api-status ' + (ok ? 'online' : 'offline');
    el.innerHTML = ok
      ? '<span class="dot"></span> Live prices are connected'
      : '<span class="dot"></span> Showing sample data — start the backend for live prices';
  }

  async function ensureHistorical() {
    if (histData) return histData;
    try {
      const data = await AgriPricePH.API.historical();
      if (data?.historical) {
        histData = normalizeHistoricalPayload(data);
        return histData;
      }
    } catch { /* fallback */ }

    const mock = AgriPricePH.Data?.historical;
    const n = mock?.locWellMilled?.length || 90;
    const labels = [];
    const today = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      labels.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    const historical = { fuel: mock?.fuel || [], exchange: mock?.exchange || [] };
    RICE.forEach(({ key }) => {
      historical[key] = mock?.[key] || [];
    });
    histData = { labels, historical };
    return histData;
  }

  async function loadCurrentPrices() {
    const grid = $('#lp-current-grid');
    if (!grid) return;

    let prices = AgriPricePH.Data?.currentPrices;
    try {
      const hist = await AgriPricePH.API.historical();
      if (hist?.historical?.locWellMilled?.length) {
        const built = {};
        RICE.forEach(({ key, label }) => {
          const k = key;
          const arr = hist.historical[k];
          if (!arr?.length) return;
          const last = arr[arr.length - 1];
          const prev = arr.length > 1 ? arr[arr.length - 2] : last;
          const change = last - prev;
          const pct = prev ? (change / prev) * 100 : 0;
          built[label] = { price: last, change, pct };
        });
        if (Object.keys(built).length) prices = built;
      }
    } catch { /* mock */ }

    grid.innerHTML = '';
    const featured = 'Local Well-Milled';
    Object.entries(prices || {}).forEach(([type, d]) => {
      const ch = d.change ?? 0;
      const cls = ch > 0 ? 'up' : ch < 0 ? 'down' : 'flat';
      const sign = ch > 0 ? '+' : '';
      const card = document.createElement('div');
      card.className = 'lp-price-card' + (type === featured ? ' featured' : '');
      const changeText = ch === 0
        ? 'No change from yesterday'
        : `${sign}₱${Math.abs(ch).toFixed(2)} (${sign}${(d.pct ?? 0).toFixed(1)}%) from yesterday`;
      card.innerHTML = `
        <div class="type">${type}${type === featured ? ' · main forecast type' : ''}</div>
        <div><span class="price">₱${Number(d.price).toFixed(2)}</span><span class="unit"> per kg</span></div>
        <div class="change ${cls}">${changeText}</div>
      `;
      grid.appendChild(card);
    });

    const wm = prices?.[featured];
    const hero = $('#lp-current-hero-price');
    if (hero && wm) hero.textContent = `₱${Number(wm.price).toFixed(2)}`;
  }

  function buildMockForecasts() {
    const mock = {};
    const hist = AgriPricePH.Data?.historical || {};
    RICE.forEach(({ key }) => {
      const series = hist[key] || [];
      const last = series.length ? series[series.length - 1] : 50;
      mock[key] = [
        { day: 1, date: 'Tomorrow', price: +(last * 1.005).toFixed(2), confidence: 0.75 },
        { day: 2, date: 'Day after tomorrow', price: +(last * 1.01).toFixed(2), confidence: 0.72 },
        { day: 3, date: 'In 3 days', price: +(last * 1.014).toFixed(2), confidence: 0.66 },
      ];
    });
    return mock;
  }

  function renderRicePicker(containerId) {
    const el = document.getElementById(containerId || 'lp-rice-picker');
    if (!el) return;
    el.innerHTML = '';
    el.setAttribute('role', 'tablist');

    const groups = [
      { title: 'Local rice', filter: (r) => r.group === 'local' },
      { title: 'Imported rice', filter: (r) => r.group === 'imported' },
    ];

    groups.forEach(({ title, filter }) => {
      const section = document.createElement('div');
      section.className = 'lp-rice-picker-section';
      section.innerHTML = `<div class="lp-rice-picker-section-title">${title}</div>`;
      const row = document.createElement('div');
      row.className = 'lp-rice-picker';
      RICE.filter(filter).forEach(({ key, label }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lp-rice-btn' + (key === selectedForecastKey ? ' active' : '');
        btn.dataset.riceKey = key;
        btn.textContent = label.replace('Local ', '').replace('Imported ', '');
        btn.title = label;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', key === selectedForecastKey ? 'true' : 'false');
        btn.addEventListener('click', () => {
          selectedForecastKey = key;
          $$('.lp-rice-btn').forEach((b) => {
            const on = b.dataset.riceKey === key;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
          });
          renderForecastCards();
        });
        row.appendChild(btn);
      });
      section.appendChild(row);
      el.appendChild(section);
    });
  }

  function renderForecastCards() {
    const row = $('#lp-forecast-row');
    const targetEl = $('#lp-predict-target');
    if (!row) return;

    const meta = AgriPricePH.RiceTypes.byKey?.[selectedForecastKey];
    const label = meta?.label || selectedForecastKey;
    const days = forecastByKey[selectedForecastKey] || forecastByKey.locWellMilled || [];

    if (targetEl) targetEl.textContent = label;

    row.innerHTML = '';
    const fallback = [
      { day: 1, date: 'Tomorrow', price: 52.8, confidence: 0.75 },
      { day: 2, date: 'Day after tomorrow', price: 53.1, confidence: 0.72 },
      { day: 3, date: 'In 3 days', price: 53.35, confidence: 0.66 },
    ];
    (days.length ? days.slice(0, 3) : fallback).forEach((d, i) => {
      const card = document.createElement('div');
      card.className = 'lp-forecast-card';
      const conf = d.confidence ?? d.conf;
      const confPct = conf != null ? (conf <= 1 ? conf * 100 : conf) : null;
      const dayLabel = d.date || ['Tomorrow', 'Day after tomorrow', 'In 3 days'][i] || `Day ${i + 1}`;
      card.innerHTML = `
        <div class="day-label">${dayLabel}</div>
        <div class="forecast-price">₱${Number(d.price ?? d.wm).toFixed(2)}</div>
        <div class="unit" style="font-size:12px;color:var(--text-muted)">per kg</div>
        ${confPct != null ? `<div class="conf">Model confidence: ${confPct.toFixed(0)}%</div>` : ''}
      `;
      row.appendChild(card);
    });
  }

  async function loadPredictions() {
    const statusEl = $('#lp-predict-model');
    if (!$('#lp-forecast-row')) return;

    let ready = false;

    try {
      const data = await AgriPricePH.API.predictions();
      if (data?.ready) {
        ready = true;
        if (data.forecasts_by_key && Object.keys(data.forecasts_by_key).length) {
          forecastByKey = data.forecasts_by_key;
        } else if (data.forecast?.length) {
          forecastByKey = { locWellMilled: data.forecast };
        }
      }
    } catch { /* mock */ }

    if (!Object.keys(forecastByKey).length) {
      forecastByKey = buildMockForecasts();
    }

    if (statusEl) {
      statusEl.textContent = ready
        ? 'Live forecast from the trained model (all 8 rice types)'
        : 'Sample forecast — train the model in admin for live numbers';
    }

    renderRicePicker('lp-rice-picker');
    renderForecastCards();
  }

  function getPeriod() {
    const active = $('.lp-period-tabs button.active');
    return active?.dataset?.period || '90';
  }

  function bindPeriodTabs() {
    $$('.lp-period-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.lp-period-tabs button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        renderHistoricalChart(btn.dataset.period);
      });
    });
  }

  function sliceHist(period) {
    if (!histData?.labels?.length) return { labels: [], series: {} };
    const start = period === 'all' ? 0 : -parseInt(period, 10);
    const labels = histData.labels.slice(start);
    const series = {};
    Object.entries(histData.historical || {}).forEach(([k, arr]) => {
      series[k] = (arr || []).slice(start);
    });
    return { labels, series };
  }

  // Which chart lines are hidden. The Price History page seeds this so only the variety chosen in
  // the page's own selector is drawn — eight overlapping lines by default is unreadable on a phone
  // and buries whichever variety the reader actually came for. Others stay one tap away.
  const histLegendHidden = {};

  function setHistoryFocus(key) {
    if (!RICE.some((r) => r.key === key)) return;
    RICE.forEach((r) => { histLegendHidden[r.key] = r.key !== key; });
    if (charts.historical) {
      RICE.forEach((r) => {
        const idx = datasetIndexForRiceKey(charts.historical, r.key);
        if (idx >= 0) charts.historical.setDatasetVisibility(idx, r.key === key);
      });
      syncHistoricalLegendUi();
      charts.historical.update();
    }
  }

  const historicalCrosshairPlugin = {
    id: 'historicalCrosshair',
    afterDraw(chart) {
      const tooltip = chart.tooltip;
      if (!tooltip || tooltip.opacity === 0) return;
      const points = tooltip.dataPoints;
      if (!points?.length) return;
      const x = points[0].element.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(38,84,56,0.22)';
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.restore();
    },
  };

  function usesHistoricalFooterLegend() {
    return !!document.querySelector('.hist-legend-grid');
  }

  function hexToRgba(hex, alpha) {
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6) return `rgba(74,158,103,${alpha})`;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function lineAreaGradient(canvas, color) {
    const ctx = canvas.getContext('2d');
    const h = canvas.offsetHeight || 400;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hexToRgba(color, 0.2));
    grad.addColorStop(0.55, hexToRgba(color, 0.06));
    grad.addColorStop(1, hexToRgba(color, 0));
    return grad;
  }

  function datasetIndexForRiceKey(chart, riceKey) {
    if (!chart || !riceKey) return -1;
    const rice = RICE.find((r) => r.key === riceKey);
    if (!rice) return -1;
    return chart.data.datasets.findIndex((d) => d.label === rice.label);
  }

  function syncHistoricalLegendUi() {
    const chart = charts.historical;
    if (!chart) return;
    document.querySelectorAll('.hist-legend-item[data-rice-key]').forEach((item) => {
      const idx = datasetIndexForRiceKey(chart, item.dataset.riceKey);
      const hidden = idx < 0 || !chart.isDatasetVisible(idx);
      item.classList.toggle('hist-legend-item--hidden', hidden);
      item.setAttribute('aria-pressed', hidden ? 'false' : 'true');
    });
  }

  function toggleHistoricalLegendItem(item) {
    const chart = charts.historical;
    if (!chart || !item?.dataset?.riceKey) return;

    const key = item.dataset.riceKey;
    const idx = datasetIndexForRiceKey(chart, key);
    if (idx < 0) return;

    const visible = chart.isDatasetVisible(idx);
    chart.setDatasetVisibility(idx, !visible);
    histLegendHidden[key] = visible;
    item.classList.toggle('hist-legend-item--hidden', visible);
    item.setAttribute('aria-pressed', visible ? 'false' : 'true');
    chart.update();
  }

  function bindHistoricalLegendGrid() {
    const grid = document.querySelector('.hist-legend-grid');
    if (!grid || grid.dataset.legendBound) return;
    grid.dataset.legendBound = '1';

    grid.addEventListener('click', (e) => {
      const item = e.target.closest('.hist-legend-item');
      if (!item) return;
      toggleHistoricalLegendItem(item);
    });

    grid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const item = e.target.closest('.hist-legend-item');
      if (!item) return;
      e.preventDefault();
      toggleHistoricalLegendItem(item);
    });
  }

  function buildHistoricalChartOptions() {
    function formatPriceUpTo2(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return '—';
      // Convert to 2 decimals first, then trim unnecessary trailing zeros.
      return num.toFixed(2)
        .replace(/(\.\d*?[1-9])0+$/, '$1')
        .replace(/\.0+$/, '');
    }

    function isOnlyImportedWellMilledVisible() {
      const chart = charts.historical;
      if (!chart?.data?.datasets?.length) return false;
      const visible = chart.data.datasets
        .map((ds, idx) => (chart.isDatasetVisible(idx) ? ds : null))
        .filter(Boolean);
      return visible.length === 1 && visible[0]?.label === 'Imported Well-Milled';
    }

    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 850, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(8,21,14,0.94)',
          titleColor: 'rgba(255,255,255,0.48)',
          bodyColor: '#f0fdf4',
          borderColor: 'rgba(114,201,141,0.4)',
          borderWidth: 1,
          padding: { top: 12, right: 16, bottom: 12, left: 16 },
          cornerRadius: 12,
          displayColors: false,
          boxPadding: 6,
          titleFont: { family: "'Plus Jakarta Sans', sans-serif", size: 11, weight: '700' },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
          bodySpacing: 5,
          callbacks: {
            title(items) {
              const label = items[0]?.label;
              return label ? `Date · ${label}` : '';
            },
            label(ctx) {
              const v = ctx.parsed.y;
              if (v == null) return null;
              const onlyImpWellMilled = isOnlyImportedWellMilledVisible();
              const price = onlyImpWellMilled ? formatPriceUpTo2(v) : Number(v).toFixed(2);
              return `${ctx.dataset.label}  ₱${price}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(38,84,56,0.07)', drawBorder: false, lineWidth: 1 },
          ticks: {
            color: '#8aaa97',
            font: { family: "'Plus Jakarta Sans', sans-serif", size: 10.5 },
            maxTicksLimit: 10,
            maxRotation: 0,
            padding: 8,
          },
          border: { display: false },
        },
        y: {
          position: 'right',
          grid: { color: 'rgba(38,84,56,0.09)', drawBorder: false, lineWidth: 1 },
          ticks: {
            color: '#6d9480',
            font: { family: "'JetBrains Mono', monospace", size: 10.5 },
            callback: (v) => {
              const onlyImpWellMilled = isOnlyImportedWellMilledVisible();
              if (onlyImpWellMilled) return `₱${formatPriceUpTo2(v)}`;
              return `₱${v}`;
            },
            maxTicksLimit: 6,
            padding: 10,
          },
          border: { display: false },
        },
      },
    };
  }

  function renderHistoricalChart(period) {
    const canvas = $('#chart-historical');
    if (!canvas || !histData) return;
    const { labels, series } = sliceHist(period);
    destroyChart('historical');

    const customLegend = usesHistoricalFooterLegend();

    const datasets = RICE.map(({ key, label, color }) => {
      const data = series[key];
      if (!data?.length) return null;
      const base = {
        label,
        data,
        borderColor: color,
        backgroundColor: customLegend ? lineAreaGradient(canvas, color) : color + '18',
        fill: customLegend,
        tension: 0.42,
        pointRadius: 0,
        pointHoverRadius: 7,
        pointHoverBorderWidth: 2.5,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: '#ffffff',
        borderWidth: 3.1,
      };
      return base;
    }).filter(Boolean);

    function formatHistXAxisLabel(isoOrText) {
      const s = String(isoOrText || '');
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return s;
      const year = m[1];
      const monthNum = Number(m[2]);
      const day = Number(m[3]);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = months[monthNum - 1] || m[2];
      return `${month} ${day} ${year}`;
    }

    const options = customLegend
      ? buildHistoricalChartOptions()
      : {
          ...chartOptions('Price in pesos per kg'),
          plugins: {
            legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 }, padding: 8 } },
          },
        };

    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels.map((l) => formatHistXAxisLabel(l)),
        datasets,
      },
      options,
      plugins: customLegend ? [historicalCrosshairPlugin] : [],
    });
    charts.historical = chart;
    chart.update();

    if (customLegend) {
      RICE.forEach(({ key }) => {
        if (!histLegendHidden[key]) return;
        const idx = datasetIndexForRiceKey(charts.historical, key);
        if (idx >= 0) charts.historical.setDatasetVisibility(idx, false);
      });
      syncHistoricalLegendUi();
    }
  }

  function chartOptions(yLabel) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, font: { size: 10 } }, grid: { display: false } },
        y: { title: { display: !!yLabel, text: yLabel, font: { size: 11 } }, ticks: { font: { size: 10 } } },
      },
    };
  }

  function destroyChart(key) {
    if (charts[key]) {
      charts[key].destroy();
      charts[key] = null;
    }
  }

  // The Price History page now owns its own chart (public/js/public-history.js): it draws one
  // variety chosen from a dropdown, with gaps left as gaps, instead of eight toggleable lines.
  // Nothing is left for this module to initialise there — but the export stays so the page's
  // unlock callback keeps working. Charts & Stats is its own module too (public/js/public-stats.js).
  async function initHistoricalPage() {
    await ensureHistorical();
  }


  return {
    checkApiStatus,
    loadCurrentPrices,
    loadPredictions,
    initHistoricalPage,
    setHistoryFocus,
  };
})();
