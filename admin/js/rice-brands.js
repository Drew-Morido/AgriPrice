/* AgriPricePH — Admin "Rice Brands" module.

   Branded rice products grouped under the 8 forecast categories the LSTM already predicts
   (GET /api/catalog), each with a display price from GET /api/brand-prices:
     brand price = category base price × (1 + weight_pct / 100)
   where weight_pct is the brand's canvassed variance ("patong"), edited via
   POST /api/brand-prices/:id/weight.

   Full CRUD + governance through POST/PUT/DELETE /api/brands/* — add, edit, verification status
   (unverified / field_verified / dti_verified), soft-delete (deactivate) and restore, plus a
   per-brand change history (brand_audit). Duplicate (category, name, package) and a missing
   source are blocked server-side; the same checks run here first so errors show before a
   round-trip.

   Layout: a category rail (All / Local / Imported) beside ONE filtered, paginated table, with
   add/edit, weight, and details/history in dialogs — so the page never becomes a long scroll
   of 8 stacked tables.

   Nothing here touches model/ or the retail_prices series the LSTM trains on — brand data is a
   display/governance layer on top of the 8 categories, never a forecast input. */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.RiceBrands = (function () {
  const $ = (id) => document.getElementById(id);
  const peso = (v) => (v == null || isNaN(v)) ? '—' : `₱${Number(v).toFixed(2)}`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SEGMENT_ORDER = { Local: 0, Imported: 1 };
  const WEIGHT_MIN = -70, WEIGHT_MAX = 200; // mirrors BRAND_WEIGHT_BAND_MIN/MAX in catalog_service.py
  // Rows per page adapt to the window height so the page fits without scrolling (see fitPageSize).
  const PAGE_MIN = 5, PAGE_MAX = 15;
  let PAGE_SIZE = 8;
  const VERIFICATION_LABELS = {
    unverified: 'Unverified', field_verified: 'Field-verified', dti_verified: 'DTI-verified',
  };
  const VERIFICATION_PILL_CLASS = {
    unverified: 'pill-verify-unverified', field_verified: 'pill-verify-field', dti_verified: 'pill-verify-dti',
  };
  const ICON = {
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    view: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
    on: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  };

  let _categories = [];       // /api/catalog categories (include_inactive=1), each with .brands
  let _priceByKey = {};       // canonical_key -> category base price (or null)
  let _brandInfoById = {};    // brand id -> /api/brand-prices brand object (price, weight, sample…)
  let _historyCache = {};     // brand id -> audit rows
  let _pricesLoaded = false;

  // View state
  let _cat = 'all';           // 'all' or a canonical_key
  let _query = '';
  let _verify = 'all';
  let _status = 'active';
  let _page = 1;
  let _weightBrandId = null;
  let _detailBrandId = null;

  // Add/Edit Brand image field — the file is only uploaded once the brand itself saves
  // successfully (using the resulting brand id), so cancelling the form never leaves an orphan.
  let _pendingImageFile = null;  // File picked but not yet uploaded
  let _imageRemoved = false;     // "Remove" clicked on an existing image
  let _currentImagePath = null;  // the brand's image_path when the form opened (edit only)

  function adminToken() {
    try { return JSON.parse(sessionStorage.getItem('agriprice_admin_session') || 'null')?.token || ''; }
    catch { return ''; }
  }

  // image_path from the API is root-relative ('/public/images/rice-brands/...'). The admin
  // dashboard isn't always served from the same origin as the Flask API (see js/api.js's
  // detectBase() — Live Server / any other port always talks to the API on :5000 regardless of
  // where the page itself loaded from), so a bare <img src="/public/..."> resolves against the
  // WRONG origin and 404s there even though the API call that returned the path succeeded. A
  // freshly-picked, not-yet-uploaded file's blob: preview URL must pass through unchanged.
  function resolveImageUrl(src) {
    if (!src) return src;
    if (/^(blob:|data:|https?:)/i.test(src)) return src;
    return `${AgriPricePH.API.BASE}${src}`;
  }

  function renderImagePreview(hostId, src) {
    const host = $(hostId);
    if (!host) return;
    host.innerHTML = src ? `<img src="${esc(resolveImageUrl(src))}" alt="">` : ICON.image;
  }

  function sortedCategories() {
    return _categories.slice().sort((a, b) => {
      const s = (SEGMENT_ORDER[a.segment] ?? 9) - (SEGMENT_ORDER[b.segment] ?? 9);
      return s !== 0 ? s : String(a.name).localeCompare(String(b.name));
    });
  }

  function allBrands() {
    return sortedCategories().reduce((acc, c) =>
      acc.concat((c.brands || []).map(b => ({ ...b, _cat: c }))), []);
  }

  function findBrand(brandId) {
    const id = Number(brandId);
    for (const c of _categories) {
      const b = (c.brands || []).find(x => x.id === id);
      if (b) return { brand: b, category: c };
    }
    return null;
  }

  // ================= Stats =================
  function renderStats() {
    const wrap = $('rb-stats');
    if (!wrap) return;
    const brands = allBrands();
    const active = brands.filter(b => b.active);
    const covered = _categories.filter(c => (c.brands || []).some(b => b.active)).length;
    const verified = active.filter(b => b.verification_status && b.verification_status !== 'unverified').length;
    const unverified = active.length - verified;
    const weighted = active.filter(b => (_brandInfoById[b.id] || {}).weight_pct != null).length;
    const stat = (label, value, sub, tone, filterAttr) => `
      <button type="button" class="rb-stat ${filterAttr ? 'is-link' : ''}" ${filterAttr || 'tabindex="-1"'}>
        <span class="rb-stat-label">${label}</span>
        <span class="rb-stat-value ${tone || ''}">${value}</span>
        <span class="rb-stat-sub">${sub}</span>
      </button>`;
    wrap.innerHTML =
      stat('Active brands', active.length, `across ${_categories.length} categories`, 'accent') +
      stat('Categories covered', `${covered}<small>/${_categories.length}</small>`, covered < _categories.length ? `${_categories.length - covered} with no brands yet` : 'all categories have brands') +
      stat('Need verification', unverified, 'click to review', unverified ? 'warn' : '', 'data-quick="unverified"') +
      stat('With price weight', `${weighted}<small>/${active.length}</small>`, _pricesLoaded ? 'canvassed variance set' : 'loading prices…') +
      stat('Deactivated', brands.length - active.length, 'click to review', '', 'data-quick="inactive"');
  }

  // ================= Category rail =================
  function renderRail() {
    const rail = $('rb-rail');
    const sel = $('rb-rail-select');
    if (!rail) return;
    const cats = sortedCategories();
    const activeCount = (c) => (c.brands || []).filter(b => b.active).length;
    const unverifiedCount = (c) => (c.brands || []).filter(b => b.active && (b.verification_status || 'unverified') === 'unverified').length;
    const total = cats.reduce((n, c) => n + activeCount(c), 0);

    let html = `
      <button type="button" class="rb-rail-item ${_cat === 'all' ? 'active' : ''}" data-cat="all">
        <span class="rb-rail-icon">${ICON.grid}</span>
        <span class="rb-rail-name">All brands</span>
        <span class="rb-rail-count">${total}</span>
      </button>`;
    ['Local', 'Imported'].forEach(seg => {
      const group = cats.filter(c => c.segment === seg);
      if (!group.length) return;
      html += `<div class="rb-rail-group">${seg}</div>`;
      html += group.map(c => {
        const n = activeCount(c);
        const u = unverifiedCount(c);
        const price = _priceByKey[c.canonical_key];
        const tip = `${c.name} — ${n} active brand${n === 1 ? '' : 's'}`
          + (price != null ? `, category price ${peso(price)}/kg` : '')
          + (u ? `, ${u} unverified` : '');
        return `
          <button type="button" class="rb-rail-item ${_cat === c.canonical_key ? 'active' : ''} ${n ? '' : 'is-empty'}" data-cat="${esc(c.canonical_key)}" title="${esc(tip)}">
            <span class="rb-rail-dot ${esc(seg)}"></span>
            <span class="rb-rail-name">${esc(c.name.replace(/^(Local|Imported)\s+/, ''))}</span>
            ${u ? `<span class="rb-rail-flag" aria-label="${u} unverified">${u}</span>` : ''}
            <span class="rb-rail-count">${n}</span>
          </button>`;
      }).join('');
    });
    rail.innerHTML = html;

    if (sel) {
      sel.innerHTML = `<option value="all">All brands (${total})</option>` + cats.map(c =>
        `<option value="${esc(c.canonical_key)}">${esc(c.name)} (${activeCount(c)})</option>`).join('');
      sel.value = _cat;
    }
  }

  function setCategory(key) {
    _cat = key || 'all';
    _page = 1;
    renderRail();
    renderMain();
  }

  // ================= Main table =================
  function matchesQuery(b, q) {
    return [b.brand_name, b.package, b.location, b.source].some(v => String(v || '').toLowerCase().includes(q));
  }

  function visibleBrands() {
    const q = _query.trim().toLowerCase();
    return allBrands().filter(b => {
      if (_cat !== 'all' && b._cat.canonical_key !== _cat) return false;
      if (_status === 'active' && !b.active) return false;
      if (_status === 'inactive' && b.active) return false;
      if (_verify !== 'all' && (b.verification_status || 'unverified') !== _verify) return false;
      if (q && !matchesQuery(b, q)) return false;
      return true;
    });
  }

  function renderMainHeader() {
    const cat = _categories.find(c => c.canonical_key === _cat);
    const segEl = $('rb-main-segment');
    const priceWrap = $('rb-main-price');
    if (!cat) {
      $('rb-main-title').textContent = 'All brands';
      $('rb-main-sub').textContent = 'Every brand across the 8 forecast categories';
      if (segEl) segEl.hidden = true;
      if (priceWrap) priceWrap.hidden = true;
      return;
    }
    $('rb-main-title').textContent = cat.name;
    const n = (cat.brands || []).filter(b => b.active).length;
    $('rb-main-sub').textContent = `${n} active brand${n === 1 ? '' : 's'} · brand prices are this category's price adjusted by each brand's weight`;
    if (segEl) {
      segEl.hidden = false;
      segEl.textContent = cat.segment;
      segEl.className = `pill rb-segment-pill ${cat.segment}`;
    }
    if (priceWrap) {
      const p = _priceByKey[cat.canonical_key];
      priceWrap.hidden = !_pricesLoaded;
      $('rb-main-price-value').textContent = p != null ? `${peso(p)}/kg` : 'Not available';
    }
  }

  function renderMain() {
    renderMainHeader();
    const thead = $('rb-thead');
    const tbody = $('rb-tbody');
    if (!thead || !tbody) return;

    const showCat = _cat === 'all';
    const cols = 6;
    thead.innerHTML = `<tr>
      <th>Brand</th>
      <th>Location</th>
      <th>Verification</th>
      <th class="rb-num">Price / kg</th>
      <th class="rb-num">Weight</th>
      <th class="rb-col-actions">Actions</th>
    </tr>`;

    if (!_categories.length) {
      tbody.innerHTML = `<tr><td colspan="${cols}" class="rb-empty">Catalog not available — backend unreachable, or the catalog hasn't been initialized yet.</td></tr>`;
      $('rb-result-count').textContent = '';
      $('rb-pager').innerHTML = '';
      return;
    }

    const rows = visibleBrands();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    _page = Math.min(Math.max(1, _page), pages);
    const start = (_page - 1) * PAGE_SIZE;
    const pageRows = rows.slice(start, start + PAGE_SIZE);

    if (!rows.length) {
      const cat = _categories.find(c => c.canonical_key === _cat);
      const noneAtAll = cat && !(cat.brands || []).length;
      const msg = noneAtAll
        ? `No brands catalogued for ${esc(cat.name)} yet. Use “Add Brand” to add the first one.`
        : 'No brands match the current search or filters.';
      tbody.innerHTML = `<tr><td colspan="${cols}" class="rb-empty">${msg}</td></tr>`;
    } else {
      tbody.innerHTML = pageRows.map(b => rowHtml(b, showCat)).join('');
    }

    $('rb-result-count').textContent = rows.length
      ? `Showing ${start + 1}–${start + pageRows.length} of ${rows.length} brand${rows.length === 1 ? '' : 's'}`
      : '0 brands';
    renderPager(pages);
  }

  function rowHtml(b, showCat) {
    const info = _brandInfoById[b.id] || null;
    const status = b.verification_status || 'unverified';
    const catPrice = _priceByKey[b._cat.canonical_key];
    const price = info && info.price != null ? info.price : catPrice;
    const w = info ? info.weight_pct : null;

    const priceHtml = _pricesLoaded
      ? `<div class="rb-price">${peso(price)}</div>
         <div class="rb-price-tag">${info && info.estimated ? 'brand estimate' : 'category price'}</div>`
      : '<span class="rb-muted">…</span>';

    const weightHtml = b.active
      ? `<button type="button" class="rb-weight-chip ${w != null ? (w >= 0 ? 'up' : 'down') : 'none'}" data-act="weight" data-id="${b.id}" title="Set price weight">
           ${w != null ? `${w > 0 ? '+' : ''}${Number(w).toFixed(1)}%` : 'Set'}
         </button>`
      : `<span class="rb-muted">${w != null ? `${w > 0 ? '+' : ''}${Number(w).toFixed(1)}%` : '—'}</span>`;

    const actions = `
      <button type="button" class="rb-icon-btn" data-act="view" data-id="${b.id}" title="Details &amp; history" aria-label="Details for ${esc(b.brand_name)}">${ICON.view}</button>
      ${b.active ? `<button type="button" class="rb-icon-btn" data-act="edit" data-id="${b.id}" title="Edit brand" aria-label="Edit ${esc(b.brand_name)}">${ICON.edit}</button>` : ''}
      ${b.active
        ? `<button type="button" class="rb-icon-btn danger" data-act="deactivate" data-id="${b.id}" title="Deactivate" aria-label="Deactivate ${esc(b.brand_name)}">${ICON.off}</button>`
        : `<button type="button" class="rb-icon-btn success" data-act="reactivate" data-id="${b.id}" title="Reactivate" aria-label="Reactivate ${esc(b.brand_name)}">${ICON.on}</button>`}`;

    return `
      <tr class="${b.active ? '' : 'rb-inactive-row'}">
        <td>
          <button type="button" class="rb-brand" data-act="view" data-id="${b.id}" title="${esc(b.brand_name)}${b.package ? ' — ' + esc(b.package) : ''}">
            <span class="rb-brand-name">${esc(b.brand_name)}${b.active ? '' : ' <span class="pill rb-inactive-badge">Inactive</span>'}</span>
            <span class="rb-brand-sub">${showCat
              ? `<span class="rb-cat-tag"><span class="rb-rail-dot ${esc(b._cat.segment)}"></span>${esc(b._cat.name)}</span>${b.package ? ` · ${esc(b.package)}` : ''}`
              : esc(b.package || 'No package / variety recorded')}</span>
          </button>
        </td>
        <td class="rb-loc"><span title="${esc(b.location || '')}">${esc(b.location || '—')}</span></td>
        <td><span class="pill ${VERIFICATION_PILL_CLASS[status] || 'pill-verify-unverified'}">${VERIFICATION_LABELS[status] || esc(status)}</span></td>
        <td class="rb-num">${priceHtml}</td>
        <td class="rb-num">${weightHtml}</td>
        <td class="rb-col-actions"><div class="rb-actions">${actions}</div></td>
      </tr>`;
  }

  function renderPager(pages) {
    const el = $('rb-pager');
    if (!el) return;
    if (pages <= 1) { el.innerHTML = ''; return; }
    // First, last, and the current page ±1, with "…" for the gaps — stays short on any width.
    const span = window.innerWidth < 600 ? 0 : 1;
    const shown = [...new Set([1, pages, ...Array.from({ length: 2 * span + 1 }, (_, i) => _page - span + i)])]
      .filter(p => p >= 1 && p <= pages).sort((a, b) => a - b);
    let html = `<button type="button" class="rb-page-btn" data-page="${_page - 1}" ${_page === 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>`;
    shown.forEach((p, i) => {
      if (i && p - shown[i - 1] > 1) html += '<span class="rb-page-gap">…</span>';
      html += `<button type="button" class="rb-page-btn ${p === _page ? 'active' : ''}" data-page="${p}" aria-label="Page ${p}">${p}</button>`;
    });
    html += `<button type="button" class="rb-page-btn" data-page="${_page + 1}" ${_page === pages ? 'disabled' : ''} aria-label="Next page">›</button>`;
    el.innerHTML = html;
  }

  function renderAll() {
    renderStats();
    renderRail();
    renderMain();
    fitPageSize();
  }

  // Pick how many rows fit between the table header and the bottom of the window, so the whole
  // module stays on one screen (≈5 rows at 768px tall, ≈12 at 1080px). Narrow/phone layouts
  // stack the rail above the table, so they just use the minimum.
  function fitPageSize() {
    const tbody = $('rb-tbody');
    if (!tbody) return;
    let size = PAGE_MIN;
    if (window.innerWidth > 900) {
      const firstRow = tbody.querySelector('tr');
      const rowH = Math.max(40, firstRow && tbody.children.length > 1 ? firstRow.offsetHeight : 49);
      const top = tbody.getBoundingClientRect().top + window.scrollY;
      const reserve = ($('rb-pager')?.closest('.rb-footer')?.offsetHeight || 42) + 14 + 28 + 26;
      size = Math.floor((window.innerHeight - top - reserve) / rowH);
      size = Math.max(PAGE_MIN, Math.min(PAGE_MAX, size));
    }
    if (size !== PAGE_SIZE) {
      const firstIndex = (_page - 1) * PAGE_SIZE;
      PAGE_SIZE = size;
      _page = Math.floor(firstIndex / PAGE_SIZE) + 1;
      renderMain();
    }
  }

  let _resizeTimer = null;
  function onResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => { if ($('rb-tbody')) fitPageSize(); }, 150);
  }

  // ================= Data loading =================
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
    _pricesLoaded = true;
  }

  async function load() {
    try {
      const d = await AgriPricePH.API.catalog(true);
      _categories = (d && d.ready) ? (d.categories || []) : [];
    } catch (e) {
      _categories = [];
    }
    if (_cat !== 'all' && !_categories.some(c => c.canonical_key === _cat)) _cat = 'all';
    populateCategorySelect();
    renderAll();
    await loadBrandPrices();
    renderAll(); // again once prices + weights are in
  }

  function populateCategorySelect() {
    const sel = $('rf-category');
    if (!sel) return;
    sel.innerHTML = sortedCategories().map(c => `<option value="${esc(c.canonical_key)}">${esc(c.name)}</option>`).join('');
  }

  // ================= Dialog helpers =================
  function mountOverlays() {
    document.querySelectorAll('body > .rb-modal-overlay').forEach(el => el.remove());
    ['rb-form-overlay', 'rb-weight-overlay', 'rb-detail-overlay'].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('mousedown', (e) => { if (e.target === el) closeOverlay(id); });
      el.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => closeOverlay(id)));
      document.body.appendChild(el);
    });
  }

  function openOverlay(id) { const el = $(id); if (el) el.hidden = false; }
  function closeOverlay(id) { const el = $(id); if (el) el.hidden = true; }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    // The shared confirm/alert dialog handles its own Escape; don't also close ours underneath it.
    const shared = $('ui-modal-overlay');
    if (shared && !shared.hidden) return;
    ['rb-weight-overlay', 'rb-form-overlay', 'rb-detail-overlay'].some(id => {
      const el = $(id);
      if (el && !el.hidden) { closeOverlay(id); return true; }
      return false;
    });
  }

  function showMsg(id, text) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  function apiError(res, fallback) {
    return res?.data?.error || (res?.status === 401 ? 'Your admin session has expired — please sign in again.' : fallback);
  }

  // ================= Add / edit brand =================
  const FORM_FIELDS = ['rf-brand-id', 'rf-brand-name', 'rf-package', 'rf-location', 'rf-source',
    'rf-source-url', 'rf-last-verified', 'rf-classification-note', 'rf-notes'];

  function resetImageField(existingPath) {
    _pendingImageFile = null;
    _imageRemoved = false;
    _currentImagePath = existingPath || null;
    if ($('rf-image-file')) $('rf-image-file').value = '';
    renderImagePreview('rf-image-preview', _currentImagePath);
    if ($('rf-image-remove')) $('rf-image-remove').hidden = !_currentImagePath;
    showMsg('rf-image-msg', '');
  }

  function openAddForm() {
    FORM_FIELDS.forEach(id => { const el = $(id); if (el) el.value = ''; });
    $('rf-verification').value = 'unverified';
    $('rf-category').value = _cat !== 'all' ? _cat : (sortedCategories()[0]?.canonical_key || '');
    $('rb-form-title').textContent = 'Add Brand';
    $('rb-form-sub').textContent = 'Adds a branded product under one of the 8 forecast categories.';
    $('rf-save').textContent = 'Add Brand';
    resetImageField(null);
    showMsg('rf-msg', '');
    openOverlay('rb-form-overlay');
    setTimeout(() => $('rf-brand-name')?.focus(), 30);
  }

  function openEditForm(brandId) {
    const found = findBrand(brandId);
    if (!found) return;
    const { brand: b, category: cat } = found;
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
    resetImageField(b.image_path || null);
    $('rb-form-title').textContent = `Edit ${b.brand_name}`;
    $('rb-form-sub').textContent = `${cat.name} · every change is recorded in the brand's history.`;
    $('rf-save').textContent = 'Save Changes';
    showMsg('rf-msg', '');
    closeOverlay('rb-detail-overlay');
    openOverlay('rb-form-overlay');
    setTimeout(() => $('rf-brand-name')?.focus(), 30);
  }

  function formPayload() {
    const v = (id) => ($(id)?.value || '').trim();
    return {
      category_key: $('rf-category')?.value || '',
      brand_name: v('rf-brand-name'),
      package: v('rf-package') || null,
      location: v('rf-location') || null,
      source: v('rf-source'),
      source_url: v('rf-source-url') || null,
      last_verified: v('rf-last-verified') || null,
      classification_note: v('rf-classification-note') || null,
      notes: v('rf-notes') || null,
      verification_status: $('rf-verification')?.value || 'unverified',
    };
  }

  async function saveBrand() {
    const payload = formPayload();
    if (!payload.brand_name) { showMsg('rf-msg', 'Brand name is required.'); return; }
    if (!payload.source) { showMsg('rf-msg', 'A source is required — where did this entry come from?'); return; }
    if (payload.source_url && !/^https?:\/\/\S+$/i.test(payload.source_url)) {
      showMsg('rf-msg', 'Source URL must start with http:// or https://'); return;
    }
    showMsg('rf-msg', '');
    const brandId = $('rf-brand-id')?.value;
    const saveBtn = $('rf-save');
    if (saveBtn) saveBtn.disabled = true;
    try {
      const res = brandId
        ? await AgriPricePH.API.brandUpdate(brandId, payload, adminToken())
        : await AgriPricePH.API.brandAdd(payload, adminToken());
      if (res.ok && res.data.ok) {
        const bid = brandId || res.data.brand_id;
        let imageNote = '';
        if (_pendingImageFile) {
          const imgRes = await AgriPricePH.API.brandImageUpload(bid, _pendingImageFile, adminToken());
          if (!(imgRes.ok && imgRes.data.ok)) {
            imageNote = ` The brand saved, but the image could not be uploaded (${apiError(imgRes, 'please try again')}).`;
          }
        } else if (_imageRemoved && _currentImagePath) {
          const imgRes = await AgriPricePH.API.brandImageDelete(bid, adminToken());
          if (!(imgRes.ok && imgRes.data.ok)) {
            imageNote = ` The brand saved, but the image could not be removed (${apiError(imgRes, 'please try again')}).`;
          }
        }
        if (brandId) delete _historyCache[brandId];
        closeOverlay('rb-form-overlay');
        if (!brandId) { _cat = payload.category_key; _status = 'active'; syncFilters(); }
        await load();
        AgriPricePH.Modals.alert({
          title: brandId ? 'Brand updated' : 'Brand added',
          text: `'${res.data.brand_name || payload.brand_name}' was saved.${imageNote}`,
          type: imageNote ? 'warning' : 'success',
        });
      } else {
        showMsg('rf-msg', apiError(res, 'Could not save this brand.'));
      }
    } catch (e) {
      showMsg('rf-msg', 'Backend unreachable — please try again.');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // ================= Price weight =================
  function openWeight(brandId) {
    const found = findBrand(brandId);
    if (!found) return;
    const { brand: b, category: cat } = found;
    const info = _brandInfoById[b.id] || {};
    _weightBrandId = b.id;
    $('rb-weight-title').textContent = `Price weight — ${b.brand_name}`;
    $('rb-weight-sub').textContent = cat.name + (info.sample_date ? ` · last surveyed ${info.sample_date}` : '');
    $('rw-weight').value = info.weight_pct != null ? info.weight_pct : '';
    $('rw-weight').min = WEIGHT_MIN; $('rw-weight').max = WEIGHT_MAX;
    $('rw-range').textContent = `Allowed range ${WEIGHT_MIN}% to +${WEIGHT_MAX}%`;
    $('rw-date').value = info.sample_date || new Date().toISOString().slice(0, 10);
    $('rw-clear').hidden = info.weight_pct == null;
    showMsg('rw-msg', '');
    updateWeightPreview();
    openOverlay('rb-weight-overlay');
    setTimeout(() => $('rw-weight')?.focus(), 30);
  }

  function updateWeightPreview() {
    const found = findBrand(_weightBrandId);
    if (!found) return;
    const base = _priceByKey[found.category.canonical_key];
    const w = parseFloat($('rw-weight').value);
    $('rw-base').textContent = base != null ? `${peso(base)}/kg` : 'Not available';
    $('rw-result').textContent = (base != null && !isNaN(w)) ? `${peso(base * (1 + w / 100))}/kg` : '—';
  }

  async function saveWeight() {
    const raw = $('rw-weight').value.trim();
    const weight = parseFloat(raw);
    if (raw === '' || isNaN(weight)) { showMsg('rw-msg', 'Enter a weight in %, or use “Clear weight”.'); return; }
    if (weight < WEIGHT_MIN || weight > WEIGHT_MAX) { showMsg('rw-msg', `Weight must be between ${WEIGHT_MIN}% and +${WEIGHT_MAX}%.`); return; }
    const info = _brandInfoById[_weightBrandId] || {};
    const btn = $('rw-save');
    if (btn) btn.disabled = true;
    try {
      const res = await AgriPricePH.API.brandWeightSet(_weightBrandId, {
        weight_pct: weight,
        sample_date: $('rw-date').value || null,
        sample_locations: info.sample_locations || null,
        sample_n: info.sample_n || null,
        source_notes: info.source_notes || null,
      }, adminToken());
      if (res.ok && res.data.ok) {
        closeOverlay('rb-weight-overlay');
        delete _historyCache[_weightBrandId];
        await loadBrandPrices();
        renderAll();
      } else {
        showMsg('rw-msg', apiError(res, 'Could not save the weight.'));
      }
    } catch (e) {
      showMsg('rw-msg', 'Backend unreachable — please try again.');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function clearWeight() {
    const ok = await AgriPricePH.Modals.confirm({
      title: 'Clear this price weight?',
      text: 'The brand will show its plain category price again. You can set a new weight at any time.',
      type: 'warning', okText: 'Clear weight', danger: true,
    });
    if (!ok) return;
    try {
      const res = await AgriPricePH.API.brandWeightSet(_weightBrandId, { weight_pct: null }, adminToken());
      if (res.ok && res.data.ok) {
        closeOverlay('rb-weight-overlay');
        delete _historyCache[_weightBrandId];
        await loadBrandPrices();
        renderAll();
      } else {
        showMsg('rw-msg', apiError(res, 'Could not clear the weight.'));
      }
    } catch (e) {
      showMsg('rw-msg', 'Backend unreachable — please try again.');
    }
  }

  // ================= Details + history =================
  async function openDetails(brandId) {
    const found = findBrand(brandId);
    if (!found) return;
    const { brand: b, category: cat } = found;
    const info = _brandInfoById[b.id] || {};
    const status = b.verification_status || 'unverified';
    _detailBrandId = b.id;

    $('rb-detail-title').textContent = b.brand_name;
    $('rb-detail-sub').textContent = `${cat.name} · ${b.active ? 'Active' : 'Deactivated'}`;
    $('rb-detail-edit').hidden = !b.active;
    renderImagePreview('rb-detail-image', b.image_path || null);

    const item = (label, value, wide) => `
      <div class="rb-detail-item ${wide ? 'wide' : ''}">
        <span class="rb-detail-label">${label}</span>
        <span class="rb-detail-value">${value}</span>
      </div>`;
    const link = b.source_url
      ? `<a href="${esc(b.source_url)}" target="_blank" rel="noopener noreferrer">${esc(b.source_url)}</a>` : '—';
    const w = info.weight_pct;
    $('rb-detail-grid').innerHTML =
      item('Package / variety', esc(b.package || '—')) +
      item('Location', esc(b.location || '—')) +
      item('Verification', `<span class="pill ${VERIFICATION_PILL_CLASS[status]}">${VERIFICATION_LABELS[status] || esc(status)}</span>`) +
      item('Last verified', esc(b.last_verified || '—')) +
      item('Brand price', info.price != null ? `${peso(info.price)}/kg${info.estimated ? ' <span class="rb-muted">(estimate)</span>' : ''}` : '—') +
      item('Price weight', w != null ? `${w > 0 ? '+' : ''}${Number(w).toFixed(1)}%${info.sample_date ? ` <span class="rb-muted">· surveyed ${esc(info.sample_date)}</span>` : ''}` : '—') +
      item('Source', esc(b.source || '—'), true) +
      item('Source URL', link, true) +
      (b.classification_note ? item('Classification note', esc(b.classification_note), true) : '') +
      (b.notes ? item('Notes', esc(b.notes), true) : '');

    openOverlay('rb-detail-overlay');
    const hist = $('rb-detail-history');
    if (!_historyCache[b.id]) {
      hist.innerHTML = '<div class="rb-history-empty">Loading history…</div>';
      try {
        const d = await AgriPricePH.API.brandAudit(b.id, adminToken());
        _historyCache[b.id] = d.audit || [];
      } catch (e) {
        _historyCache[b.id] = null;
      }
    }
    if (_detailBrandId !== b.id) return; // user moved on while loading
    const rows = _historyCache[b.id];
    hist.innerHTML = rows == null
      ? '<div class="rb-history-empty">Couldn’t load the change history.</div>'
      : !rows.length
        ? '<div class="rb-history-empty">No changes recorded yet.</div>'
        : rows.map(r => `
          <div class="rb-history-item">
            <span class="rb-history-action">${esc(r.action)}</span>
            <span class="rb-history-detail">${esc(r.detail || '')}</span>
            <span class="rb-history-meta">${esc(r.actor || '—')} · ${esc(r.created_at || '')}</span>
          </div>`).join('');
  }

  // ================= Deactivate / reactivate =================
  async function setActive(brandId, activate) {
    const found = findBrand(brandId);
    if (!found) return;
    const name = found.brand.brand_name;
    const ok = await AgriPricePH.Modals.confirm(activate
      ? { title: `Reactivate '${name}'?`, text: 'It will show on the public catalog and in brand prices again.', type: 'info', okText: 'Reactivate' }
      : { title: `Deactivate '${name}'?`, text: 'It stops showing on the public catalog and in brand prices. Its price weight and change history are kept, and you can reactivate it later.', type: 'warning', okText: 'Deactivate', danger: true });
    if (!ok) return;
    try {
      const res = activate
        ? await AgriPricePH.API.brandReactivate(brandId, adminToken())
        : await AgriPricePH.API.brandDeactivate(brandId, adminToken());
      if (res.ok && res.data.ok) {
        delete _historyCache[brandId];
        await load();
      } else {
        AgriPricePH.Modals.alert({ title: 'Action failed', text: apiError(res, 'Could not update this brand.'), type: 'danger' });
      }
    } catch (e) {
      AgriPricePH.Modals.alert({ title: 'Backend unreachable', text: 'Please try again.', type: 'danger' });
    }
  }

  // ================= Wiring =================
  function syncFilters() {
    if ($('rb-search')) $('rb-search').value = _query;
    if ($('rb-verify-filter')) $('rb-verify-filter').value = _verify;
    if ($('rb-status-filter')) $('rb-status-filter').value = _status;
  }

  function bindEvents() {
    $('rb-add-btn')?.addEventListener('click', openAddForm);
    $('rb-rail')?.addEventListener('click', (e) => {
      const item = e.target.closest('[data-cat]');
      if (item) setCategory(item.dataset.cat);
    });
    $('rb-rail-select')?.addEventListener('change', (e) => setCategory(e.target.value));
    $('rb-search')?.addEventListener('input', (e) => { _query = e.target.value; _page = 1; renderMain(); });
    $('rb-verify-filter')?.addEventListener('change', (e) => { _verify = e.target.value; _page = 1; renderMain(); });
    $('rb-status-filter')?.addEventListener('change', (e) => { _status = e.target.value; _page = 1; renderMain(); });
    $('rb-pager')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-page]');
      if (!btn || btn.disabled) return;
      _page = Number(btn.dataset.page);
      renderMain();
    });
    $('rb-stats')?.addEventListener('click', (e) => {
      const q = e.target.closest('[data-quick]')?.dataset.quick;
      if (!q) return;
      _cat = 'all'; _query = ''; _page = 1;
      if (q === 'unverified') { _verify = 'unverified'; _status = 'active'; }
      if (q === 'inactive') { _verify = 'all'; _status = 'inactive'; }
      syncFilters();
      renderRail();
      renderMain();
    });
    $('rb-tbody')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = btn.dataset.id;
      switch (btn.dataset.act) {
        case 'view': openDetails(id); break;
        case 'edit': openEditForm(id); break;
        case 'weight': openWeight(id); break;
        case 'deactivate': setActive(id, false); break;
        case 'reactivate': setActive(id, true); break;
      }
    });
    $('rf-image-pick')?.addEventListener('click', () => $('rf-image-file')?.click());
    $('rf-image-remove')?.addEventListener('click', () => {
      _pendingImageFile = null;
      _imageRemoved = true;
      if ($('rf-image-file')) $('rf-image-file').value = '';
      renderImagePreview('rf-image-preview', null);
      $('rf-image-remove').hidden = true;
      showMsg('rf-image-msg', '');
    });
    $('rf-image-file')?.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        showMsg('rf-image-msg', 'Image must be PNG, JPG, or WEBP.');
        e.target.value = '';
        return;
      }
      if (file.size > 4 * 1024 * 1024) {
        showMsg('rf-image-msg', 'Image must be 4MB or smaller.');
        e.target.value = '';
        return;
      }
      showMsg('rf-image-msg', '');
      _pendingImageFile = file;
      _imageRemoved = false;
      renderImagePreview('rf-image-preview', URL.createObjectURL(file));
      $('rf-image-remove').hidden = false;
    });
    $('rb-form')?.addEventListener('submit', (e) => { e.preventDefault(); saveBrand(); });
    $('rb-weight-form')?.addEventListener('submit', (e) => { e.preventDefault(); saveWeight(); });
    $('rw-weight')?.addEventListener('input', updateWeightPreview);
    $('rw-clear')?.addEventListener('click', clearWeight);
    $('rb-detail-edit')?.addEventListener('click', () => openEditForm(_detailBrandId));
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', onResize);
  }

  function init() {
    _cat = 'all'; _query = ''; _verify = 'all'; _status = 'active'; _page = 1;
    _pricesLoaded = false; _historyCache = {};
    mountOverlays();
    bindEvents();
    load();
  }

  function destroy() {
    document.querySelectorAll('body > .rb-modal-overlay').forEach(el => el.remove());
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize', onResize);
  }

  return { init, destroy };
})();
