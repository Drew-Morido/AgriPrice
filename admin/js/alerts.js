/* AgriPricePH — Price Alerts (rules + notification log + live evaluation) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Alerts = (function () {

  let _rules = [];
  let _log = [];
  let _apiOnline = false;
  let _apiError = '';
  let _loading = false;
  let _evaluating = false;
  let _bound = false;
  let _loadGen = 0;

  const COLORS = { danger: '#EF4444', info: '#3B82F6', warning: '#F59E0B', success: '#4CAF6E' };

  const RICE_OPTIONS = [
    { value: 'locWellMilled', label: 'Local Well-Milled' },
    { value: 'locRegular', label: 'Local Regular' },
    { value: 'locPremium', label: 'Local Premium' },
    { value: 'locSpecial', label: 'Local Special' },
    { value: 'impWellMilled', label: 'Imported Well-Milled' },
    { value: 'impRegular', label: 'Imported Regular' },
    { value: 'impPremium', label: 'Imported Premium' },
    { value: 'impSpecial', label: 'Imported Special' },
    { value: 'all', label: 'All Rice Types' },
  ];

  const CONDITION_OPTIONS = [
    { value: 'above', label: 'Price above (₱)', thresholdStep: '0.01', placeholder: '55.00' },
    { value: 'below', label: 'Price below (₱)', thresholdStep: '0.01', placeholder: '44.00' },
    { value: 'change_up', label: '3-day change greater than (%)', thresholdStep: '0.1', placeholder: '5' },
    { value: 'change_down', label: '3-day drop greater than (%)', thresholdStep: '0.1', placeholder: '5' },
    { value: 'confidence_below', label: 'Forecast confidence below (%)', thresholdStep: '1', placeholder: '75' },
  ];

  function init() {
    populateFormSelects();
    bindEvents();
    loadAlerts();
  }

  function destroy() {
    _bound = false;
    _loadGen += 1;
    closeModal();
  }

  function populateFormSelects() {
    const riceSel = document.getElementById('alert-form-rice');
    const condSel = document.getElementById('alert-form-condition');
    if (riceSel && !riceSel.dataset.ready) {
      riceSel.innerHTML = RICE_OPTIONS.map(o =>
        `<option value="${o.value}">${o.label}</option>`
      ).join('');
      riceSel.dataset.ready = '1';
    }
    if (condSel && !condSel.dataset.ready) {
      condSel.innerHTML = CONDITION_OPTIONS.map(o =>
        `<option value="${o.value}">${o.label}</option>`
      ).join('');
      condSel.dataset.ready = '1';
      condSel.addEventListener('change', updateThresholdHint);
      updateThresholdHint();
    }
  }

  function updateThresholdHint() {
    const cond = document.getElementById('alert-form-condition')?.value;
    const th = document.getElementById('alert-form-threshold');
    const opt = CONDITION_OPTIONS.find(o => o.value === cond);
    if (th && opt) {
      th.step = opt.thresholdStep;
      th.placeholder = opt.placeholder;
    }
  }

  function bindEvents() {
    if (_bound) return;
    _bound = true;

    document.getElementById('add-alert-btn')?.addEventListener('click', () => openModal());
    document.getElementById('alerts-run-check-btn')?.addEventListener('click', () => runEvaluate(true));
    document.getElementById('clear-notif-log-btn')?.addEventListener('click', clearLog);
    document.getElementById('alert-modal-close')?.addEventListener('click', closeModal);
    document.getElementById('alert-modal-cancel')?.addEventListener('click', closeModal);
    document.getElementById('alert-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'alert-modal-overlay') closeModal();
    });
    document.getElementById('alert-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      saveRule();
    });

    const rulesList = document.getElementById('alert-rules-list');
    rulesList?.addEventListener('change', (e) => {
      const inp = e.target.closest('[data-toggle-rule]');
      if (!inp) return;
      toggleRule(inp.dataset.toggleRule, inp.checked);
    });
    rulesList?.addEventListener('click', (e) => {
      const editBtn = e.target.closest('[data-edit-rule]');
      const delBtn = e.target.closest('[data-delete-rule]');
      if (editBtn) openModal(editBtn.dataset.editRule);
      if (delBtn) deleteRule(delBtn.dataset.deleteRule);
    });
  }

  function setLoadingState(loading) {
    _loading = loading;
    const list = document.getElementById('alert-rules-list');
    const logList = document.getElementById('notif-log-list');
    if (loading) {
      const msg = '<div class="dash-pred-loading text-muted" style="padding:16px;">Loading alert rules…</div>';
      if (list) list.innerHTML = msg;
      if (logList) logList.innerHTML = msg;
    }
  }

  async function loadAlerts() {
    const gen = ++_loadGen;
    setLoadingState(true);
    updateStatusBanner('');

    try {
      const data = await AgriPricePH.API.alerts();
      if (gen !== _loadGen) return;

      if (data.error && data.ready === false) {
        throw new Error(data.error);
      }

      _apiOnline = true;
      _apiError = '';
      _rules = data.rules || [];
      _log = data.log || [];
      _loading = false;
      syncLocalData();
      refreshUI(data.summary || {});
      AgriPricePH.Topbar?.refreshAlertBadge?.();
    } catch (e) {
      if (gen !== _loadGen) return;
      console.warn('Alerts API offline:', e);
      _apiOnline = false;
      _apiError = e.message || 'Backend unavailable';
      _rules = [];
      _log = [];
      _loading = false;
      syncLocalData();
      refreshUI({});
      updateStatusBanner(
        'Cannot reach the alerts API. Run python api/app.py and refresh. Mock data is not used on this page.'
      );
    }
  }

  async function runEvaluate(showFeedback) {
    if (_evaluating) return;
    if (!_apiOnline) {
      if (showFeedback) showToast('Start the API server before running a price check.', true);
      return;
    }

    const btn = document.getElementById('alerts-run-check-btn');
    _evaluating = true;
    if (btn) {
      btn.disabled = true;
      btn.dataset.busy = '1';
    }

    try {
      const res = await AgriPricePH.API.post('/api/alerts/evaluate');
      const d = res.data || {};

      if (res.ok && d.success !== false) {
        if (Array.isArray(d.rules)) _rules = d.rules;
        if (Array.isArray(d.log)) _log = d.log;
        syncLocalData();
        refreshUI({
          triggered_today: d.triggered_today,
          rules_count: d.rules?.length ?? _rules.length,
          active_rules: _rules.filter(r => r.active).length,
        });
        AgriPricePH.Topbar?.refreshAlertBadge?.();
        if (showFeedback) {
          const n = d.new_count || 0;
          showToast(n ? `${n} new notification(s) added.` : 'Check complete — no new triggers.');
        }
      } else if (showFeedback) {
        showToast(d.error || 'Alert check failed.', true);
      }
    } catch (e) {
      if (showFeedback) showToast('Backend offline — cannot run alert check.', true);
    } finally {
      _evaluating = false;
      if (btn) {
        btn.disabled = false;
        delete btn.dataset.busy;
      }
    }
  }

  function updateStatusBanner(message) {
    let el = document.getElementById('alerts-status-banner');
    if (!message) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'alerts-status-banner';
      el.className = 'alerts-status-banner error';
      const header = document.querySelector('#page-outlet .section-header');
      header?.insertAdjacentElement('afterend', el);
    }
    el.className = 'alerts-status-banner error';
    el.textContent = message;
  }

  function syncLocalData() {
    AgriPricePH.Data.alertRules = _rules.map(r => ({
      id: r.id,
      name: r.name,
      rice: r.rice,
      condition: r.condition_label || r.condition,
      value: r.value,
      type: r.type,
      active: r.active,
      triggered: r.triggered,
    }));
    AgriPricePH.Data.notifLog = _log.map(n => ({
      type: n.type,
      title: n.title,
      desc: n.desc,
      time: n.time,
    }));
  }

  function refreshUI(summary) {
    updateSubtitle(summary);
    renderAlertRules();
    renderNotifLog();
  }

  function updateSubtitle(summary) {
    const el = document.getElementById('alerts-page-subtitle');
    if (!el) return;
    if (_loading) {
      el.textContent = 'Loading…';
      return;
    }
    if (!_apiOnline) {
      el.textContent = 'Offline — API not connected';
      return;
    }
    const total = summary.rules_count ?? _rules.length;
    const active = summary.active_rules ?? _rules.filter(r => r.active).length;
    const today = summary.triggered_today ?? 0;
    el.textContent = `${total} rules configured · ${active} active · ${today} triggered today`;
  }

  function renderAlertRules() {
    const list = document.getElementById('alert-rules-list');
    const empty = document.getElementById('alert-rules-empty');
    if (!list) return;
    if (_loading) return;

    if (!_rules.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = _rules.map(r => {
      const c = COLORS[r.type] || COLORS.warning;
      const triggered = (r.triggered || 0) > 0
        ? `<span class="alert-triggered-badge">${r.triggered}× triggered</span>` : '';
      return `
        <div class="alert-rule-item${r.active ? '' : ' inactive'}" data-rule-id="${r.id}">
          <div class="alert-rule-icon" style="background:${c}22;">${svgBell(c)}</div>
          <div class="alert-rule-main">
            <div class="alert-rule-name">${escapeHtml(r.name)}${triggered}</div>
            <div class="alert-rule-desc">${escapeHtml(r.rice)} — ${escapeHtml(r.condition_label || r.condition)} ${escapeHtml(r.value)}</div>
          </div>
          <div class="alert-rule-value" style="color:${c}">${escapeHtml(r.value)}</div>
          <div class="alert-rule-actions">
            <label class="toggle-switch" title="Enable/disable rule">
              <input type="checkbox" data-toggle-rule="${r.id}" ${r.active ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <button type="button" class="btn btn-ghost btn-sm" data-edit-rule="${r.id}">Edit</button>
            <button type="button" class="btn btn-ghost btn-sm" data-delete-rule="${r.id}" style="color:var(--color-danger);">Delete</button>
          </div>
        </div>`;
    }).join('');
  }

  function renderNotifLog() {
    const list = document.getElementById('notif-log-list');
    const empty = document.getElementById('notif-log-empty');
    if (!list || _loading) return;

    if (!_log.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = _log.map(n => {
      const c = COLORS[n.type] || COLORS.info;
      return `
        <div class="notif-item">
          <div class="notif-icon" style="background:${c}22;">${svgBell(c)}</div>
          <div style="flex:1;min-width:0;">
            <div class="notif-title">${escapeHtml(n.title)}</div>
            <div class="notif-desc">${escapeHtml(n.desc)}</div>
          </div>
          <span class="notif-time">${escapeHtml(n.time || '—')}</span>
        </div>`;
    }).join('');
  }

  function openModal(ruleId) {
    if (!_apiOnline) {
      showToast('Connect to the API server to manage alert rules.', true);
      return;
    }
    const overlay = document.getElementById('alert-modal-overlay');
    const title = document.getElementById('alert-modal-title');
    const idInp = document.getElementById('alert-form-id');
    if (!overlay) return;

    const rule = ruleId ? _rules.find(r => r.id === ruleId) : null;
    if (title) title.textContent = rule ? 'Edit Alert Rule' : 'Add Alert Rule';
    if (idInp) idInp.value = rule?.id || '';
    document.getElementById('alert-form-name').value = rule?.name || '';
    document.getElementById('alert-form-rice').value = rule?.rice_key || 'locWellMilled';
    document.getElementById('alert-form-condition').value = rule?.condition || 'above';
    document.getElementById('alert-form-threshold').value = rule?.threshold ?? '';
    document.getElementById('alert-form-type').value = rule?.type || 'warning';
    document.getElementById('alert-form-active').checked = rule ? !!rule.active : true;
    updateThresholdHint();
    overlay.hidden = false;
  }

  function closeModal() {
    const overlay = document.getElementById('alert-modal-overlay');
    if (overlay) overlay.hidden = true;
  }

  async function saveRule() {
    const id = document.getElementById('alert-form-id')?.value;
    const payload = {
      name: document.getElementById('alert-form-name')?.value.trim(),
      rice_key: document.getElementById('alert-form-rice')?.value,
      condition: document.getElementById('alert-form-condition')?.value,
      threshold: parseFloat(document.getElementById('alert-form-threshold')?.value),
      type: document.getElementById('alert-form-type')?.value,
      active: document.getElementById('alert-form-active')?.checked,
    };

    try {
      let res;
      if (id) {
        res = await AgriPricePH.API.put(`/api/alerts/rules/${id}`, payload);
      } else {
        res = await AgriPricePH.API.post('/api/alerts/rules', payload);
      }
      if (!res.ok) throw new Error(res.data?.error || 'Save failed');
      closeModal();
      await loadAlerts();
      showToast(id ? 'Rule updated.' : 'Rule created.');
    } catch (e) {
      showToast(e.message || 'Could not save rule.', true);
    }
  }

  async function toggleRule(ruleId, active) {
    const idx = _rules.findIndex(r => r.id === ruleId);
    if (idx < 0) return;

    const prev = _rules[idx].active;
    _rules[idx] = { ..._rules[idx], active };
    renderAlertRules();

    try {
      const res = await AgriPricePH.API.post(`/api/alerts/rules/${ruleId}/toggle`, { active });
      if (!res.ok) throw new Error(res.data?.error);
      if (res.data.rule) _rules[idx] = res.data.rule;
      syncLocalData();
      renderAlertRules();
    } catch (e) {
      _rules[idx] = { ..._rules[idx], active: prev };
      renderAlertRules();
      showToast('Could not toggle rule.', true);
    }
  }

  async function deleteRule(ruleId) {
    if (!confirm('Delete this alert rule?')) return;
    try {
      const res = await AgriPricePH.API.delete(`/api/alerts/rules/${ruleId}`);
      if (!res.ok) throw new Error(res.data?.error);
      _rules = _rules.filter(r => r.id !== ruleId);
      syncLocalData();
      refreshUI({});
      showToast('Rule deleted.');
    } catch (e) {
      showToast('Could not delete rule.', true);
    }
  }

  async function clearLog() {
    if (!confirm('Clear all notification log entries?')) return;
    try {
      const res = await AgriPricePH.API.delete('/api/alerts/log');
      if (!res.ok) throw new Error(res.data?.error);
      _log = [];
      syncLocalData();
      renderNotifLog();
      showToast('Notification log cleared.');
    } catch (e) {
      showToast('Could not clear log.', true);
    }
  }

  function showToast(msg, isError) {
    let el = document.getElementById('alerts-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'alerts-toast';
      el.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:1100;padding:12px 18px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:var(--shadow-md);max-width:320px;transition:opacity 0.3s;';
      document.body.appendChild(el);
    }
    el.style.background = isError ? '#FEE2E2' : 'var(--color-accent-light)';
    el.style.color = isError ? '#B91C1C' : 'var(--color-accent-dark, #2D8A50)';
    el.style.border = isError ? '1px solid #FECACA' : '1px solid rgba(76,175,110,0.3)';
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 3500);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function svgBell(color) {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
  }

  function getRecentAlerts(limit = 5) {
    return _log.slice(0, limit);
  }

  function applySearchContext() {
    /* no-op — navigates to alerts page only */
  }

  return { init, destroy, loadAlerts, getRecentAlerts, applySearchContext };
})();
