/* ============================================
   WEB SCRAPER MODULE JS  (AgriPricePH v3)
   ============================================
   FIX: Tinanggal ang SSE auto-reconnect loop
   na nagdudulot ng "fast reloading" effect
   kapag pinindot ang Run Now.

   Strategy:
   - POLLING lang ang ginagamit para sa logs
     at status (every 3s habang running,
     every 10s kapag idle)
   - SSE ay HINDI ginagamit — ito ang root
     cause ng reconnect loop
   ============================================ */

window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.WebScraper = (function () {

  const API        = AgriPricePH.API?.BASE || 'http://127.0.0.1:5000';
  const POLL_IDLE  = 10_000;  // 10s kapag hindi nag-sscrape
  const POLL_RUN   = 2_000;   // 2s kapag nag-sscrape (para real-time ang logs)

  function _adminToken() {
    try { return JSON.parse(sessionStorage.getItem('agriprice_admin_session') || 'null')?.token || ''; }
    catch { return ''; }
  }

  // ─── STATE ─────────────────────────────────────────────────────────────────
  let _mounted   = false;
  let _running   = false;   // TRUE kung nag-sscrape ang backend
  let _pollTimer = null;
  let _cdTimer   = null;

  let _logs      = [];      // [{ time, level, msg }] — nananatili sa memory
  let _logCount  = 0;       // ilang logs na ang nakuha natin — para incremental lang

  let _cachedStats = {};   // ← FIX: i-cache ang stats para agad ma-render sa _restoreUI
  let _nextRun   = null;
  let _backendOk = true;

  // ─── INIT ──────────────────────────────────────────────────────────────────
  function init() {
    if (_mounted) {
      _restoreUI();
      return;
    }
    _mounted = true;
    _restoreUI();
    _bindRunBtn();
    _poll();
  }

  // ─── DESTROY ───────────────────────────────────────────────────────────────
  function destroy() {
    clearTimeout(_pollTimer);
    clearInterval(_cdTimer);
    _mounted = false;
    // _logs, _cache, _running — HINDI nire-reset, para ma-restore kapag bumalik
  }

  // ─── RESTORE UI (fresh DOM o bumalik sa page) ──────────────────────────────
  function _restoreUI() {
    // Logs
    const logEl = document.getElementById('scraper-log');
    if (logEl) {
      logEl.innerHTML = '';
      if (_logs.length === 0) {
        _writeLine(logEl, '--:--:--', 'INFO', 'Connecting to scraper backend...');
      } else {
        _logs.forEach(l => _writeLine(logEl, l.time, l.level, l.msg));
        logEl.scrollTop = logEl.scrollHeight;
      }
    }

    // Button
    _syncBtn();

    // Stats — i-render agad mula sa cache, hindi na hihintayin ang fetch
    _renderStats(_cachedStats);

    // Countdown + per-source schedule rows
    if (_nextRun) _startCountdown();
    else _updateSchedule();
    _updateSchedulePills();
  }

  // ─── POLLING LOOP ──────────────────────────────────────────────────────────
  // Walang SSE — polling lang. Kapag nag-sscrape, mas mabilis ang poll (2s)
  // para makita agad ang bagong logs. Kapag idle, 10s lang.
  function _poll() {
    clearTimeout(_pollTimer);
    _fetchStatus().finally(() => {
      if (!_mounted) return;
      const interval = _running ? POLL_RUN : POLL_IDLE;
      _pollTimer = setTimeout(_poll, interval);
    });
  }

  async function _fetchStatus() {
    try {
      const res = await fetch(`${API}/api/scrape-status`);
      if (!res.ok) return;
      const data = await res.json();

      // ── Running state ──
      const wasRunning = _running;
      _running = !!(data.stats && data.stats.running);
      if (wasRunning !== _running) { _syncBtn(); _updateSchedulePills(); }

      // ── Logs (incremental — kukunin lang ang bago) ──
      const allLogs = data.logs || [];
      if (allLogs.length > _logCount) {
        const newLogs = allLogs.slice(_logCount);
        _logCount = allLogs.length;
        const logEl = document.getElementById('scraper-log');
        newLogs.forEach(l => {
          _logs.push(l);
          if (logEl) _writeLine(logEl, l.time, l.level, l.msg);
        });
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
      }

      // ── Stats ──
      _cachedStats = data.stats || {};
      _renderStats(_cachedStats);

      // ── Held-for-review queue ──
      _fetchReview();

      // ── Schedule ──
      _updateSchedule();

      if (!_backendOk) _addLocalLog('INFO', 'Connected to scraper backend.');
      _backendOk = true;

    } catch (err) {
      if (_backendOk) {
        _backendOk = false;
        const msg = (err && err.message) ? err.message : String(err);
        _addLocalLog('ERROR', `Cannot load scraper status: ${msg}`);
        _addLocalLog('INFO', 'Start backend: run_backend.bat  →  http://127.0.0.1:5000/');
      }
    }
  }

  // ─── RUN NOW BUTTON ────────────────────────────────────────────────────────
  function _bindRunBtn() {
    const btn = document.getElementById('scraper-run-btn');
    if (!btn) return;
    btn.setAttribute('type', 'button');
    btn.addEventListener('click', _onRunClick);
  }

  async function _onRunClick(e) {
    e.preventDefault();
    e.stopPropagation();

    if (_running) {
      _addLocalLog('WARN', 'Scraper is already running.');
      return;
    }

    _addLocalLog('INFO', 'Manual run initiated — starting scraper...');

    try {
      const token = _adminToken();
      const res = await fetch(`${API}/api/run-scraper`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (res.status === 401) {
        _addLocalLog('ERROR', 'Admin session required — please log out and log back in.');
        return;
      }
      if (res.status === 409) {
        _addLocalLog('WARN', 'Scraper is already running on the server.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      _addLocalLog('INFO', 'Scrape started! Fetching live logs...');

      // Poll immediately — running state comes from server (stats.running)
      clearTimeout(_pollTimer);
      _pollTimer = setTimeout(_poll, 300);

    } catch (err) {
      _addLocalLog('ERROR', `Cannot reach backend: ${err.message}`);
      _addLocalLog('INFO', 'Start API server: python api/app.py');
    }
  }

  function _syncBtn() {
    const btn = document.getElementById('scraper-run-btn');
    if (!btn) return;
    if (_running) {
      btn.disabled  = true;
      btn.innerHTML = '<span class="scraper-blink">●</span> Running...';
    } else {
      btn.disabled  = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
        stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run Now`;
    }
  }

  // ─── STATS ─────────────────────────────────────────────────────────────────
  function _renderStats(stats) {
    // Pinaikli natin yung pangalan ng types para mag-kasya sa text sa ilalim ng card
    const _SHORT_LABELS = {
        'Local Special': 'L.Special', 'Local Premium': 'L.Premium', 'Local Well Milled': 'L.Well', 'Local Regular Milled': 'L.Regular',
        'Imported Special': 'I.Special', 'Imported Premium': 'I.Premium', 'Imported Well Milled': 'I.Well', 'Imported Regular Milled': 'I.Regular',
        'Gasoline': 'Gasoline', 'RON_100': 'RON100', 'RON_97': 'RON97', 'RON_95': 'RON95', 'RON_91': 'RON91', 'Diesel': 'Diesel', 'Diesel_Plus': 'Diesel+', 'Kerosene': 'Kerosene',
        'USD_to_PHP': 'USD', 'THB_to_PHP': 'THB', 'VND_to_PHP': 'VND'
    };

    // SA LOOB NG _renderStats(stats) na function
    const calToday = stats.calendar_today || '';

    const renderItem = (id, missingId, dataObj, total, kind) => {
      const el = document.getElementById(id);
      const missingEl = document.getElementById(missingId);
      if (!el) return;

      // ← FIX: kapag walang dataObj pa (hindi pa nag-fetch), i-show agad ang "No data"
      // instead na manatili sa "Loading..." indefinitely
      if (!dataObj) {
        el.textContent = `0/${total}`;
        if (missingEl) {
          missingEl.textContent = kind === 'rice'
            ? 'No DA bulletin in database yet. Run scraper.'
            : 'No data for today. Please run scraper.';
          missingEl.style.color = 'var(--color-danger)';
        }
        return;
      }

      el.textContent = `${dataObj.count}/${total}`;

      if (missingEl) {
        const dateLabel = dataObj.latest_date
          ? (dataObj.is_today ? `Today (${dataObj.latest_date})` : `Bulletin ${dataObj.latest_date}`)
          : '';
        if (dataObj.count === total) {
          if (kind === 'rice' && dataObj.is_estimated) {
            missingEl.textContent =
              `✓ Estimated for ${dataObj.latest_date} — replaced when the DA bulletin is published`;
            missingEl.style.color = 'var(--color-warning)';
          } else if (kind === 'rice' && dataObj.latest_date && !dataObj.is_today && calToday) {
            missingEl.textContent =
              `✓ Up to date — latest DA bulletin ${dataObj.latest_date}`;
            missingEl.style.color = 'var(--color-success)';
          } else if (kind === 'fuel' && dataObj.latest_date) {
            missingEl.textContent = `✓ Complete — DOE week of ${dataObj.latest_date}`;
            missingEl.style.color = 'var(--color-success)';
          } else {
            missingEl.textContent = `✓ Complete${dateLabel ? ' — ' + dateLabel : ''}`;
            missingEl.style.color = 'var(--color-success)'; // Green
          }
        } else if (dataObj.count === 0) {
          missingEl.textContent = kind === 'rice'
            ? 'No rice bulletin scraped yet.'
            : 'No data found. Please run scraper.';
          missingEl.style.color = 'var(--color-danger)'; // Red
        } else {
          const missingShort = dataObj.missing.map(m => _SHORT_LABELS[m] || m).join(', ');
          const prefix = dateLabel ? `[${dateLabel}] ` : '';
          missingEl.textContent = prefix + 'Missing: ' + missingShort;
          missingEl.style.color = dataObj.is_today ? 'var(--color-danger)' : 'var(--color-warning)'; // Red if today, yellow if older
        }
      }
    };

    renderItem('stat-rice', 'missing-rice', stats.rice, 8, 'rice');
    renderItem('stat-fuel', 'missing-fuel', stats.fuel, 6, 'fuel');   // DOE bulletin: 6 products
    renderItem('stat-rates', 'missing-rates', stats.rates, 3, 'rates');
  }

  // ─── SCHEDULE & COUNTDOWN ──────────────────────────────────────────────────

  // Every source in the schedule table is a live backend scraper. The times come from the backend's real
  // plan (/api/scrape-status → stats.schedule, see api/app.py::_loop_scraper): one full sync every N hours
  // (Admin → Settings), plus DA-only retries while today's bulletin is still missing. This page used to
  // invent per-source schedules (rice every 4h, fuel Mondays, rates hourly, "daily 8:00 AM") that the
  // backend never ran.
  const _LIVE_SCRAPERS = ['rice', 'fuel', 'rate', 'tariff', 'psa'];
  const _SOURCE_ID = { rice: 'da', fuel: 'doe', rate: 'api', tariff: 'tc', psa: 'psa' };

  function _schedule() { return (_cachedStats && _cachedStats.schedule) || null; }

  function _fmtTime(dt) {
    return dt.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  function _formatScheduleNext(dt) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (dt.toDateString() === now.toDateString()) return `Today ${_fmtTime(dt)}`;
    if (dt.toDateString() === tomorrow.toDateString()) return `Tomorrow ${_fmtTime(dt)}`;
    return `${months[dt.getMonth()]} ${dt.getDate()} ${_fmtTime(dt)}`;
  }

  function _updateScheduleRows() {
    const sc = _schedule();
    const off = new Set((sc && sc.disabled) || []);
    const every = sc && sc.interval_hours ? `Every ${+sc.interval_hours}h` : 'Daily';
    const cadence = {
      rice: `${every} + retries`, fuel: `${every} · DOE weekly`, rate: every,
      tariff: `${every} · quarterly rate`, psa: `${every} · PSA monthly`,
    };
    const full = sc && sc.next_full ? new Date(sc.next_full) : null;
    _LIVE_SCRAPERS.forEach(id => {
      _setText(`int-${id}`, cadence[id]);
      let next = 'Next: —';
      if (sc && !sc.auto) next = 'Auto-scrape off';
      else if (off.has(_SOURCE_ID[id])) next = 'Off in Settings';
      else if (id === 'rice' && sc && sc.da_waiting && sc.next_da_retry) next = `Retry: ${_formatScheduleNext(new Date(sc.next_da_retry))}`;
      else if (full) next = `Next: ${_formatScheduleNext(full)}`;
      _setText(`next-${id}`, next);
    });
  }

  function _updateSchedulePills() {
    const sc = _schedule();
    const off = new Set((sc && sc.disabled) || []);
    _LIVE_SCRAPERS.forEach(key => {
      const el = document.getElementById(`pill-${key}`);
      if (!el) return;
      if (_running) {
        el.textContent = 'Running...';
        el.className = 'pill pill-yellow';
        el.style.animation = 'pulse 1s ease-in-out infinite';
      } else if ((sc && !sc.auto) || off.has(_SOURCE_ID[key])) {
        el.textContent = 'Off';
        el.className = 'pill pill-gray';
        el.style.animation = '';
      } else if (key === 'rice' && sc && sc.da_waiting) {
        el.textContent = 'Waiting';
        el.className = 'pill pill-yellow';
        el.style.animation = '';
        el.title = `Today's DA bulletin is not in yet — retried every ${sc.da_retry_every_hours || 2}h between ${(sc.da_retry_hours || [7, 21]).join(':00 and ')}:00.`;
      } else {
        el.textContent = 'Active';
        el.className = 'pill pill-green';
        el.style.animation = '';
        el.title = '';
      }
    });
  }

  function _updateSchedule() {
    const sc = _schedule();
    _nextRun = sc && sc.auto && sc.next_full ? new Date(sc.next_full) : null;
    _updateScheduleRows();
    _startCountdown();
    _updateSchedulePills();
  }

  function _startCountdown() {
    clearInterval(_cdTimer);
    const tick = () => {
      if (_running) { _setText('stat-lastrun', 'Scraping now...'); return; }
      const sc = _schedule();
      if (sc && !sc.auto) { _setText('stat-lastrun', 'Auto-scrape is off\n(Admin → Settings)'); return; }
      if (!_nextRun) { _setText('stat-lastrun', '—'); return; }
      const diff = _nextRun - new Date();
      if (diff <= 0) { _setText('stat-lastrun', 'Starting shortly...'); return; }
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);
      _setText('stat-lastrun', `${_formatScheduleNext(_nextRun)}\n(in ${h}h ${m}m ${s}s)`);
    };
    tick();
    _cdTimer = setInterval(tick, 1000);
  }

  // ─── LOG HELPERS ───────────────────────────────────────────────────────────
  const _LEVEL_CLASS = {
    INFO:    'log-level-info',
    WARN:    'log-level-warn',
    WARNING: 'log-level-warn',
    ERROR:   'log-level-error',
    SUCCESS: 'log-level-success',
  };

  function _writeLine(el, time, level, msg) {
    el.insertAdjacentHTML('beforeend', `
      <div class="log-line">
        <span class="log-time">${_esc(time)}</span>
        <span class="${_LEVEL_CLASS[level] || 'log-level-info'}">[${_esc(level)}]</span>
        <span class="log-msg">${_esc(msg)}</span>
      </div>`);
  }

  function _addLocalLog(level, msg) {
    const time  = new Date().toLocaleTimeString('en-PH', { hour12: true });
    const entry = { time, level, msg };
    _logs.push(entry);
    const el = document.getElementById('scraper-log');
    if (el) {
      _writeLine(el, time, level, msg);
      el.scrollTop = el.scrollHeight;
    }
  }

  // ─── UTILITIES ─────────────────────────────────────────────────────────────

  function _setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  // ─── HELD FOR REVIEW ───────────────────────────────────────────────────────
  // Rice prices the scraper held back (tools/scrape_guard.py). Approve writes the held value into
  // the database; reject keeps the cell empty. Both need the admin session token.
  let _review = [];

  async function _fetchReview() {
    try {
      const token = _adminToken();
      const res = await fetch(`${API}/api/scrape-review`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) return;
      _review = (await res.json()).pending || [];
      _renderReview();
    } catch { /* keep the last list */ }
  }

  function _renderReview() {
    const host = document.getElementById('scraper-review');
    const count = document.getElementById('scraper-review-count');
    if (count) {
      count.textContent = `${_review.length} pending`;
      count.className = `pill ${_review.length ? 'pill-orange' : 'pill-green'}`;
    }
    if (!host) return;
    if (!_review.length) {
      host.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Nothing held.</div>';
      return;
    }
    host.innerHTML = _review.map((e, i) => `
      <div style="display:grid;grid-template-columns:110px 1fr 90px auto;gap:12px;align-items:center;padding:10px 0;border-top:1px solid rgba(76,175,110,0.1);">
        <span style="font-weight:600;">${_esc(e.date)}</span>
        <span><b>${_esc(e.column)}</b> — ${_esc(e.reason)}</span>
        <span style="font-family:var(--font-mono, monospace);font-weight:600;">₱${Number(e.value).toFixed(2)}</span>
        <span style="display:flex;gap:6px;">
          <button type="button" class="btn btn-primary btn-sm" data-review="${i}" data-action="approve">Approve</button>
          <button type="button" class="btn btn-outline btn-sm" data-review="${i}" data-action="reject">Reject</button>
        </span>
      </div>`).join('');
    host.querySelectorAll('button[data-review]').forEach((btn) => {
      btn.addEventListener('click', () => _resolveReview(_review[+btn.dataset.review], btn.dataset.action, btn));
    });
  }

  async function _resolveReview(entry, action, btn) {
    if (!entry) return;
    btn.disabled = true;
    try {
      const res = await fetch(`${API}/api/scrape-review/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_adminToken()}` },
        body: JSON.stringify({ date: entry.date, column: entry.column, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      _addLocalLog('INFO', `${action === 'approve' ? 'Approved' : 'Rejected'} ${entry.date} ${entry.column} ₱${Number(entry.value).toFixed(2)}`);
      await _fetchReview();
    } catch (err) {
      btn.disabled = false;
      _addLocalLog('ERROR', `Review ${action} failed: ${err.message || err}`);
    }
  }

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  return { init, destroy };

})();