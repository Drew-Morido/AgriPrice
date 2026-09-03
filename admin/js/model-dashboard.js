/* ============================================
   AgriPricePH - Model Dashboard
   ============================================
   Merges the old "LSTM Model" (architecture/hyperparameters) and "Performance Metrics"
   (MAE/RMSE/baseline/ADF, per-type table) pages into one, ported from the provided mockup —
   same markup/class language (admin/css/model-dashboard.css), same Chart.js-based charts and
   click-to-pin interaction, real Chart.js (already loaded globally in admin/index.html).

   Real numbers come straight from /api/model-status (model/meta.json) — the same source the
   old Metrics module used. Two things stay honestly labeled as simulated rather than real,
   because the backend doesn't persist them: the "Predicted" line on the forecast chart (no
   day-by-day prediction log exists) and the Error Distribution histogram (no per-day residual
   log exists) — both are modeled from each classification's known MAE/RMSE instead of invented
   from nothing. Per CLAUDE.md, this app must never claim the model "beats the baseline" when it
   doesn't — see fillMetricCards()/renderErrInsight() for the honest framing.
   ============================================ */

window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.ModelDashboard = (function () {
  const RICE_LABELS = {
    locSpecial: 'Local Special', locPremium: 'Local Premium',
    locWellMilled: 'Local Well-Milled', locRegular: 'Local Regular',
    impSpecial: 'Imported Special', impPremium: 'Imported Premium',
    impWellMilled: 'Imported Well-Milled', impRegular: 'Imported Regular',
  };
  const CLASS_KEYS = Object.keys(RICE_LABELS);
  const STATUS_TOLERANCE = 1.10; // MAE within 10% of the naive baseline counts as "optimal"

  let masterData = { labels: [] };
  let meta = {};
  let modelReady = false;
  let selectedClass = 'locWellMilled';
  let selectedRange = 30;
  let tableSort = { key: null, dir: 1 };
  let tableFilter = 'all';
  let tableSearch = '';
  let forecastChart = null, errorChart = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
  const peso = (v) => (v == null || isNaN(v)) ? '—' : `₱${Number(v).toFixed(2)}`;

  function targetFor(key) { return (meta.targets && meta.targets[key]) || null; }

  // MAE within STATUS_TOLERANCE of the naive baseline is "optimal" (tracking as expected at
  // this near-random-walk horizon); notably behind it flags the classification for retraining.
  function computeStatus(t) {
    if (!t || t.mae_peso == null || !t.baseline_mae_peso) return 'optimal';
    return (t.mae_peso / t.baseline_mae_peso) <= STATUS_TOLERANCE ? 'optimal' : 'review';
  }

  /* ================= Init ================= */
  async function init() {
    tableSort = { key: null, dir: 1 };
    tableFilter = 'all';
    tableSearch = '';

    bindClassSelect();
    bindRangeSeg();
    bindStatusSeg();
    bindSearchBox();
    bindTableSort();

    const [statusRes] = await Promise.all([
      AgriPricePH.API.modelStatus().catch(() => null),
      fetchHistorical(),
    ]);

    if (statusRes) {
      meta = statusRes.meta || {};
      modelReady = !!statusRes.ready;
    }

    renderHealthChip();
    fillMetricCards();
    renderClassTable();
    renderAllCharts();
  }

  function destroy() {
    if (forecastChart) { forecastChart.destroy(); forecastChart = null; }
    if (errorChart) { errorChart.destroy(); errorChart = null; }
  }

  async function fetchHistorical() {
    try {
      const res = await AgriPricePH.API.historical();
      if (res.error) throw new Error(res.error);
      masterData.labels = res.labels || [];
      CLASS_KEYS.forEach(key => { masterData[key] = res.historical?.[key] || []; });
    } catch {
      // Offline / unreachable — charts below just render empty; cards/table still show
      // whatever /api/model-status returned.
    }
  }

  /* ================= Health chip ================= */
  function renderHealthChip() {
    const chip = document.getElementById('mdl-health-chip');
    const text = document.getElementById('mdl-health-text');
    const pop = document.getElementById('mdl-health-pop');
    if (!chip || !text || !pop) return;

    if (modelReady) {
      chip.classList.remove('stale');
      text.textContent = 'Model healthy';
      pop.innerHTML = '<strong>Healthy</strong> means a trained model is loaded and serving live 3-day forecasts. It reflects readiness, not whether it beats the baseline — see the comparison below for the honest accuracy picture.';
    } else {
      chip.classList.add('stale');
      text.textContent = 'No trained model';
      pop.innerHTML = 'No trained model was found on disk. Run a training job from the <strong>Training</strong> page to generate one.';
    }
  }

  /* ================= Top metric cards ================= */
  function fillMetricCards() {
    const primaryKey = meta.target || 'locWellMilled';
    const primary = targetFor(primaryKey) || meta; // meta.json also duplicates the primary target's fields at top level

    const mae = primary.mae_peso;
    const rmse = primary.rmse_peso;
    const baseline = primary.baseline_mae_peso;
    const adf = primary.adf_pvalue;
    const rolling = primary.rolling_eval;

    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const setDelta = (id, text, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      el.className = 'mdl-metric-delta ' + cls;
    };

    set('mdl-mae', peso(mae));
    setDelta('mdl-mae-delta',
      rolling ? `±${peso(rolling.std)} across ${rolling.k} rolling test blocks` : 'No trained model yet',
      'flat');

    set('mdl-rmse', peso(rmse));
    const rmseRatio = (mae && rmse != null) ? rmse / mae : null;
    setDelta('mdl-rmse-delta',
      rmseRatio == null ? '—' : (rmseRatio < 1.9 ? 'Tracks MAE closely' : 'Some outlier days push RMSE up'),
      'flat');

    set('mdl-baseline', peso(baseline));
    const gapPct = (mae != null && baseline) ? ((mae - baseline) / baseline) * 100 : null;
    if (gapPct == null) {
      setDelta('mdl-baseline-delta', '—', 'flat');
    } else if (gapPct <= 0) {
      setDelta('mdl-baseline-delta', `Beats the naive baseline by ${Math.abs(gapPct).toFixed(1)}%`, 'good');
    } else {
      setDelta('mdl-baseline-delta', `Within ${gapPct.toFixed(1)}% of the naive baseline`, 'flat');
    }

    if (adf == null) {
      set('mdl-adf', 'n/a');
      setDelta('mdl-adf-delta', 'No trained model yet', 'flat');
    } else {
      set('mdl-adf', adf < 0.001 ? 'p < 0.001' : `p = ${Number(adf).toFixed(4)}`);
      setDelta('mdl-adf-delta',
        adf < 0.05 ? 'Stable series' : 'Near-random-walk — forecasts inherently uncertain',
        adf < 0.05 ? 'good' : 'flat');
    }
  }

  /* ================= Classification table ================= */
  function tableRows() {
    return CLASS_KEYS.map(key => {
      const t = targetFor(key);
      if (!t) return null;
      return {
        key, name: RICE_LABELS[key],
        err: t.mae_peso, bench: t.baseline_mae_peso, mape: t.mape_pct, acc: t.accuracy_pct,
        status: computeStatus(t),
      };
    }).filter(Boolean);
  }

  function renderClassTable() {
    const tbody = document.getElementById('mdl-class-tbody');
    if (!tbody) return;

    let rows = tableRows().filter(r => {
      const matchesStatus = tableFilter === 'all' || r.status === tableFilter;
      const matchesSearch = r.name.toLowerCase().includes(tableSearch.toLowerCase());
      return matchesStatus && matchesSearch;
    });

    if (tableSort.key) {
      rows = [...rows].sort((a, b) => {
        const av = a[tableSort.key], bv = b[tableSort.key];
        if (typeof av === 'string') return av.localeCompare(bv) * tableSort.dir;
        return ((av ?? 0) - (bv ?? 0)) * tableSort.dir;
      });
    }

    if (!rows.length) {
      const msg = tableRows().length ? 'No classifications match your search.' : 'No trained model yet — run Training first.';
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--mdl-ink4);padding:26px;">${esc(msg)}</td></tr>`;
    } else {
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td class="mdl-td-name">${esc(r.name)}</td>
          <td class="mdl-td-num">${r.err != null ? r.err.toFixed(2) : '—'}</td>
          <td class="mdl-td-num">${r.bench != null ? r.bench.toFixed(2) : '—'}</td>
          <td class="mdl-td-num">${r.mape != null ? r.mape.toFixed(1) + '%' : '—'}</td>
          <td class="mdl-td-num">${r.acc != null ? r.acc.toFixed(1) + '%' : '—'}</td>
          <td><span class="mdl-status-pill${r.status === 'review' ? ' mdl-status-warning' : ''}">${r.status === 'optimal' ? 'Optimal' : 'Needs review'}</span></td>
        </tr>`).join('');
    }

    document.querySelectorAll('#page-outlet .mdl-view th[data-key]').forEach(th => {
      th.classList.toggle('sorted', th.dataset.key === tableSort.key);
    });
  }

  function bindTableSort() {
    document.querySelectorAll('#page-outlet .mdl-view th[data-key]').forEach(th => {
      th.addEventListener('click', (e) => {
        if (e.target.closest('.mdl-tooltip-text')) return; // don't sort when clicking inside a tooltip
        const key = th.dataset.key;
        tableSort.dir = tableSort.key === key ? -tableSort.dir : 1;
        tableSort.key = key;
        renderClassTable();
      });
    });
  }

  function bindStatusSeg() {
    document.querySelectorAll('#mdl-status-seg button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#mdl-status-seg button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        tableFilter = btn.getAttribute('data-filter');
        renderClassTable();
      });
    });
  }

  function bindSearchBox() {
    const input = document.getElementById('mdl-table-search');
    if (!input) return;
    input.addEventListener('input', () => { tableSearch = input.value || ''; renderClassTable(); });
  }

  /* ================= Charts (real Chart.js, matching the mockup) ================= */
  function renderAllCharts() {
    renderForecastChart();
    renderErrorChart();
    renderErrStats();
    renderErrInsight();
  }

  // Deterministic pseudo-forecast: actual price plus a smooth ripple scaled to this
  // classification's known MAE. Not a literal logged prediction (see the on-page note) —
  // just enough to visualize what "roughly MAE-sized" forecast noise looks like.
  function simulatePredicted(actual, key) {
    const t = targetFor(key);
    const mae = (t && t.mae_peso) || 0.3;
    const phase = key.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 10;
    return actual.map((v, i) => v == null ? null : +(v + Math.sin(i * 0.9 + phase) * mae * 1.3).toFixed(2));
  }

  function renderForecastChart() {
    const canvasEl = document.getElementById('mdl-forecast-chart');
    if (!canvasEl || typeof Chart === 'undefined') return;

    const fullArr = masterData[selectedClass] || [];
    const fullLabels = masterData.labels || [];
    const sliceStart = -Math.min(selectedRange, fullArr.length || selectedRange);
    const actual = fullArr.slice(sliceStart);
    const labels = fullLabels.slice(sliceStart);
    const predicted = simulatePredicted(actual, selectedClass);

    const sub = document.getElementById('mdl-chart-sub');
    if (sub) sub.textContent = `${RICE_LABELS[selectedClass]} · last ${selectedRange} days`;

    if (!actual.length) {
      if (forecastChart) { forecastChart.destroy(); forecastChart = null; }
      resetForecastSummary();
      return;
    }

    // Update the existing chart in place (rather than destroy + recreate) so switching the
    // date range or classification animates smoothly between the old and new series instead
    // of snapping straight to the new data.
    if (forecastChart) {
      forecastChart.data.labels = labels;
      forecastChart.data.datasets[0].data = actual;
      forecastChart.data.datasets[1].data = predicted;
      forecastChart.update();
      resetForecastSummary();
      return;
    }

    const ctx = canvasEl.getContext('2d');
    forecastChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Actual Price (₱)', data: actual, borderColor: '#1c3d28', backgroundColor: '#1c3d28', borderWidth: 2, tension: 0.3, spanGaps: false, pointRadius: 3, pointHoverRadius: 6, pointHitRadius: 12 },
          { label: 'Simulated Forecast (₱)', data: predicted, borderColor: '#72c98d', backgroundColor: '#72c98d', borderDash: [5, 5], borderWidth: 2, tension: 0.3, pointRadius: 3, pointHoverRadius: 6, pointHitRadius: 12 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 650, easing: 'easeOutQuart' },
        onClick: (evt, elements, chart) => {
          const points = chart.getElementsAtEventForMode(evt, 'index', { intersect: false }, true);
          // Read the chart's *current* data at click time (not the closured arrays from
          // creation) — renderForecastChart() mutates chart.data in place on later updates.
          if (points.length) showChartSummary(points[0].index, chart.data.labels, chart.data.datasets[0].data, chart.data.datasets[1].data);
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { family: "'Plus Jakarta Sans'", size: 11.5 }, color: '#527060' } },
          tooltip: {
            backgroundColor: '#0b1d14', titleColor: '#a8e2bc', bodyColor: '#fff',
            borderColor: 'rgba(114,201,141,0.35)', borderWidth: 1, padding: 12, cornerRadius: 10,
            titleFont: { family: "'Plus Jakarta Sans'", weight: '700', size: 12 },
            bodyFont: { family: "'JetBrains Mono'", size: 12 }, boxPadding: 5,
            callbacks: {
              label: (item) => item.raw == null ? `${item.dataset.label}: not yet recorded` : `${item.dataset.label}: ${peso(item.raw)}`,
              afterBody: (items) => {
                if (items.length < 2) return '';
                const a = items.find(i => i.dataset.label.startsWith('Actual'));
                const p = items.find(i => i.dataset.label.startsWith('Simulated'));
                if (!a || !p || a.raw == null || p.raw == null) return '';
                const diff = p.raw - a.raw;
                return `Diff: ${diff >= 0 ? '+' : ''}${peso(diff)}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#8aaa97', font: { size: 10.5 }, autoSkip: true, maxTicksLimit: 10 } },
          y: { grid: { color: 'rgba(38,84,56,0.08)' }, ticks: { color: '#8aaa97', font: { size: 10.5 } } },
        },
      },
    });

    resetForecastSummary();
  }

  function resetForecastSummary() {
    const el = document.getElementById('mdl-chart-summary');
    if (!el) return;
    el.className = 'mdl-chart-click-summary';
    el.innerHTML = `<i class="ti ti-hand-click"></i> Hover a point for a quick look, or click it to pin the summary here.`;
  }

  function showChartSummary(index, labels, actual, predicted) {
    const el = document.getElementById('mdl-chart-summary');
    if (!el) return;
    const a = actual[index], p = predicted[index];
    el.className = 'mdl-chart-click-summary pinned';

    let diffHtml = `<div class="mdl-ccs-item"><span class="mdl-ccs-lbl">Difference</span><span class="mdl-ccs-val">—</span></div>`;
    if (a != null && p != null) {
      const diff = p - a;
      diffHtml = `<div class="mdl-ccs-item"><span class="mdl-ccs-lbl">Difference</span><span class="mdl-ccs-val ${diff <= 0 ? 'good' : 'bad'}">${diff >= 0 ? '+' : ''}${peso(diff)}</span></div>`;
    }

    el.innerHTML = `
      <div class="mdl-ccs-item"><span class="mdl-ccs-lbl">${esc(labels[index])} · ${esc(RICE_LABELS[selectedClass])}</span><span class="mdl-ccs-val" style="color:var(--mdl-ink4);font-weight:600;font-size:11px;">Pinned from chart</span></div>
      <div class="mdl-ccs-item"><span class="mdl-ccs-lbl">Actual</span><span class="mdl-ccs-val">${a != null ? peso(a) : 'Not yet recorded'}</span></div>
      <div class="mdl-ccs-item"><span class="mdl-ccs-lbl">Simulated forecast</span><span class="mdl-ccs-val">${peso(p)}</span></div>
      ${diffHtml}`;
  }

  function renderErrorChart() {
    const canvasEl = document.getElementById('mdl-error-chart');
    if (!canvasEl || typeof Chart === 'undefined') return;
    const t = targetFor(selectedClass);

    if (errorChart) { errorChart.destroy(); errorChart = null; }
    if (!t) return;

    const rmse = t.rmse_peso || 0.4;
    const testDays = t.test_samples || 600;
    const step = rmse / 1.5;
    const centers = [-3, -2, -1, 0, 1, 2, 3].map(m => m * step);
    // Rough gaussian-shaped weights (sums to 1) — an estimate, not a measured residual log.
    const weights = [0.03, 0.09, 0.23, 0.30, 0.23, 0.09, 0.03];
    const counts = weights.map(w => Math.max(1, Math.round(w * testDays)));
    const labels = centers.map(c => (c >= 0 ? '+' : '') + peso(c));
    const colors = counts.map((_, i) => (i <= 1 || i >= 5) ? '#F59E0B' : '#4CAF6E');

    const ctx = canvasEl.getContext('2d');
    errorChart = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Est. days at this error', data: counts, backgroundColor: colors, borderRadius: 6 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0b1d14', titleColor: '#a8e2bc', bodyColor: '#fff', padding: 10, cornerRadius: 8,
            callbacks: { label: (item) => `${item.raw} day${item.raw === 1 ? '' : 's'} (est.) at this error` },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#8aaa97', font: { size: 10.5 } } },
          y: { beginAtZero: true, grid: { color: 'rgba(38,84,56,0.08)' }, ticks: { color: '#8aaa97', font: { size: 10.5 } } },
        },
      },
    });
  }

  // Standard normal CDF via the Abramowitz-Stegun erf approximation — used only to turn a
  // known RMSE into an "estimated % of days within ±₱0.50" figure for the stat cell below.
  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }

  function renderErrStats() {
    const el = document.getElementById('mdl-err-stats');
    if (!el) return;
    const t = targetFor(selectedClass);
    if (!t) { el.innerHTML = ''; return; }

    const mae = t.mae_peso, rmse = t.rmse_peso || (mae ? mae * 1.6 : 0.4);
    const withinPct = rmse ? Math.round(erf(0.5 / (rmse * Math.SQRT2)) * 100) : null;

    const statLbl = (text, tip) => `<div class="mdl-err-stat-lbl mdl-tooltip" tabindex="0">${esc(text)}<i class="ti ti-info-circle mdl-tooltip-icon"></i><span class="mdl-tooltip-text" style="text-transform:none;font-weight:400;letter-spacing:normal;">${tip}</span></div>`;

    el.innerHTML = `
      <div class="mdl-err-stat">${statLbl('Avg Error (MAE)', 'The mean absolute forecast error for this classification, in pesos per kg.')}<div class="mdl-err-stat-val">${peso(mae)}</div></div>
      <div class="mdl-err-stat">${statLbl('Error Spread (RMSE)', 'Root-mean-squared error — penalizes large outlier misses more heavily than MAE.')}<div class="mdl-err-stat-val">${peso(rmse)}</div></div>
      <div class="mdl-err-stat">${statLbl('Est. within ±₱0.50', 'Estimated share of days the forecast would land within 50 centavos of the actual price, based on a normal-distribution approximation using this classification\'s RMSE.')}<div class="mdl-err-stat-val">${withinPct == null ? '—' : withinPct + '%'}</div></div>`;
  }

  function renderErrInsight() {
    const el = document.getElementById('mdl-err-insight');
    if (!el) return;
    const t = targetFor(selectedClass);
    if (!t) {
      el.className = 'mdl-err-insight';
      el.innerHTML = `<i class="ti ti-alert-triangle"></i> <span>No trained model yet for ${esc(RICE_LABELS[selectedClass])} — run Training first.</span>`;
      return;
    }

    const status = computeStatus(t);
    const gapPct = t.baseline_mae_peso ? Math.abs(((t.mae_peso - t.baseline_mae_peso) / t.baseline_mae_peso) * 100) : 0;
    const isHealthy = status === 'optimal';
    el.className = 'mdl-err-insight' + (isHealthy ? ' positive' : '');

    if (isHealthy) {
      el.innerHTML = `<i class="ti ti-circle-check"></i> <span><strong>On track</strong> — ${esc(RICE_LABELS[selectedClass])} MAE (${peso(t.mae_peso)}) is within ${gapPct.toFixed(1)}% of the ${peso(t.baseline_mae_peso)} naive baseline, inside the normal tolerance band for this near-random-walk horizon.</span>`;
    } else {
      el.innerHTML = `<i class="ti ti-alert-triangle"></i> <span><strong>Review suggested</strong> — ${esc(RICE_LABELS[selectedClass])} MAE (${peso(t.mae_peso)}) is ${gapPct.toFixed(1)}% behind the ${peso(t.baseline_mae_peso)} naive baseline. Consider retraining this classification in the Training console.</span>`;
    }
  }

  /* ================= Controls ================= */
  function bindClassSelect() {
    const sel = document.getElementById('mdl-class-select');
    if (!sel) return;
    sel.value = selectedClass;
    sel.addEventListener('change', (e) => {
      selectedClass = e.target.value;
      renderAllCharts();
    });
  }

  function bindRangeSeg() {
    document.querySelectorAll('#mdl-range-seg button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#mdl-range-seg button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedRange = parseInt(btn.getAttribute('data-range'), 10) || 30;
        renderForecastChart();
      });
    });
  }

  return { init, destroy };
})();
