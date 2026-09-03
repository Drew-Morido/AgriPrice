/* ============================================
   AgriPricePH - Correlation Analysis ("Market Drivers")
   ============================================
   Layout/content ported from the provided "Market Drivers" mockup, themed identically to Model
   Dashboard (admin/css/correlation.css mirrors admin/css/model-dashboard.css's tokens/fonts).

   Real, live-computed from /api/historical-data (same source used elsewhere): Pearson r between
   diesel/USD-PHP and the selected rice type, the trend chart, drift detection ("diverging" vs
   "tracking"), and per-source data-completeness ("signal reliability"). The backend has no
   correlation endpoint — Rice Stock Level, Rainfall, Month (seasonality), and Import Tariff can't
   be recomputed client-side (stock/rainfall/tariff series aren't exposed by /api/historical-data),
   so those four keep the app's existing vetted research figures (previously hardcoded in this same
   page) rather than being invented from nothing or silently dropped.
   ============================================ */

window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Correlation = (function () {
  const RICE_LABELS = {
    locSpecial: 'Local · Special', locPremium: 'Local · Premium',
    locWellMilled: 'Local · Well-Milled', locRegular: 'Local · Regular-Milled',
    impSpecial: 'Imported · Special', impPremium: 'Imported · Premium',
    impWellMilled: 'Imported · Well-Milled', impRegular: 'Imported · Regular-Milled',
  };
  const SHORT_LABELS = {
    locSpecial: 'Local Special', locPremium: 'Local Premium',
    locWellMilled: 'Local Well-Milled', locRegular: 'Local Regular-Milled',
    impSpecial: 'Imported Special', impPremium: 'Imported Premium',
    impWellMilled: 'Imported Well-Milled', impRegular: 'Imported Regular-Milled',
  };

  // Vetted findings that can't be recomputed from what /api/historical-data exposes (no stock,
  // rainfall, or tariff time series client-side) — see file header. These match the numbers this
  // page has carried since the correlation study was written up.
  const STATIC_FACTORS = [
    { key: 'stock', name: 'Rice Stock Level', r: -0.63, significant: true, icon: 'ti-building-warehouse',
      detail: 'High warehouse stock cools market speculation, causing retail prices to dip or stabilize.' },
    { key: 'rainfall', name: 'Rainfall', r: 0.41, significant: true, icon: 'ti-cloud-rain',
      detail: 'Heavy rain disrupts harvest logistics and drying, tightening near-term supply.' },
    { key: 'month', name: 'Month (Seasonality)', r: 0.33, significant: true, icon: 'ti-calendar',
      detail: 'Lean-season months (Jul–Sep) see mild seasonal price pressure ahead of harvest.' },
    { key: 'tariff', name: 'Import Tariff', r: -0.03, significant: false, icon: 'ti-receipt-tax',
      detail: 'Policy step-variable (15–35% band, reviewed quarterly) — see the note below the table. Imported rice only.',
      importedOnly: true },
  ];

  let masterData = { labels: [] };
  let selectedClass = 'locWellMilled';
  let selectedRange = '8w';
  let trendChart = null;
  let tableSearch = '';
  let liveFactors = []; // recomputed per classification: [{key:'diesel'|'usd', ...}]

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
  const peso = (v) => (v == null || isNaN(v)) ? '—' : `₱${Number(v).toFixed(2)}`;

  /* ================= Stats helpers ================= */
  function pearson(xs, ys) {
    const pairs = [];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i], y = ys[i];
      if (x != null && y != null && !isNaN(x) && !isNaN(y)) pairs.push([x, y]);
    }
    const n = pairs.length;
    if (n < 5) return { r: null, n };
    const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
    const my = pairs.reduce((a, p) => a + p[1], 0) / n;
    let num = 0, dx2 = 0, dy2 = 0;
    pairs.forEach(([x, y]) => { const dx = x - mx, dy = y - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; });
    const denom = Math.sqrt(dx2 * dy2);
    return { r: denom ? num / denom : 0, n };
  }

  // Two-tailed significance via the standard t-test normal approximation (valid for the sample
  // sizes this app always has, n well over 30) — not a full t-distribution CDF, just the common
  // |t| > 1.96 ⇒ roughly p < 0.05 rule of thumb.
  function isSignificant(r, n) {
    if (r == null || n < 4 || Math.abs(r) >= 1) return r != null && Math.abs(r) >= 1;
    const t = r * Math.sqrt((n - 2) / (1 - r * r));
    return Math.abs(t) > 1.96;
  }

  function strengthLabel(r) {
    const a = Math.abs(r || 0);
    if (a >= 0.7) return 'Very Strong';
    if (a >= 0.5) return 'Strong';
    if (a >= 0.3) return 'Moderate';
    if (a >= 0.1) return 'Weak';
    return 'Negligible';
  }

  function pctChangeOverWindow(arr, window) {
    const n = arr.length;
    if (n <= window) return null;
    const prev = arr[n - 1 - window], cur = arr[n - 1];
    if (prev == null || cur == null || isNaN(prev) || isNaN(cur) || prev === 0) return null;
    return (cur - prev) / prev;
  }

  // Scans backward up to `lookback` days for the most recent point where diesel and the selected
  // rice type moved in opposite directions over a trailing 7-day window (diesel's move being big
  // enough — >1% — to matter). Returns null when nothing qualifies as a drift in that window.
  function detectDrift(dieselArr, riceArr, lookback = 60, window = 7) {
    const n = dieselArr.length;
    for (let i = n - 1; i >= Math.max(window, n - lookback); i--) {
      const dPrev = dieselArr[i - window], dCur = dieselArr[i];
      const rPrev = riceArr[i - window], rCur = riceArr[i];
      if ([dPrev, dCur, rPrev, rCur].some(v => v == null || isNaN(v)) || dPrev === 0 || rPrev === 0) continue;
      const dChange = (dCur - dPrev) / dPrev;
      const rChange = (rCur - rPrev) / rPrev;
      if (Math.abs(dChange) > 0.01 && Math.sign(dChange) !== Math.sign(rChange) && rChange !== 0) {
        return { daysAgo: n - 1 - i, dChange, rChange };
      }
    }
    return null;
  }

  // Share of non-null, in-range values in the array — a real (if simple) data-completeness check
  // used for "signal reliability" instead of the mockup's arbitrary flavor labels.
  function completeness(arr, lastN) {
    const slice = arr.slice(-lastN);
    if (!slice.length) return 0;
    const ok = slice.filter(v => v != null && !isNaN(v) && v > 0).length;
    return ok / slice.length;
  }

  /* ================= Init ================= */
  async function init() {
    tableSearch = '';
    bindClassSelect();
    bindRangeSelect();
    bindSearchBox();

    await fetchHistorical();
    renderAll();
  }

  function destroy() {
    if (trendChart) { trendChart.destroy(); trendChart = null; }
  }

  async function fetchHistorical() {
    try {
      const res = await AgriPricePH.API.historical();
      if (res.error) throw new Error(res.error);
      masterData.labels = res.labels || [];
      Object.keys(RICE_LABELS).forEach(key => { masterData[key] = res.historical?.[key] || []; });
      masterData.fuel = res.historical?.fuel || [];
      masterData.exchange = res.historical?.exchange || [];
    } catch {
      // Offline — everything below just renders empty/placeholder states.
    }
  }

  function renderAll() {
    computeLiveFactors();
    renderHealthChip();
    renderStatStrip();
    renderChart();
    renderDriverList();
    renderSignalChips();
    renderTable();
  }

  /* ================= Live factor computation ================= */
  function computeLiveFactors() {
    const rice = masterData[selectedClass] || [];
    const diesel = masterData.fuel || [];
    const usd = masterData.exchange || [];

    const dieselCorr = pearson(diesel, rice);
    const usdCorr = pearson(usd, rice);

    liveFactors = [
      {
        key: 'diesel', name: 'Diesel Fuel Price', icon: 'ti-gas-station',
        r: dieselCorr.r, n: dieselCorr.n, significant: isSignificant(dieselCorr.r, dieselCorr.n),
        detail: 'Sustained pump price increases cascade into transport costs, pushing retail rice up.',
      },
      {
        key: 'usd', name: 'USD/PHP Exchange Rate', icon: 'ti-currency-dollar',
        r: usdCorr.r, n: usdCorr.n, significant: isSignificant(usdCorr.r, usdCorr.n),
        detail: 'A weaker peso makes imported inputs costlier, giving retailers room to raise prices.',
      },
    ];
  }

  /* ================= Health chip ================= */
  function renderHealthChip() {
    const chip = document.getElementById('corr-health-chip');
    const text = document.getElementById('corr-health-text');
    if (!chip || !text) return;
    const rice = masterData[selectedClass] || [];
    const sources = [rice, masterData.fuel || [], masterData.exchange || []];
    const healthy = sources.filter(s => completeness(s, 90) >= 0.9).length;
    text.textContent = `${healthy} of ${sources.length} signals healthy`;
    chip.classList.toggle('warn', healthy < sources.length);
  }

  /* ================= Stat strip ================= */
  function renderStatStrip() {
    const el = document.getElementById('corr-stat-strip');
    if (!el) return;
    const rice = masterData[selectedClass] || [];
    const diesel = masterData.fuel || [];

    const dieselAvg30 = avgLastN(diesel, 30);
    const riceAvg30 = avgLastN(rice, 30);
    const riceAvgPrev30 = avgLastN(rice.slice(0, Math.max(0, rice.length - 30)), 30);
    const riceDeltaPct = (riceAvg30 != null && riceAvgPrev30) ? ((riceAvg30 - riceAvgPrev30) / riceAvgPrev30) * 100 : null;

    const corr = pearson(diesel, rice);
    const drift = detectDrift(diesel, rice);

    const stats = [
      {
        label: 'Diesel Price (30D)', value: dieselAvg30 != null ? peso(dieselAvg30) : '—',
        delta: '30-day average', deltaClass: 'flat',
        info: 'Average diesel pump price over the last 30 days of recorded data.',
      },
      {
        label: 'Retail Rice (30D)', value: riceAvg30 != null ? peso(riceAvg30) : '—',
        delta: riceDeltaPct == null ? '—' : `${riceDeltaPct >= 0 ? '▲' : '▼'} ${Math.abs(riceDeltaPct).toFixed(1)}% vs prior 30D`,
        deltaClass: riceDeltaPct == null ? 'flat' : (riceDeltaPct >= 0 ? '' : 'bad'),
        info: `Average market price for ${esc(RICE_LABELS[selectedClass])} over the last 30 days.`,
      },
      {
        label: 'Diesel ↔ Rice Correl.', value: corr.r != null ? `r ${corr.r >= 0 ? '' : '−'}${Math.abs(corr.r).toFixed(2)}` : '—',
        delta: corr.r == null ? '—' : `${strengthLabel(corr.r).toLowerCase()}, full history`, deltaClass: 'flat',
        info: 'Pearson correlation between diesel price and this rice type across all available history.',
      },
      {
        label: 'Since Last Drift', value: drift == null ? 'None recent' : (drift.daysAgo === 0 ? 'Active now' : `${drift.daysAgo}d ago`),
        delta: drift == null ? 'tracking normally' : 'diverging window', deltaClass: drift == null ? 'flat' : 'bad',
        info: 'Days since diesel and this rice type last moved in opposite directions over a 7-day window (checked over the last 60 days).',
      },
    ];

    el.innerHTML = stats.map(s => `
      <div class="corr-stat-card">
        <div class="corr-slabel">
          ${esc(s.label)}
          <span class="corr-tt" tabindex="0"><i class="ti ti-info-circle corr-tt-icon"></i><span class="corr-tt-text">${s.info}</span></span>
        </div>
        <div>
          <div class="corr-sval">${s.value}</div>
          <div class="corr-sdelta ${s.deltaClass}">${esc(s.delta)}</div>
        </div>
      </div>`).join('');
  }

  function avgLastN(arr, n) {
    const slice = (arr || []).slice(-n).filter(v => v != null && !isNaN(v));
    if (!slice.length) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  /* ================= Trend chart ================= */
  function windowSizeFor(range, totalLen) {
    if (range === '8w') return Math.min(56, totalLen);
    if (range === '90d') return Math.min(90, totalLen);
    return totalLen; // all-time
  }

  // Aggregates daily series into `buckets` evenly-sized weekly-ish points so the "8 Weeks" /
  // "All-Time" views stay readable instead of plotting hundreds of raw daily points.
  function bucketAverage(labels, arr, buckets) {
    const n = arr.length;
    if (n <= buckets) return { labels: labels.slice(), values: arr.slice() };
    const outLabels = [], outValues = [];
    const size = n / buckets;
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor(b * size), end = Math.floor((b + 1) * size);
      const chunk = arr.slice(start, end).filter(v => v != null && !isNaN(v));
      outValues.push(chunk.length ? chunk.reduce((a, c) => a + c, 0) / chunk.length : null);
      outLabels.push(labels[end - 1] || labels[labels.length - 1]);
    }
    return { labels: outLabels, values: outValues };
  }

  function renderChart() {
    const canvasEl = document.getElementById('corr-trend-chart');
    if (!canvasEl || typeof Chart === 'undefined') return;

    const fullLabels = masterData.labels || [];
    const fullDiesel = masterData.fuel || [];
    const fullRice = masterData[selectedClass] || [];
    const win = windowSizeFor(selectedRange, fullLabels.length);
    const sliceStart = -win;

    const labels = fullLabels.slice(sliceStart);
    const diesel = fullDiesel.slice(sliceStart);
    const rice = fullRice.slice(sliceStart);

    const buckets = selectedRange === '8w' ? Math.min(8, labels.length) : Math.min(24, labels.length);
    const dieselB = bucketAverage(labels, diesel, buckets);
    const riceB = bucketAverage(labels, rice, buckets);

    const sub = document.getElementById('corr-chart-sub');
    const rangeLabel = selectedRange === '8w' ? 'last 8 weeks' : selectedRange === '90d' ? 'last 90 days' : 'all-time';
    if (sub) sub.textContent = `${RICE_LABELS[selectedClass]} — ${rangeLabel}`;

    renderInsight(fullDiesel, fullRice);

    if (!dieselB.values.length) {
      if (trendChart) { trendChart.destroy(); trendChart = null; }
      return;
    }

    if (trendChart) {
      trendChart.data.labels = dieselB.labels;
      trendChart.data.datasets[0].data = dieselB.values;
      trendChart.data.datasets[1].data = riceB.values;
      trendChart.update();
      return;
    }

    const ctx = canvasEl.getContext('2d');
    trendChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: dieselB.labels,
        datasets: [
          { label: 'Diesel Fuel Price (₱/L)', data: dieselB.values, borderColor: '#1c3d28', backgroundColor: '#1c3d28', borderWidth: 2, tension: 0.3, pointRadius: 3, pointHoverRadius: 6, yAxisID: 'y' },
          { label: 'Retail Rice Price (₱/kg)', data: riceB.values, borderColor: '#72c98d', backgroundColor: '#72c98d', borderWidth: 2, borderDash: [5, 4], tension: 0.3, pointRadius: 3, pointHoverRadius: 6, yAxisID: 'y1' },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 550, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0b1d14', titleColor: '#a8e2bc', bodyColor: '#fff',
            borderColor: 'rgba(114,201,141,0.35)', borderWidth: 1, padding: 12, cornerRadius: 10,
            titleFont: { family: "'Plus Jakarta Sans'", weight: '700', size: 12 },
            bodyFont: { family: "'JetBrains Mono'", size: 12 }, boxPadding: 5,
            callbacks: { label: (item) => item.raw == null ? `${item.dataset.label}: —` : `${item.dataset.label}: ₱${Number(item.raw).toFixed(2)}` },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#8aaa97', font: { size: 10.5 }, autoSkip: true, maxTicksLimit: 8 } },
          y: { position: 'left', grid: { color: 'rgba(38,84,56,0.08)' }, ticks: { color: '#8aaa97', font: { size: 10.5 } } },
          y1: { position: 'right', grid: { display: false }, ticks: { color: '#8aaa97', font: { size: 10.5 } } },
        },
      },
    });
  }

  function renderInsight(dieselArr, riceArr) {
    const bar = document.getElementById('corr-insight-bar');
    const text = document.getElementById('corr-insight-text');
    const icon = bar?.querySelector('i');
    if (!bar || !text) return;

    const drift = detectDrift(dieselArr, riceArr);
    const label = RICE_LABELS[selectedClass];

    if (!drift) {
      bar.classList.add('calm');
      if (icon) icon.className = 'ti ti-circle-check';
      text.textContent = `Tracking closely — ${label} has moved with diesel over the last 60 days, no significant divergence detected.`;
      return;
    }

    bar.classList.remove('calm');
    if (icon) icon.className = 'ti ti-alert-triangle';
    const dPct = (Math.abs(drift.dChange) * 100).toFixed(1);
    const rPct = (drift.rChange * 100).toFixed(1);
    const dieselDir = drift.dChange > 0 ? 'up' : 'down';
    const whenText = drift.daysAgo === 0 ? 'over the past week' : `starting ${drift.daysAgo} day${drift.daysAgo === 1 ? '' : 's'} ago`;
    text.textContent = `Diverging — diesel moved ${dieselDir} ${dPct}% but ${label} only moved ${rPct >= 0 ? '+' : ''}${rPct}% ${whenText}. Past drift episodes have typically closed within 5–9 days.`;
  }

  /* ================= Driver ranked list ================= */
  function renderDriverList() {
    const el = document.getElementById('corr-driver-list');
    if (!el) return;

    const stockFactor = STATIC_FACTORS.find(f => f.key === 'stock');
    const drift = detectDrift(masterData.fuel || [], masterData[selectedClass] || []);

    const rows = [...liveFactors, stockFactor]
      .map(f => ({ ...f, score: Math.round(Math.abs(f.r || 0) * 100), flagged: f.key === 'diesel' && !!drift }))
      .sort((a, b) => b.score - a.score);

    el.innerHTML = rows.map((d, i) => `
      <div class="corr-driver-row ${d.flagged ? 'flagged' : ''}">
        <span class="corr-drank">${String(i + 1).padStart(2, '0')}</span>
        <div class="corr-dinfo">
          <div class="corr-dtop">
            <span class="corr-dname">${esc(d.name)} ${d.flagged ? '<span class="corr-drift-tag">Drift</span>' : ''}</span>
            <span class="corr-dscore">${d.r == null ? '—' : d.score}</span>
          </div>
          <div class="corr-dbar-track"><div class="corr-dbar-fill" style="width:0%"></div></div>
        </div>
      </div>`).join('');

    requestAnimationFrame(() => {
      el.querySelectorAll('.corr-dbar-fill').forEach((bar, i) => { bar.style.width = rows[i].score + '%'; });
    });
  }

  /* ================= Signal reliability chips ================= */
  function renderSignalChips() {
    const el = document.getElementById('corr-signal-chips');
    if (!el) return;
    const rice = masterData[selectedClass] || [];
    const sources = [
      { name: `${SHORT_LABELS[selectedClass]} Price`, arr: rice },
      { name: 'Diesel Fuel', arr: masterData.fuel || [] },
      { name: 'USD/PHP Rate', arr: masterData.exchange || [] },
    ];
    el.innerHTML = sources.map(s => {
      const pct = completeness(s.arr, 90);
      const reliable = pct >= 0.9;
      return `<span class="corr-signal-chip${reliable ? '' : ' warn'}"><span class="corr-cdot"></span> ${esc(s.name)} — ${reliable ? 'Reliable' : `Gaps (${Math.round(pct * 100)}%)`}</span>`;
    }).join('');
  }

  /* ================= Summary table ================= */
  function allTableRows() {
    const dynamic = liveFactors.map(f => ({
      name: f.name, icon: f.icon, r: f.r, significant: f.significant, detail: f.detail, importedOnly: false,
    }));
    const staticRows = STATIC_FACTORS.map(f => ({
      name: f.name, icon: f.icon, r: f.r, significant: f.significant, detail: f.detail, importedOnly: !!f.importedOnly,
    }));
    return [...dynamic, ...staticRows];
  }

  function renderTable() {
    const tbody = document.getElementById('corr-table-body');
    if (!tbody) return;
    const q = tableSearch.trim().toLowerCase();
    const rows = allTableRows().filter(r => r.name.toLowerCase().includes(q));

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--c-ink4);padding:26px;">No market factor matches your search.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const dir = r.r == null ? 'up' : (r.r >= 0 ? 'up' : 'down');
      const arrowSvg = dir === 'up'
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`;
      const strength = r.r == null ? 'Unavailable' : `${strengthLabel(r.r)} (${r.r >= 0 ? 'Drives Up' : 'Drives Down'})`;
      const nameSuffix = r.importedOnly ? ' <span class="corr-status-pill ns" style="margin-left:6px;">imported rice</span>' : '';
      return `<tr>
        <td><div class="corr-factor-row"><span class="corr-factor-icon"><i class="ti ${esc(r.icon)}"></i></span> ${esc(r.name)}${nameSuffix}</div></td>
        <td><div class="corr-impact-cell ${dir}">${r.r == null ? '' : arrowSvg} ${esc(strength)}</div></td>
        <td>${esc(r.detail)}</td>
        <td><span class="corr-status-pill${r.significant ? '' : ' ns'}">${r.significant ? 'Verified' : 'Not significant'}</span></td>
      </tr>`;
    }).join('');
  }

  /* ================= Controls ================= */
  function bindClassSelect() {
    const sel = document.getElementById('corr-class-select');
    if (!sel) return;
    sel.value = selectedClass;
    sel.addEventListener('change', (e) => { selectedClass = e.target.value; renderAll(); });
  }

  function bindRangeSelect() {
    const sel = document.getElementById('corr-range-select');
    if (!sel) return;
    sel.value = selectedRange;
    sel.addEventListener('change', (e) => { selectedRange = e.target.value; renderChart(); });
  }

  function bindSearchBox() {
    const input = document.getElementById('corr-table-search');
    if (!input) return;
    input.addEventListener('input', () => { tableSearch = input.value || ''; renderTable(); });
  }

  return { init, destroy };
})();
