/* AgriPricePH — Admin "Rice Catalog & Taxes" module.
   Reads /api/catalog, /api/taxes, /api/prices/brackets, /api/consumer-price.
   Empty-safe: shows [VERIFY] states until official DTI/BOC data is loaded. */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Catalog = (function () {
  const $ = (id) => document.getElementById(id);
  const peso = (v) => (v == null || isNaN(v)) ? '—' : `₱${Number(v).toFixed(2)}`;
  let _cats = [];

  function badge(ok) {
    const color = ok ? 'var(--color-accent,#4CAF6E)' : 'var(--color-danger,#EF4444)';
    return `<span style="color:${color};font-weight:600;">${ok ? '✓ verified' : '⚠ [VERIFY]'}</span>`;
  }

  async function loadCategories() {
    const body = $('cat-body'); const note = $('cat-note');
    try {
      const d = await AgriPricePH.API.catalog();
      _cats = d.categories || [];
      if (note) note.textContent = d.note || '';
      body.innerHTML = _cats.length ? _cats.map(c => `
        <tr style="border-top:1px solid var(--border-color,#eee);">
          <td style="padding:6px 8px;">${c.name}</td>
          <td style="padding:6px 8px;">${c.segment}</td>
          <td style="padding:6px 8px;"><code>${c.canonical_key}</code></td>
          <td style="padding:6px 8px;">${badge(!!c.dti_verified)}</td>
          <td style="padding:6px 8px;">${(c.brands && c.brands.length) ? c.brands.map(b => b.brand_name).join(', ') : '<span style="color:var(--text-muted);">none — [VERIFY: DTI]</span>'}</td>
        </tr>`).join('') : '<tr><td colspan="5" style="padding:10px 8px;color:var(--text-muted);">No categories — run datasets/catalog_schema.py.</td></tr>';
      const sel = $('cp-category');
      if (sel) sel.innerHTML = _cats.map(c => `<option value="${c.canonical_key}">${c.name}</option>`).join('');
    } catch (e) {
      body.innerHTML = `<tr><td colspan="5" style="padding:10px 8px;color:var(--color-danger,#EF4444);">Backend unreachable.</td></tr>`;
    }
  }

  async function loadTaxes() {
    const body = $('tax-body'); const note = $('tax-note');
    try {
      const d = await AgriPricePH.API.taxes();
      const taxes = d.taxes || [];
      if (note) note.textContent = d.note || '';
      body.innerHTML = taxes.length ? taxes.map(t => `
        <tr style="border-top:1px solid var(--border-color,#eee);">
          <td style="padding:6px 8px;">${t.name}</td>
          <td style="padding:6px 8px;">${t.kind}</td>
          <td style="padding:6px 8px;">${t.rate_pct != null ? t.rate_pct + '%' : (t.flat_amount != null ? peso(t.flat_amount) + '/kg' : '—')}</td>
          <td style="padding:6px 8px;">${t.legal_basis || '—'}</td>
        </tr>`).join('') : '<tr><td colspan="4" style="padding:10px 8px;color:var(--text-muted);">No tax components — pending BOC/BIR/DTI [VERIFY].</td></tr>';
    } catch (e) {
      body.innerHTML = `<tr><td colspan="4" style="padding:10px 8px;color:var(--color-danger,#EF4444);">Backend unreachable.</td></tr>`;
    }
  }

  async function loadBrackets() {
    const body = $('bracket-body');
    try {
      const d = await AgriPricePH.API.priceBrackets();
      const rows = d.brackets || [];
      body.innerHTML = rows.length ? rows.map(b => `
        <tr style="border-top:1px solid var(--border-color,#eee);">
          <td style="padding:6px 8px;">${b.category}</td>
          <td style="padding:6px 8px;">${b.effective_date}</td>
          <td style="padding:6px 8px;">${peso(b.price_min)}</td>
          <td style="padding:6px 8px;">${peso(b.price_max)}</td>
          <td style="padding:6px 8px;">${b.province || '—'}${b.market_name ? ' · ' + b.market_name : ''}</td>
          <td style="padding:6px 8px;">${b.source || '—'}</td>
        </tr>`).join('') : `<tr><td colspan="6" style="padding:10px 8px;color:var(--text-muted);">${d.note || 'No brackets — pending DTI [VERIFY].'}</td></tr>`;
    } catch (e) {
      body.innerHTML = `<tr><td colspan="6" style="padding:10px 8px;color:var(--color-danger,#EF4444);">Backend unreachable.</td></tr>`;
    }
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
        ${taxLines || '<div style="padding-left:12px;color:var(--text-muted);">No taxes applied</div>'}
        <div style="margin-top:6px;">Final consumer price: <strong>${peso(d.final_consumer_price)}</strong></div>
        ${d.note ? `<div style="color:var(--text-muted);margin-top:6px;">${d.note}</div>` : ''}`;
    } catch (e) {
      out.textContent = 'Backend unreachable.';
    }
  }

  function init() {
    loadCategories();
    loadTaxes();
    loadBrackets();
    const go = $('cp-go');
    if (go) go.addEventListener('click', computeConsumerPrice);
  }

  return { init };
})();
