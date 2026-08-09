/* ============================================
   AgriPricePH — Training Module
   Live training + archived history (tabs)
   ============================================ */

window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Training = (function () {

  const API       = AgriPricePH.API?.BASE || 'http://127.0.0.1:5000';
  const POLL_IDLE = 5_000;
  const POLL_RUN  = 2_000;

  let _mounted      = false;
  let _running      = false;
  let _pollTimer    = null;
  let _logs         = [];
  let _logCount     = 0;
  let _trainLoss    = [];
  let _valLoss      = [];
  let _lastEpoch    = 0;
  let _epochTotal   = 100;
  let _targetIndex  = 0;
  let _targetTotal  = 1;
  let _currentTarget = '';

  let _activeTab         = 'live';
  let _historyRuns       = [];
  let _tabsBound         = false;
  let _historyBound      = false;
  let _liveSessionCurves = false;
  let _sessionLocked     = false;
  let _cancelling        = false;
  let _cancelInFlight    = null;
  let _pendingRefresh    = false;
  let _finishHandledKey  = null;
  let _metricNums = { train: null, val: null, mae: null };
  let _metricDisplay = { train: '—', val: '—', mae: '—' };
  let _cachedStatusLabel = '';
  let _cachedDuration = '—';

  const SVG_METRIC_STATUS = {
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>',
    bad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    none: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"/></svg>',
  };

  const METRIC_STATUS_LABEL = {
    ok: 'Good — within target range',
    warn: 'Fair — review before deploying',
    bad: 'Needs attention — error is high',
    none: 'Waiting for metrics',
  };

  const EPOCH_RE = /\[EPOCH\]\s*(?:(\S+)\s*\|\s*)?(\d+)\/(\d+)\s*\|\s*loss:\s*([\d.]+)\s*\|\s*val_loss:\s*([\d.]+)\s*\|\s*mae:\s*([\d.]+)/i;
  const TARGET_RE = /\[TARGET\]\s*(\d+)\/(\d+)\s+(\S+)/i;

  const RICE_LABELS = {
    locWellMilled: 'Local Well-Milled',
    locRegular:    'Local Regular',
    locPremium:    'Local Premium',
    locSpecial:    'Local Special',
    impWellMilled: 'Imported Well-Milled',
    impRegular:    'Imported Regular',
    impPremium:    'Imported Premium',
    impSpecial:    'Imported Special',
  };

  const SVG_INSIGHT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
  const SVG_CHEVRON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;

  function init() {
    _mounted = true;
    _bindTabs();
    _bindHistory();
    _bindToolbarActions();
    _syncTabPanels();
    _remountLiveView();
    _ensurePolling();
    Promise.all([
      _fetchStatusOnce().then(data => {
        if (data) _applyStatusData(data);
        return data;
      }).catch(() => null),
      _fetchHistoryLight(),
    ]).then(() => {
      if (_mounted) _remountLiveView();
    });
  }

  function destroy() {
    _mounted = false;
    _tabsBound = false;
    _historyBound = false;
    if (!isActive()) {
      clearTimeout(_pollTimer);
      _pollTimer = null;
    }
  }

  function _ensurePolling() {
    if (!_pollTimer) _poll();
  }

  function isActive() {
    return _running || _cancelling;
  }

  // ─── TABS ───────────────────────────────────────────────────────────────────
  function _bindTabs() {
    if (_tabsBound) return;
    _tabsBound = true;

    document.querySelectorAll('.training-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (!tab || tab === _activeTab) return;
        if (isActive()) {
          _confirmLeaveTraining(
            'Switch to Training History?',
            'Leaving Live Training will cancel the current run. Partial progress is saved to Training History.'
          ).then(ok => {
            if (!ok) return;
            _cancelTraining().then(stopped => {
              if (stopped) _switchTab(tab);
            });
          });
          return;
        }
        _switchTab(tab);
      });
    });
  }

  function _switchTab(tab) {
    _activeTab = tab;
    _syncTabPanels();
    _syncToolbarButtons();
    if (tab === 'history') _loadHistory(null, { skipLiveSync: true });
    if (tab === 'live') _remountLiveView();
  }

  function _syncTabPanels() {
    document.querySelectorAll('.training-tab-btn').forEach(btn => {
      const on = btn.dataset.tab === _activeTab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const live = document.getElementById('training-tab-live');
    const hist = document.getElementById('training-tab-history');
    if (live) {
      live.classList.toggle('active', _activeTab === 'live');
      live.hidden = _activeTab !== 'live';
    }
    if (hist) {
      hist.classList.toggle('active', _activeTab === 'history');
      hist.hidden = _activeTab !== 'history';
    }
  }

  // ─── LIVE CHART ─────────────────────────────────────────────────────────────
  function _normalizeCurve(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(v => Number(v)).filter(v => Number.isFinite(v));
  }

  function _pairCurves(trainRaw, valRaw) {
    const train = _normalizeCurve(trainRaw);
    const val   = _normalizeCurve(valRaw);
    if (!train.length && !val.length) return { train: [], val: [] };

    let n = Math.min(train.length, val.length);
    if (!n) n = Math.max(train.length, val.length);
    while (train.length < n) train.push(train[train.length - 1] ?? 0);
    while (val.length < n) val.push(val[val.length - 1] ?? 0);
    return { train: train.slice(0, n), val: val.slice(0, n) };
  }

  function _findLatestRunWithCurves(runs) {
    for (const run of runs || []) {
      const { train, val } = _pairCurves(run.train_loss_curve, run.val_loss_curve);
      if (train.length >= 1 && val.length >= 1) return run;
    }
    return null;
  }

  function _setLossChartCaption(run, live) {
    const el = document.getElementById('loss-chart-caption');
    if (!el) return;
    if (live) {
      el.textContent = 'Live run in progress';
      return;
    }
    if (!run) {
      el.textContent = '';
      return;
    }
    const d = new Date(run.completed_at || run.started_at);
    const when = Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
    const dur = run.duration && run.duration !== '—' ? ` · ${run.duration}` : '';
    el.textContent = when
      ? `Showing last run · ${when}${dur}`
      : 'Showing last run';
  }

  function _applyLastRunToLive(run) {
    const { train, val } = _pairCurves(run.train_loss_curve, run.val_loss_curve);
    if (!train.length || !val.length) return false;

    _trainLoss = train;
    _valLoss   = val;
    _lastEpoch = run.epochs_completed || train.length;
    _epochTotal = run.epochs_planned || 100;

    _setEpochLevel(_lastEpoch);
    if (_sessionLocked || !_running) {
      const epNote = _lastEpoch && _epochTotal
        ? ` · epoch level ${_lastEpoch}${_lastEpoch < _epochTotal ? ` (early stop of ${_epochTotal})` : ''}`
        : '';
      _setProgressComplete({
        failed: run.ok === false,
        label: run.ok === false ? 'Failed' : `100% Complete${epNote}`,
      });
    } else {
      _updateProgress(_lastEpoch, _epochTotal);
    }
    if (run.final_train_loss != null) {
      const t = Number(run.final_train_loss);
      _setTrainingMetric('train-loss', t.toFixed(4), t);
    }
    if (run.final_val_loss != null) {
      const v = Number(run.final_val_loss);
      _setTrainingMetric('val-loss', v.toFixed(4), v);
    }
    if (run.final_mae != null) {
      const m = Number(run.final_mae);
      _setTrainingMetric('mae', m.toFixed(4), m);
    } else if (run.mae_peso != null) {
      const m = Number(run.mae_peso);
      _setTrainingMetric('mae', `₱${m.toFixed(2)}`, m);
    }
    if (run.duration && run.duration !== '—') {
      _setText('metric-duration', run.duration);
    }
    _setLossChartCaption(run, false);
    _redrawLossChartDeferred();
    return true;
  }

  function _syncLiveFromLastRun() {
    if (_running) return;
    const run = _findLatestRunWithCurves(_historyRuns);
    if (run) _applyLastRunToLive(run);
    else _redrawLossChart();
  }

  function _redrawLossChart() {
    const canvas = document.getElementById('loss-chart');
    if (!canvas || !AgriPricePH.Charts?.lossCurve) return;
    AgriPricePH.Charts.lossCurve(canvas, _trainLoss, _valLoss);
  }

  function _redrawLossChartDeferred() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!_mounted) return;
        _redrawLossChart();
      });
    });
  }

  /** Canvas needs layout after router swaps HTML — redraw a few times. */
  function _scheduleLossChartRedraw() {
    _redrawLossChartDeferred();
    [80, 250, 500].forEach(ms => {
      setTimeout(() => {
        if (!_mounted || _activeTab !== 'live') return;
        _redrawLossChart();
      }, ms);
    });
  }

  function _restoreLogs(force) {
    const logEl = document.getElementById('training-log');
    if (!logEl) return;
    const rendered = logEl.querySelectorAll('.log-line').length;
    if (!force && rendered === _logs.length) return;
    logEl.innerHTML = '';
    if (_logs.length === 0) {
      _writeLine(logEl, '--:--:--', 'INFO', 'Waiting for training backend...');
    } else {
      _logs.forEach(l => _writeLine(logEl, l.time, l.level, l.msg));
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function _restoreMetricsFromState() {
    if (_metricNums.train != null) {
      _setTrainingMetric('train-loss', _metricDisplay.train, _metricNums.train);
    }
    if (_metricNums.val != null) {
      _setTrainingMetric('val-loss', _metricDisplay.val, _metricNums.val);
    }
    if (_metricNums.mae != null) {
      _setTrainingMetric('mae', _metricDisplay.mae, _metricNums.mae);
    }
    if (_cachedDuration && _cachedDuration !== '—') {
      _setText('metric-duration', _cachedDuration);
    }
  }

  function _restoreProgressFromState() {
    if (_lastEpoch <= 0) return;
    _setEpochLevel(_lastEpoch);
    if (isActive()) {
      if ((_targetTotal || 1) > 1) _updateOverallProgress();
      else _updateProgress(_lastEpoch, _epochTotal);
    } else if (_sessionLocked) {
      const epNote = _lastEpoch < _epochTotal
        ? ` · stopped at epoch ${_lastEpoch}`
        : '';
      _setProgressComplete({ label: `100% Complete${epNote}` });
    }
  }

  /** Repaint Live tab after DOM remount (leave module and return). */
  function _remountLiveView() {
    _restoreLogs(true);
    _syncBtn();
    _updatePill();
    _syncTabPanels();
    _syncToolbarButtons();

    if (_cachedStatusLabel) {
      _setText('training-status-label', _cachedStatusLabel);
    }

    if (_activeTab === 'history' && _historyRuns.length) {
      _renderHistoryTable();
      _renderHistoryCharts();
    }

    if (_activeTab !== 'live') return;

    _restoreMetricsFromState();
    _restoreProgressFromState();

    if (_trainLoss.length || _valLoss.length) {
      if (_liveSessionCurves) {
        if (_running) _setLossChartCaption(null, true);
        else _setLossChartCaption(_findLatestRunWithCurves(_historyRuns), false);
      }
      _scheduleLossChartRedraw();
    } else if (!_running) {
      _syncLiveFromLastRun();
      if (!_trainLoss.length && !_valLoss.length) {
        _scheduleLossChartRedraw();
      }
    }
  }

  function _initChart() {
    _redrawLossChartDeferred();
  }

  function _updateChart() {
    if (!_trainLoss.length && !_valLoss.length) return;
    _redrawLossChartDeferred();
  }

  function _finalizeChartAfterTraining() {
    _liveSessionCurves = false;
    const run = _findLatestRunWithCurves(_historyRuns);
    if (run) {
      _applyLastRunToLive(run);
      return;
    }
    if (_trainLoss.length) {
      _setLossChartCaption(null, false);
      _redrawLossChartDeferred();
    }
  }

  function _restoreUI() {
    _remountLiveView();
  }

  // ─── POLLING ────────────────────────────────────────────────────────────────
  function _shouldKeepPolling() {
    return _mounted || isActive();
  }

  function _poll() {
    clearTimeout(_pollTimer);
    _pollTimer = null;
    _fetchStatus().finally(() => {
      if (!_shouldKeepPolling()) return;
      _pollTimer = setTimeout(_poll, _running ? POLL_RUN : POLL_IDLE);
    });
  }

  async function _fetchStatusOnce() {
    const res = await fetch(`${API}/api/training-status`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function _applyStatusData(data) {
    const wasRunning = _running;
    _running = !!data.running;

    const allLogs = data.logs || [];
    if (allLogs.length < _logCount) {
      if (_running || _cancelling) {
        _logCount = allLogs.length;
      } else {
        _logCount = 0;
        _logs = [];
      }
    }
    if (allLogs.length > _logCount && !_sessionLocked) {
      const newLogs = allLogs.slice(_logCount);
      _logCount = allLogs.length;
      const logEl = document.getElementById('training-log');

      let latestEpochMsg = null;
      newLogs.forEach(l => {
        _logs.push(l);
        if (logEl) _writeLine(logEl, l.time, l.level, l.msg);
        if (TARGET_RE.test(l.msg)) _parseTargetLine(l.msg);
        if (EPOCH_RE.test(l.msg)) latestEpochMsg = l.msg;
      });

      if (logEl) logEl.scrollTop = logEl.scrollHeight;
      if (latestEpochMsg) _parseEpochLine(latestEpochMsg);
    } else if (allLogs.length > _logCount) {
      _logCount = allLogs.length;
    }

    if (data.last_run && !_running) {
      const d = new Date(data.last_run);
      const formatted = d.toLocaleDateString('en-PH', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      const result = data.last_result;
      const status = result?.cancelled ? 'Cancelled' : (result?.ok ? 'Completed' : 'Failed');
      _setText('training-status-label', `Last Run: ${formatted} — ${status}`);
      if (result?.duration) _setText('metric-duration', result.duration);
    }

    if (!_running && _sessionLocked) {
      _setProgressTransition(false);
    }

    if (wasRunning && !_running) {
      _cancelling = false;
      _handleTrainingStopped(data, true);
    } else if (wasRunning !== _running) {
      _syncBtn();
      _updatePill();
      _syncToolbarButtons();
    }
  }

  async function _fetchStatus() {
    try {
      const data = await _fetchStatusOnce();
      _applyStatusData(data);
    } catch { /* retry on next poll */ }
  }

  function _handleTrainingStopped(data, fromRunning) {
    if (!fromRunning || data?.running) return;
    _running = false;
    _cancelling = false;
    _syncBtn();
    _updatePill();
    _syncToolbarButtons();
    _onTrainingFinished(data);
  }

  async function _waitForTrainingStopped(maxMs = 120000) {
    const deadline = Date.now() + maxMs;
    let lastData = null;
    while (Date.now() < deadline) {
      lastData = await _fetchStatusOnce();
      if (!lastData.running) {
        _running = false;
        _cancelling = false;
        return lastData;
      }
      await new Promise(r => setTimeout(r, 700));
    }
    throw new Error('Timed out waiting for training to stop');
  }

  async function _onTrainingFinished(data) {
    const finishKey = data?.last_saved_run?.id || data?.last_run || String(Date.now());
    if (_finishHandledKey === finishKey) return;
    _finishHandledKey = finishKey;

    _sessionLocked = true;
    _cancelling = false;
    _targetIndex = Math.max(_targetTotal, _targetIndex || 1);
    _lastEpoch = _epochTotal;

    const cancelled = !!(data?.last_result?.cancelled);
    const failed = !!(data?.last_result && data.last_result.ok === false && !cancelled);
    if (cancelled || failed) {
      _setProgressComplete({ cancelled, failed });
    } else {
      _setProgressComplete({
        label: _lastEpoch && _lastEpoch < _epochTotal
          ? `100% Complete · stopped at epoch ${_lastEpoch}`
          : '100% Complete',
      });
    }
    _setProgressTransition(false);
    _setLossChartCaption(null, false);
    _pendingRefresh = true;
    _syncToolbarButtons();

    await _loadHistory(null, { skipLiveSync: true, silent: true });

    const saved = data?.last_saved_run;
    if (saved && !_historyRuns.some(r => r.id === saved.id)) {
      _historyRuns.unshift(saved);
      _setText('training-history-count', String(_historyRuns.length));
      if (_activeTab === 'history') {
        _renderHistoryTable();
        _renderHistoryCharts();
      }
    }

    if (saved) {
      _applyLastRunToLive(saved);
    } else {
      _finalizeChartAfterTraining();
    }

    const logEl = document.getElementById('training-log');
    if (logEl) {
      const level = cancelled ? 'WARN' : 'SUCCESS';
      const msg = cancelled
        ? (saved
          ? `Training cancelled — partial run saved as ${saved.id}. Use Refresh Window to update other modules.`
          : 'Training cancelled — see Training History tab.')
        : (saved
          ? `Training finished — saved as run ${saved.id}. Use Refresh Window to update other modules.`
          : 'Training finished — check Training History tab. Use Refresh Window to update other modules.');
      _writeLine(
        logEl,
        new Date().toLocaleTimeString('en-PH', { hour12: true }),
        level,
        msg
      );
      logEl.scrollTop = logEl.scrollHeight;
    }

    if (cancelled) {
      _setText('training-status-label', 'Last Run: Cancelled — partial progress saved');
    } else if (!failed && data?.last_run) {
      const d = new Date(data.last_run);
      const formatted = Number.isNaN(d.getTime())
        ? ''
        : d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
      if (formatted) {
        _setText('training-status-label', `Last Run: ${formatted} — Completed`);
      }
    }
  }

  function _parseTargetLine(msg) {
    if (_sessionLocked) return;
    const match = msg.match(TARGET_RE);
    if (!match) return;
    _targetIndex = parseInt(match[1], 10);
    _targetTotal = parseInt(match[2], 10);
    _currentTarget = match[3];
    _lastEpoch = 0;
    _setEpochLevel(0);
    const label = RICE_LABELS[_currentTarget] || _currentTarget;
    _setText(
      'training-status-label',
      `Training ${label} (${_targetIndex}/${_targetTotal})…`
    );
    _setLossChartCaption(null, true);
    _updateOverallProgress();
  }

  function _parseEpochLine(msg) {
    if (_sessionLocked) return;
    const match = msg.match(EPOCH_RE);
    if (!match) return;

    const [, targetName, epochStr, totalStr, trainLoss, valLoss, mae] = match;
    const epoch = parseInt(epochStr, 10);
    const total = parseInt(totalStr, 10);
    _lastEpoch  = epoch;
    _epochTotal = total;
    if (targetName) _currentTarget = targetName;

    _setEpochLevel(epoch);
    _updateOverallProgress();
    const t = parseFloat(trainLoss);
    const v = parseFloat(valLoss);
    const m = parseFloat(mae);
    _setTrainingMetric('train-loss', t.toFixed(4), t);
    _setTrainingMetric('val-loss', v.toFixed(4), v);
    _setTrainingMetric('mae', m.toFixed(4), m);

    _liveSessionCurves = true;
    _trainLoss.push(parseFloat(trainLoss));
    _valLoss.push(parseFloat(valLoss));
    _setLossChartCaption(null, true);
    _updateChart();
  }

  function _setProgressTransition(on) {
    const bar = document.getElementById('training-progress-fill');
    if (bar) bar.style.transition = on ? 'width 0.35s ease' : 'none';
  }

  /** Full bar after a run ends (not epoch 11/100 from early stopping). */
  function _setProgressComplete(opts = {}) {
    const bar = document.getElementById('training-progress-fill');
    if (bar) bar.style.width = '100%';
    let label = '100% Complete';
    if (opts.cancelled) label = 'Cancelled';
    else if (opts.failed) label = 'Failed';
    else if (opts.label) label = opts.label;
    _setText('training-pct-label', label);
  }

  function _updateProgress(epoch, total, opts = {}) {
    if (_sessionLocked && !_running && !opts.allowWhileIdle) return;
    const pct = total > 0 ? Math.min(100, Math.round((epoch / total) * 100)) : 0;
    const bar = document.getElementById('training-progress-fill');
    if (bar) bar.style.width = pct + '%';
    _setText('training-pct-label', pct + '% Complete');
  }

  function _updateOverallProgress() {
    const targets = Math.max(1, _targetTotal || 1);
    const perTarget = _epochTotal > 0 ? _lastEpoch / _epochTotal : 0;
    const completed = Math.max(0, (_targetIndex || 1) - 1);
    const overall = Math.min(1, (completed + perTarget) / targets);
    const pct = Math.round(overall * 100);
    const bar = document.getElementById('training-progress-fill');
    if (bar) bar.style.width = pct + '%';
    const targetHint = _currentTarget
      ? ` · ${_currentTarget} epoch ${_lastEpoch}/${_epochTotal}`
      : '';
    _setText('training-pct-label', `${pct}% overall${targetHint}`);
  }

  // ─── CONFIRM / CANCEL / REFRESH ─────────────────────────────────────────────
  function _confirmLeaveTraining(title, text) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'ds-modal-overlay';
      const box = document.createElement('div');
      box.className = 'ds-modal-box';
      box.innerHTML = `
        <h3 class="ds-modal-title">${_esc(title)}</h3>
        <div class="ds-modal-text">${_esc(text)}</div>
        <div class="ds-modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-modal="stay">Stay</button>
          <button type="button" class="btn btn-primary btn-sm" data-modal="leave">Leave &amp; Cancel Training</button>
        </div>`;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('visible'));
      const close = (ok) => {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 200);
        resolve(ok);
      };
      box.querySelector('[data-modal="stay"]').onclick = () => close(false);
      box.querySelector('[data-modal="leave"]').onclick = () => close(true);
      overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
    });
  }

  function confirmLeave() {
    return _confirmLeaveTraining(
      'Leave Model Training?',
      'Training is in progress. Leaving this module will cancel the run. Partial progress is saved to Training History.'
    );
  }

  async function _cancelTraining() {
    if (_cancelInFlight) return _cancelInFlight;

    _cancelInFlight = (async () => {
      try {
        let data;
        try {
          data = await _fetchStatusOnce();
        } catch {
          data = { running: _running };
        }
        _running = !!data.running;
        if (!data.running) {
          _cancelling = false;
          return true;
        }

        _cancelling = true;
        _ensurePolling();
        _syncBtn();
        _syncToolbarButtons();
        if (_mounted) _addLocalLog('WARN', 'Cancelling training…');

        const res = await fetch(`${API}/api/cancel-training`, { method: 'POST' });
        if (res.status === 409) {
          data = await _waitForTrainingStopped(15000).catch(() => null);
          if (data && !data.running) {
            _handleTrainingStopped(data, true);
            return true;
          }
          return false;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        data = await _waitForTrainingStopped();
        _handleTrainingStopped(data, true);
        return true;
      } catch (err) {
        if (_mounted) _addLocalLog('ERROR', `Cancel failed: ${err.message}`);
        return false;
      } finally {
        _cancelling = false;
        _cancelInFlight = null;
        _syncBtn();
        _syncToolbarButtons();
        if (!_running && !isActive()) {
          clearTimeout(_pollTimer);
          _pollTimer = null;
        }
      }
    })();

    return _cancelInFlight;
  }

  function _bindToolbarActions() {
    const runBtn = document.getElementById('training-run-btn');
    const cancelBtn = document.getElementById('training-cancel-btn');
    const refreshBtn = document.getElementById('training-module-refresh');
    if (runBtn) runBtn.onclick = _onRunClick;
    if (cancelBtn) cancelBtn.onclick = (e) => { e.preventDefault(); _onCancelClick(); };
    if (refreshBtn) refreshBtn.onclick = (e) => {
      e.preventDefault();
      window.location.reload();
    };
  }

  async function _onCancelClick() {
    if (!isActive()) return;
    const ok = await _confirmLeaveTraining(
      'Cancel Training?',
      'The current run will stop. Partial progress (epochs completed so far) is saved to Training History.'
    );
    if (!ok) return;
    await _cancelTraining();
  }

  function _syncToolbarButtons() {
    const runBtn = document.getElementById('training-run-btn');
    const cancelBtn = document.getElementById('training-cancel-btn');
    const refreshBtn = document.getElementById('training-module-refresh');
    const onLive = _activeTab === 'live';
    const active = isActive();

    if (runBtn) {
      runBtn.hidden = !onLive || active;
      runBtn.style.display = runBtn.hidden ? 'none' : '';
    }
    if (cancelBtn) {
      cancelBtn.hidden = !onLive || !active;
      cancelBtn.style.display = cancelBtn.hidden ? 'none' : '';
      cancelBtn.disabled = _cancelling;
    }
    if (refreshBtn) {
      const show = _pendingRefresh && !active && onLive;
      refreshBtn.hidden = !show;
      refreshBtn.style.display = show ? '' : 'none';
    }
  }

  // ─── START TRAINING ─────────────────────────────────────────────────────────

  async function _onRunClick(e) {
    e.preventDefault();
    if (_running) {
      _addLocalLog('WARN', 'Training is already in progress.');
      return;
    }

    _sessionLocked = false;
    _liveSessionCurves = false;
    _pendingRefresh = false;
    _cancelling = false;
    _logs = [];
    _logCount = 0;
    _trainLoss = [];
    _valLoss   = [];
    _lastEpoch = 0;
    _epochTotal = 100;
    _targetIndex = 0;
    _targetTotal = 1;
    _currentTarget = '';
    const logEl = document.getElementById('training-log');
    if (logEl) logEl.innerHTML = '';
    _setProgressTransition(true);
    _updateProgress(0, _epochTotal);
    _setLossChartCaption(null, true);
    _initChart();
    _clearTrainingMetrics();
    _setText('metric-duration', '—');

    _finishHandledKey = null;
    _switchTab('live');
    _syncToolbarButtons();
    _addLocalLog('INFO', 'Sending training request to backend...');

    try {
      const res = await fetch(`${API}/api/run-training`, { method: 'POST' });
      if (res.status === 409) {
        _addLocalLog('WARN', 'Training is already running on the server.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      _running = true;
      _logCount = 0;
      _setProgressTransition(true);
      _syncBtn();
      _updatePill();
      _syncToolbarButtons();
      _addLocalLog('SUCCESS', 'Training started! Listening for logs...');
      _ensurePolling();
    } catch (err) {
      _addLocalLog('ERROR', `Cannot reach backend: ${err.message}`);
      _addLocalLog('INFO', 'Is app.py running? → python app.py');
    }
  }

  function _syncBtn() {
    const btn = document.getElementById('training-run-btn');
    if (!btn) return;
    btn.disabled = isActive();
    if (!isActive()) {
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
        stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Training`;
    }
  }

  function _updatePill() {
    const pill = document.getElementById('training-log-pill');
    if (!pill) return;
    if (_running) {
      pill.textContent = 'Running...';
      pill.className = 'pill pill-yellow';
    } else {
      pill.textContent = 'Idle';
      pill.className = 'pill pill-green';
    }
  }

  // ─── TRAINING HISTORY ───────────────────────────────────────────────────────
  function _bindHistory() {
    if (_historyBound) return;
    _historyBound = true;

    const refresh = document.getElementById('training-history-refresh');
    if (refresh) refresh.addEventListener('click', () => _loadHistory());

    const tbody = document.getElementById('training-history-tbody');
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-run-id]');
        if (!row) return;
        const run = _historyRuns.find(r => r.id === row.dataset.runId);
        if (run) _showRunModal(run);
      });
    }
  }

  async function _fetchHistoryLight() {
    try {
      const res = await fetch(`${API}/api/training-history`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      _historyRuns = data.runs || [];
      _setText('training-history-count', String(data.total ?? _historyRuns.length));
      if (_activeTab === 'history') {
        _renderHistoryTable();
        _renderHistoryCharts();
      } else if (_activeTab === 'live' && !_running) {
        if (!_trainLoss.length && !_valLoss.length) _syncLiveFromLastRun();
        if (_mounted) _remountLiveView();
      }
    } catch { /* badge stays at last value */ }
  }

  async function _loadHistory(cached, opts = {}) {
    const hint = document.getElementById('training-history-hint');
    try {
      let data = cached;
      if (!data?.runs) {
        const res = await fetch(`${API}/api/training-history`, { cache: 'no-store' });
        if (res.status === 404) {
          throw new Error('Training history API not found — restart app.py (run_backend.bat).');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      }
      _historyRuns = data.runs || [];
      _setText('training-history-count', String(data.total ?? _historyRuns.length));
      if (hint) hint.hidden = true;
      if (_activeTab === 'history' || opts.forceRender) {
        _renderHistoryTable();
        _renderHistoryCharts();
      }
      if (!_running && !opts.skipLiveSync && _activeTab === 'live') {
        _syncLiveFromLastRun();
      }
    } catch (err) {
      _historyRuns = [];
      if (_activeTab === 'history') _renderHistoryTable();
      if (hint) {
        hint.hidden = false;
        hint.textContent = err.message || 'Could not load training history.';
      }
    }
  }

  function _setHistoryTableVisibility(hasRuns) {
    const empty = document.getElementById('training-history-empty');
    const wrap  = document.getElementById('training-history-table-wrap');
    if (empty) {
      empty.classList.toggle('is-hidden', hasRuns);
      if (hasRuns) empty.setAttribute('hidden', '');
      else empty.removeAttribute('hidden');
    }
    if (wrap) wrap.classList.toggle('is-hidden', !hasRuns);
  }

  function _renderHistoryTable() {
    const tbody = document.getElementById('training-history-tbody');
    if (!tbody) return;

    const hasRuns = _historyRuns.length > 0;
    _setHistoryTableVisibility(hasRuns);

    if (!hasRuns) {
      tbody.innerHTML = '';
      return;
    }

    tbody.innerHTML = _historyRuns.map((run, idx) => {
      const d = new Date(run.completed_at || run.started_at);
      const dateStr = Number.isNaN(d.getTime())
        ? '—'
        : d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const statusPill = run.ok
        ? '<span class="pill pill-green">Completed</span>'
        : '<span class="pill pill-red">Failed</span>';
      const ep = run.epochs_completed ? `Level ${run.epochs_completed}` : '—';
      const vl = run.final_val_loss != null ? Number(run.final_val_loss).toFixed(4) : '—';
      const mae = run.mae_peso != null ? `₱${Number(run.mae_peso).toFixed(2)}` : '—';
      const accVal = run.avg_accuracy_pct ?? run.accuracy_pct;
      const acc = accVal != null ? `${Number(accVal).toFixed(1)}%` : '—';

      return `<tr data-run-id="${_esc(run.id)}" title="View run details">
        <td><span class="font-mono text-sm">#${_historyRuns.length - idx}</span></td>
        <td>${_esc(dateStr)}</td>
        <td>${statusPill}</td>
        <td class="font-mono">${_esc(ep)}</td>
        <td class="font-mono">${_esc(vl)}</td>
        <td class="font-mono">${_esc(mae)}</td>
        <td class="font-mono">${_esc(acc)}</td>
        <td>${_esc(run.duration || '—')}</td>
        <td class="row-chevron">${SVG_CHEVRON}</td>
      </tr>`;
    }).join('');
  }

  function _renderHistoryCharts() {
    const pathCanvas = document.getElementById('history-path-chart');
    const accCanvas  = document.getElementById('history-accuracy-chart');
    const hint       = document.getElementById('history-path-hint');
    if (!pathCanvas || !AgriPricePH.Charts?.lineChart) return;

    const completed = [..._historyRuns].reverse().filter(r => r.ok && r.final_val_loss != null);
    if (!completed.length) {
      if (hint) hint.hidden = false;
      AgriPricePH.Charts.lossCurve(pathCanvas, [], []);
      if (accCanvas) AgriPricePH.Charts.lossCurve(accCanvas, [], []);
      return;
    }
    if (hint) hint.hidden = true;

    const labels = completed.map((r, i) => `Run ${i + 1}`);
    const valLosses = completed.map(r => Number(r.final_val_loss));
    const accuracies = completed.map(r => Number(r.accuracy_pct) || 0);

    AgriPricePH.Charts.lineChart(pathCanvas, [
      { data: valLosses, color: '#3B82F6', fill: true, lineWidth: 2, label: 'Val Loss' },
    ], { minY: 0, labels });

    if (accCanvas) {
      AgriPricePH.Charts.lineChart(accCanvas, [
        { data: accuracies, color: '#4CAF6E', fill: true, lineWidth: 2, label: 'Accuracy %' },
      ], { minY: 0, maxY: 100, labels });
    }
  }

  function _showRunModal(run) {
    const started = _fmtDate(run.started_at);
    const completed = _fmtDate(run.completed_at);
    const statusLabel = run.ok ? 'Completed' : 'Failed';
    const statusClass = run.ok ? 'pill-green' : 'pill-red';

    const insights = (run.insights || []).map(text => `
      <li>${SVG_INSIGHT}<span>${_esc(text)}</span></li>`).join('');

    const logHtml = (run.log_excerpt || []).map(line => {
      let cls = '';
      if (/error|failed|exception/i.test(line)) cls = 'log-err';
      else if (/warn/i.test(line)) cls = 'log-warn';
      else if (/\[DONE\]|\[SAVED\]|complete/i.test(line)) cls = 'log-ok';
      return `<div class="${cls}">${_esc(line)}</div>`;
    }).join('') || '<div>No log excerpt saved for this run.</div>';

    const metricsHtml = `
      <div class="training-modal-metrics">
        <div class="training-modal-metric"><label>Status</label><div class="val"><span class="pill ${statusClass}">${statusLabel}</span></div></div>
        <div class="training-modal-metric"><label>Backend</label><div class="val">${_esc(run.backend || '—')}</div></div>
        <div class="training-modal-metric"><label>Epoch Level</label><div class="val">${run.epochs_completed ? 'Level ' + _esc(String(run.epochs_completed)) : '—'}</div></div>
        <div class="training-modal-metric"><label>Duration</label><div class="val">${_esc(run.duration || '—')}</div></div>
        <div class="training-modal-metric"><label>Final Train Loss</label><div class="val">${_fmtNum(run.final_train_loss, 4)}</div></div>
        <div class="training-modal-metric"><label>Final Val Loss</label><div class="val">${_fmtNum(run.final_val_loss, 4)}</div></div>
        <div class="training-modal-metric"><label>MAE (PHP/kg)</label><div class="val">${run.mae_peso != null ? '₱' + Number(run.mae_peso).toFixed(2) : '—'}</div></div>
        <div class="training-modal-metric"><label>RMSE (PHP/kg)</label><div class="val">${run.rmse_peso != null ? '₱' + Number(run.rmse_peso).toFixed(2) : '—'}</div></div>
        <div class="training-modal-metric"><label>Accuracy (Avg, all trained types)</label><div class="val">${(run.avg_accuracy_pct ?? run.accuracy_pct) != null ? Number(run.avg_accuracy_pct ?? run.accuracy_pct).toFixed(1) + '%' : '—'}</div></div>
        <div class="training-modal-metric"><label>Primary target accuracy</label><div class="val">${run.primary_accuracy_pct != null ? Number(run.primary_accuracy_pct).toFixed(1) + '%' : '—'}</div></div>
        <div class="training-modal-metric"><label>Data Through</label><div class="val">${_esc(run.last_data_date || '—')}</div></div>
        <div class="training-modal-metric"><label>Train Samples</label><div class="val">${_esc(String(run.train_samples ?? '—'))}</div></div>
        <div class="training-modal-metric"><label>Test Samples</label><div class="val">${_esc(String(run.test_samples ?? '—'))}</div></div>
      </div>`;

    const overlay = document.createElement('div');
    overlay.className = 'ds-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ds-modal-box ds-modal-wide ds-modal-summary';
    box.innerHTML = `
      <div class="ds-modal-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4CAF6E"
          stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/>
        </svg>
      </div>
      <h3 class="ds-modal-title">Training Run — ${_esc(run.id)}</h3>
      <p class="text-xs text-muted" style="margin-bottom:12px;">${_esc(started)} → ${_esc(completed)}</p>
      <div class="ds-modal-text">
        ${metricsHtml}
        <div class="training-modal-chart-wrap">
          <div class="text-xs text-muted" style="margin-bottom:8px;font-weight:600;">Epoch loss curve (this run)</div>
          <canvas id="modal-run-loss-chart" style="width:100%;height:200px;display:block;"></canvas>
        </div>
        ${insights ? `<p class="text-xs text-muted" style="font-weight:600;margin-top:8px;">Insights</p><ul class="training-insights-list">${insights}</ul>` : ''}
        <p class="text-xs text-muted" style="font-weight:600;margin-top:16px;">Log excerpt</p>
        <div class="training-modal-log">${logHtml}</div>
      </div>
      <div class="ds-modal-actions">
        <button type="button" class="btn btn-primary btn-sm" data-modal="confirm">Close</button>
      </div>`;

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const close = () => {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 200);
    };
    box.querySelector('[data-modal="confirm"]').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const modalCanvas = box.querySelector('#modal-run-loss-chart');
    if (modalCanvas && AgriPricePH.Charts?.lossCurve) {
      const t = run.train_loss_curve || [];
      const v = run.val_loss_curve || [];
      if (t.length) AgriPricePH.Charts.lossCurve(modalCanvas, t, v);
      else AgriPricePH.Charts.lossCurve(modalCanvas, [0], [0]);
    }
  }

  // ─── LOG HELPERS ────────────────────────────────────────────────────────────
  const _LEVEL_CLASS = {
    INFO: 'log-level-info', WARN: 'log-level-warn', WARNING: 'log-level-warn',
    ERROR: 'log-level-error', SUCCESS: 'log-level-success', DONE: 'log-level-success',
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
    const time = new Date().toLocaleTimeString('en-PH', { hour12: true });
    const entry = { time, level, msg };
    _logs.push(entry);
    const el = document.getElementById('training-log');
    if (el) {
      _writeLine(el, time, level, msg);
      el.scrollTop = el.scrollHeight;
    }
  }

  function _setEpochLevel(level) {
    const el = document.getElementById('epoch-level');
    if (el) el.textContent = String(level);
  }

  function _rateLoss(v) {
    if (!Number.isFinite(v)) return 'none';
    if (v <= 0.01) return 'ok';
    if (v <= 0.05) return 'warn';
    return 'bad';
  }

  function _rateValLoss(v, trainV) {
    let s = _rateLoss(v);
    if (s === 'none') return s;
    if (Number.isFinite(trainV) && trainV > 0 && v > trainV * 1.35) {
      s = s === 'ok' ? 'warn' : 'bad';
    }
    if (Number.isFinite(trainV) && trainV > 0 && v > trainV * 2) return 'bad';
    return s;
  }

  function _rateMae(v) {
    if (!Number.isFinite(v)) return 'none';
    if (v > 1) {
      if (v <= 0.45) return 'ok';
      if (v <= 1.2) return 'warn';
      return 'bad';
    }
    if (v <= 0.05) return 'ok';
    if (v <= 0.2) return 'warn';
    return 'bad';
  }

  function _setMetricStatus(kind, level) {
    const el = document.getElementById(`metric-${kind}-status`);
    if (!el) return;
    const key = METRIC_STATUS_LABEL[level] ? level : 'none';
    el.className = `metric-status metric-status-${key}`;
    el.innerHTML = SVG_METRIC_STATUS[key] || SVG_METRIC_STATUS.none;
    el.title = METRIC_STATUS_LABEL[key];
    el.setAttribute('aria-label', METRIC_STATUS_LABEL[key]);
  }

  function _refreshMetricStatuses() {
    _setMetricStatus('train-loss', _rateLoss(_metricNums.train));
    _setMetricStatus('val-loss', _rateValLoss(_metricNums.val, _metricNums.train));
    _setMetricStatus('mae', _rateMae(_metricNums.mae));
  }

  function _setTrainingMetric(kind, text, num) {
    _setText(`metric-${kind}`, text);
    if (kind === 'train-loss') {
      _metricNums.train = num;
      _metricDisplay.train = text;
    } else if (kind === 'val-loss') {
      _metricNums.val = num;
      _metricDisplay.val = text;
    } else if (kind === 'mae') {
      _metricNums.mae = num;
      _metricDisplay.mae = text;
    }
    _refreshMetricStatuses();
  }

  function _clearTrainingMetrics() {
    _metricNums = { train: null, val: null, mae: null };
    _metricDisplay = { train: '—', val: '—', mae: '—' };
    _setTrainingMetric('train-loss', '—', null);
    _setTrainingMetric('val-loss', '—', null);
    _setTrainingMetric('mae', '—', null);
  }

  function _setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
    if (id === 'training-status-label') _cachedStatusLabel = val;
    if (id === 'metric-duration') _cachedDuration = val;
  }

  function _getText(id) {
    const el = document.getElementById(id);
    return el ? el.textContent : '';
  }

  function _esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _fmtNum(n, dec) {
    return n != null && Number.isFinite(Number(n)) ? Number(n).toFixed(dec) : '—';
  }

  function _fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  return { init, destroy, isActive, confirmLeave, cancelTraining: _cancelTraining };

})();
