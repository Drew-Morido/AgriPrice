/* AgriPricePH — public NCR Rice Catalog.
   8 category tabs drive ONE reusable table (Brand | Price | Actual Package | Location | Source |
   Last Update). Brand/package/location/source come from the verified catalog API. PRICE is, per
   brand, either:
     - an adjusted estimate (base forecast × a canvassed retail-premium weight) for brands an
       admin has actually surveyed — via GET /api/brand-prices, labeled "Estimated — base
       forecast + observed retail premium, surveyed [date]" (never "AI predicted": this is a
       field-observed retail markup applied to the forecast, not a model output), or
     - the plain category forecast price (brackets / current forecast) for every other brand —
       nothing is invented for brands with no field data.
   NCR-only; empty state when a category has no verified products. */
(function () {
  // Tab order per spec.
  const TABS = [
    { key: 'locRegular',    seg: 'local',    label: 'Local Regular-Milled' },
    { key: 'locWellMilled', seg: 'local',    label: 'Local Well-Milled' },
    { key: 'locPremium',    seg: 'local',    label: 'Local Premium' },
    { key: 'locSpecial',    seg: 'local',    label: 'Local Special' },
    { key: 'impRegular',    seg: 'imported', label: 'Imported Regular-Milled' },
    { key: 'impWellMilled', seg: 'imported', label: 'Imported Well-Milled' },
    { key: 'impPremium',    seg: 'imported', label: 'Imported Premium' },
    { key: 'impSpecial',    seg: 'imported', label: 'Imported Special' },
  ];

  const peso = (v) => (v == null || isNaN(v)) ? null : `₱${Number(v).toFixed(2)}`;
  let CATS = {};        // canonical_key -> category (with brands[])
  let PRICE = {};       // canonical_key -> { text, label } (category-level forecast price)
  let BRAND_INFO = {};  // brand id -> { price, estimated, sample_date, sample_locations }
  let active = 'locRegular';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /** Price for a category, sourced from the forecast: bracket range first, else current price. */
  function priceFor(key) {
    return PRICE[key] || { text: '—', label: 'no forecast price' };
  }

  function renderTabs() {
    const draw = (hostId, seg) => {
      const host = document.getElementById(hostId);
      if (!host) return;
      host.innerHTML = TABS.filter(t => t.seg === seg).map(t =>
        `<button class="rc-tab${t.key === active ? ' active' : ''}" data-key="${t.key}">${t.label}</button>`
      ).join('');
      host.querySelectorAll('.rc-tab').forEach(btn =>
        btn.addEventListener('click', () => { active = btn.dataset.key; renderTabs(); renderTable(); }));
    };
    draw('rc-tabs-local', 'local');
    draw('rc-tabs-imported', 'imported');
  }

  function renderTable() {
    const tbody = document.getElementById('rc-tbody');
    const title = document.getElementById('rc-active-title');
    const sub = document.getElementById('rc-active-sub');
    const tab = TABS.find(t => t.key === active);
    const cat = CATS[active];
    const price = priceFor(active);
    if (title) title.textContent = tab ? tab.label : '—';
    if (sub) sub.textContent = `Forecast price for this category: ${price.text} (${price.label})`;

    const brands = (cat && cat.brands) ? cat.brands : [];
    if (!brands.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="rc-empty">No verified NCR rice products available for this category yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = brands.map(b => {
      const src = b.source_url
        ? `<a class="rc-srclink" href="${esc(b.source_url)}" target="_blank" rel="noopener">${esc(b.source || 'Source')}</a>`
        : esc(b.source || '—');
      const info = BRAND_INFO[b.id];
      // Estimated (canvassed weight applied) vs. the plain category forecast price — never
      // invented for a brand with no field data, and never labeled as an AI prediction: this is
      // a field-observed retail premium/discount applied on top of the forecast.
      const priceCell = (info && info.estimated && info.price != null)
        ? `${peso(info.price)}/kg<div class="rc-price-sub">Estimated — base forecast + observed retail premium, surveyed ${esc(info.sample_date || '—')}${info.sample_locations ? ' · ' + esc(info.sample_locations) : ''}</div>`
        : price.text;
      return `<tr>
        <td>${esc(b.brand_name)}</td>
        <td class="rc-price">${priceCell}</td>
        <td class="rc-pkg">${esc(b.package || '—')}</td>
        <td>${esc(b.location || 'NCR')}</td>
        <td>${src}</td>
        <td>${esc(b.last_verified || '—')}</td>
      </tr>`;
    }).join('');
  }

  function buildPriceMap(brackets, predictions) {
    const map = {};
    (brackets.brackets || []).forEach(bk => {
      if (!map[bk.canonical_key]) {
        map[bk.canonical_key] = { text: `${peso(bk.price_min)}–${peso(bk.price_max)}/kg`, label: 'prevailing range · DA' };
      }
    });
    const cur = (predictions && predictions.current_prices) || {};
    Object.keys(cur).forEach(k => {
      if (!map[k] && cur[k] != null) map[k] = { text: `${peso(cur[k])}/kg`, label: 'latest forecast price' };
    });
    return map;
  }

  async function init() {
    try {
      const [cat, brk, pred, bp] = await Promise.all([
        AgriPricePH.API.catalog(),
        AgriPricePH.API.priceBrackets(),
        AgriPricePH.API.predictions().catch(() => ({})),
        AgriPricePH.API.brandPrices().catch(() => ({})),
      ]);
      CATS = {};
      (cat.categories || []).forEach(c => { CATS[c.canonical_key] = c; });
      PRICE = buildPriceMap(brk, pred);
      BRAND_INFO = {};
      (bp.categories || []).forEach(c => (c.brands || []).forEach(b => { BRAND_INFO[b.id] = b; }));

      const note = document.getElementById('rc-note');
      const anyBrands = (cat.categories || []).some(c => c.brands && c.brands.length);
      if (note) {
        note.innerHTML =
          '<strong>About the data.</strong> Prices are the prevailing category price from the ' +
          'Price Forecast page (DA Bantay Presyo ranges / latest forecast). Brand, package, and ' +
          'location are verified from official brand or NCR-retailer sources (see the Source link). ' +
          'Many milled-rice categories are sold <em>by classification, not by brand</em> (per DA\'s ' +
          '2018 labeling rule), so they may show no branded products. ' +
          (anyBrands ? '' : 'No verified branded products are loaded yet.');
      }
      renderTabs();
      renderTable();
    } catch (e) {
      const tbody = document.getElementById('rc-tbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="rc-empty">Cannot reach the price service right now.</td></tr>`;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
