/* AgriPricePH — Admin "Taxes & Import Charges" module (admin-only).
   Import charges on imported rice affect consumer prices; this view manages/reviews them and
   previews the resulting consumer price. The public rice catalog lives on the public site. */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Taxes = (function () {
  const $ = (id) => document.getElementById(id);
  const peso = (v) => (v == null || isNaN(v)) ? '—' : `₱${Number(v).toFixed(2)}`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function adminToken() {
    try { return JSON.parse(sessionStorage.getItem('agriprice_admin_session') || 'null')?.token || ''; }
    catch { return ''; }
  }

  function srcCell(url, label) {
    const text = esc(label || 'Source');
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener" style="color:var(--color-accent,#4CAF6E);text-decoration:underline;">${text}</a>` : text;
  }

  async function loadTariff() {
    const cur = $('tariff-current'); const body = $('tariff-body');
    const stale = $('tariff-stale'); const qEl = $('tariff-quarter');
    try {
      const d = await AgriPricePH.API.tariff();
      const a = d.applicable;
      if (qEl) qEl.textContent = d.as_of ? `as of ${d.as_of} · band ${d.band?.min}%–${d.band?.max}%` : '';
      if (a) {
        cur.innerHTML = `Applicable rate: <strong>${a.rate_pct}%</strong>
          <span style="color:var(--text-muted);">(${esc(a.quarter_label || '—')}, ${esc(a.effective_start || '?')} → ${esc(a.effective_end || 'open')})</span>
          ${a.verified ? '<span style="color:var(--color-accent,#4CAF6E);">✓ verified</span>' : '<span style="color:var(--color-danger,#EF4444);">[VERIFY]</span>'}`;
      } else {
        cur.textContent = 'No tariff rows loaded — run datasets/seed_verified_data.py.';
      }
      if (stale) {
        if (a && a.stale) { stale.style.display = 'block'; stale.textContent = '⚠ ' + (a.stale_reason || 'Rate may be outdated for the current quarter.'); }
        else { stale.style.display = 'none'; }
      }
      const rows = d.schedule || [];
      body.innerHTML = rows.length ? rows.map(r => {
        const isActive = !!r.active;
        const statusBadge = isActive
          ? '<span class="pill pill-success">ACTIVE</span>'
          : '<span class="pill pill-neutral">INACTIVE</span>';
        const isAdmin = String(r.entry_type || 'OFFICIAL').toUpperCase() === 'ADMIN';
        const addedByBadge = isAdmin
          ? '<span class="pill pill-admin">Admin Entry</span>'
          : '<span class="pill pill-success">Official / System</span>';
        const identity = r.approved_by && r.approved_by !== 'seed'
          ? `<div style="font-size:var(--fs-caption);color:var(--text-muted);margin-top:3px;">${esc(r.approved_by)}${r.approved_at ? ' · ' + esc(String(r.approved_at).slice(0, 10)) : ''}</div>`
          : '';
        const verifiedBadge = r.verified
          ? '<span class="pill pill-success">Verified</span>'
          : '<span class="pill pill-warning">Verify</span>';
        return `
        <tr${isActive ? '' : ' style="opacity:.55;"'}>
          <td>${esc(r.quarter_label || '—')}</td>
          <td><strong>${r.rate_pct}%</strong></td>
          <td>${esc(r.effective_start || '?')} → ${esc(r.effective_end || 'open')}</td>
          <td>${esc(r.legal_basis || '—')}</td>
          <td>${srcCell(r.da_certification_url, r.source)}</td>
          <td>${addedByBadge}${identity}</td>
          <td>${verifiedBadge}</td>
          <td>${statusBadge}</td>
          <td><button type="button" class="btn btn-outline btn-sm tariff-toggle-btn" data-id="${r.id}" data-active="${isActive ? 1 : 0}"
              data-label="${esc(r.quarter_label || ('#' + r.id))}">${isActive ? 'Deactivate' : 'Activate'}</button></td>
        </tr>`;
      }).join('') : '<tr><td colspan="9" class="empty-state">No tariff schedule loaded.</td></tr>';
      body.querySelectorAll('.tariff-toggle-btn').forEach(btn =>
        btn.addEventListener('click', () => toggleTariff(btn)));
    } catch (e) {
      if (cur) cur.textContent = 'Backend unreachable.';
    }
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
      msg.style.color = 'var(--color-danger,#EF4444)'; msg.textContent = 'Rate and effective start are required.'; return;
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
    if (!confirm(summary)) { msg.style.color = 'var(--text-muted)'; msg.textContent = 'Release cancelled.'; return; }
    const addBtn = $('tf-add');
    if (addBtn) addBtn.disabled = true;   // prevent accidental duplicate submissions
    msg.style.color = 'var(--text-muted)'; msg.textContent = 'Releasing…';
    try {
      const res = await AgriPricePH.API.tariffAdd(body, adminToken());
      if (res.ok && res.data.ok) {
        msg.style.color = 'var(--color-accent,#4CAF6E)';
        msg.textContent = `Released ${res.data.quarter_label} @ ${res.data.rate_pct}% (Admin Entry).`;
        ['tf-rate', 'tf-start', 'tf-end', 'tf-label', 'tf-basis', 'tf-url'].forEach(id => { const el = $(id); if (el) el.value = ''; });
        if (addBtn) addBtn.disabled = false;
        loadTariff();
      } else {
        if (addBtn) addBtn.disabled = false;
        msg.style.color = 'var(--color-danger,#EF4444)';
        msg.textContent = res.data.error || (res.status === 401 ? 'Admin session required — re-login.' : 'Failed to add rate.');
      }
    } catch (e) {
      if (addBtn) addBtn.disabled = false;
      msg.style.color = 'var(--color-danger,#EF4444)'; msg.textContent = 'Backend unreachable.';
    }
  }

  async function computeIndicative() {
    const out = $('fao-result');
    const cur = parseFloat($('fao-current').value);
    const base = $('fao-base').value;
    if (isNaN(cur)) { out.textContent = 'Enter the current FAO price.'; return; }
    out.textContent = 'Computing…';
    try {
      const d = await AgriPricePH.API.tariffIndicative(cur, base);
      if (!d.ok) { out.innerHTML = `<span style="color:var(--color-danger,#EF4444);">${esc(d.error || 'Unavailable.')}</span>`; return; }
      out.innerHTML = `Price change vs baseline: <strong>${d.pct_change}%</strong>
        → <strong>${d.steps_of_5pct}</strong> step(s) of 5% = <strong>${d.adjustment_points} pp</strong> adjustment
        within the ${d.band.min}%–${d.band.max}% band.<br>
        <span style="color:var(--text-muted);">${esc(d.note)}</span>`;
    } catch (e) { out.textContent = 'Backend unreachable.'; }
  }

  async function loadTaxes() {
    const body = $('tax-body'); const note = $('tax-note');
    try {
      const d = await AgriPricePH.API.taxes();
      const taxes = d.taxes || [];
      if (note) note.textContent = d.note || '';
      body.innerHTML = taxes.length ? taxes.map(t => `
        <tr>
          <td>${esc(t.name)} ${t.verified ? '<span class="pill pill-success">Verified</span>' : '<span class="pill pill-warning">Verify</span>'}</td>
          <td>${esc(t.kind)}</td>
          <td>${t.rate_pct != null ? t.rate_pct + '%' : (t.flat_amount != null ? peso(t.flat_amount) + '/kg' : '—')}</td>
          <td>${esc(t.applies_to)}</td>
          <td>${esc(t.legal_basis || '—')}</td>
          <td>${esc(t.source || '—')}</td>
        </tr>`).join('') : '<tr><td colspan="6" class="empty-state">No tax components loaded — run datasets/seed_verified_data.py.</td></tr>';
    } catch (e) {
      body.innerHTML = `<tr><td colspan="6" class="empty-state" style="color:var(--color-danger);">Backend unreachable.</td></tr>`;
    }
  }

  async function loadCategoryOptions() {
    try {
      const d = await AgriPricePH.API.catalog();
      const sel = $('cp-category');
      if (sel) sel.innerHTML = (d.categories || [])
        .map(c => `<option value="${c.canonical_key}">${c.name}</option>`).join('');
    } catch (e) { /* leave empty */ }
  }

  async function computeConsumerPrice() {
    const sel = $('cp-category'); const out = $('cp-result');
    if (!sel || !sel.value) return;
    out.textContent = 'Computing…';
    try {
      const d = await AgriPricePH.API.consumerPrice(sel.value);
      if (d.error) { out.textContent = d.error; return; }
      const taxLines = (d.taxes || []).map(t =>
        `<div style="padding-left:12px;">+ ${t.name} (${t.rate_pct != null ? t.rate_pct + '%' : peso(t.flat_amount)}): ${peso(t.amount_added)}</div>`).join('');
      out.innerHTML = `
        <div><strong>${d.category}</strong> (${d.segment})</div>
        <div>Base price: <strong>${peso(d.base_price)}</strong> <span style="color:var(--text-muted);">(${d.base_source})</span></div>
        ${taxLines || '<div style="padding-left:12px;color:var(--text-muted);">No import charges applied</div>'}
        <div style="margin-top:6px;">Final consumer price: <strong>${peso(d.final_consumer_price)}</strong></div>
        ${d.note ? `<div style="color:var(--text-muted);margin-top:6px;">${d.note}</div>` : ''}`;
    } catch (e) {
      out.textContent = 'Backend unreachable.';
    }
  }

  function init() {
    loadTaxes();
    loadTariff();
    loadCategoryOptions();
    const go = $('cp-go');
    if (go) go.addEventListener('click', computeConsumerPrice);
    const tfAdd = $('tf-add');
    if (tfAdd) tfAdd.addEventListener('click', addTariff);
    const faoGo = $('fao-go');
    if (faoGo) faoGo.addEventListener('click', computeIndicative);
  }

  return { init };
})();
