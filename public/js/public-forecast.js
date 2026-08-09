/* AgriPricePH — Public Rice Price Forecast dashboard */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.PublicForecast = (function () {
  let _forecast = null;
  let _historical = null;
  let _heroType = 'local';
  let _riceTab = 'wm';
  let _chart = null;

  const SHORT = { wm: 'Well-Milled', rm: 'Regular', pm: 'Premium', sp: 'Special' };

  const OUTLOOK_KEYS = {
    local: { wm: 'locWellMilled', rm: 'locRegular', pm: 'locPremium', sp: 'locSpecial' },
    imported: { wm: 'impWellMilled', rm: 'impRegular', pm: 'impPremium', sp: 'impSpecial' },
  };

  const MOCK_FIELD = { wm: 'wm', rm: 'rm', pm: 'pm', sp: 'sp' };
  const HIST_TAIL = 30;

  function $(sel) { return document.querySelector(sel); }

  function getRiceKey() {
    const map = OUTLOOK_KEYS[_heroType] || OUTLOOK_KEYS.local;
    return map[_riceTab] || map.wm;
  }

  function getShortLabel() {
    return SHORT[_riceTab] || 'Well-Milled';
  }

  function getFullLabel() {
    const prefix = _heroType === 'local' ? 'Local' : 'Imported';
    return `${prefix} ${getShortLabel()}`;
  }

  function getDisplayLabel() {
    return `${getShortLabel()} (${_heroType === 'local' ? 'Local' : 'Imported'})`;
  }

  function init() {
    AgriPricePH.Dates?.applyPageDates(null);
    buildRiceTabs();
    bindHeroToggle();
    bindRiceTabs();
    loadPredictions();
  }

  function buildRiceTabs() {
    const wrap = $('#forecast-rice-tabs');
    if (!wrap) return;
    wrap.innerHTML = Object.entries(SHORT).map(([key, label]) =>
      `<button type="button" class="forecast-rice-tab${key === _riceTab ? ' active' : ''}" data-tab="${key}" role="tab" aria-selected="${key === _riceTab}">${label}</button>`
    ).join('');
  }

  function bindRiceTabs() {
    $('#forecast-rice-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.forecast-rice-tab');
      if (!btn) return;
      _riceTab = btn.dataset.tab || 'wm';
      document.querySelectorAll('.forecast-rice-tab').forEach((b) => {
        const on = b.dataset.tab === _riceTab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      refreshView();
    });
  }

  function bindHeroToggle() {
    const toggle = $('#hero-toggle');
    if (!toggle) return;
    toggle.querySelectorAll('.hero-toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggle.querySelectorAll('.hero-toggle-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        _heroType = btn.dataset.type || 'local';
        if (_forecast?.current_prices) renderHeroFromApi(_forecast);
        else renderHeroPrices();
        refreshView();
      });
    });
  }

  async function loadPredictions() {
    try {
      const [data, hist] = await Promise.all([
        AgriPricePH.API.predictions(),
        AgriPricePH.API.historical().catch(() => null),
      ]);
      if (hist?.historical) {
        _historical = { labels: hist.labels || [], series: hist.historical };
      }
      if (data?.ready) {
        _forecast = data;
        applyMetrics(data.metrics);
        AgriPricePH.Dates?.applyPageDates(data);
        updateLastUpdated(data);
        renderHeroFromApi(data);
        refreshView();
        return;
      }
    } catch { /* mock */ }

    renderFromMock();
  }

  function renderFromMock() {
    _historical = {
      labels: (AgriPricePH.Data.historicalLabels || []).slice(-HIST_TAIL),
      series: AgriPricePH.Data.historical,
    };
    AgriPricePH.Dates?.applyPageDates({
      as_of_display: AgriPricePH.Dates.formatDisplay(AgriPricePH.Dates.today()),
      forecast: [{ date_iso: isoPlusDays(1) }, { date_iso: isoPlusDays(2) }],
    });
    $('#status-system').textContent = 'Running (sample data)';
    renderHeroPrices();
    setTimeout(refreshView, 50);
  }

  function isoPlusDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function updateLastUpdated(data) {
    const el = $('#status-updated');
    if (!el) return;
    if (data?.last_data_date) {
      const d = new Date(data.last_data_date + 'T12:00:00');
      const days = Math.floor((Date.now() - d.getTime()) / 86400000);
      el.textContent = days <= 0 ? 'Today' : days === 1 ? '1 day ago' : `${days} days ago`;
    } else {
      el.textContent = AgriPricePH.Dates?.relativeTime?.(AgriPricePH.Dates.today()) || 'Recently';
    }
  }

  function applyMetrics(m) {
    if (!m) return;
    const mae = m.mae_peso != null ? Number(m.mae_peso) : 0.45;
    const accSub = $('#status-accuracy-sub');
    if (accSub) accSub.textContent = `Usually off by only ₱${mae.toFixed(2)} per kilo`;

    const accTitle = $('#status-accuracy-title');
    if (accTitle) {
      if (mae <= 0.5) accTitle.textContent = 'Very close';
      else if (mae <= 1.2) accTitle.textContent = 'Fairly close';
      else accTitle.textContent = 'Rough estimate';
    }

    const badge = $('#status-accuracy-badge');
    if (badge) {
      if (mae <= 0.6) badge.textContent = 'Almost always right';
      else if (mae <= 1.2) badge.textContent = 'Usually reliable';
      else badge.textContent = 'Use as a guide';
    }
  }

  function getHistoricalSlice(riceKey) {
    if (riceKey === 'locWellMilled' && _forecast?.history?.values?.length) {
      return {
        values: _forecast.history.values.slice(-HIST_TAIL),
        labels: (_forecast.history.labels || []).slice(-HIST_TAIL),
      };
    }
    if (_historical?.series?.[riceKey]) {
      const values = _historical.series[riceKey].map(Number).filter((v) => !Number.isNaN(v));
      const labels = (_historical.labels || []).slice(-values.length);
      return { values: values.slice(-HIST_TAIL), labels: labels.slice(-HIST_TAIL) };
    }
    const mock = AgriPricePH.Data.historical[riceKey] || AgriPricePH.Data.historical.locWellMilled || [];
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
    const tail = hist.values.filter((v) => v > 0);
    if (tail.length) return tail[tail.length - 1];
    const mock = AgriPricePH.Data.currentPrices[getFullLabel()];
    return mock?.price ?? 0;
  }

  function getForecastForKey(riceKey) {
    const fromApi = _forecast?.forecasts_by_key?.[riceKey];
    if (Array.isArray(fromApi) && fromApi.length) return fromApi;
    if (
      _forecast?.ready &&
      Array.isArray(_forecast.forecast) &&
      _forecast.forecast.length &&
      riceKey === 'locWellMilled'
    ) {
      return _forecast.forecast;
    }
    return [];
  }

  function getMockForecast(riceKey) {
    const field = MOCK_FIELD[_riceTab] || 'wm';
    const rows = AgriPricePH.Data.forecast2d?.length
      ? AgriPricePH.Data.forecast2d
      : (AgriPricePH.Data.forecast7d || []).slice(0, 2);
    const lastPrice = getLastPrice(riceKey);
    return rows.map((d, i) => {
      const price = Number(d[field] ?? d.price ?? d.wm ?? lastPrice);
      const prev = i === 0 ? lastPrice : Number(rows[i - 1][field] ?? rows[i - 1].price ?? lastPrice);
      return {
        day: i + 1,
        date: d.date || formatShortDate(i + 1),
        date_iso: d.date_iso || isoPlusDays(i + 1),
        price,
        change: price - prev,
        confidence: d.conf ?? 0.85,
      };
    });
  }

  function formatShortDate(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function refreshView() {
    const riceKey = getRiceKey();
    const label = getDisplayLabel();
    const hist = getHistoricalSlice(riceKey);
    const lastPrice = getLastPrice(riceKey);
    const forecast = _forecast?.ready ? getForecastForKey(riceKey) : getMockForecast(riceKey);
    const days = forecast.length ? forecast : getMockForecast(riceKey);

    updateTitles(label);
    renderForecastChart(hist, days, lastPrice);
    renderTomorrowCard(days[0], label, lastPrice);
    renderSidebarBars(days);
    renderConfBars(days);
    renderForecastTable(days, lastPrice);
    updateMovementStatus(days, lastPrice);
    updateBuyingTip(days, lastPrice);
  }

  function updateTitles(label) {
    const chart = $('#forecast-chart-title');
    const table = $('#forecast-table-title');
    if (chart) chart.textContent = `Actual vs Predicted Prices — ${label}`;
    if (table) table.textContent = `Daily Price Forecast — ${label}`;
  }

  function renderHeroFromApi(data) {
    const container = $('#hero-prices');
    if (!container || !data.current_prices) return;
    const keys = Object.values(OUTLOOK_KEYS[_heroType]);
    const types = Object.keys(SHORT);
    container.innerHTML = types.map((tab, i) => {
      const key = keys[i];
      let price = data.current_prices[key];
      if (price == null || Number(price) <= 0) price = getLastPrice(key);
      if (!price) return '';
      return heroPriceCard(SHORT[tab], price);
    }).join('');
  }

  function renderHeroPrices() {
    const container = $('#hero-prices');
    if (!container) return;
    const prefix = _heroType === 'local' ? 'Local' : 'Imported';
    container.innerHTML = Object.values(SHORT).map((short) => {
      const name = `${prefix} ${short}`;
      const d = AgriPricePH.Data.currentPrices[name] || { price: 0 };
      return heroPriceCard(short, d.price);
    }).join('');
  }

  function heroPriceCard(shortName, price) {
    return `
      <div class="hero-price-item">
        <div class="hero-price-rice">${shortName}</div>
        <div class="hero-price-val">₱${Number(price).toFixed(2)}</div>
        <div class="hero-price-foot">Today's price</div>
      </div>`;
  }

  function renderForecastChart(hist, forecast, lastPrice) {
    const canvas = $('#forecast-main-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    const histVals = [...(hist.values || [])];
    const histLabels = (hist.labels || []).map(formatChartLabel);
    const predVals = (forecast || []).map((f) => f.price);
    const predLabels = (forecast || []).map((f) => f.date || formatShortDate(f.day));

    const bridge = histVals.length ? histVals[histVals.length - 1] : lastPrice;
    const actualData = [...histVals, ...Array(predVals.length).fill(null)];
    const predictedLine = [
      ...Array(Math.max(histVals.length - 1, 0)).fill(null),
      bridge,
      ...predVals,
    ];

    const mae = _forecast?.metrics?.mae_peso != null ? Number(_forecast.metrics.mae_peso) : 0.45;
    const upper = predictedLine.map((v) => (v == null ? null : v + mae));
    const lower = predictedLine.map((v) => (v == null ? null : Math.max(0, v - mae)));

    const labels = [...histLabels, ...predLabels];

    if (_chart) {
      _chart.destroy();
      _chart = null;
    }

    _chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Expected range (upper)',
            data: upper,
            borderColor: 'transparent',
            backgroundColor: 'transparent',
            pointRadius: 0,
            tension: 0.35,
            fill: false,
            order: 0,
          },
          {
            label: 'Expected range',
            data: lower,
            borderColor: 'transparent',
            backgroundColor: 'rgba(76, 175, 110, 0.18)',
            pointRadius: 0,
            tension: 0.35,
            fill: '-1',
            order: 0,
          },
          {
            label: 'Predicted price',
            data: predictedLine,
            borderColor: '#3B82F6',
            backgroundColor: 'transparent',
            borderWidth: 2,
            borderDash: [6, 4],
            pointRadius: 4,
            pointBackgroundColor: '#3B82F6',
            pointBorderColor: '#fff',
            pointBorderWidth: 2,
            tension: 0.35,
            spanGaps: true,
            order: 2,
          },
          {
            label: 'Actual price',
            data: actualData,
            borderColor: '#2D5A3E',
            backgroundColor: 'rgba(45, 90, 62, 0.06)',
            borderWidth: 2.5,
            pointRadius: histVals.length > 20 ? 0 : 3,
            pointBackgroundColor: '#2D5A3E',
            tension: 0.35,
            fill: false,
            order: 3,
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
            callbacks: {
              label(ctx) {
                if (ctx.dataset.label?.includes('range') && ctx.dataset.label !== 'Expected range') return null;
                if (ctx.parsed.y == null) return null;
                return `${ctx.dataset.label}: ₱${ctx.parsed.y.toFixed(2)}`;
              },
            },
            filter(item) {
              return !item.dataset.label?.includes('upper');
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { maxTicksLimit: 8, font: { size: 11 }, color: '#8FA896' },
          },
          y: {
            ticks: {
              callback: (v) => `₱${Number(v).toFixed(1)}`,
              font: { size: 11, family: "'DM Mono', monospace" },
              color: '#8FA896',
            },
            grid: { color: '#E2EAE4' },
          },
        },
      },
    });
  }

  function formatChartLabel(lb) {
    if (!lb) return '';
    if (lb.includes('/')) {
      const p = lb.split('/');
      return new Date(`${p[2]}-${p[0]}-${p[1]}`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(lb)) {
      return new Date(lb + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return lb;
  }

  function renderTomorrowCard(day1, label, lastPrice) {
    if (!day1) return;
    const change = day1.price - lastPrice;
    const conf = (day1.confidence ?? 0.85) * 100;

    const pill = $('#tomorrow-date-pill');
    if (pill) pill.textContent = day1.date || formatShortDate(1);

    const rice = $('#tomorrow-rice-label');
    if (rice) rice.textContent = label;

    const price = $('#tomorrow-price');
    if (price) price.textContent = `₱${day1.price.toFixed(2)}`;

    const ch = $('#tomorrow-change-pill');
    if (ch) {
      ch.className = 'forecast-change-pill' + (change < 0 ? ' down' : change === 0 ? ' flat' : '');
      if (change > 0) ch.textContent = `↗ +₱${change.toFixed(2)} more than today`;
      else if (change < 0) ch.textContent = `↘ ₱${Math.abs(change).toFixed(2)} less than today`;
      else ch.textContent = 'Same as today';
    }

    const fill = $('#tomorrow-conf-fill');
    if (fill) fill.style.width = `${conf}%`;
    const pct = $('#tomorrow-conf-pct');
    if (pct) pct.textContent = `${conf.toFixed(0)}% confident`;
  }

  function renderSidebarBars(forecast) {
    const container = $('#pred-sidebar-bars');
    if (!container || !forecast?.length) return;
    const prices = forecast.map((f) => f.price);
    const maxP = Math.max(...prices);
    const minP = Math.min(...prices);
    container.innerHTML = forecast.map((f) => {
      const pct = ((f.price - minP) / ((maxP - minP) || 1)) * 55 + 35;
      const dateLabel = f.date || formatShortDate(f.day);
      return `
        <div class="pred-day">
          <span class="pred-day-label">${dateLabel}</span>
          <div class="pred-bar-wrap">
            <div class="pred-bar" style="width:${pct}%">
              <span class="pred-bar-val">₱${f.price.toFixed(2)}</span>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function renderConfBars(forecast) {
    const container = $('#pred-conf-bars');
    if (!container) return;
    container.innerHTML = (forecast || []).map((f) => {
      const pct = ((f.confidence ?? 0.85) * 100).toFixed(0);
      const dateLabel = f.date || formatShortDate(f.day);
      return `
        <div class="forecast-conf-day-row">
          <span>${dateLabel}</span>
          <div class="forecast-conf-track">
            <div class="forecast-conf-fill" style="width:${pct}%"></div>
          </div>
          <span>${pct}%</span>
        </div>`;
    }).join('');
  }

  function renderForecastTable(forecast, lastPrice) {
    const tbody = $('#forecast-tbody');
    if (!tbody) return;
    const dayNames = ['Tomorrow', 'Day after tomorrow'];

    tbody.innerHTML = (forecast || []).map((f, i) => {
      const delta = f.price - lastPrice;
      const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      const dirText = delta > 0 ? 'Going up' : delta < 0 ? 'Going down' : 'Staying flat';
      const arrow = delta > 0 ? '↗' : delta < 0 ? '↘' : '→';
      const sign = delta > 0 ? '+' : '';
      const conf = ((f.confidence ?? 0.85) * 100).toFixed(0);
      const sub = dayNames[i] || `Day ${f.day}`;

      return `
        <div class="forecast-row">
          <div>
            <div class="forecast-date-main">${f.date} — ${sub}</div>
          </div>
          <div class="forecast-direction ${dir}">
            <span aria-hidden="true">${arrow}</span> ${dirText}
          </div>
          <div class="forecast-price">₱${f.price.toFixed(2)}</div>
          <div>
            <span class="forecast-change-badge ${dir === 'down' ? 'down' : ''}">${sign}₱${Math.abs(delta).toFixed(2)}</span>
          </div>
          <div class="forecast-conf-cell">${conf}%</div>
        </div>`;
    }).join('');
  }

  function updateMovementStatus(forecast, lastPrice) {
    if (!forecast?.length) return;
    const maxMove = Math.max(...forecast.map((f) => Math.abs(f.price - lastPrice)));
    const title = $('#status-movement-title');
    const sub = $('#status-movement-sub');
    const badge = $('#status-movement-badge');

    if (maxMove <= 0.5) {
      if (title) title.textContent = 'Small changes only';
      if (sub) sub.textContent = 'Price stays close to what we predict';
      if (badge) { badge.textContent = 'Price is stable'; badge.className = 'model-status-badge orange'; }
    } else if (maxMove <= 1.5) {
      if (title) title.textContent = 'Moderate movement';
      if (sub) sub.textContent = 'Prices may shift a little over the next 2 days';
      if (badge) { badge.textContent = 'Watch the trend'; badge.className = 'model-status-badge orange'; }
    } else {
      if (title) title.textContent = 'Bigger swings possible';
      if (sub) sub.textContent = 'Prices could move more than usual';
      if (badge) { badge.textContent = 'Plan ahead'; badge.className = 'model-status-badge orange'; }
    }
  }

  function updateBuyingTip(forecast, lastPrice) {
    const el = $('#buying-tip-text');
    if (!el || !forecast?.length) return;

    const rice = getShortLabel();
    const rising = forecast.every((f, i) => i === 0 ? f.price >= lastPrice : f.price >= forecast[i - 1].price);
    const falling = forecast.every((f, i) => i === 0 ? f.price <= lastPrice : f.price <= forecast[i - 1].price);

    if (rising && forecast[forecast.length - 1].price > lastPrice + 0.2) {
      el.textContent =
        `Prices are expected to slowly rise over the next 2 days. If you're planning to buy in bulk, today might be a better time to stock up on ${rice} rice.`;
    } else if (falling) {
      el.textContent =
        `Prices may ease slightly over the next 2 days. If you can wait, you might save a little on ${rice} rice — but check again tomorrow.`;
    } else {
      el.textContent =
        `Prices look fairly steady for ${rice} rice over the next 2 days. Buy when it fits your budget — no strong rush either way.`;
    }
  }

  return { init };
})();
