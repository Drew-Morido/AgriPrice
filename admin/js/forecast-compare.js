/* AgriPricePH — Forecast vs Actual (admin). The two forecast lines usually overlap (they differ by about a
   centavo), so "without" is drawn as a wide translucent orange band under the dashed purple line, and the Show
   selector can display either forecast alone.

   Ma'am Shein asked for a page where the panel can watch the system's forecasts against the real prices, with and
   without the factors. Each point is a day-1 forecast made the day before from data available that day
   (model/forecast_compare.py, GET /api/forecast-compare). "Play" replays the window day by day: the forecasts for a
   day appear first, then that day's real DA price, and the running error updates. */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.ForecastCompare = (function () {
  const NAMES = {
    locWellMilled: 'Local Well-Milled', locRegular: 'Local Regular Milled', locPremium: 'Local Premium',
    locSpecial: 'Local Special', impWellMilled: 'Imported Well-Milled', impRegular: 'Imported Regular Milled',
    impPremium: 'Imported Premium', impSpecial: 'Imported Special',
  };
  const ORDER = Object.keys(NAMES);
  const COLORS = { actual: '#2D8A50', with: '#8B5CF6', without: '#F59E0B', naive: '#94A3B8' };
  // The window the team agreed for the AVP (20 days). The network was fitted on data through Mar 2025, so none
  // of these days was used to fit it; the page opens on this window and the dates can be changed.
  const AVP_WINDOW = { start: '2026-10-07', end: '2026-10-26' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let mounted = false;
  let data = null;              // last /api/forecast-compare answer
  let chart = null;
  let timers = [];
  let playing = false;
  let shown = -1;               // index of the last day revealed during a replay; -1 = everything shown
  let pollTimer = null;

  const $ = (id) => document.getElementById(id);
  const peso = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `₱${Number(v).toFixed(2)}`);
  const short = (iso) => { const d = new Date(iso + 'T00:00:00'); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
  const long = (iso) => { const d = new Date(iso + 'T00:00:00'); return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const type = () => ($('fc-type') || {}).value || 'locWellMilled';

  async function fetchCompare(start, end) {
    const q = new URLSearchParams();
    if (start) q.set('start', start);
    if (end) q.set('end', end);
    const base = (AgriPricePH.API && AgriPricePH.API.BASE) || '';
    const res = await fetch(`${base}/api/forecast-compare${q.toString() ? '?' + q : ''}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    return body;
  }

  function setStatus(text) { const el = $('fc-status'); if (el) el.textContent = text; }

  async function load(first) {
    clearTimeout(pollTimer);
    try {
      let start = $('fc-start').value || null;
      let end = $('fc-end').value || null;
      let res = await fetchCompare(start, end);
      if (!mounted) return;
      if (!res.ready) {
        setStatus(res.error ? `Could not build: ${res.error}` : 'Preparing the comparison… about a minute');
        if (!res.error || res.building) pollTimer = setTimeout(() => mounted && load(first), 5000);
        return;
      }
      if (first && !end && res.start) {
        // Default window: the first 20 days after the model's training data ends.
        start = AVP_WINDOW.start;
        end = res.end && AVP_WINDOW.end > res.end ? res.end : AVP_WINDOW.end;
        $('fc-start').value = start;
        $('fc-end').value = end;
        res = await fetchCompare(start, end);
        if (!mounted) return;
      }
      data = res;
      setStatus(res.building ? 'Updating with the newest data…' : `Updated ${new Date(res.built_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
      if (res.building) pollTimer = setTimeout(() => mounted && load(false), 8000);
      stop();
      renderAll();
    } catch (e) {
      setStatus('Cannot reach the backend');
    }
  }

  function days() { return (data && data.types && data.types[type()] && data.types[type()].days) || []; }
  function summary() { return (data && data.types && data.types[type()] && data.types[type()].summary) || {}; }

  function renderAll() {
    const t = type();
    $('fc-chart-title').textContent = `${NAMES[t]} · retail price (₱/kg)`;
    const fit = data.model_fit_end;
    $('fc-subtitle').textContent = data.start
      ? `${long(data.start)} – ${long(data.end)} · ${data.n_days} days · each forecast made the day before`
        + (fit ? ` · the model was fitted on data through ${long(fit)}, so none of these days was used to fit it` : '')
      : 'No days in this window';
    renderStats();
    renderChart(-1);
    renderTable(-1);
    renderAllTypes();
  }

  function stat(color, title, s, extra) {
    if (!s) return '';
    return `
      <div class="fc-stat">
        <div class="fc-stat-head"><span class="fc-swatch" style="background:${color}"></span>${title}</div>
        <div class="fc-stat-val">${peso(s.mae)} <small>average error</small></div>
        <div class="fc-stat-sub">Within ₱0.50 on ${s.within_050_pct}% of days · within ₱1.00 on ${s.within_100_pct}%${extra || ''}</div>
      </div>`;
  }

  function skillText(v) {
    if (v == null) return '';
    return v >= 0 ? ` · ${v}% lower error than "tomorrow = today"` : ` · ${Math.abs(v)}% higher error than "tomorrow = today"`;
  }

  function renderStats() {
    const s = summary();
    $('fc-stats').innerHTML = !s.with_factors ? '' :
      stat(COLORS.with, 'Forecast with factors (published)', s.with_factors, skillText(s.with_factors.skill_vs_naive_pct))
      + stat(COLORS.without, 'Forecast without factors', s.without_factors, skillText(s.without_factors.skill_vs_naive_pct))
      + stat(COLORS.naive, 'Tomorrow = today', s.naive, ` · real price moved within a ₱${(s.actual_range || 0).toFixed(2)} range`);
  }

  function series(upto) {
    const ds = days();
    const take = (key, i) => (upto < 0 || i <= upto ? ds[i][key] : null);
    return {
      labels: ds.map((d) => short(d.date)),
      actual: ds.map((d, i) => (upto < 0 || i < upto || (i === upto && actualShown) ? d.actual : null)),
      with: ds.map((d, i) => take('with_factors', i)),
      without: ds.map((d, i) => take('without_factors', i)),
      naive: ds.map((d, i) => take('naive', i)),
    };
  }

  let actualShown = true;   // during a replay step, whether the current day's real price is visible yet

  function yRange() {
    const vals = days().flatMap((d) => [d.actual, d.with_factors, d.without_factors]);
    if (!vals.length) return {};
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max(0.15, (hi - lo) * 0.15);
    return { min: Math.floor((lo - pad) * 10) / 10, max: Math.ceil((hi + pad) * 10) / 10 };
  }

  function renderChart(upto) {
    const canvas = $('fc-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    const s = series(upto);
    const r = yRange();
    if (chart) {
      chart.data.labels = s.labels;
      chart.data.datasets[0].data = s.actual;
      chart.data.datasets[1].data = s.with;
      chart.data.datasets[2].data = s.without;
      chart.data.datasets[3].data = s.naive;
      applyView();
      chart.options.scales.y.min = r.min;
      chart.options.scales.y.max = r.max;
      chart.update(playing ? { duration: 250 } : undefined);
      return;
    }
    const tick = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#8aa596';
    chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: s.labels,
        datasets: [
          { label: 'Actual DA retail price', data: s.actual, borderColor: COLORS.actual, backgroundColor: COLORS.actual,
            borderWidth: 3, pointRadius: 3.5, tension: 0.2, spanGaps: false, order: 0 },
          { label: 'Forecast with factors', data: s.with, borderColor: COLORS.with, backgroundColor: COLORS.with,
            borderWidth: 2.5, borderDash: [7, 4], pointRadius: 3.5, tension: 0.2, order: 1 },
          { label: 'Forecast without factors', data: s.without, borderColor: 'rgba(245,158,11,0.55)', backgroundColor: COLORS.without,
            borderWidth: 8, pointRadius: 5, pointBorderWidth: 0, tension: 0.2, order: 2 },
          { label: 'Tomorrow = today', data: s.naive, borderColor: COLORS.naive, backgroundColor: COLORS.naive,
            borderWidth: 1.5, pointRadius: 0, tension: 0, stepped: 'before', hidden: true, order: 3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8, color: tick } },
          tooltip: { callbacks: { label: (c) => (c.raw == null ? null : `${c.dataset.label}: ${peso(c.raw)}`) } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
          y: { min: r.min, max: r.max, grid: { color: 'rgba(38,84,56,0.08)' }, ticks: { color: tick, callback: (v) => `₱${Number(v).toFixed(2)}` },
               title: { display: true, text: 'Retail price (₱ per kg)', color: tick } },
        },
      },
    });
    applyView();
  }

  // Show selector: both forecasts, or one of them alone (datasets 1 = with, 2 = without).
  function applyView() {
    if (!chart) return;
    const v = ($('fc-view') || {}).value || 'both';
    chart.setDatasetVisibility(1, v !== 'without');
    chart.setDatasetVisibility(2, v !== 'with');
  }

  function renderTable(upto) {
    const tb = $('fc-tbody');
    if (!tb) return;
    const cls = (e) => (e <= 0.5 ? 'fc-ok' : e > 1 ? 'fc-warn' : '');
    tb.innerHTML = days().map((d, i) => {
      const hidden = upto >= 0 && (i > upto || (i === upto && !actualShown));
      const ew = Math.abs(d.with_factors - d.actual), eo = Math.abs(d.without_factors - d.actual);
      return `<tr class="${hidden ? 'is-hidden' : ''}${i === upto ? ' is-current' : ''}">
        <td>${short(d.date)}</td><td><b>${peso(d.actual)}</b></td>
        <td>${peso(d.with_factors)}</td><td class="${cls(ew)}">${peso(ew)}</td>
        <td>${peso(d.without_factors)}</td><td class="${cls(eo)}">${peso(eo)}</td></tr>`;
    }).reverse().join('');
  }

  function renderAllTypes() {
    const tb = $('fc-alltypes');
    if (!tb || !data) return;
    tb.innerHTML = ORDER.map((t) => {
      const s = (data.types[t] || {}).summary || {};
      if (!s.with_factors) return '';
      return `<tr${t === type() ? ' class="is-current"' : ''}><td>${NAMES[t]}</td><td>${peso(s.with_factors.mae)}</td>
        <td>${peso(s.without_factors.mae)}</td><td>${peso(s.naive.mae)}</td></tr>`;
    }).join('');
    const a = data.all_types || {};
    if (a.with_factors) {
      tb.innerHTML += `<tr><td><b>All 8 types</b></td><td><b>${peso(a.with_factors.mae)}</b></td>
        <td><b>${peso(a.without_factors.mae)}</b></td><td><b>${peso(a.naive.mae)}</b></td></tr>`;
      const gap = a.mean_gap_with_vs_without;
      const same = Math.abs(a.with_factors.mae - a.without_factors.mae) < 0.01;
      $('fc-note').textContent = `Average error per kilo. Across all 8 rice types the forecast with factors was off by `
        + `${peso(a.with_factors.mae)} and the forecast without factors by ${peso(a.without_factors.mae)}, against `
        + `${peso(a.naive.mae)} for "tomorrow = today". The two forecasts differ by ${peso(gap)} on average`
        + (same ? ', so they are practically the same: for a next-day forecast the price\'s own recent movement carries the prediction, and the factors barely change it. The factors are tracked in Market Drivers, where they explain why prices move.'
          : '.');
    }
  }

  function readout(i) {
    const el = $('fc-readout');
    if (!el) return;
    const ds = days();
    if (i < 0 || !ds[i]) { el.innerHTML = ''; return; }
    const d = ds[i];
    const upto = ds.slice(0, i + 1);
    const avg = (k) => upto.reduce((s, x) => s + Math.abs(x[k] - x.actual), 0) / upto.length;
    el.innerHTML = `<b>${long(d.date)}</b> · actual <b>${peso(d.actual)}</b> · with factors ${peso(d.with_factors)} `
      + `(off ${peso(Math.abs(d.with_factors - d.actual))}) · without ${peso(d.without_factors)} `
      + `(off ${peso(Math.abs(d.without_factors - d.actual))}) · average error so far ${peso(avg('with_factors'))} / ${peso(avg('without_factors'))}`;
  }

  function stop() {
    timers.forEach(clearTimeout);
    timers = [];
    playing = false;
    const btn = $('fc-play');
    if (btn) btn.innerHTML = '<i class="ti ti-player-play"></i> <span>Play</span>';
  }

  function showAll() {
    stop();
    shown = -1;
    actualShown = true;
    renderChart(-1);
    renderTable(-1);
    readout(-1);
  }

  function play() {
    if (playing) { showAll(); return; }
    const ds = days();
    if (!ds.length) return;
    const step = Number(($('fc-speed') || {}).value) || 1200;
    playing = true;
    $('fc-play').innerHTML = '<i class="ti ti-player-stop"></i> <span>Stop</span>';
    ds.forEach((_, i) => {
      // Forecasts for day i first, then (half a step later) that day's real price.
      timers.push(setTimeout(() => { shown = i; actualShown = false; renderChart(i); renderTable(i); }, i * step));
      timers.push(setTimeout(() => { actualShown = true; renderChart(i); renderTable(i); readout(i); }, i * step + step / 2));
    });
    timers.push(setTimeout(() => { stop(); shown = -1; renderTable(-1); }, ds.length * step + 200));
  }

  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener('change', (e) => {
      if (!mounted) return;
      if (e.target.id === 'fc-type') { showAll(); renderAll(); }
      if (e.target.id === 'fc-start' || e.target.id === 'fc-end') load(false);
      if (e.target.id === 'fc-view' && chart) { applyView(); chart.update(); }
    });
    document.addEventListener('click', (e) => {
      if (!mounted) return;
      if (e.target.closest('#fc-play')) play();
      if (e.target.closest('#fc-reset')) showAll();
    });
  }

  function init() {
    mounted = true;
    chart = null;
    bind();
    load(true);
  }

  function destroy() {
    mounted = false;
    stop();
    clearTimeout(pollTimer);
    if (chart) { chart.destroy(); chart = null; }
  }

  return { init, destroy };
})();
