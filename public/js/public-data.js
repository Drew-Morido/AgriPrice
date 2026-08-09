/* AgriPricePH — Public pages data & charts */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.PublicData = (function () {
  const RICE = AgriPricePH.RiceTypes || [];

  let charts = {};
  let histData = null;
  let statsAudience = (function () {
    try {
      const v = localStorage.getItem('agriprice_stats_audience');
      return v === 'household' ? 'household' : 'vendor';
    } catch {
      return 'vendor';
    }
  })();
  let forecastByKey = {};
  let selectedForecastKey = 'locWellMilled';
  let selectedStatsRiceKey = 'locWellMilled';
  let statsPeriod = '90'; // '7', '30', '90'

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
      labels.push(d.toISOString().slice(0, 10));
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

  const histLegendHidden = {};

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

  function bindStatsTabs() {
    $$('.lp-stats-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.lp-stats-tabs button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        statsAudience = btn.dataset.audience;
        renderStatsCharts();
      });
    });
  }

  function bindStatsRiceFilter(series) {
    const select = document.getElementById('stats-rice-filter');
    if (!select || select.dataset.bound === '1') return;
    const available = RICE.filter((r) => (series?.[r.key] || []).length);
    if (!available.length) return;

    if (!available.some((r) => r.key === selectedStatsRiceKey)) {
      selectedStatsRiceKey = available[0].key;
    }

    select.innerHTML = available
      .map((r) => `<option value="${r.key}">${r.label}</option>`)
      .join('');
    select.value = selectedStatsRiceKey;
    select.addEventListener('change', () => {
      selectedStatsRiceKey = select.value;
      renderStatsCharts();
    });
    select.dataset.bound = '1';
  }

  function resolveStatsAudience() {
    const role = AgriPricePH.PublicAuth?.getSession?.()?.role;
    if (role === 'vendor' || role === 'household') {
      statsAudience = role;
      const roleEl = $('#stats-role-indicator');
      if (roleEl) roleEl.textContent = `Logged in as: ${role === 'vendor' ? 'Vendor' : 'Household'}`;
      return;
    }
    statsAudience = 'vendor';
    const roleEl = $('#stats-role-indicator');
    if (roleEl) roleEl.textContent = 'Logged in as: Vendor';
  }

  function renderStatsCharts() {
    if (!histData) return;
    const { labels, series } = sliceHist(statsPeriod);
    bindStatsRiceFilter(series);
    const selectedMeta = RICE.find((r) => r.key === selectedStatsRiceKey) || RICE.find((r) => r.key === 'locWellMilled') || RICE[0];
    const rice = series[selectedMeta.key] || [];
    if (!rice.length) return;

    const shortLabel = selectedMeta.label
      .replace('Imported ', 'Imp. ')
      .replace('Local ', 'Loc. ');

    const avg = rice.reduce((a, b) => a + b, 0) / rice.length;
    const min = Math.min(...rice);
    const max = Math.max(...rice);
    const last = rice[rice.length - 1];
    const vol = rice.slice(1).reduce((s, v, i) => s + Math.abs(v - rice[i]), 0) / (rice.length - 1);

    if ($('#stat-avg')) $('#stat-avg').textContent = `₱${avg.toFixed(2)}`;
    if ($('#stat-range')) $('#stat-range').textContent = `₱${min.toFixed(2)} – ₱${max.toFixed(2)}`;
    if ($('#stat-vol')) $('#stat-vol').textContent = `₱${vol.toFixed(2)}`;
    if ($('#stat-last')) $('#stat-last').textContent = `₱${last.toFixed(2)}`;
    if ($('#stat-vol-strip')) $('#stat-vol-strip').textContent = `₱${vol.toFixed(2)}`;
    if ($('#stat-last-strip')) $('#stat-last-strip').textContent = `₱${last.toFixed(2)}`;
    if ($('#stat-last-insight')) $('#stat-last-insight').textContent = `₱${last.toFixed(2)}`;

    const isVendor = statsAudience === 'vendor';
    const days = parseInt(statsPeriod, 10);
    const periodLabel = Number.isFinite(days) ? `${days}-day` : 'multi-day';
    const periodPhrase = Number.isFinite(days) ? `${days}-day` : 'selected';
    const ruleLabel = document.querySelector('.sec-rule .sec-rule-label');
    if (ruleLabel) ruleLabel.textContent = `Price trend · ${selectedMeta.label}`;
    const sub = document.getElementById('stats-trend-sub');
    if (sub) sub.textContent = `Rolling ${periodLabel} window · ${selectedMeta.label} only`;
    const trendTag = document.getElementById('stats-trend-tag');
    if (trendTag) trendTag.textContent = `${periodLabel} movement · ₱ per kg`;
    const footerLegend = document.querySelector('.tf-leg');
    if (footerLegend) footerLegend.innerHTML = '<span class="tf-line"></span>' + `${shortLabel} price`;
    const heroLiveText = document.querySelector('.hero-live .live-text');
    if (heroLiveText) heroLiveText.textContent = `${selectedMeta.label} · Last ${days}-day window · Updated daily`;
    const heroPeriodLabel = document.getElementById('stats-hero-period-label');
    if (heroPeriodLabel) heroPeriodLabel.textContent = `${periodLabel} view`;
    const kpiAvgLbl = document.getElementById('stats-kpi-avg-label');
    if (kpiAvgLbl) kpiAvgLbl.textContent = `${periodLabel} avg`;
    const footerDays = document.getElementById('stats-footer-days');
    if (footerDays && Number.isFinite(days)) footerDays.textContent = String(days);

    destroyChart('statsTrend');
    destroyChart('statsCompare');

    // ─── LINE CHART: Price Trend ──────────────────────────────────────────────
    const canvas1 = $('#chart-stats-trend');
    if (canvas1) {
      const lineColor = selectedMeta.color || '#65be82';
      const ctx1 = canvas1.getContext('2d');

      // Gradient fill under the line
      const gradFill = ctx1.createLinearGradient(0, 0, 0, canvas1.offsetHeight || 280);
      gradFill.addColorStop(0,   hexToRgba(lineColor, 0.28));
      gradFill.addColorStop(0.5, hexToRgba(lineColor, 0.08));
      gradFill.addColorStop(1,   hexToRgba(lineColor, 0));

      // Build a flat avg reference line dataset
      const avgLineData = rice.map(() => parseFloat(avg.toFixed(2)));

      // Thin tick labels: show every ~10th label to avoid clutter
      // Short x-axis labels, but keep the raw ISO labels for tooltips.
      const rawIsoLabels = labels.slice();
      const trendLabels = labels.map((l) => {
        const s = String(l);
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return s;
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return `${months[Number(m[2])-1]} ${Number(m[3])}`;
      });

      charts.statsTrend = new Chart(canvas1, {
        type: 'line',
        data: {
          labels: trendLabels,
          datasets: [
            {
              label: isVendor
                ? `${selectedMeta.label} — selling price`
                : `${selectedMeta.label} — market price`,
              data: rice,
              borderColor: lineColor,
              backgroundColor: gradFill,
              fill: true,
              tension: 0.38,
              pointRadius: 0,
              pointHitRadius: 18,
              pointHoverRadius: 6,
              pointHoverBackgroundColor: lineColor,
              pointHoverBorderColor: '#ffffff',
              pointHoverBorderWidth: 2,
              borderWidth: 2.5,
              order: 1,
            },
            {
              label: `${periodLabel} avg · ₱${avg.toFixed(2)}`,
              data: avgLineData,
              borderColor: 'rgba(255,255,255,0.22)',
              backgroundColor: 'transparent',
              fill: false,
              tension: 0,
              pointRadius: 0,
              borderWidth: 1.5,
              borderDash: [6, 4],
              order: 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 700, easing: 'easeOutQuart' },
          interaction: { mode: 'nearest', axis: 'x', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              mode: 'nearest',
              axis: 'x',
              intersect: false,
              backgroundColor: 'rgba(6,16,10,0.95)',
              titleColor: 'rgba(255,255,255,0.45)',
              bodyColor: '#e2f5ea',
              borderColor: hexToRgba(lineColor, 0.45),
              borderWidth: 1,
              padding: { top: 10, right: 14, bottom: 10, left: 14 },
              cornerRadius: 10,
              displayColors: true,
              boxWidth: 8,
              boxHeight: 8,
              boxPadding: 4,
              titleFont: { family: "'Plus Jakarta Sans', sans-serif", size: 10.5, weight: '700' },
              bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
              bodySpacing: 4,
              callbacks: {
                title(items) {
                  const item = items?.[0];
                  if (!item) return '';
                  const idx = item.dataIndex ?? item.parsed?.x;
                  const isoFromChart = (idx != null && item.chart?.$rawIsoLabels)
                    ? item.chart.$rawIsoLabels[idx]
                    : null;
                  const iso = isoFromChart || (idx != null ? rawIsoLabels[idx] : item.label);
                  return iso ? formatIsoDateLabel(iso) : '';
                },
                label(ctx) {
                  if (ctx.datasetIndex === 1) return null; // hide avg line from tooltip
                  const v = ctx.parsed.y;
                  if (v == null) return null;
                  const diff = v - avg;
                  const sign = diff >= 0 ? '+' : '';
                  return [
                    `  ₱${Number(v).toFixed(2)} / kg`,
                    `  ${sign}₱${diff.toFixed(2)} vs avg`,
                  ];
                },
              },
            },
          },
          scales: {
            x: {
              grid: { color: 'rgba(61,150,96,0.07)', drawBorder: false },
              ticks: {
                color: '#7aaa8e',
                font: { family: "'Plus Jakarta Sans', sans-serif", size: 10 },
                maxTicksLimit: 9,
                autoSkip: false,
                maxRotation: 0,
                padding: 6,
                callback(value, index) {
                  const total = trendLabels.length;
                  if (!total) return '';
                  const targetTicks = Math.min(9, total);
                  const step = Math.max(1, Math.ceil((total - 1) / Math.max(1, targetTicks - 1)));
                  const shouldShow = index === 0 || index === total - 1 || index % step === 0;
                  return shouldShow ? this.getLabelForValue(value) : '';
                },
              },
              border: { display: false },
            },
            y: {
              position: 'right',
              grid: { color: 'rgba(61,150,96,0.09)', drawBorder: false },
              ticks: {
                color: '#6d9480',
                font: { family: "'JetBrains Mono', monospace", size: 10.5 },
                callback: (v) => `₱${Number(v).toFixed(2)}`,
                maxTicksLimit: 6,
                padding: 10,
              },
              border: { display: false },
              // tight padding around the data range
              afterDataLimits(scale) {
                const pad = (scale.max - scale.min) * 0.12 || 1;
                scale.min = Math.max(0, scale.min - pad);
                scale.max = scale.max + pad;
              },
            },
          },
        },
        plugins: [
          // Vertical crosshair on hover
          {
            id: 'statsTrendCrosshair',
            afterDraw(chart) {
              const tooltip = chart.tooltip;
              if (!tooltip || tooltip.opacity === 0) return;
              const pts = tooltip.dataPoints;
              if (!pts?.length) return;
              const x = pts[0].element.x;
              const { top, bottom } = chart.chartArea;
              const c = chart.ctx;
              c.save();
              c.beginPath();
              c.moveTo(x, top);
              c.lineTo(x, bottom);
              c.lineWidth = 1;
              c.strokeStyle = hexToRgba(lineColor, 0.35);
              c.setLineDash([4, 4]);
              c.stroke();
              c.restore();
            },
          },
        ],
      });
      // Keep raw ISO labels for accurate tooltip dates (independent of shortened x-axis labels).
      charts.statsTrend.$rawIsoLabels = rawIsoLabels;
    }

    // ─── BAR CHART: Variety Comparison ───────────────────────────────────────
    const canvas2 = $('#chart-stats-compare');
    if (canvas2) {
      const barMeta = RICE.map((r) => ({
        key:      r.key,
        label:    r.label.replace('Imported ', 'Imp. ').replace('Local ', 'Loc. '),
        fullLabel: r.label,
        color:    r.color,
        avg:      avgOf(series[r.key]),
        isLocal:  r.group === 'local',
      }));

      // Sort descending by avg price for visual clarity
      barMeta.sort((a, b) => b.avg - a.avg);

      const sortedLabels = barMeta.map((b) => b.label);
      const sortedData   = barMeta.map((b) => b.avg);
      const sortedColors = barMeta.map((b) => b.color);
      // Slightly dimmed border-less bg, full color on hover via borderColor
      const bgColors     = sortedColors.map((c) => hexToRgba(c, 0.72));
      const hoverColors  = sortedColors.map((c) => hexToRgba(c, 1.0));
      const borderColors = sortedColors;

      // Overall avg across all varieties for reference line
      const allAvg = sortedData.reduce((a, b) => a + b, 0) / (sortedData.length || 1);

      charts.statsCompare = new Chart(canvas2, {
        type: 'bar',
        data: {
          labels: sortedLabels,
          datasets: [
            {
              label: `${periodLabel} average (₱/kg)`,
              data: sortedData,
              backgroundColor: bgColors,
              hoverBackgroundColor: hoverColors,
              borderColor: borderColors,
              borderWidth: 0,
              borderRadius: 6,
              borderSkipped: 'bottom',
              order: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 700, easing: 'easeOutQuart' },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(6,16,10,0.95)',
              titleColor: 'rgba(255,255,255,0.45)',
              bodyColor: '#e2f5ea',
              borderColor: 'rgba(61,150,96,0.4)',
              borderWidth: 1,
              padding: { top: 10, right: 14, bottom: 10, left: 14 },
              cornerRadius: 10,
              displayColors: true,
              boxWidth: 8,
              boxHeight: 8,
              boxPadding: 4,
              titleFont: { family: "'Plus Jakarta Sans', sans-serif", size: 10.5, weight: '700' },
              bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
              callbacks: {
                title(items) {
                  if (!items[0]) return '';
                  const meta = barMeta.find((b) => b.label === items[0].label);
                  return meta ? meta.fullLabel : items[0].label;
                },
                label(ctx) {
                  const v = ctx.parsed.y;
                  if (v == null) return null;
                  const diff = v - allAvg;
                  const sign = diff >= 0 ? '+' : '';
                  const meta = barMeta[ctx.dataIndex];
                  const group = meta?.isLocal ? 'Local' : 'Imported';
                  return [
                    `  ₱${Number(v).toFixed(2)} / kg  (${group})`,
                    `  ${sign}₱${diff.toFixed(2)} vs all-variety avg`,
                  ];
                },
              },
            },
            // Value labels on top of each bar
            afterDraw: undefined,
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                color: '#8aaa97',
                font: { family: "'Plus Jakarta Sans', sans-serif", size: 10 },
                maxRotation: 35,
                minRotation: 0,
                padding: 4,
              },
              border: { display: false },
            },
            y: {
              grid: { color: 'rgba(61,150,96,0.09)', drawBorder: false },
              ticks: {
                color: '#6d9480',
                font: { family: "'JetBrains Mono', monospace", size: 10.5 },
                callback: (v) => `₱${Number(v).toFixed(0)}`,
                maxTicksLimit: 6,
                padding: 10,
              },
              border: { display: false },
              afterDataLimits(scale) {
                const pad = (scale.max - scale.min) * 0.18 || 2;
                scale.min = Math.max(0, scale.min - pad * 0.3);
                scale.max = scale.max + pad;
              },
            },
          },
        },
        plugins: [
          // Draw ₱ value labels above each bar
          {
            id: 'statsBarValueLabels',
            afterDatasetsDraw(chart) {
              const { ctx, data, chartArea: { top } } = chart;
              ctx.save();
              chart.getDatasetMeta(0).data.forEach((bar, i) => {
                const value = data.datasets[0].data[i];
                if (value == null) return;
                const label = `₱${Number(value).toFixed(2)}`;
                ctx.fillStyle = 'rgba(255,255,255,0.75)';
                ctx.font = "500 9.5px 'JetBrains Mono', monospace";
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillText(label, bar.x, bar.y - 4);
              });
              ctx.restore();
            },
          },
          // Dashed all-variety average reference line
          {
            id: 'statsBarAvgLine',
            afterDraw(chart) {
              const { ctx, chartArea: { left, right }, scales: { y } } = chart;
              if (!y) return;
              const yPx = y.getPixelForValue(allAvg);
              ctx.save();
              ctx.beginPath();
              ctx.moveTo(left, yPx);
              ctx.lineTo(right, yPx);
              ctx.strokeStyle = 'rgba(255,255,255,0.18)';
              ctx.lineWidth = 1.2;
              ctx.setLineDash([6, 5]);
              ctx.stroke();
              // Label for the avg line
              ctx.setLineDash([]);
              ctx.fillStyle = 'rgba(255,255,255,0.35)';
              ctx.font = "600 9px 'Plus Jakarta Sans', sans-serif";
              ctx.textAlign = 'right';
              ctx.textBaseline = 'bottom';
              ctx.fillText(`avg ₱${allAvg.toFixed(2)}`, right - 4, yPx - 3);
              ctx.restore();
            },
          },
        ],
      });
    }

    const insight = $('#lp-stats-insight');
    if (insight) {
      const pct = avg ? (((last - avg) / avg) * 100).toFixed(1) : '0';
      const dir = last >= avg ? 'above' : 'below';
      insight.textContent = isVendor
        ? `${selectedMeta.label} today is ${Math.abs(pct)}% ${dir} the ${periodLabel} average. Use this with the 3-day forecast when you set prices or order stock.`
        : `${selectedMeta.label} today is ${Math.abs(pct)}% ${dir} the ${periodLabel} average. You may save money when prices stay below the average.`;
    }
  }

  function bindStatsPeriodFilters() {
    const cards = document.querySelectorAll('.stats-period-card[data-period]');
    if (!cards.length) return;
    cards.forEach((card) => {
      card.addEventListener('click', () => {
        const period = card.dataset.period || '90';
        statsPeriod = period;
        cards.forEach((c) => c.classList.toggle('active', c === card));
        renderStatsCharts();
      });
    });
  }

  function avgOf(arr) {
    if (!arr?.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
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

  async function initHistoricalPage() {
    bindPeriodTabs();
    bindHistoricalLegendGrid();
    await ensureHistorical();
    renderHistoricalChart(getPeriod());
    if ($('#stat-avg')) renderStatsCharts();
  }

  async function initStatisticsPage() {
    resolveStatsAudience();
    await ensureHistorical();
    bindStatsPeriodFilters();
    renderStatsCharts();
  }

  return {
    checkApiStatus,
    loadCurrentPrices,
    loadPredictions,
    initHistoricalPage,
    initStatisticsPage,
  };
})();
