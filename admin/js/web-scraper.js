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

  // ─── STATE ─────────────────────────────────────────────────────────────────
  let _mounted   = false;
  let _running   = false;   // TRUE kung nag-sscrape ang backend
  let _pollTimer = null;
  let _cdTimer   = null;

  let _logs      = [];      // [{ time, level, msg }] — nananatili sa memory
  let _logCount  = 0;       // ilang logs na ang nakuha natin — para incremental lang

  let _cache      = { rice: null, fuel: null, rates: null };
  let _cachedStats = {};   // ← FIX: i-cache ang stats para agad ma-render sa _restoreUI
  let _activeTab = 'rice';
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
    _bindTabs();
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

    // Tab active state
    document.querySelectorAll('.scraper-tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === _activeTab);
    });

    // Table
    _renderTable(_activeTab);

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

      // ── CSV preview cache ──
      _cache = {
        rice:  data.preview_rice  || null,
        fuel:  data.preview_fuel  || null,
        rates: data.preview_rates || null,
      };
      _renderTable(_activeTab);

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
      const res = await fetch(`${API}/api/run-scraper`, { method: 'POST' });

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

  // ─── TABS ──────────────────────────────────────────────────────────────────
  function _bindTabs() {
    document.querySelectorAll('.scraper-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _activeTab = btn.dataset.tab;
        document.querySelectorAll('.scraper-tab-btn').forEach(b =>
          b.classList.toggle('active', b === btn)
        );
        _renderTable(_activeTab);
      });
    });
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
          missingEl.style.color = '#ffb4b4';
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
              `✓ Estimated ${dataObj.latest_date} — papalitan kapag may DA bulletin na`;
            missingEl.style.color = '#ffd97d';
          } else if (kind === 'rice' && dataObj.latest_date && !dataObj.is_today && calToday) {
            missingEl.textContent =
              `✓ Complete — Bulletin ${dataObj.latest_date} (walang ${calToday} sa DA.gov.ph pa)`;
            missingEl.style.color = '#a8e6cf';
          } else {
            missingEl.textContent = `✓ Complete${dateLabel ? ' — ' + dateLabel : ''}`;
            missingEl.style.color = '#a8e6cf'; // Green
          }
        } else if (dataObj.count === 0) {
          missingEl.textContent = kind === 'rice'
            ? 'No rice bulletin scraped yet.'
            : 'No data found. Please run scraper.';
          missingEl.style.color = '#ffb4b4'; // Red
        } else {
          const missingShort = dataObj.missing.map(m => _SHORT_LABELS[m] || m).join(', ');
          const prefix = dateLabel ? `[${dateLabel}] ` : '';
          missingEl.textContent = prefix + 'Missing: ' + missingShort;
          missingEl.style.color = dataObj.is_today ? '#ffb4b4' : '#ffd97d'; // Red if today, yellow if older
        }
      }
    };

    renderItem('stat-rice', 'missing-rice', stats.rice, 8, 'rice');
    renderItem('stat-fuel', 'missing-fuel', stats.fuel, 8, 'fuel');
    renderItem('stat-rates', 'missing-rates', stats.rates, 3, 'rates');
  }

  // ─── SCHEDULE & COUNTDOWN ──────────────────────────────────────────────────

  // Live scrapers (backend) vs planned (shown in schedule, not wired yet)
  const _LIVE_SCRAPERS  = ['rice', 'fuel', 'rate'];
  const _PLANNED_SCRAPERS = ['psa', 'pagasa'];

  function _formatScheduleNext(dt) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const time = dt.toLocaleTimeString('en-PH', {
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    if (dt.toDateString() === now.toDateString()) return `Next: Today ${time}`;
    if (dt.toDateString() === tomorrow.toDateString()) return `Next: Tomorrow ${time}`;
    return `Next: ${months[dt.getMonth()]} ${dt.getDate()}`;
  }

  function _nextMonthlyFirst(now) {
    const d = new Date(now);
    let next = new Date(d.getFullYear(), d.getMonth(), 1, 8, 0, 0, 0);
    if (next <= d) next = new Date(d.getFullYear(), d.getMonth() + 1, 1, 8, 0, 0, 0);
    return next;
  }

  function _updateScheduleRows() {
    const now = new Date();
    const rows = [
      { id: 'rice',   next: _nextInterval(now, 4 * 60) },
      { id: 'fuel',   next: _nextWeekday(now, 1) },
      { id: 'rate',   next: _nextInterval(now, 60) },
      { id: 'psa',    next: _nextMonthlyFirst(now) },
      { id: 'pagasa', next: _nextInterval(now, 3 * 60) },
    ];
    rows.forEach(({ id, next }) => _setText(`next-${id}`, _formatScheduleNext(next)));
  }

  function _updateSchedulePills() {
    _LIVE_SCRAPERS.forEach(key => {
      const el = document.getElementById(`pill-${key}`);
      if (!el) return;
      if (_running) {
        el.textContent = 'Running...';
        el.className = 'pill pill-yellow';
        el.style.animation = 'pulse 1s ease-in-out infinite';
      } else {
        el.textContent = 'Active';
        el.className = 'pill pill-green';
        el.style.animation = '';
      }
    });
    _PLANNED_SCRAPERS.forEach(key => {
      const el = document.getElementById(`pill-${key}`);
      if (!el) return;
      el.textContent = 'Planned';
      el.className = 'pill pill-gray';
      el.style.animation = '';
    });
  }

  function _updateSchedule() {
    const now = new Date();
    let nextRun = new Date(now);

    // Global auto-scrape cycle (backend default: daily ~8:00 AM)
    nextRun.setHours(8, 0, 0, 0);
    if (now > nextRun) nextRun.setDate(nextRun.getDate() + 1);

    _nextRun = nextRun;
    _updateScheduleRows();
    _startCountdown();
    _updateSchedulePills();
  }

  function _startCountdown() {
    clearInterval(_cdTimer);
    const tick = () => {
      _updateScheduleRows();
      if (!_nextRun) return;
      if (_running) { _setText('stat-lastrun', 'Scraping now...'); return; }

      const diff = _nextRun - new Date();
      if (diff <= 0) { _setText('stat-lastrun', 'Scraping now...'); return; }

      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);

      // Aalamin kung mamaya na ba ito o bukas pa
      const isToday = _nextRun.getDate() === new Date().getDate();
      const dayStr = isToday ? 'Today' : 'Tomorrow';

      // Pinaghiwalay natin ng linya para mas malinis tignan
      _setText('stat-lastrun', `${dayStr} 8:00 AM\n(in ${h}h ${m}m ${s}s)`);
    };
    tick();
    _cdTimer = setInterval(tick, 1000);
  }

  // ─── TABLE ─────────────────────────────────────────────────────────────────
  const _SHORT = {
    'Local Special':           'L-Special',
    'Local Premium':           'L-Premium',
    'Local Well Milled':       'L-Well',
    'Local Regular Milled':    'L-Regular',
    'Imported Special':        'I-Special',
    'Imported Premium':        'I-Premium',
    'Imported Well Milled':    'I-Well',
    'Imported Regular Milled': 'I-Regular',
    'USD_to_PHP':              'USD→PHP',
    'THB_to_PHP':              'THB→PHP',
    'VND_to_PHP':              'VND→PHP',
  };

  const _COLS = {
    rice:  ['Date','Local Special','Local Premium','Local Well Milled','Local Regular Milled',
            'Imported Special','Imported Premium','Imported Well Milled','Imported Regular Milled'],
    fuel:  ['Date','Gasoline','RON_100','RON_97','RON_95','RON_91','Diesel','Diesel_Plus','Kerosene'],
    rates: ['Date','USD_to_PHP','THB_to_PHP','VND_to_PHP'],
  };

  const _EMPTY_SVG = `<svg width="42" height="42" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
    style="color:var(--text-muted,#8aad99);margin-bottom:12px;">
    <path d="M22 12h-6l-2 3h-4l-2-3H2"/>
    <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
  </svg>`;

  function _renderTable(tab) {
    const el = document.getElementById('scraper-table-container');
    if (!el) return;
    const rows = _cache[tab];
    if (!rows || !rows.length) {
      el.innerHTML = `
        <div class="scraper-table-wrapper"
          style="display:flex;align-items:center;justify-content:center;">
          <div class="scraper-empty-state">${_EMPTY_SVG}
            <div style="color:var(--text-muted,#8aad99);font-size:13px;">
              No ${tab} data yet. Run the scraper to collect records.
            </div>
          </div>
        </div>`;
      return;
    }
    const keys  = Object.keys(rows[0]);
    const cols  = (_COLS[tab] || keys).filter(k => keys.includes(k));
    // Backend already sorts newest-first — take top 10 directly, no reverse needed.
    const top10 = rows.slice(0, 10);
    el.innerHTML = `
      <div class="scraper-table-wrapper">
        <table class="scraper-data-table">
          <thead><tr>${cols.map(c =>
            `<th>${_esc(_SHORT[c] || c)}</th>`).join('')}</tr></thead>
          <tbody>${top10.map((r, i) => {
            const hl = i === 0 ? ' style="font-weight:700;color:var(--accent,#4caf6e);"' : '';
            return `<tr${hl}>${cols.map(c => `<td>${_esc(r[c] ?? '')}</td>`).join('')}</tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      <div style="padding:10px 12px;font-size:11px;font-family:var(--font-mono);
        color:#3D6B4F;border-top:1px solid rgba(76,175,110,0.15);">
        Showing latest ${top10.length} of ${rows.length} records — live from CSV
      </div>`;
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
  function _nextInterval(now, mins) {
    const ms = mins * 60_000;
    return new Date(Math.ceil((now.getTime() + 1) / ms) * ms);
  }

  function _nextWeekday(now, day) {
    const d    = new Date(now);
    const diff = (day - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    d.setHours(6, 0, 0, 0);
    return d;
  }

  function _setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  return { init, destroy };

})();