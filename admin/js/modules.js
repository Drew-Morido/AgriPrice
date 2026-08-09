/* ============================================
   AgriPricePH - All Module Logic
   ============================================ */

window.AgriPricePH = window.AgriPricePH || {};

/* Predictions module → js/predictions.js */


/* ════════════════════════════════════════════
   LSTM MODEL MODULE
   ════════════════════════════════════════════ */

AgriPricePH.LSTMModel = (function () {
  function init() {}
  return { init };
})();




/* ════════════════════════════════════════════
   METRICS MODULE
   ════════════════════════════════════════════ */

AgriPricePH.Metrics = (function () {

  function init() {
    const hist   = (AgriPricePH.Data.historical.locWellMilled || AgriPricePH.Data.historical.wellMilled || []).slice(-30);
    const pred   = hist.map(v => v + (Math.random() - 0.5) * 2.5);
    const labels = AgriPricePH.Data.historicalLabels.slice(-30);
    const pad    = { top: 20, right: 20, bottom: 36, left: 54 };

    const c1 = document.getElementById('pred-vs-actual-chart');
    if (c1) AgriPricePH.Charts.lineChart(c1, [
      { data: hist, color: '#4CAF6E', fill: false, lineWidth: 2 },
      { data: pred, color: '#F59E0B', fill: false, lineWidth: 2, dashed: true },
    ], { labels, padding: pad });

    const c2 = document.getElementById('error-dist-chart');
    if (c2) AgriPricePH.Charts.barChart(c2,
      ['<-3', '-3:-2', '-2:-1', '-1:0', '0:1', '1:2', '2:3', '>3'],
      [3, 7, 18, 32, 28, 20, 10, 4],
      [3, 7, 18, 32, 28, 20, 10, 4].map((_, i) => i < 3 || i > 4 ? '#EF4444' : '#4CAF6E')
    );
  }

  return { init };
})();


/* ════════════════════════════════════════════
   CORRELATION MODULE
   ════════════════════════════════════════════ */

AgriPricePH.Correlation = (function () {

  function init() {
    const canvas = document.getElementById('corr-heatmap');
    if (canvas) AgriPricePH.Charts.correlationHeatmap(canvas, AgriPricePH.Data.corrMatrix, AgriPricePH.Data.corrLabels);
  }

  return { init };
})();


/* Reports module → js/reports.js */


/* Alerts module → js/alerts.js */


/* Settings module → js/settings.js */


/* ════════════════════════════════════════════
   SYSTEM LOGS MODULE
   ════════════════════════════════════════════ */

AgriPricePH.SystemLogs = (function () {

  function init() {
    renderLogs('ALL');
    // Scoped to #page-outlet — router injects pages here, no per-page IDs
    document.querySelectorAll('#page-outlet .log-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#page-outlet .log-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderLogs(btn.dataset.filter);
      });
    });
  }

  function renderLogs(filter) {
    const body = document.getElementById('log-viewer-body');
    if (!body) return;
    const cls = { INFO: 'le-level-INFO', WARNING: 'le-level-WARNING', ERROR: 'le-level-ERROR', SUCCESS: 'le-level-SUCCESS' };
    body.innerHTML = AgriPricePH.Data.systemLogs
      .filter(l => filter === 'ALL' || l.level === filter)
      .map(l => `
        <div class="log-entry">
          <span class="le-time">${l.time}</span>
          <span class="le-source">[${l.source}]</span>
          <span class="${cls[l.level] || 'le-level-INFO'}">${l.level}</span>
          <span class="le-msg">${l.msg}</span>
        </div>
      `).join('');
  }

  return { init };
})();


/* ════════════════════════════════════════════
   SVG ICON HELPERS
   ════════════════════════════════════════════ */

function svgLeaf() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>`;
}
function svgFuel() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1z"/><path d="M13 22V9a1 1 0 0 0-1-1H5"/><path d="M13 8h1a3 3 0 0 1 3 3v2h1a2 2 0 0 1 2 2v7"/><path d="M5 8V3"/></svg>`;
}
function svgGlobe() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><path d="M2 12h20"/></svg>`;
}
function svgChart() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg>`;
}
function svgCloud() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/></svg>`;
}
function svgRefresh() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
}
function svgBell(color) {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color || 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
}