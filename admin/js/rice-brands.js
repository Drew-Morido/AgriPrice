/* AgriPricePH — Admin "Rice Brands" module.

   Phase 1: groups the branded rice products under the 8 forecast categories the LSTM already
   predicts. Sourced from GET /api/catalog (categories + brands).

   Phase 2 ("patong" / variance weight): each brand can carry its own canvassed price variance
   vs. the category's plain forecast price (price = base_price × (1 + weight_pct/100)). That
   figure and the current weight come from GET /api/brand-prices, and admins edit it inline via
   POST /api/brand-prices/:id/weight.

   Phase 3 (full CRUD + governance): admins can add a brand, edit one, change its verification
   status (unverified / field_verified / dti_verified), soft-delete (deactivate) and restore it,
   and see a small per-brand change-history view — all through POST/PUT/DELETE /api/brands/*,
   each of which writes a brand_audit row server-side. A duplicate (category, name, package) and
   a missing source are both blocked server-side; this page mirrors those same checks client-side
   so the error shows up before a round-trip, not just after.

   Nothing here touches model/ or the retail_prices series the LSTM trains on — brand (its price
   weight, and its governance record) is a read/write display layer on top of the existing 8
   categories, never an input to the forecast itself. */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.RiceBrands = (function () {
  const $ = (id) => document.getElementById(id);
  const peso = (v) => (v == null || isNaN(v)) ? '—' : `₱${Number(v).toFixed(2)}`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Local before Imported, matching the source workbook's ordering.
  const SEGMENT_ORDER = { Local: 0, Imported: 1 };
  const WEIGHT_MIN = -70, WEIGHT_MAX = 200; // mirrors BRAND_WEIGHT_BAND_MIN/MAX in catalog_service.py
  const VERIFICATION_LABELS = {
    unverified: 'Unverified', field_verified: 'Field-verified', dti_verified: 'DTI-verified',
  };
  const VERIFICATION_PILL_CLASS = {
    unverified: 'pill-verify-unverified', field_verified: 'pill-verify-field', dti_verified: 'pill-verify-dti',
  };

  let _categories = [];       // /api/catalog categories, include_inactive=1 (each with .brands)
  let _priceByKey = {};       // canonical_key -> plain category base price (or null)
  let _brandInfoById = {};    // brand id -> the matching brand object from /api/brand-prices
  let _historyOpenFor = null; // brand id whose change-history row is expanded, or null
  let _historyCache = {};     // brand id -> audit rows (fetched once, cleared after any edit)

  function adminToken() {
    try { return JSON.parse(sessionStorage.getItem('agriprice_admin_session') || 'null')?.token || ''; }
    catch { return ''; }
  }

  function renderStats() {
    const wrap = $('rb-stats');
    if (!wrap) return;
    const allBrands = _categories.reduce((acc, c) => acc.concat(c.brands || []), []);
    const activeBrands = allBrands.filter(b => b.active);
    const totalBrands = activeBrands.length;
    const withBrands = _categories.filter(c => (c.brands || []).some(b => b.active)).length;
    const empty = _categories.length - withBrands;
    const verified = activeBrands.filter(b => b.verification_status !== 'unverified').length;
    const weighted = activeBrands.filter(b => (_brandInfoById[b.id] || {}).weight_pct != null).length;
    const deactivated = allBrands.length - totalBrands;

    wrap.innerHTML = `
      <div class="rb-stat">
        <p class="rb-stat-label">Total brands</p>
        <p class="rb-stat-value accent">${totalBrands}<small> across ${_categories.length} categories</small></p>
      </div>
      <div class="rb-stat">
        <p class="rb-stat-label">Categories covered</p>
        <p class="rb-stat-value">${withBrands}<small> of ${_categories.length}</small></p>
      </div>
      <div class="rb-stat">
        <p class="rb-stat-label">Verified</p>
        <p class="rb-stat-value">${verified}<small> of ${totalBrands}</small></p>
      </div>
      <div class="rb-stat">
        <p class="rb-stat-label">Canvassed weight</p>
        <p class="rb-stat-value">${weighted}<small> of ${totalBrands} brands</small></p>
      </div>
      <div class="rb-stat">
        <p class="rb-stat-label">Deactivated</p>
        <p class="rb-stat-value">${deactivated}<small> kept for history</small></p>
      </div>`;
  }

  function weightCellHtml(b, info) {
    const w = info ? info.weight_pct : null;
    const val = w != null ? w : '';
    return `
      <div class="rb-weight-cell">
        <input type="number" class="form-input rb-weight-input" id="rb-wt-${b.id}"
          value="${val}" placeholder="—" step="0.1" min="${WEIGHT_MIN}" max="${WEIGHT_MAX}" ${b.active ? '' : 'disabled'}>
        <button type="button" class="btn btn-outline btn-sm rb-weight-save" data-brand-id="${b.id}" ${b.active ? '' : 'disabled'}>Save</button>
        ${w != null ? `<button type="button" class="btn btn-ghost btn-sm rb-weight-clear" data-brand-id="${b.id}" ${b.active ? '' : 'disabled'}>Clear</button>` : ''}
      </div>
      <div class="rb-weight-msg" id="rb-wt-msg-${b.id}"></div>`;
  }

  function priceCellHtml(info, categoryPrice) {
    const price = info ? info.price : categoryPrice;
    const estimated = !!(info && info.estimated);
    const pill = estimated
      ? '<span class="pill pill-info">Estimated</span>'
      : '<span class="pill pill-neutral">Category price</span>';
    const dateNote = estimated && info.sample_date
      ? `<div class="rb-sample-note">surveyed ${esc(info.sample_date)}${info.sample_locations ? ' · ' + esc(info.sample_locations) : ''}</div>`
      : '';
    return `<div style="font-weight:700;">${peso(price)}/kg</div>${pill}${dateNote}`;
  }

  function statusCellHtml(b) {
    const status = b.verification_status || 'unverified';
    const pill = `<span class="pill ${VERIFICATION_PILL_CLASS[status] || 'pill-verify-unverified'}">${VERIFICATION_LABELS[status] || status}</span>`;
    const inactive = b.active ? '' : '<span class="pill rb-inactive-badge">Inactive</span>';
    return `<div class="rb-pill-row">${pill}${inactive}</div>`;
  }

  function actionsCellHtml(b) {
    const historyOpen = _historyOpenFor === b.id;
    const editBtn = b.active
      ? `<button type="button" class="rb-icon-btn rb-edit-btn" data-brand-id="${b.id}">Edit</button>` : '';
    const toggleBtn = b.active
      ? `<button type="button" class="rb-icon-btn danger rb-deactivate-btn" data-brand-id="${b.id}" data-brand-name="${esc(b.brand_name)}">Deactivate</button>`
      : `<button type="button" class="rb-icon-btn rb-reactivate-btn" data-brand-id="${b.id}" data-brand-name="${esc(b.brand_name)}">Reactivate</button>`;
    const historyBtn = `<button type="button" class="rb-icon-btn rb-history-btn" data-brand-id="${b.id}">${historyOpen ? 'Hide history' : 'History'}</button>`;
    return `<div class="rb-actions-cell">${editBtn}${toggleBtn}${historyBtn}</div>`;
  }

  function historyRowHtml(b, colspan) {
    if (_historyOpenFor !== b.id) return '';
    const rows = _historyCache[b.id];
    let body;
    if (!rows) {
      body = `<div class="rb-history-empty">Loading…</div>`;
    } else if (!rows.length) {
      body = `<div class="rb-history-empty">No changes recorded yet.</div>`;
    } else {
      body = `<div class="rb-history-list">${rows.map(r => `
        <div class="rb-history-item">
          <span class="rb-history-action">${esc(r.action)}</span>
          <span class="rb-history-detail">${esc(r.detail || '')}</span>
          <span class="rb-history-meta">${esc(r.actor || '—')} · ${esc(r.created_at || '')}</span>
        </div>`).join('')}</div>`;
    }
    return `<tr class="rb-history-row"><td colspan="${colspan}">${body}</td></tr>`;
  }

  function brandRowHtml(b) {
    const info = _brandInfoById[b.id] || null;
    const rowClass = b.active ? '' : 'rb-inactive-row';
    return `
      <tr class="${rowClass}">
        <td>
          <div style="font-weight:600;">${esc(b.brand_name)}</div>
        </td>
        <td>${esc(b.package || '—')}</td>
        <td>${esc(b.location || '—')}</td>
        <td class="rb-source-cell">${esc(b.source || '—')}</td>
        <td>${statusCellHtml(b)}</td>
        <td>${priceCellHtml(info, _priceByKey[b._categoryKey])}</td>
        <td>${weightCellHtml(b, info)}</td>
        <td>${actionsCellHtml(b)}</td>
      </tr>${historyRowHtml(b, 8)}`;
  }

  function matchesQuery(b, query) {
    return String(b.brand_name || '').toLowerCase().includes(query) ||
      String(b.package || '').toLowerCase().includes(query) ||
      String(b.location || '').toLowerCase().includes(query) ||
      String(b.source || '').toLowerCase().includes(query);
  }

  function groupHtml(cat, query, showInactive) {
    let brands = (cat.brands || []).filter(b => showInactive || b.active);
    if (query) brands = brands.filter(b => matchesQuery(b, query));
    if ((query || !showInactive) && !brands.length) return ''; // hide empty-after-filter categories

    const activeCount = (cat.brands || []).filter(b => b.active).length;
    const price = _priceByKey[cat.canonical_key];
    const priceHtml = price != null
      ? `<div class="rb-group-price"><span class="rb-price-label">Category price</span><span class="rb-price-value">${peso(price)}/kg</span></div>`
      : '';

    const bodyHtml = brands.length
      ? brands.map(b => brandRowHtml({ ...b, _categoryKey: cat.canonical_key })).join('')
      : `<tr><td colspan="8"><div class="rb-empty-cat">No brands catalogued yet for this category.</div></td></tr>`;

    return `
      <div class="card rb-group">
        <div class="card-header rb-group-header">
          <div class="rb-group-heading">
            <span class="rb-group-name">${esc(cat.name)}</span>
            <span class="pill rb-segment-pill ${esc(cat.segment)}">${esc(cat.segment)}</span>
            <span class="rb-group-count">${activeCount} brand${activeCount === 1 ? '' : 's'}</span>
          </div>
          ${priceHtml}
        </div>
        <div class="table-wrap" style="overflow-x:auto;">
          <table class="data-table">
            <thead>
              <tr><th>Brand</th><th>Package / Variety</th><th>Location</th><th>Source</th><th>Status</th><th>Price</th><th>Weight %</th><th>Actions</th></tr>
            </thead>
            <tbody>${bodyHtml}</tbody>
          </table>
        </div>
      </div>`;
  }

  function render() {
    const wrap = $('rb-groups');
    const countEl = $('rb-result-count');
    if (!wrap) return;

    if (!_categories.length) {
      wrap.innerHTML = `<div class="empty-state"><h3>Catalog not available</h3><p>Backend unreachable, or the catalog schema hasn't been initialized yet.</p></div>`;
      if (countEl) countEl.textContent = '';
      return;
    }

    const query = ($('rb-search')?.value || '').trim().toLowerCase();
    const showInactive = !!$('rb-show-inactive')?.checked;
    const sorted = _categories.slice().sort((a, b) => {
      const s = (SEGMENT_ORDER[a.segment] ?? 9) - (SEGMENT_ORDER[b.segment] ?? 9);
      return s !== 0 ? s : String(a.name).localeCompare(String(b.name));
    });

    const html = sorted.map(c => groupHtml(c, query, showInactive)).join('');
    wrap.innerHTML = html || `<div class="empty-state"><h3>No matches</h3><p>No brands match "${esc(query)}".</p></div>`;

    if (countEl) {
      const visible = sorted.reduce((n, c) =>
        n + (c.brands || []).filter(b => (showInactive || b.active) && (!query || matchesQuery(b, query))).length, 0);
      const total = _categories.reduce((n, c) => n + (c.brands || []).filter(b => b.active).length, 0);
      countEl.textContent = (query || showInactive) ? `${visible} brand${visible === 1 ? '' : 's'} shown` : `${total} brand${total === 1 ? '' : 's'}`;
    }

    wrap.querySelectorAll('.rb-weight-save').forEach(btn =>
      btn.addEventListener('click', () => saveWeight(btn.dataset.brandId)));
    wrap.querySelectorAll('.rb-weight-clear').forEach(btn =>
      btn.addEventListener('click', () => clearWeight(btn.dataset.brandId)));
    wrap.querySelectorAll('.rb-edit-btn').forEach(btn =>
      btn.addEventListener('click', () => openEditForm(btn.dataset.brandId)));
    wrap.querySelectorAll('.rb-deactivate-btn').forEach(btn =>
      btn.addEventListener('click', () => deactivateBrand(btn.dataset.brandId, btn.dataset.brandName)));
    wrap.querySelectorAll('.rb-reactivate-btn').forEach(btn =>
      btn.addEventListener('click', () => reactivateBrand(btn.dataset.brandId, btn.dataset.brandName)));
    wrap.querySelectorAll('.rb-history-btn').forEach(btn =>
      btn.addEventListener('click', () => toggleHistory(btn.dataset.brandId)));
  }

  // ================= Data loading =================
  // Admin view always pulls include_inactive=1 so deactivated brands can still be reviewed and
  // restored — the "Show deactivated" toggle only controls whether render() displays them.
  async function loadBrandPrices() {
    _priceByKey = {};
    _brandInfoById = {};
    await Promise.all(_categories.map(async (c) => {
      try {
        const d = await AgriPricePH.API.brandPrices(c.canonical_key, true);
        _priceByKey[c.canonical_key] = (d && d.base_price != null) ? d.base_price : null;
        (d?.brands || []).forEach(b => { _brandInfoById[b.id] = b; });
      } catch (e) {
        _priceByKey[c.canonical_key] = null;
      }
    }));
  }

  async function load() {
    const wrap = $('rb-groups');
    if (wrap) wrap.innerHTML = `<div class="empty-state"><h3>Loading…</h3></div>`;
    try {
      const d = await AgriPricePH.API.catalog(true);
      _categories = (d && d.ready) ? (d.categories || []) : [];
    } catch (e) {
      _categories = [];
    }
    renderStats();
    render();
    populateCategorySelect();
    await loadBrandPrices();
    renderStats();
    render(); // re-render once prices + weights are in
  }

  function populateCategorySelect() {
    const sel = $('rf-category');
    if (!sel) return;
    const sorted = _categories.slice().sort((a, b) => {
      const s = (SEGMENT_ORDER[a.segment] ?? 9) - (SEGMENT_ORDER[b.segment] ?? 9);
      return s !== 0 ? s : String(a.name).localeCompare(String(b.name));
    });
    sel.innerHTML = sorted.map(c => `<option value="${esc(c.canonical_key)}">${esc(c.name)}</option>`).join('');
  }

  // ================= Weight (Phase 2) =================
  async function saveWeight(brandId) {
    const input = $(`rb-wt-${brandId}`);
    const msg = $(`rb-wt-msg-${brandId}`);
    if (!input) return;
    const raw = input.value.trim();
    if (raw === '') { if (msg) { msg.textContent = 'Enter a % or use Clear.'; msg.className = 'rb-weight-msg error'; } return; }
    const weight = parseFloat(raw);
    if (isNaN(weight) || weight < WEIGHT_MIN || weight > WEIGHT_MAX) {
      if (msg) { msg.textContent = `Must be between ${WEIGHT_MIN}% and ${WEIGHT_MAX}%.`; msg.className = 'rb-weight-msg error'; }
      return;
    }
    const info = _brandInfoById[brandId];
    const sampleDate = prompt('Date this weight was surveyed (YYYY-MM-DD)?', new Date().toISOString().slice(0, 10));
    if (sampleDate === null) return; // cancelled
    if (msg) { msg.textContent = 'Saving…'; msg.className = 'rb-weight-msg'; }
    try {
      const res = await AgriPricePH.API.brandWeightSet(brandId, {
        weight_pct: weight,
        sample_date: sampleDate || null,
        sample_locations: info?.sample_locations || null,
        sample_n: info?.sample_n || null,
        source_notes: info?.source_notes || null,
      }, adminToken());
      if (res.ok && res.data.ok) {
        await loadBrandPrices();
        renderStats();
        render();
      } else if (msg) {
        msg.textContent = res.data.error || (res.status === 401 ? 'Admin session required — re-login.' : 'Failed to save.');
        msg.className = 'rb-weight-msg error';
      }
    } catch (e) {
      if (msg) { msg.textContent = 'Backend unreachable.'; msg.className = 'rb-weight-msg error'; }
    }
  }

  async function clearWeight(brandId) {
    if (!confirm('Clear this brand\'s canvassed weight? It will revert to showing the plain category price.')) return;
    const msg = $(`rb-wt-msg-${brandId}`);
    if (msg) { msg.textContent = 'Clearing…'; msg.className = 'rb-weight-msg'; }
    try {
      const res = await AgriPricePH.API.brandWeightSet(brandId, { weight_pct: null }, adminToken());
      if (res.ok && res.data.ok) {
        await loadBrandPrices();
        renderStats();
        render();
      } else if (msg) {
        msg.textContent = res.data.error || 'Failed to clear.';
        msg.className = 'rb-weight-msg error';
      }
    } catch (e) {
      if (msg) { msg.textContent = 'Backend unreachable.'; msg.className = 'rb-weight-msg error'; }
    }
  }

  // ================= Add / edit brand form (Phase 3) =================
  function findBrand(brandId) {
    const id = Number(brandId);
    for (const c of _categories) {
      const b = (c.brands || []).find(x => x.id === id);
      if (b) return { brand: b, category: c };
    }
    return null;
  }

  function resetForm() {
    ['rf-brand-id', 'rf-brand-name', 'rf-package', 'rf-location', 'rf-source', 'rf-source-url',
      'rf-last-verified', 'rf-classification-note', 'rf-notes'].forEach(id => { const el = $(id); if (el) el.value = ''; });
    const v = $('rf-verification'); if (v) v.value = 'unverified';
    const msg = $('rf-msg'); if (msg) { msg.textContent = ''; msg.className = 'rb-form-msg'; }
    $('rf-deactivate')?.setAttribute('hidden', '');
  }

  function openAddForm() {
    resetForm();
    setFormTitle('Add a new brand');
    const panel = $('rb-form');
    panel?.classList.add('open');
    panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('rf-brand-name')?.focus();
  }

  function setFormTitle(text) {
    const title = $('rb-form-title');
    if (!title) return;
    // Keep the leading <svg>, replace only the trailing text node.
    const svg = title.querySelector('svg');
    title.textContent = ' ' + text;
    if (svg) title.prepend(svg);
  }

  function openEditForm(brandId) {
    const found = findBrand(brandId);
    if (!found) return;
    const { brand: b, category: cat } = found;
    resetForm();
    setFormTitle(`Edit ${b.brand_name}`);
    $('rf-brand-id').value = b.id;
    $('rf-category').value = cat.canonical_key;
    $('rf-brand-name').value = b.brand_name || '';
    $('rf-package').value = b.package || '';
    $('rf-location').value = b.location || '';
    $('rf-source').value = b.source || '';
    $('rf-source-url').value = b.source_url || '';
    $('rf-last-verified').value = b.last_verified || '';
    $('rf-classification-note').value = b.classification_note || '';
    $('rf-notes').value = b.notes || '';
    $('rf-verification').value = b.verification_status || 'unverified';
    $('rf-deactivate')?.removeAttribute('hidden');
    const panel = $('rb-form');
    panel?.classList.add('open');
    panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('rf-brand-name')?.focus();
  }

  function closeForm() {
    $('rb-form')?.classList.remove('open');
  }

  function toggleAddForm() {
    const panel = $('rb-form');
    if (!panel) return;
    if (panel.classList.contains('open')) { closeForm(); } else { openAddForm(); }
  }

  function formPayload() {
    return {
      category_key: $('rf-category')?.value || '',
      brand_name: ($('rf-brand-name')?.value || '').trim(),
      package: ($('rf-package')?.value || '').trim() || null,
      location: ($('rf-location')?.value || '').trim() || null,
      source: ($('rf-source')?.value || '').trim(),
      source_url: ($('rf-source-url')?.value || '').trim() || null,
      last_verified: ($('rf-last-verified')?.value || '').trim() || null,
      classification_note: ($('rf-classification-note')?.value || '').trim() || null,
      notes: ($('rf-notes')?.value || '').trim() || null,
      verification_status: $('rf-verification')?.value || 'unverified',
    };
  }

  async function saveBrand() {
    const msg = $('rf-msg');
    const payload = formPayload();
    // Client-side mirror of the server's required-field checks — catches the common miss before
    // a round-trip; the server still re-validates (never trust the client alone).
    if (!payload.brand_name) {
      if (msg) { msg.textContent = 'Brand name is required.'; msg.className = 'rb-form-msg error'; }
      return;
    }
    if (!payload.source) {
      if (msg) { msg.textContent = 'A source is required — where did this entry come from?'; msg.className = 'rb-form-msg error'; }
      return;
    }
    const brandId = $('rf-brand-id')?.value;
    const saveBtn = $('rf-save');
    if (saveBtn) saveBtn.disabled = true;
    if (msg) { msg.textContent = 'Saving…'; msg.className = 'rb-form-msg'; }
    try {
      const res = brandId
        ? await AgriPricePH.API.brandUpdate(brandId, payload, adminToken())
        : await AgriPricePH.API.brandAdd(payload, adminToken());
      if (res.ok && res.data.ok) {
        if (msg) { msg.textContent = `Saved '${res.data.brand_name}'.`; msg.className = 'rb-form-msg ok'; }
        if (brandId) delete _historyCache[brandId];
        closeForm();
        await load();
      } else if (msg) {
        msg.textContent = res.data.error || (res.status === 401 ? 'Admin session required — re-login.' : 'Failed to save.');
        msg.className = 'rb-form-msg error';
      }
    } catch (e) {
      if (msg) { msg.textContent = 'Backend unreachable.'; msg.className = 'rb-form-msg error'; }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function deactivateFromForm() {
    const brandId = $('rf-brand-id')?.value;
    const name = $('rf-brand-name')?.value || `#${brandId}`;
    if (!brandId) return;
    if (!(await confirmDeactivate(name))) return;
    await deactivateBrand(brandId, name, /* fromForm */ true);
  }

  function confirmDeactivate(name) {
    return Promise.resolve(confirm(
      `Deactivate '${name}'?\n\nIt will stop showing on the public catalog and in brand-prices, ` +
      `but its price/weight and change history are kept and it can be reactivated later.`));
  }

  // ================= Deactivate / reactivate (Phase 3) =================
  async function deactivateBrand(brandId, name, fromForm) {
    if (!fromForm && !(await confirmDeactivate(name))) return;
    try {
      const res = await AgriPricePH.API.brandDeactivate(brandId, adminToken());
      if (res.ok && res.data.ok) {
        delete _historyCache[brandId];
        if (fromForm) closeForm();
        await load();
      } else {
        alert(res.data.error || (res.status === 401 ? 'Admin session required — re-login.' : 'Could not deactivate.'));
      }
    } catch (e) {
      alert('Backend unreachable.');
    }
  }

  async function reactivateBrand(brandId, name) {
    if (!confirm(`Reactivate '${name}'? It will show up again on the public catalog.`)) return;
    try {
      const res = await AgriPricePH.API.brandReactivate(brandId, adminToken());
      if (res.ok && res.data.ok) {
        delete _historyCache[brandId];
        await load();
      } else {
        alert(res.data.error || (res.status === 401 ? 'Admin session required — re-login.' : 'Could not reactivate.'));
      }
    } catch (e) {
      alert('Backend unreachable.');
    }
  }

  // ================= Change-history (Phase 3) =================
  async function toggleHistory(brandId) {
    const id = Number(brandId);
    if (_historyOpenFor === id) {
      _historyOpenFor = null;
      render();
      return;
    }
    _historyOpenFor = id;
    render(); // shows "Loading…" immediately
    if (!_historyCache[id]) {
      try {
        const d = await AgriPricePH.API.brandAudit(id, adminToken());
        _historyCache[id] = d.audit || [];
      } catch (e) {
        _historyCache[id] = [];
      }
    }
    render();
  }

  function init() {
    load();
    $('rb-search')?.addEventListener('input', render);
    $('rb-show-inactive')?.addEventListener('change', render);
    $('rb-add-toggle')?.addEventListener('click', toggleAddForm);
    $('rf-cancel')?.addEventListener('click', closeForm);
    $('rf-save')?.addEventListener('click', saveBrand);
    $('rf-deactivate')?.addEventListener('click', deactivateFromForm);
  }

  function destroy() {}

  return { init, destroy };
})();
