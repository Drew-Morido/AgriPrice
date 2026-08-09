/* AgriPricePH — Homepage (ticker, hero, prices grid, how-it-works chart) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Landpage = (function () {
  const RICE = () => AgriPricePH.RiceTypes || [];
  const HERO_GRADES = [
    { short: 'Special', suffix: 'Special' },
    { short: 'Premium', suffix: 'Premium' },
    { short: 'Well-Milled', suffix: 'Well-Milled' },
    { short: 'Regular', suffix: 'Regular' },
  ];
  const PRICE_ROWS = [
    { origin: 'local', title: 'Local rice' },
    { origin: 'imported', title: 'Imported rice' },
  ];
  const HOW_RICE_KEY = 'locRegular';
  const HOW_HIST_DAYS = 5;

  let _origin = 'local';
  let _pricesByLabel = {};
  let _histSeries = null;
  let _histLabels = [];
  let _forecastByKey = {};
  let _howChart = null;

  function $(sel) { return document.querySelector(sel); }

  function labelFor(origin, suffix) {
    return origin === 'local' ? `Local ${suffix}` : `Imported ${suffix}`;
  }

  function getEntry(label) {
    return _pricesByLabel[label] || { price: 0, change: 0, pct: 0 };
  }

  function formatPctBadge(pct) {
    const n = Number(pct);
    if (n > 0.05) return { cls: 'up', text: `▲ ${Math.abs(n).toFixed(1)}%` };
    if (n < -0.05) return { cls: 'down', text: `▼ ${Math.abs(n).toFixed(1)}%` };
    return { cls: 'flat', text: '— 0.0%' };
  }

  function formatTickerChange(pct) {
    const n = Number(pct);
    if (n > 0.05) return `<span class="ticker-up">▲ ${Math.abs(n).toFixed(1)}%</span>`;
    if (n < -0.05) return `<span class="ticker-down">▼ ${Math.abs(n).toFixed(1)}%</span>`;
    return `<span class="ticker-up">—</span>`;
  }

  function splitPrice(price) {
    const p = Number(price).toFixed(2);
    const [whole, frac] = p.split('.');
    return { whole, frac };
  }

  function shortChartLabel(isoOrText, indexFromEnd) {
    if (isoOrText && /^\d{4}-\d{2}-\d{2}/.test(String(isoOrText))) {
      const d = new Date(isoOrText + 'T12:00:00');
      return d.toLocaleDateString('en-PH', { weekday: 'short' });
    }
    if (indexFromEnd === 0) return 'Today';
    return String(isoOrText || '').slice(0, 6);
  }

  function buildHistLabels(n) {
    const labels = [];
    const today = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      labels.push(d.toISOString().slice(0, 10));
    }
    return labels;
  }

  async function loadPrices() {
    _pricesByLabel = { ...(AgriPricePH.Data?.currentPrices || {}) };
    _histSeries = { ...(AgriPricePH.Data?.historical || {}) };
    _histLabels = AgriPricePH.Data?.historicalLabels || buildHistLabels(90);

    try {
      const data = await AgriPricePH.API.predictions();
      if (data?.current_prices) {
        RICE().forEach(({ key, label }) => {
          const raw = data.current_prices[key];
          if (raw == null || Number(raw) <= 0) return;
          const mock = AgriPricePH.Data?.currentPrices?.[label];
          _pricesByLabel[label] = {
            price: Number(raw),
            change: mock?.change ?? 0,
            pct: mock?.pct ?? 0,
          };
        });
      }
      if (data?.forecasts_by_key) {
        _forecastByKey = data.forecasts_by_key;
      } else if (Array.isArray(data?.forecast) && data.forecast.length) {
        _forecastByKey = { locWellMilled: data.forecast };
      }
    } catch { /* sample data */ }

    try {
      const hist = await AgriPricePH.API.historical();
      if (hist?.historical) {
        _histSeries = hist.historical;
        if (hist.labels?.length) _histLabels = hist.labels;
        RICE().forEach(({ key, label }) => {
          const series = hist.historical[key];
          if (!Array.isArray(series) || series.length < 2) return;
          const last = Number(series[series.length - 1]);
          const prev = Number(series[series.length - 2]);
          if (!last || !prev) return;
          const change = +(last - prev).toFixed(2);
          const pct = +((change / prev) * 100).toFixed(2);
          const cur = _pricesByLabel[label];
          _pricesByLabel[label] = {
            price: cur?.price > 0 ? cur.price : last,
            change,
            pct,
          };
        });
      }
    } catch { /* keep mock */ }
  }

  function getHowHistorical() {
    const raw = (_histSeries?.[HOW_RICE_KEY] || []).map(Number).filter((v) => v > 0);
    const labels = _histLabels.slice(-raw.length);
    const count = Math.min(HOW_HIST_DAYS, raw.length);
    return {
      values: raw.slice(-count),
      labels: labels.slice(-count),
    };
  }

  function getHowForecast(lastActual) {
    const fromApi = _forecastByKey[HOW_RICE_KEY];
    if (Array.isArray(fromApi) && fromApi.length) {
      return fromApi.slice(0, 2).map((f, i) => ({
        date: f.date || (i === 0 ? 'Tomorrow' : '+2 days'),
        date_iso: f.date_iso,
        price: Number(f.price ?? f.wm ?? lastActual),
      }));
    }
    const mock = AgriPricePH.Data?.forecast2d || [];
    return mock.slice(0, 2).map((f, i) => ({
      date: f.date || (i === 0 ? 'Tomorrow' : '+2 days'),
      price: Number(f.rm ?? f.price ?? lastActual * (1 + 0.005 * (i + 1))),
    }));
  }

  function renderTicker() {
    const inner = $('#home-ticker');
    if (!inner) return;

    const items = RICE().map(({ label }) => {
      const d = getEntry(label);
      const short = label.replace(/^Imported /, 'Imp. ').replace(/^Local /, '');
      return `<div class="ticker-item"><span class="ticker-name">${short}</span><span class="ticker-price">₱${Number(d.price).toFixed(2)}/kg</span>${formatTickerChange(d.pct)}</div>`;
    }).join('');

    inner.innerHTML = items + items;
  }

  function renderHeroCards() {
    const wrap = $('#hero-price-cards');
    if (!wrap) return;

    wrap.innerHTML = HERO_GRADES.map(({ short, suffix }) => {
      const full = labelFor(_origin, suffix);
      const d = getEntry(full);
      const { whole, frac } = splitPrice(d.price);
      const badge = formatPctBadge(d.pct);
      return `
        <div class="hero-stat-card">
          <div class="hsc-label">${short}</div>
          <div class="hsc-row">
            <div>
              <div class="hsc-value">₱${whole}<span>.${frac}</span></div>
              <div class="hsc-sub">per kilogram · today</div>
            </div>
            <div class="hsc-badge ${badge.cls}">${badge.text}</div>
          </div>
        </div>`;
    }).join('');
  }

  function priceCardHtml(origin, suffix, featured) {
    const label = labelFor(origin, suffix);
    const d = getEntry(label);
    const changeCls = Number(d.pct) > 0.05 ? 'up' : Number(d.pct) < -0.05 ? 'down' : 'flat';
    const changeText = Number(d.change) === 0
      ? '— No change'
      : `${Number(d.change) > 0 ? '▲' : '▼'} ₱${Math.abs(Number(d.change)).toFixed(2)} vs yesterday`;
    return `
      <div class="price-card${featured ? ' featured' : ''}">
        <div class="pc-type">${suffix}</div>
        <div class="pc-price">₱${Number(d.price).toFixed(2)}<span>/kg</span></div>
        <div class="pc-change ${changeCls}">${changeText}</div>
      </div>`;
  }

  function renderPricesGrid() {
    const grid = $('#home-prices-grid');
    if (!grid) return;

    grid.innerHTML = PRICE_ROWS.map(({ origin, title }) => `
      <div class="prices-row">
        <div class="prices-row-head">${title}</div>
        <div class="prices-row-cards">
          ${HERO_GRADES.map(({ suffix }) =>
            priceCardHtml(origin, suffix, origin === 'local' && suffix === 'Regular')
          ).join('')}
        </div>
      </div>
    `).join('');
  }

  function renderHowTable(hist, forecast) {
    const tbody = $('#home-how-tbody');
    if (!tbody) return;

    const rows = [];
    hist.labels.forEach((lbl, i) => {
      rows.push(`
        <tr>
          <td>${shortChartLabel(lbl, hist.labels.length - 1 - i)}</td>
          <td>Actual</td>
          <td>₱${Number(hist.values[i]).toFixed(2)}</td>
        </tr>`);
    });
    forecast.forEach((f) => {
      rows.push(`
        <tr class="forecast-row">
          <td>${f.date}</td>
          <td>AI forecast<span class="tag-forecast">LSTM</span></td>
          <td>₱${Number(f.price).toFixed(2)}</td>
        </tr>`);
    });
    tbody.innerHTML = rows.join('');
  }

  function renderHowChart() {
    const canvas = $('#home-how-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    const hist = getHowHistorical();
    const lastActual = hist.values.length ? hist.values[hist.values.length - 1] : getEntry('Local Regular').price;
    const forecast = getHowForecast(lastActual);

    const histLabels = hist.labels.map((l, i) => shortChartLabel(l, hist.labels.length - 1 - i));
    const fcLabels = forecast.map((f) => f.date);
    const allLabels = [...histLabels, ...fcLabels];

    const actualData = [...hist.values, ...Array(forecast.length).fill(null)];
    const bridge = hist.values.length ? hist.values[hist.values.length - 1] : lastActual;
    const predictedLine = [
      ...Array(Math.max(hist.values.length - 1, 0)).fill(null),
      bridge,
      ...forecast.map((f) => f.price),
    ];

    const liveEl = $('#home-how-live');
    if (liveEl) {
      liveEl.textContent = Object.keys(_forecastByKey).length ? 'Live' : 'Sample data';
    }

    renderHowTable(hist, forecast);

    if (_howChart) {
      _howChart.destroy();
      _howChart = null;
    }

    _howChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: allLabels,
        datasets: [
          {
            label: 'Actual price',
            data: actualData,
            borderColor: '#52b07a',
            backgroundColor: 'rgba(82, 176, 122, 0.12)',
            borderWidth: 2.5,
            pointRadius: 4,
            pointBackgroundColor: '#52b07a',
            tension: 0.35,
            fill: true,
            spanGaps: false,
          },
          {
            label: 'AI forecast',
            data: predictedLine,
            borderColor: 'rgba(170, 224, 190, 0.9)',
            borderWidth: 2,
            borderDash: [6, 4],
            pointRadius: 4,
            pointBackgroundColor: 'rgba(170, 224, 190, 1)',
            tension: 0.35,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(13, 33, 23, 0.92)',
            titleFont: { family: "'Plus Jakarta Sans', sans-serif", size: 11 },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
            callbacks: {
              label(ctx) {
                const v = ctx.parsed.y;
                if (v == null) return null;
                return ` ₱${Number(v).toFixed(2)}/kg`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.06)' },
            ticks: { color: 'rgba(255,255,255,0.45)', font: { size: 10 } },
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.06)' },
            ticks: {
              color: 'rgba(255,255,255,0.45)',
              font: { size: 10 },
              callback: (v) => `₱${v}`,
            },
          },
        },
      },
    });
  }

  function bindOriginToggle() {
    const toggle = $('#hero-origin-toggle');
    if (!toggle) return;
    toggle.querySelectorAll('.hero-origin-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggle.querySelectorAll('.hero-origin-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        _origin = btn.dataset.origin === 'imported' ? 'imported' : 'local';
        renderHeroCards();
      });
    });
  }

  async function init() {
    bindOriginToggle();
    await loadPrices();
    renderTicker();
    renderHeroCards();
    renderPricesGrid();
    renderHowChart();
  }

  return { init };
})();
