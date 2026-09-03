/* ============================================
   AgriPricePH - All Module Logic
   ============================================ */

window.AgriPricePH = window.AgriPricePH || {};

/* Predictions module → js/predictions.js */

/* LSTM Model + Performance Metrics modules → merged into js/model-dashboard.js ("Model Dashboard") */

/* Correlation Analysis ("Market Drivers") module → js/correlation.js */


/* Reports module → js/reports.js */


/* Alerts module → js/alerts.js */


/* Settings module → js/settings.js */


/* ════════════════════════════════════════════
   SYSTEM LOGS MODULE
   ════════════════════════════════════════════ */

AgriPricePH.SystemLogs = (function () {
  // Real system activity from the backend in-memory buffer (GET /api/logs). In-memory only, so it
  // resets when the server restarts. No mock data.
  let _logs = [];
  let _filter = 'ALL';
  let _text = '';
  let _loading = false;
  let _error = '';
  let _timer = null;

  const EMPTY_STYLE = 'padding:22px 14px;text-align:center;color:var(--text-muted,#8aa0a8);font-size:13px;';

  function adminToken() {
    try { return JSON.parse(sessionStorage.getItem('agriprice_admin_session') || 'null')?.token || ''; }
    catch { return ''; }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Buffer levels are INFO/WARN/ERROR; the UI uses WARNING. Map for display + filtering.
  function dispLevel(l) {
    const v = String(l || '').toUpperCase();
    return v === 'WARN' ? 'WARNING' : v;
  }

  function render() {
    const body = document.getElementById('log-viewer-body');
    if (!body) return;
    if (_loading && !_logs.length) { body.innerHTML = `<div style="${EMPTY_STYLE}">Loading logs…</div>`; return; }
    if (_error) { body.innerHTML = `<div style="${EMPTY_STYLE}">${esc(_error)}</div>`; return; }

    const q = _text.toLowerCase();
    const cls = { INFO: 'le-level-INFO', WARNING: 'le-level-WARNING', ERROR: 'le-level-ERROR', SUCCESS: 'le-level-SUCCESS' };
    const rows = _logs.filter(l => {
      const lv = dispLevel(l.level);
      if (_filter !== 'ALL' && lv !== _filter) return false;
      if (q && !(`${l.msg || ''} ${l.source || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
    if (!rows.length) {
      const msg = _logs.length ? 'No logs match the current filter.' : 'No system activity recorded yet.';
      body.innerHTML = `<div style="${EMPTY_STYLE}">${msg}</div>`;
      return;
    }
    body.innerHTML = rows.map(l => {
      const lv = dispLevel(l.level);
      return `
        <div class="log-entry">
          <span class="le-time">${esc(l.time)}</span>
          <span class="le-source">[${esc(l.source || 'SYSTEM')}]</span>
          <span class="${cls[lv] || 'le-level-INFO'}">${lv}</span>
          <span class="le-msg">${esc(l.msg)}</span>
        </div>`;
    }).join('');
  }

  async function load() {
    _loading = true; _error = ''; render();
    try {
      const d = await AgriPricePH.API.systemLogs({}, adminToken());
      if (d && d.ready) { _logs = d.logs || []; _error = ''; }
      else { _error = 'Couldn’t load logs — admin session required, or the backend returned an error.'; }
    } catch {
      _error = 'Couldn’t load logs — backend unreachable.';
    }
    _loading = false; render();
  }

  function exportLogs() {
    const blob = new Blob([JSON.stringify(_logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `system-logs-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  async function clearLogs() {
    if (!confirm('Clear all system logs? This cannot be undone.')) return;
    try {
      const res = await AgriPricePH.API.clearSystemLogs(adminToken());
      if (res.ok) { _logs = []; render(); }
      else { alert(res.status === 401 ? 'Admin session required — please re-login.' : 'Could not clear logs.'); }
    } catch { alert('Backend unreachable.'); }
  }

  function init() {
    _filter = 'ALL'; _text = '';
    // Scoped to #page-outlet — router injects pages here, no per-page IDs
    document.querySelectorAll('#page-outlet .log-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#page-outlet .log-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _filter = btn.dataset.filter || 'ALL';
        render();
      });
    });
    const search = document.getElementById('log-search');
    if (search) search.addEventListener('input', () => { _text = search.value || ''; render(); });
    document.getElementById('log-export-btn')?.addEventListener('click', exportLogs);
    document.getElementById('log-clear-btn')?.addEventListener('click', clearLogs);

    load();
    // Light auto-refresh; self-cancels once the page is navigated away (element gone).
    clearInterval(_timer);
    _timer = setInterval(() => {
      if (!document.getElementById('log-viewer-body')) { clearInterval(_timer); _timer = null; return; }
      load();
    }, 10000);
  }

  function destroy() {
    clearInterval(_timer); _timer = null;
  }

  return { init, destroy };
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