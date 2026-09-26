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
  const POPULAR_COUNT = 4;

  let _origin = 'popular';   // falls back to 'local' when the variety data cannot load
  let _pricesByLabel = {};
  let _histSeries = null;
  let _histLabels = [];
  let _forecastByKey = {};
  let _howChart = null;
  let _live = false;       // true once the API answered with real DA prices
  let _asOf = '';          // DA data date, e.g. "September 25, 2026"
  let _brandsByGrade = {}; // canonical key -> { brands, names, min, max, asOf } (public-varieties.js)
  let _varieties = [];   // top varieties for the Popular rice strip + ticker (public-varieties.js)

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
        _live = true;
        _asOf = data.as_of_display || data.last_data_date || '';
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
    const fcLabel = (i) => ['Tomorrow', '+2 days', '+3 days'][i] || `+${i + 1} days`;
    const fromApi = _forecastByKey[HOW_RICE_KEY];
    if (Array.isArray(fromApi) && fromApi.length) {
      return fromApi.slice(0, 3).map((f, i) => ({
        date: f.date || fcLabel(i),
        date_iso: f.date_iso,
        price: Number(f.price ?? f.wm ?? lastActual),
      }));
    }
    const mock = AgriPricePH.Data?.forecast2d || [];
    return mock.slice(0, 3).map((f, i) => ({
      date: f.date || fcLabel(i),
      price: Number(f.rm ?? f.price ?? lastActual * (1 + 0.005 * (i + 1))),
    }));
  }

  function renderTicker() {
    const inner = $('#home-ticker');
    if (!inner) return;

    // Well-known variety names lead — they are what most Filipinos look for first. They carry no
    // up/down arrow: a variety has a shop-price range from one survey, not a daily movement, so an
    // arrow would be invented. The grade prices that follow keep their real day-on-day change.
    const varietyItems = _varieties.map((v) =>
      `<div class="ticker-item is-variety"><span class="ticker-name">${esc(v.name)}</span><span class="ticker-price">${priceRange(v, true)}/kg</span><span class="ticker-tag">shop prices</span></div>`
    ).join('');
    const gradeItems = RICE().map(({ label }) => {
      const d = getEntry(label);
      const short = label.replace(/^Imported /, 'Imp. ').replace(/^Local /, '');
      return `<div class="ticker-item"><span class="ticker-name">${short}</span><span class="ticker-price">₱${Number(d.price).toFixed(2)}/kg</span>${formatTickerChange(d.pct)}</div>`;
    }).join('');
    const items = varietyItems + gradeItems;

    inner.innerHTML = items + items;
    // Keep the scroll speed the same as when the belt held only the 8 grades (30s for 8 items).
    inner.style.animationDuration = `${Math.round(30 * ((_varieties.length + RICE().length) / Math.max(RICE().length, 1)))}s`;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function peso(n) {
    return `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function priceRange(v, short) {
    if (Math.abs(v.max - v.min) < 0.005) return peso(v.min);
    return short ? `${peso(v.min)}–${Number(v.max).toFixed(2)}` : `${peso(v.min)} – ${peso(v.max)}`;
  }

  function prettyDay(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
    return new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  const INFO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r=".6" fill="currentColor"/></svg>';
  const SURVEY_TIP = 'Shop prices were canvassed in local markets every day for 30 days (Aug 6 – Sep 4, 2026), and verified by the local government. The 30th and last day, Sep 4, is the one used.';
  const infoTip = (text, cls = '') => `<span class="lp-tip ${cls}" tabindex="0" role="note" aria-label="${esc(text)}" data-tip="${esc(text)}">${INFO_SVG}</span>`;

  const GRAIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h18a9 9 0 0 1-18 0z"/><path d="M12 12V4"/><path d="M9 7c0-1.5 1-3 3-3s3 1.5 3 3"/></svg>';

  /** "Popular rice": the most-listed varieties, each linking to the catalog already searched. */
  function renderPopular() {
    const sec = $('#popular');
    const grid = $('#popular-grid');
    if (!sec || !grid) return;
    if (!_varieties.length) { sec.hidden = true; return; }

    grid.innerHTML = _varieties.map((v, i) => `
      <a class="pop-card" style="--i:${i}" href="rice-catalog.html?variety=${encodeURIComponent(v.name)}"
         aria-label="${esc(v.name)}: shop prices ${priceRange(v)} per kilo. See these in the Rice Catalog">
        <div class="pop-top"><span class="pop-ico">${GRAIN_ICON}</span><span class="pop-name">${esc(v.name)}</span></div>
        <div class="pop-price">${priceRange(v)}<span> /kg</span></div>
        <div class="pop-meta"><b>${v.brands} brand${v.brands === 1 ? '' : 's'}</b> sell it
          <div>${v.gradeLabels.map((g) => `<span class="pop-grade">${esc(g)}</span>`).join('')}</div>
        </div>
        <span class="pop-go">See the brands <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 7h10M8 3l4 4-4 4"/></svg></span>
      </a>`).join('');

    const when = prettyDay(_varieties.map((v) => v.asOf).filter(Boolean).sort().pop());
    $('#popular-note').innerHTML = `Ranked by how many brands sell each variety in our catalog. Prices are the range of shop prices across those brands — not a daily market price or a forecast ${infoTip(SURVEY_TIP)}. For today's market rates and the 3-day forecast, see the grade prices below.`;
    sec.hidden = false;
  }

  async function loadVarieties() {
    try {
      const bp = await AgriPricePH.API.brandPrices();
      _varieties = AgriPricePH.Varieties.summarize(bp).slice(0, POPULAR_COUNT);
      _brandsByGrade = AgriPricePH.Varieties.byGrade(bp);
    } catch {
      _varieties = [];
      _brandsByGrade = {};          // backend unreachable: the strip stays hidden, the ticker shows grades only
    }
  }

  function renderHeroCards() {
    const wrap = $('#hero-price-cards');
    if (!wrap) return;
    const note = $('#hero-popular-note');

    if (_origin === 'popular' && _varieties.length) {
      // Same data and wording as the Popular rice section below, so the two can never disagree.
      wrap.innerHTML = _varieties.map((v) => `
        <a class="hero-stat-card" href="rice-catalog.html?variety=${encodeURIComponent(v.name)}"
           aria-label="${esc(v.name)}: shop prices ${priceRange(v)} per kilo from ${v.brands} brands. See them in the Rice Catalog">
          <div class="hsc-name">${esc(v.name)}<span class="hsc-badge brands">${v.brands} brand${v.brands === 1 ? '' : 's'}</span></div>
          <div class="hsc-value hsc-value--range">${priceRange(v)}</div>
          <div class="hsc-sub">per kilogram · ${esc(v.gradeLabels.join(', '))}</div>
        </a>`).join('');
      if (note) {
        const when = prettyDay(_varieties.map((v) => v.asOf).filter(Boolean).sort().pop());
        note.innerHTML = `Shop-price range across brands ${infoTip(SURVEY_TIP, 'lp-tip--dark lp-tip--right')} · tap a rice to see the brands`;
        note.hidden = false;
      }
      return;
    }
    if (note) note.hidden = true;

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

  const ARROW = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 7h10M8 3l4 4-4 4"/></svg>';

  function keyFor(origin, suffix) {
    const r = RICE().find((x) => x.label === labelFor(origin, suffix));
    return r ? r.key : '';
  }

  /** One grade: today's DA price → tomorrow's expected range → the brands you'll find. */
  function priceCardHtml(origin, suffix, featured) {
    const label = labelFor(origin, suffix);
    const key = keyFor(origin, suffix);
    const d = getEntry(label);
    const changeCls = Number(d.pct) > 0.05 ? 'up' : Number(d.pct) < -0.05 ? 'down' : 'flat';
    const changeText = Number(d.change) === 0
      ? '— No change'
      : `${Number(d.change) > 0 ? '▲' : '▼'} ₱${Math.abs(Number(d.change)).toFixed(2)} vs yesterday`;

    // Tomorrow: the model's calibrated band — the same range the Price Forecast page shows.
    const f = (_forecastByKey[key] || [])[0];
    const range = f && f.low != null && f.high != null
      ? `<div class="pc-range">Tomorrow, expected
           <strong>${peso(f.low)} – ${peso(f.high)}</strong>
         </div>`
      : '';

    // Brands filed under this grade in the Rice Catalog, with their shop-price range.
    const g = _brandsByGrade[key];
    let brands = '';
    if (g && g.brands) {
      const shown = g.names.slice(0, 3).join(', ') + (g.names.length > 3 ? ` +${g.names.length - 3}` : '');
      const shop = g.min != null ? ` · ${g.max - g.min < 0.005 ? peso(g.min) : `${peso(g.min)} – ${peso(g.max)}`} in shops` : '';
      brands = `<div class="pc-brands">
          <span><b>${g.brands} brand${g.brands === 1 ? '' : 's'}</b>${shop}</span>
          <span class="pc-brand-names" title="${esc(g.names.join(', '))}">${esc(shown)}</span>
          <a class="pc-brands-link" href="rice-catalog.html?grade=${encodeURIComponent(key)}">See the brands ${ARROW}</a>
        </div>`;
    } else if (_live || Object.keys(_brandsByGrade).length) {
      const why = key === 'impRegular'
        ? 'Not sold under a brand name in the Philippines.'
        : 'Sold by grade — no branded products listed yet.';
      brands = `<div class="pc-brands"><span class="pc-none">${why}</span></div>`;
    }

    return `
      <div class="price-card${featured ? ' featured' : ''}">
        <div class="pc-head"><div class="pc-type">${suffix}</div>${_live ? '<span class="pc-today">Today</span>' : ''}</div>
        <div class="pc-price">${peso(d.price)}<span>/kg</span></div>
        <div><span class="pc-change ${changeCls}">${changeText}</span></div>
        ${range}
        ${brands}
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

    // Header + legend say exactly where each number comes from. The old "Sample data for
    // illustration" line was always shown, even over live data; now a notice appears only when
    // the API really could not be reached.
    const desc = $('#home-prices-desc');
    if (desc) {
      desc.innerHTML = _live
        ? `Today&rsquo;s Department of Agriculture price for every grade${_asOf ? ` (as of ${esc(_asOf)})` : ''}, tomorrow&rsquo;s expected range, and the brands you&rsquo;ll find on the shelf.`
        : `Today&rsquo;s price for every grade, tomorrow&rsquo;s expected range, and the brands you&rsquo;ll find on the shelf.<br><span class="prices-offline">Live prices can&rsquo;t be reached right now — showing sample figures.</span>`;
    }
    const legend = $('#home-prices-legend');
    if (legend) {
      const shopDate = prettyDay(Object.values(_brandsByGrade).map((g) => g.asOf).filter(Boolean).sort().pop());
      legend.innerHTML = [
        `<span><i class="lg-today"></i><b>Today</b> DA daily price monitoring${_asOf ? `, ${esc(_asOf)}` : ''}</span>`,
        Object.keys(_forecastByKey).length ? '<span><i class="lg-range"></i><b>Tomorrow</b> AgriPricePH forecast &mdash; about 9 in 10 past forecasts landed inside this range</span>' : '',
        Object.keys(_brandsByGrade).length ? `<span><i class="lg-brands"></i><b>In shops</b> brand shelf prices ${infoTip(SURVEY_TIP, 'lp-tip--dark')}</span>` : '',
      ].join('');
    }
  }

  /** Back-to-top: shows once the hero has scrolled away. The page scrolls on <html>, not window. */
  function bindBackTop() {
    const btn = $('#home-back-top');
    if (!btn) return;
    const scroller = document.scrollingElement || document.documentElement;
    const hero = document.querySelector('.hero, .hero-section, section') || document.body;
    const update = () => btn.classList.toggle('is-visible', scroller.scrollTop > Math.max(500, hero.offsetHeight * 0.8));
    btn.addEventListener('click', () => scroller.scrollTo({ top: 0, behavior: 'smooth' }));
    document.addEventListener('scroll', update, { passive: true, capture: true });
    update();
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

  /** The hero opens on "Popular rice" when variety data loaded; otherwise that tab stays hidden. */
  function syncPopularTab() {
    const toggle = $('#hero-origin-toggle');
    const btn = toggle && toggle.querySelector('[data-origin="popular"]');
    if (!btn) return;
    btn.hidden = !_varieties.length;
    if (!_varieties.length && _origin === 'popular') _origin = 'local';
    toggle.querySelectorAll('.hero-origin-btn').forEach((b) => b.classList.toggle('active', b.dataset.origin === _origin));
  }

  function bindOriginToggle() {
    const toggle = $('#hero-origin-toggle');
    if (!toggle) return;
    toggle.querySelectorAll('.hero-origin-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggle.querySelectorAll('.hero-origin-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        _origin = ['popular', 'imported'].includes(btn.dataset.origin) ? btn.dataset.origin : 'local';
        renderHeroCards();
      });
    });
  }

  async function init() {
    // The homepage stays reachable for everyone (Home button / logo). For logged-in users we just
    // hide the "Create free account" / "Log in" CTAs — no forced redirect (post-login routing to
    // Price Forecast lives in the auth handler, not here).
    if (AgriPricePH.PublicAuth?.isLoggedIn?.()) {
      document.querySelectorAll('[data-auth-open="signup"], [data-auth-open="login"]').forEach(el => el.remove());
    }
    bindOriginToggle();
    bindBackTop();
    await Promise.all([loadPrices(), loadVarieties()]);
    syncPopularTab();
    renderPopular();
    renderTicker();
    renderHeroCards();
    renderPricesGrid();
    renderHowChart();
  }

  return { init };
})();
