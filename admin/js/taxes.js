/* AgriPricePH — Admin "Taxes & Import Charges" module (admin-only).
   Import charges on imported rice affect consumer prices; this view manages/reviews them and
   previews the resulting consumer price. The public rice catalog lives on the public site.

   UI follows the "less text heavy" redesign: long always-visible legal paragraphs become
   click-to-open info popovers, a stat strip gives the page a real-numbers pulse, and the old
   <details> add-form becomes an inline slide-down panel. All real data/endpoints are unchanged —
   only presentation changed. See admin/css/taxes.css for the shared `tx-` component styles
   (all built on the app's existing theme tokens, so dark mode works automatically). */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Taxes = (function () {
  const $ = (id) => document.getElementById(id);
  const peso = (v) => (v == null || isNaN(v)) ? '—' : `₱${Number(v).toFixed(2)}`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- module state (raw API payloads, re-filtered/re-rendered on search/toggle changes) ----
  let _taxRows = [];
  let _tariffSchedule = [];
  let _tariffApplicable = null;
  let _tariffBand = { min: 15, max: 35 };
  let _lastAddedTariffId = null;

  function adminToken() {
    try { return JSON.parse(sessionStorage.getItem('agriprice_admin_session') || 'null')?.token || ''; }
    catch { return ''; }
  }

  // Shared markup for the info-icon glyph inside every .tx-info-btn (kept in one place so the
  // static HTML and the rows generated here always render the same icon).
  const INFO_ICON_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="11" x2="12" y2="17"/><circle cx="12" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>';

  // One consistent popover shape everywhere it's used: a short uppercase label, the explanation,
  // and an optional muted footer line — see .tx-pop-title/.tx-pop-body/.tx-pop-meta in taxes.css.
  // bodyHtml/metaHtml are trusted HTML (already esc()'d by the caller where the source is data).
  function infoBtnHtml(id, title, bodyHtml, metaHtml) {
    return `<div class="tx-info-btn" id="${id}" onclick="AgriPricePH.Taxes.toggleInfo('${id}')">
      ${INFO_ICON_SVG}
      <div class="tx-info-pop">
        <div class="tx-pop-title">${esc(title)}</div>
        <div class="tx-pop-body">${bodyHtml}</div>
        ${metaHtml ? `<div class="tx-pop-meta">${metaHtml}</div>` : ''}
      </div>
    </div>`;
  }

  function srcCell(url, label) {
    const text = esc(label || 'Source');
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener" style="color:var(--color-accent);text-decoration:underline;">${text}</a>` : text;
  }

  // Derive a short legal-basis tag for table cells; the full text lives in the info popover
  // (this is the "less text heavy" pattern — a long paragraph never sits directly in a cell).
  function legalTag(text) {
    const s = String(text || '').trim();
    if (!s) return '—';
    if (s.length <= 34) return s;
    const cut = s.slice(0, 40);
    const sepIdx = Math.max(cut.lastIndexOf(';'), cut.lastIndexOf(' —'), cut.lastIndexOf(' ('));
    const head = sepIdx > 12 ? cut.slice(0, sepIdx) : cut.slice(0, 34).replace(/\s+\S*$/, '');
    return (head.trim() || cut.trim()) + '…';
  }

  // ================= Info popovers =================
  // Each .tx-info-btn is authored with its popover as a normal DOM child (simple to template).
  // On first open we move that popover to <body> and switch it to position:fixed with coordinates
  // computed from the button's own position — the only reliable way to keep it from being clipped
  // by a horizontally-scrolling ancestor (e.g. the tariff table's .table-wrap: overflow-x:auto
  // implicitly computes overflow-y:auto too, which was cutting the legal-basis popover off).
  // Hover reveals it transiently; click/tap "pins" it open (stays open while the pointer wanders,
  // until an outside click, another popover opening, or clicking the same button again) —
  // toggleInfo() is still the one function every onclick handler in the HTML calls.
  let _hideTimer = null;

  // Rows/chips get rebuilt wholesale via innerHTML on every refresh; any popover already moved
  // out to <body> for a button about to be destroyed would otherwise be orphaned there forever.
  function cleanupMovedPopovers(container) {
    if (!container) return;
    container.querySelectorAll('.tx-info-btn').forEach(btn => {
      if (btn._infoPop) { btn._infoPop.remove(); btn._infoPop = null; }
    });
  }

  function popoverFor(btn) {
    if (!btn._infoPop) {
      const pop = btn.querySelector('.tx-info-pop');
      if (!pop) return null;
      document.body.appendChild(pop);
      pop._ownerBtn = btn;
      btn._infoPop = pop;
    }
    return btn._infoPop;
  }

  function showPop(btn) {
    const pop = popoverFor(btn);
    if (!pop) return;
    document.querySelectorAll('.tx-info-btn.open').forEach(b => { if (b !== btn) hidePop(b); });
    pop.style.top = '-9999px';
    pop.style.left = '0px';
    pop.classList.add('is-open');
    const r = btn.getBoundingClientRect();
    const popW = pop.offsetWidth || 300;
    let left = r.right - popW; // right-align to the button by default — reads naturally in a row
    if (left < 8) left = Math.min(r.left, window.innerWidth - popW - 8);
    left = Math.max(8, left);
    let top = r.bottom + 6;
    const popH = pop.offsetHeight;
    if (top + popH > window.innerHeight - 8) top = r.top - popH - 6; // flip above if no room below
    pop.style.left = left + 'px';
    pop.style.top = Math.max(8, top) + 'px';
    btn.classList.add('open');
  }

  function hidePop(btn) {
    btn.classList.remove('open');
    delete btn.dataset.pinned;
    if (btn._infoPop) btn._infoPop.classList.remove('is-open');
  }

  function toggleInfo(id) {
    const btn = $(id);
    if (!btn) return;
    const wasPinned = btn.dataset.pinned === '1';
    document.querySelectorAll('.tx-info-btn.open').forEach(b => { if (b !== btn) hidePop(b); });
    if (wasPinned) {
      hidePop(btn);
    } else {
      showPop(btn);
      btn.dataset.pinned = '1';
    }
  }

  function bindOutsideClose() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.tx-info-btn') && !e.target.closest('.tx-info-pop')) {
        document.querySelectorAll('.tx-info-btn.open').forEach(hidePop);
      }
    });

    // Hover: reveal on entering the button, keep open while the pointer is over the (now
    // body-appended, separately-positioned) popover too, close shortly after leaving both —
    // unless it's pinned open by a click, which only an outside click or re-click clears.
    document.addEventListener('mouseenter', (e) => {
      const btn = e.target.closest && e.target.closest('.tx-info-btn');
      if (btn) { clearTimeout(_hideTimer); showPop(btn); return; }
      const pop = e.target.closest && e.target.closest('.tx-info-pop');
      if (pop) clearTimeout(_hideTimer);
    }, true);
    document.addEventListener('mouseleave', (e) => {
      const btn = e.target.closest && e.target.closest('.tx-info-btn');
      const owner = btn || (e.target.closest && e.target.closest('.tx-info-pop')?._ownerBtn);
      if (!owner || owner.dataset.pinned === '1') return;
      clearTimeout(_hideTimer);
      _hideTimer = setTimeout(() => hidePop(owner), 150);
    }, true);
    const closeAll = () => document.querySelectorAll('.tx-info-btn.open').forEach(hidePop);
    window.addEventListener('resize', closeAll);
    window.addEventListener('scroll', closeAll, true);
  }

  // ================= Next certification countdown =================
  function renderCountdown() {
    const el = $('countdownDays');
    if (!el) return;
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth(); // 0-based
    const nextQuarterMonth = Math.floor(m / 3) * 3 + 3; // first month of the next quarter
    const nextQuarterStart = nextQuarterMonth > 11
      ? new Date(y + 1, 0, 1)
      : new Date(y, nextQuarterMonth, 1);
    const days = Math.max(0, Math.ceil((nextQuarterStart - today) / (1000 * 60 * 60 * 24)));
    el.textContent = days + (days === 1 ? ' day' : ' days');
  }

  // ================= Stat strip (mockup's original 4 stats — Active/Average/Review/Deactivated) =================
  // "Charges" here means every row the table can show: the Default charges from /api/taxes
  // (currently VAT — the tariff Default is represented by its live schedule row, not duplicated)
  // plus every row in the tariff schedule.
  function renderStats() {
    const wrap = $('tax-stats');
    if (!wrap) return;
    const defaultCharges = _taxRows.filter(t => t.kind !== 'tariff'); // always active, not toggleable
    const totalCharges = defaultCharges.length + _tariffSchedule.length;
    const activeCharges = defaultCharges.length + _tariffSchedule.filter(r => r.active).length;
    const deactivated = _tariffSchedule.filter(r => !r.active).length;
    const unverified = defaultCharges.filter(t => !t.verified).length
      + _tariffSchedule.filter(r => r.active && !r.verified).length;

    const percentRates = [
      ...defaultCharges.filter(t => t.rate_pct != null).map(t => Number(t.rate_pct)),
      ..._tariffSchedule.filter(r => r.active).map(r => Number(r.rate_pct)),
    ];
    const avgRate = percentRates.length ? (percentRates.reduce((s, v) => s + v, 0) / percentRates.length) : 0;

    wrap.innerHTML = `
      <div class="tx-stat">
        <p class="tx-stat-label">Active charges</p>
        <p class="tx-stat-value accent">${activeCharges}<small> of ${totalCharges} total</small></p>
      </div>
      <div class="tx-stat">
        <p class="tx-stat-label">Average rate</p>
        <p class="tx-stat-value">${avgRate.toFixed(1)}%<small> across active charges</small></p>
      </div>
      <div class="tx-stat">
        <p class="tx-stat-label">Needs review</p>
        <p class="tx-stat-value">${unverified}<small> unverified</small></p>
      </div>
      <div class="tx-stat">
        <p class="tx-stat-label">Deactivated</p>
        <p class="tx-stat-value">${deactivated}<small> kept for record</small></p>
      </div>`;
  }

  // ================= Tax components (VAT etc.) — feed the table's "Default" rows =================
  // /api/taxes is read-only reference data (no edit endpoint); its non-tariff rows (VAT) render
  // as Default rows in the tariff table itself (see renderTariffTable) rather than a second table
  // or a separate strip of chips — one table, matching the mockup's single-table concept.
  async function loadTaxes() {
    try {
      const d = await AgriPricePH.API.taxes();
      _taxRows = d.taxes || [];
    } catch (e) {
      _taxRows = [];
    }
    renderTariffTable();
    renderStats();
  }

  // ================= Tariff schedule (the real editable resource) =================
  async function loadTariff() {
    const chip = $('tariff-status-chip');
    const staleWrap = $('tariff-stale-wrap');
    try {
      const d = await AgriPricePH.API.tariff();
      _tariffSchedule = d.schedule || [];
      _tariffApplicable = d.applicable || null;
      _tariffBand = d.band || { min: 15, max: 35 };

      if (chip) {
        if (_tariffApplicable) {
          chip.innerHTML = `<span class="tx-pulse-dot"></span> Showing ${esc(_tariffApplicable.quarter_label || '—')} rate (${_tariffApplicable.rate_pct}%)`;
        } else {
          chip.innerHTML = `<span class="tx-pulse-dot"></span> No tariff rate loaded`;
        }
      }

      if (staleWrap) {
        // A real, live-computed notice (not a hardcoded default) — the backend compares today's
        // date against the schedule and only sets `stale` when no confirmed rate exists yet for
        // the current quarter. Rendered as a proper banner (not a table row, not a small chip) so
        // it reads as a system notice; the short label stays put, the full reason lives in its
        // popover — same "less text heavy" pattern as everywhere else on the page.
        cleanupMovedPopovers(staleWrap);
        staleWrap.innerHTML = (_tariffApplicable && _tariffApplicable.stale)
          ? `<div class="tx-alert-banner">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              Showing a stale rate — ${esc(_tariffApplicable.quarter_label || 'the last confirmed quarter')} hasn't been superseded yet
              ${infoBtnHtml('staleInfoBtn', 'Why this rate is shown', esc(_tariffApplicable.stale_reason || 'Rate may be outdated for the current quarter.'))}
            </div>`
          : '';
      }

      renderTariffTable();
      renderTrendChart();
    } catch (e) {
      if (chip) chip.innerHTML = `<span class="tx-pulse-dot"></span> Backend unreachable`;
      _tariffSchedule = [];
      _tariffApplicable = null;
      renderTariffTable();
    }
    renderStats();
  }

  function renderTariffTable() {
    const body = $('tariff-body');
    const countEl = $('tariff-result-count');
    if (!body) return;

    const query = ($('tariff-search')?.value || '').trim().toLowerCase();
    const showInactive = !!$('tariff-show-inactive')?.checked;

    // Default (standing) charges from /api/taxes that have no place of their own in the tariff
    // schedule — currently just VAT. The Tariff default isn't duplicated here: it's whichever
    // schedule row below is currently applicable, marked with the same "Default" badge.
    let defaultCharges = _taxRows.filter(t => t.kind !== 'tariff');
    let rows = _tariffSchedule.filter(r => showInactive || r.active);
    if (query) {
      defaultCharges = defaultCharges.filter(t =>
        String(t.name || '').toLowerCase().includes(query) ||
        String(t.legal_basis || '').toLowerCase().includes(query) ||
        String(t.source || '').toLowerCase().includes(query));
      rows = rows.filter(r =>
        String(r.quarter_label || '').toLowerCase().includes(query) ||
        String(r.legal_basis || '').toLowerCase().includes(query) ||
        String(r.source || '').toLowerCase().includes(query));
    }

    const total = defaultCharges.length + rows.length;
    if (countEl) countEl.textContent = total + (total === 1 ? ' charge' : ' charges') + (query ? ' matching' : '');

    cleanupMovedPopovers(body);
    if (!total) {
      body.innerHTML = `<tr><td colspan="8" class="empty-state">${(_taxRows.length || _tariffSchedule.length) ? 'No charges match your search.' : 'No charges loaded — run datasets/seed_verified_data.py.'}</td></tr>`;
      return;
    }

    const defaultRowsHtml = defaultCharges.map((t, i) => {
      const rateText = t.rate_pct != null ? t.rate_pct + '%' : (t.flat_amount != null ? peso(t.flat_amount) + '/kg' : '—');
      const btnId = `defBtn${i}`;
      return `
        <tr>
          <td>
            <div class="tx-charge-name">${esc(t.name)}</div>
            <div class="tx-pill-row">
              <span class="pill tx-pill-default">Default</span>
              ${t.verified ? '<span class="pill pill-success">Verified</span>' : '<span class="pill pill-warning">Verify</span>'}
            </div>
          </td>
          <td class="rate-val" style="font-weight:600;">${rateText}</td>
          <td>Standing charge</td>
          <td>
            <div class="tx-legal-cell">
              <span class="tx-legal-tag">${esc(legalTag(t.legal_basis))}</span>
              ${t.legal_basis ? infoBtnHtml(btnId, 'Legal basis', esc(t.legal_basis)) : ''}
            </div>
          </td>
          <td class="tx-source-cell">${esc(t.source || '—')}</td>
          <td><span class="pill tx-pill-default">Default</span></td>
          <td><span class="pill pill-success">Active</span></td>
          <td></td>
        </tr>`;
    }).join('');

    const scheduleRowsHtml = rows.map(r => {
      const isActive = !!r.active;
      const isDefault = !!(_tariffApplicable && r.id === _tariffApplicable.id);
      const isAdmin = String(r.entry_type || 'OFFICIAL').toUpperCase() === 'ADMIN';
      const addedByBadge = isAdmin
        ? '<span class="pill pill-admin">Admin Entry</span>'
        : '<span class="pill pill-success">Official / System</span>';
      const identity = r.approved_by && r.approved_by !== 'seed'
        ? `<div class="text-xs text-muted" style="margin-top:3px;">${esc(r.approved_by)}${r.approved_at ? ' · ' + esc(String(r.approved_at).slice(0, 10)) : ''}</div>`
        : '';
      return `
        <tr class="${isActive ? '' : 'tx-inactive-row'} ${r.id === _lastAddedTariffId ? 'tx-just-added' : ''}">
          <td>
            <div class="tx-charge-name">${esc(r.quarter_label || '—')}</div>
            <div class="tx-pill-row">
              ${isDefault ? '<span class="pill tx-pill-default">Default</span>' : ''}
              ${r.verified ? '<span class="pill pill-success">Verified</span>' : '<span class="pill pill-warning">Verify</span>'}
            </div>
          </td>
          <td class="rate-val" style="font-weight:600;">${r.rate_pct}%</td>
          <td>${esc(r.effective_start || '?')} → ${esc(r.effective_end || 'open')}</td>
          <td>
            <div class="tx-legal-cell">
              <span class="tx-legal-tag">${esc(legalTag(r.legal_basis))}</span>
              ${r.legal_basis ? infoBtnHtml(`legalBtn${r.id}`, 'Legal basis', esc(r.legal_basis)) : ''}
            </div>
          </td>
          <td class="tx-source-cell">${srcCell(r.da_certification_url, r.source)}</td>
          <td>${addedByBadge}${identity}</td>
          <td>${isActive ? '<span class="pill pill-success">Active</span>' : '<span class="pill pill-neutral">Deactivated</span>'}</td>
          <td>
            <div class="tx-row-actions">
              <button type="button" class="tx-icon-btn${isActive ? ' danger' : ''}" title="${isActive ? 'Deactivate' : 'Activate'}"
                data-id="${r.id}" data-active="${isActive ? 1 : 0}" data-label="${esc(r.quarter_label || ('#' + r.id))}">
                ${isActive
                  ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>'
                  : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'}
              </button>
            </div>
          </td>
        </tr>`;
    }).join('');

    body.innerHTML = defaultRowsHtml + scheduleRowsHtml;

    body.querySelectorAll('.tx-icon-btn[data-id]').forEach(btn =>
      btn.addEventListener('click', () => toggleTariff(btn)));

    _lastAddedTariffId = null;
  }

  async function toggleTariff(btn) {
    const id = btn.dataset.id;
    const isActive = btn.dataset.active === '1';
    const label = btn.dataset.label || ('#' + id);
    const prompt = isActive
      ? `Deactivate Tariff (${label})?\n\nThis tariff will no longer be used in current tariff / ` +
        `import-charge calculations, but the record will remain available for historical reference.`
      : `Activate Tariff (${label})?\n\nThis tariff may become eligible for current tariff / ` +
        `import-charge calculations according to its effective dates.`;
    if (!confirm(prompt)) return;
    btn.disabled = true;
    try {
      const res = await AgriPricePH.API.tariffSetActive(id, !isActive, adminToken());
      if (res.ok && res.data && res.data.ok) {
        loadTariff();
      } else {
        btn.disabled = false;
        alert((res.data && res.data.error) ||
          (res.status === 401 ? 'Admin session required — please re-login.' : 'Could not update tariff status.'));
      }
    } catch (e) {
      btn.disabled = false;
      alert('Backend unreachable.');
    }
  }

  // ================= Add-rate slide-down form =================
  function openForm() {
    const panel = $('tariff-form');
    if (!panel) return;
    panel.classList.add('open');
    const msg = $('tf-msg'); if (msg) { msg.textContent = ''; msg.className = 'tx-form-msg'; }
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('tf-rate')?.focus();
  }

  function closeForm() {
    $('tariff-form')?.classList.remove('open');
  }

  function toggleForm() {
    const panel = $('tariff-form');
    if (!panel) return;
    if (panel.classList.contains('open')) closeForm(); else openForm();
  }

  async function addTariff() {
    const msg = $('tf-msg');
    const body = {
      rate_pct: parseFloat($('tf-rate').value),
      effective_start: $('tf-start').value,
      effective_end: $('tf-end').value || null,
      quarter_label: $('tf-label').value || null,
      legal_basis: $('tf-basis').value || null,
      da_certification_url: $('tf-url').value || null,
      source: $('tf-url').value ? 'DA certification / BOC CMO (admin entry)' : null,
    };
    if (isNaN(body.rate_pct) || !body.effective_start) {
      msg.className = 'tx-form-msg error'; msg.textContent = 'Rate and effective start are required.'; return;
    }
    // Release confirmation — summarize the actual entry before publishing (backend still validates).
    const summary =
      'Release New Tariff Entry?\n\nPlease review before releasing:\n\n' +
      `  Tariff: Imported rice (MFN import tariff)\n` +
      `  Rate: ${body.rate_pct}%\n` +
      `  Entry Type: Admin Entry\n` +
      `  Effective: ${body.effective_start} → ${body.effective_end || 'open'}\n` +
      `  Source / Basis: ${body.legal_basis || body.da_certification_url || '(none provided)'}\n\n` +
      'Once released, this entry may be used by the system according to its activation rules.';
    if (!confirm(summary)) { msg.className = 'tx-form-msg'; msg.textContent = 'Release cancelled.'; return; }
    const addBtn = $('tf-add');
    if (addBtn) addBtn.disabled = true;   // prevent accidental duplicate submissions
    msg.className = 'tx-form-msg'; msg.textContent = 'Releasing…';
    try {
      const res = await AgriPricePH.API.tariffAdd(body, adminToken());
      if (res.ok && res.data.ok) {
        msg.className = 'tx-form-msg ok';
        msg.textContent = `Released ${res.data.quarter_label} @ ${res.data.rate_pct}% (Admin Entry).`;
        _lastAddedTariffId = res.data.id ?? null;
        ['tf-rate', 'tf-start', 'tf-end', 'tf-label', 'tf-basis', 'tf-url'].forEach(id => { const el = $(id); if (el) el.value = ''; });
        if (addBtn) addBtn.disabled = false;
        closeForm();
        loadTariff();
      } else {
        if (addBtn) addBtn.disabled = false;
        msg.className = 'tx-form-msg error';
        msg.textContent = res.data.error || (res.status === 401 ? 'Admin session required — re-login.' : 'Failed to add rate.');
      }
    } catch (e) {
      if (addBtn) addBtn.disabled = false;
      msg.className = 'tx-form-msg error'; msg.textContent = 'Backend unreachable.';
    }
  }

  // ================= Rate history trend chart (real schedule data) =================
  // Short month name for a compact date, e.g. "2026-01-01" -> "Jan 2026" (no date-library needed).
  function shortMonth(iso) {
    const d = new Date(String(iso || '') + 'T00:00:00');
    if (isNaN(d.getTime())) return iso || '';
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }

  function renderTrendChart() {
    const canvas = $('tariff-trend-chart');
    const note = $('tariff-band-note');
    if (!canvas || !window.AgriPricePH?.Charts) return;

    // Chronological (API returns newest-first for the table); one point per quarter.
    let chrono = _tariffSchedule.slice().sort((a, b) =>
      String(a.effective_start || '').localeCompare(String(b.effective_start || '')));

    const period = $('tariff-trend-period')?.value || 'all';
    if (period !== 'all') {
      const n = parseInt(period, 10);
      if (!isNaN(n)) chrono = chrono.slice(-n);
    }

    if (!chrono.length) {
      if (note) note.textContent = 'No rate history in this period.';
      AgriPricePH.Charts.lineChart(canvas, []);
      return;
    }

    const labels = chrono.map(r => r.quarter_label || (r.effective_start || '').slice(0, 7));
    // Richer hover title: quarter + the actual effective date range — this is the "date" the
    // compact x-axis labels leave out.
    const tooltipLabels = chrono.map(r => {
      const q = r.quarter_label || '';
      const start = shortMonth(r.effective_start);
      const end = r.effective_end ? shortMonth(r.effective_end) : 'open';
      return q ? `${q} · ${start}–${end}` : `${start}–${end}`;
    });
    const rates = chrono.map(r => Number(r.rate_pct));
    const floor = chrono.map(() => _tariffBand.min);
    const ceiling = chrono.map(() => _tariffBand.max);

    AgriPricePH.Charts.lineChart(canvas, [
      // Reference lines only — excluded from the hover tooltip (tooltip:false) so hovering shows
      // just the one number that actually matters, instead of three rows for every point.
      { data: ceiling, color: '#CBD5E1', dashed: true, lineWidth: 1, label: `Ceiling ${_tariffBand.max}%`, tooltip: false },
      { data: floor, color: '#CBD5E1', dashed: true, lineWidth: 1, label: `Floor ${_tariffBand.min}%`, tooltip: false },
      { data: rates, color: '#0F6E56', fill: true, lineWidth: 2, label: 'MFN rate' },
    ], { labels, tooltipLabels, minY: 0, maxY: 40, yDecimals: 0 });

    if (note) {
      const atFloor = rates.every(r => r === _tariffBand.min);
      note.textContent = atFloor
        ? `Rate has held at the floor (${_tariffBand.min}%) every quarter shown — no increase trigger has been breached yet.`
        : `Rate has moved within the ${_tariffBand.min}%–${_tariffBand.max}% band across ${chrono.length} quarter(s) shown.`;
    }
  }

  // ================= FAO indicative-rate helper =================
  async function computeIndicative() {
    const out = $('fao-result');
    const cur = parseFloat($('fao-current').value);
    const base = $('fao-base').value;
    if (isNaN(cur)) { out.textContent = 'Enter the current FAO price.'; return; }
    out.textContent = 'Computing…';
    try {
      const d = await AgriPricePH.API.tariffIndicative(cur, base);
      if (!d.ok) { out.innerHTML = `<span style="color:var(--color-danger);">${esc(d.error || 'Unavailable.')}</span>`; return; }
      out.innerHTML = `Price change vs baseline: <strong>${d.pct_change}%</strong>
        → <strong>${d.steps_of_5pct}</strong> step(s) of 5% = <strong>${d.adjustment_points} pp</strong> adjustment
        within the ${d.band.min}%–${d.band.max}% band.<br>
        <span class="text-muted">${esc(d.note)}</span>`;
    } catch (e) { out.textContent = 'Backend unreachable.'; }
  }

  // ================= Consumer price calculator =================
  async function loadCategoryOptions() {
    try {
      const d = await AgriPricePH.API.catalog();
      const sel = $('cp-category');
      if (sel) sel.innerHTML = (d.categories || [])
        .map(c => `<option value="${c.canonical_key}">${esc(c.name)}</option>`).join('');
    } catch (e) { /* leave empty */ }
  }

  async function computeConsumerPrice() {
    const sel = $('cp-category'); const out = $('cp-result');
    if (!sel || !sel.value) return;
    out.innerHTML = '<p class="tx-calc-empty">Computing…</p>';
    try {
      const d = await AgriPricePH.API.consumerPrice(sel.value);
      if (d.error) { out.innerHTML = `<p class="tx-calc-empty">${esc(d.error)}</p>`; return; }
      const taxRows = (d.taxes || []).map(t =>
        `<div class="tx-row"><span>+ ${esc(t.name)} (${t.rate_pct != null ? t.rate_pct + '%' : peso(t.flat_amount)})</span><span>${peso(t.amount_added)}</span></div>`).join('');
      out.innerHTML = `
        <div class="tx-calc-result">
          <div class="tx-row"><span>${esc(d.category)} <span class="text-muted">(${esc(d.segment)})</span></span><span></span></div>
          <div class="tx-row"><span>Base price</span><span>${peso(d.base_price)}</span></div>
          ${taxRows || '<div class="tx-row"><span class="text-muted">No import charges applied</span><span></span></div>'}
          <div class="tx-row total"><span>Final consumer price</span><span>${peso(d.final_consumer_price)}</span></div>
        </div>
        <p class="text-xs text-muted" style="margin-top:6px;">${esc(d.base_source || '')}</p>
        ${d.note ? `<div class="tx-vat-note">${esc(d.note)}</div>` : ''}`;
    } catch (e) {
      out.innerHTML = '<p class="tx-calc-empty">Backend unreachable.</p>';
    }
  }

  // ================= Init =================
  function init() {
    bindOutsideClose();
    renderCountdown();
    loadTaxes();
    loadTariff();
    loadCategoryOptions();

    $('tariff-add-toggle')?.addEventListener('click', toggleForm);
    $('tf-cancel')?.addEventListener('click', closeForm);
    $('tf-add')?.addEventListener('click', addTariff);
    $('tariff-search')?.addEventListener('input', renderTariffTable);
    $('tariff-show-inactive')?.addEventListener('change', renderTariffTable);
    $('fao-go')?.addEventListener('click', computeIndicative);
    $('cp-go')?.addEventListener('click', computeConsumerPrice);
    $('tariff-trend-period')?.addEventListener('change', renderTrendChart);
  }

  return { init, toggleInfo };
})();
