/* AgriPricePH — public NCR "Prices" catalog (formerly Rice Catalog).
   8 categories (Local/Imported x 4 grades) behind one custom single-line dropdown, rendering a
   grid of brand cards. Cards show only name/type/price/image by default; hovering (or focusing,
   on keyboard) reveals a short preview layer — verification, package, location/source — kept
   intentionally terse so it still reads at a glance. Clicking/selecting a card (mouse, Enter/Space,
   or tap) opens a modal with that brand's full detail. Brand fields (image, package, location,
   source, verification status) come straight from the verified catalog API — the same rows the
   Rice Brands admin table manages, including the catalog image uploaded there. PRICE is always
   shown as a range, never a single figure:
     - a DA prevailing bracket (price_min..price_max) when one exists for the category, else
     - the model's own calibrated forecast band (tomorrow's 90% interval, from /api/predictions'
       forecasts_by_key) — a real, already-computed range, never invented here;
     - for a brand an admin has actually surveyed (a canvassed retail-premium weight on file via
       GET /api/brand-prices), that same category range is scaled by the brand's weight factor —
       the identical base_price x (1 + weight_pct/100) relationship used everywhere else in the
       app, just applied to both ends of the range instead of one point.
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
  const VERIFICATION_LABEL = {
    dti_verified: 'DTI-verified', field_verified: 'Field-verified', unverified: 'Unverified',
  };
  const PLACEHOLDER_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 12h18a9 9 0 0 1-18 0z"/><path d="M12 12V4"/><path d="M9 7c0-1.5 1-3 3-3s3 1.5 3 3"/></svg>';

  const peso = (v) => (v == null || isNaN(v)) ? null : `₱${Number(v).toFixed(2)}`;
  let CATS = {};        // canonical_key -> category (with brands[])
  let PRICE = {};       // canonical_key -> { min, max, label } (category-level forecast range)
  let BRAND_INFO = {};  // brand id -> { price, estimated, weight_pct, sample_date, sample_locations, sample_n, source_notes }
  let active = 'locRegular';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function withUnit(text) {
    return String(text).replace(/\/kg/g, '<span class="rc-unit">/kg</span>');
  }

  // image_path from the API is root-relative ('/public/images/rice-brands/...'). This page isn't
  // always served from the same origin as the Flask API (js/api.js's detectBase() sends every API
  // call to :5000 regardless of where the HTML itself loaded from — e.g. Live Server on another
  // port), so a bare <img src="/public/..."> would resolve against the WRONG origin and 404 even
  // though the catalog API call that returned the path succeeded.
  function resolveImageUrl(src) {
    if (!src) return src;
    if (/^(blob:|data:|https?:)/i.test(src)) return src;
    return `${AgriPricePH.API.BASE}${src}`;
  }

  function formatRange(min, max) {
    if (min == null || max == null || isNaN(min) || isNaN(max)) return '—';
    const lo = Math.min(min, max), hi = Math.max(min, max);
    if (hi - lo < 0.005) return `${peso(lo)}/kg`; // no real spread — a single figure is honest here
    return `${peso(lo)}–${peso(hi)}/kg`;
  }

  function brandCount(key) {
    const cat = CATS[key];
    return cat && cat.brands ? cat.brands.length : 0;
  }

  const VERIFICATION_CLASS = { dti_verified: 'dti', field_verified: 'field', unverified: 'plain' };

  // variantPrefix picks the color treatment for the context this badge renders in: 'rc-badge'
  // (translucent-on-dark, for the card's hover reveal scrim) or 'rc-modal-badge' (solid-on-white,
  // for the modal). extraClass adds the reveal panel's own alignment tweak when relevant.
  function verificationBadge(status, variantPrefix, extraClass) {
    const s = status || 'unverified';
    const cls = `${variantPrefix}--${VERIFICATION_CLASS[s] || 'plain'}`;
    return `<span class="rc-badge ${extraClass || ''} ${cls}">${esc(VERIFICATION_LABEL[s] || s)}</span>`;
  }

  /** Shared by the card and the modal: a brand's price range + a plain-language note on where it
   *  came from (surveyed estimate vs. the category's own forecast/DA range). */
  function brandPriceInfo(b, catRange) {
    const info = BRAND_INFO[b.id];
    const estimated = !!(info && info.estimated && info.weight_pct != null && catRange);
    if (estimated) {
      const factor = 1 + Number(info.weight_pct) / 100;
      const bits = [`surveyed ${info.sample_date || '—'}`];
      if (info.sample_locations) bits.push(info.sample_locations);
      return {
        text: formatRange(catRange.min * factor, catRange.max * factor),
        note: `Estimated — brand's canvassed retail premium applied to the category range, ${bits.join(' · ')}`,
      };
    }
    return {
      text: catRange ? formatRange(catRange.min, catRange.max) : '—',
      note: catRange ? catRange.label : 'no forecast price',
    };
  }

  function brandMedia(b, cls) {
    return b.image_path
      ? `<img class="${cls}" src="${esc(resolveImageUrl(b.image_path))}" alt="${esc(b.brand_name)}" loading="lazy">`
      : `<div class="rc-card-placeholder">${PLACEHOLDER_SVG}</div>`;
  }

  function cardHtml(b, catRange, typeLabel) {
    const price = brandPriceInfo(b, catRange);
    const sourceHtml = b.source_url
      ? `<a class="rc-reveal-link" href="${esc(b.source_url)}" target="_blank" rel="noopener">${esc(b.source || 'Source')}</a>`
      : esc(b.source || '');
    const metaLine = [esc(b.location || 'NCR'), sourceHtml].filter(Boolean).join(' · ');
    return `
      <article class="rc-card" data-brand-id="${b.id}" tabindex="0" role="button"
        aria-haspopup="dialog" aria-label="${esc(b.brand_name)} — view details">
        <div class="rc-card-media">
          ${brandMedia(b, 'rc-card-img')}
          <div class="rc-card-reveal">
            ${verificationBadge(b.verification_status, 'rc-badge', 'rc-reveal-badge')}
            ${b.package ? `<span class="rc-reveal-line">${esc(b.package)}</span>` : ''}
            <span class="rc-reveal-line">${metaLine || '—'}</span>
          </div>
        </div>
        <div class="rc-card-body">
          <h3 class="rc-card-name">${esc(b.brand_name)}</h3>
          <p class="rc-card-type">${esc(typeLabel)}</p>
          <p class="rc-card-price">${withUnit(esc(price.text))}</p>
        </div>
      </article>`;
  }

  let CURRENT_BRANDS = [];   // brands in the active category, for the click-to-open-modal lookup
  let CURRENT_RANGE = null;
  let CURRENT_TYPE_LABEL = '';

  function renderCards() {
    const wrap = document.getElementById('rc-cards');
    const priceVal = document.getElementById('rc-active-price');
    const tab = TABS.find(t => t.key === active);
    const cat = CATS[active];
    const range = PRICE[active] || null;

    if (priceVal) priceVal.innerHTML = withUnit(esc(range ? formatRange(range.min, range.max) : '—'));

    const brands = (cat && cat.brands) ? cat.brands : [];
    CURRENT_BRANDS = brands;
    CURRENT_RANGE = range;
    CURRENT_TYPE_LABEL = tab ? tab.label : '';

    if (!wrap) return;
    if (!brands.length) {
      wrap.innerHTML = `<div class="rc-empty">No verified NCR rice products available for this category yet.</div>`;
      return;
    }
    wrap.innerHTML = brands.map(b => cardHtml(b, range, CURRENT_TYPE_LABEL)).join('');

    wrap.querySelectorAll('.rc-card').forEach(card => {
      const select = (e) => {
        if (e.target.closest('a')) return; // let the source link navigate, not open the modal
        card.classList.remove('is-selected');
        // eslint-disable-next-line no-unused-expressions
        card.offsetWidth; // restart the pop animation if the same card is clicked again
        card.classList.add('is-selected');
        const b = CURRENT_BRANDS.find(x => String(x.id) === card.dataset.brandId);
        if (b) openBrandModal(b, CURRENT_RANGE, CURRENT_TYPE_LABEL);
      };
      card.addEventListener('click', select);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(e); }
      });
      card.addEventListener('animationend', () => card.classList.remove('is-selected'));
    });
  }

  /* ================= Brand detail modal ================= */
  let _lastFocusedEl = null;

  function openBrandModal(b, catRange, typeLabel) {
    const overlay = document.getElementById('rc-modal-overlay');
    if (!overlay) return;
    const price = brandPriceInfo(b, catRange);

    document.getElementById('rc-modal-media').innerHTML = brandMedia(b, 'rc-modal-img');
    document.getElementById('rc-modal-title').textContent = b.brand_name;
    document.getElementById('rc-modal-type').textContent = typeLabel;
    document.getElementById('rc-modal-badge').innerHTML = verificationBadge(b.verification_status, 'rc-modal-badge', '');
    document.getElementById('rc-modal-price').innerHTML = withUnit(esc(price.text));
    document.getElementById('rc-modal-price-note').textContent = price.note;

    const item = (label, value) => value
      ? `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>` : '';
    const sourceHtml = b.source_url
      ? `<a class="rc-modal-link" href="${esc(b.source_url)}" target="_blank" rel="noopener">${esc(b.source || 'Source')}</a>`
      : esc(b.source || '');
    document.getElementById('rc-modal-meta').innerHTML =
      item('Package / variety', esc(b.package || '')) +
      item('Location', esc(b.location || 'NCR')) +
      item('Source', sourceHtml) +
      item('Last verified', esc(b.last_verified || ''));

    const noteEl = document.getElementById('rc-modal-note');
    const noteParts = [];
    if (b.classification_note) noteParts.push(`<strong>Category basis —</strong> ${esc(b.classification_note)}`);
    if (b.notes) noteParts.push(esc(b.notes));
    if (noteEl) {
      noteEl.hidden = !noteParts.length;
      noteEl.innerHTML = noteParts.join('<br><br>');
    }

    _lastFocusedEl = document.activeElement;
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('is-open'));
    document.body.style.overflow = 'hidden';
    overlay.querySelector('.rc-modal')?.focus();
  }

  function closeBrandModal() {
    const overlay = document.getElementById('rc-modal-overlay');
    if (!overlay || overlay.hidden) return;
    overlay.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(() => { overlay.hidden = true; }, 200);
    if (_lastFocusedEl && document.contains(_lastFocusedEl)) _lastFocusedEl.focus();
  }

  function bindModal() {
    const overlay = document.getElementById('rc-modal-overlay');
    if (!overlay) return;
    document.getElementById('rc-modal-close')?.addEventListener('click', closeBrandModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeBrandModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('is-open')) closeBrandModal();
    });
  }

  /* ================= Scroll to top =================
     Appears once the "About the data" note (the page's footer) is reached, not at a fixed pixel
     offset — so it stays correct regardless of how many brand cards are in the active category.
     This site scrolls <html class="public-site"> itself (overflow-y:auto, set in
     css/landpage-nav.css), not the window — so window.scrollTo()/window.scrollY are no-ops here;
     document.scrollingElement (the element the browser actually designates as scrollable) is what
     both reads and drives the real scroll position. */
  function bindScrollTop() {
    const btn = document.getElementById('rc-scroll-top');
    const note = document.getElementById('rc-note');
    if (!btn) return;
    const scroller = document.scrollingElement || document.documentElement;
    btn.addEventListener('click', () => scroller.scrollTo({ top: 0, behavior: 'smooth' }));
    if (note && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(entry => btn.classList.toggle('is-visible', entry.isIntersecting));
      }, { threshold: 0 });
      io.observe(note);
    } else {
      document.addEventListener('scroll', () => {
        btn.classList.toggle('is-visible', scroller.scrollTop > 600);
      }, { passive: true, capture: true });
    }
  }

  /* ================= Custom category dropdown =================
     A native <select>'s open option list can't be restyled in most browsers — it always falls
     back to plain OS chrome no matter how the closed control is themed. This is a small
     button + listbox widget instead, styled to match the rest of the page (cards, badges). */
  function dropdownOptionLabel(t) {
    return `${t.label} — ${brandCount(t.key)} brand${brandCount(t.key) === 1 ? '' : 's'}`;
  }

  function renderCategoryDropdown() {
    const panel = document.getElementById('rc-dropdown-panel');
    const trigger = document.getElementById('rc-dropdown-trigger');
    const label = document.getElementById('rc-dropdown-label');
    if (!panel || !trigger || !label) return;

    const group = (seg, segLabel) => {
      const opts = TABS.filter(t => t.seg === seg).map(t => `
        <button type="button" class="rc-dropdown-option" role="option" data-key="${t.key}"
          aria-selected="${t.key === active}">${esc(dropdownOptionLabel(t))}</button>`).join('');
      return `<div class="rc-dropdown-group-label">${segLabel}</div>${opts}`;
    };
    panel.innerHTML = group('local', 'Local') + group('imported', 'Imported');

    const activeTab = TABS.find(t => t.key === active);
    label.textContent = activeTab ? dropdownOptionLabel(activeTab) : 'Select a category';
  }

  function closeDropdown() {
    const dd = document.getElementById('rc-category-dropdown');
    const trigger = document.getElementById('rc-dropdown-trigger');
    const panel = document.getElementById('rc-dropdown-panel');
    if (!dd) return;
    dd.classList.remove('is-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (panel) panel.hidden = true;
  }

  function openDropdown() {
    const dd = document.getElementById('rc-category-dropdown');
    const trigger = document.getElementById('rc-dropdown-trigger');
    const panel = document.getElementById('rc-dropdown-panel');
    if (!dd) return;
    dd.classList.add('is-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    if (panel) panel.hidden = false;
  }

  function bindDropdown() {
    const dd = document.getElementById('rc-category-dropdown');
    const trigger = document.getElementById('rc-dropdown-trigger');
    const panel = document.getElementById('rc-dropdown-panel');
    if (!dd || !trigger || !panel) return;

    trigger.addEventListener('click', () => {
      dd.classList.contains('is-open') ? closeDropdown() : openDropdown();
    });
    panel.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-key]');
      if (!opt) return;
      active = opt.dataset.key;
      renderCategoryDropdown();
      renderCards();
      closeDropdown();
      trigger.focus();
    });
    document.addEventListener('click', (e) => {
      if (!dd.contains(e.target)) closeDropdown();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dd.classList.contains('is-open')) {
        closeDropdown();
        trigger.focus();
      }
    });
  }

  function buildPriceMap(brackets, predictions) {
    const map = {};
    (brackets.brackets || []).forEach(bk => {
      if (!map[bk.canonical_key] && bk.price_min != null && bk.price_max != null) {
        map[bk.canonical_key] = { min: Number(bk.price_min), max: Number(bk.price_max), label: 'prevailing range · DA' };
      }
    });
    // No DA bracket for this category — fall back to the model's own calibrated forecast band
    // (tomorrow's interval), a real computed range rather than a single guessed figure.
    const fbk = (predictions && predictions.forecasts_by_key) || {};
    Object.keys(fbk).forEach(k => {
      if (map[k]) return;
      const row = (fbk[k] || [])[0];
      if (row && row.low != null && row.high != null) {
        map[k] = { min: Number(row.low), max: Number(row.high), label: `forecast range · ${row.interval_pct || 90}% confidence` };
      }
    });
    // Last resort — no band data at all, just a plain current price (renders as a single figure).
    const cur = (predictions && predictions.current_prices) || {};
    Object.keys(cur).forEach(k => {
      if (!map[k] && cur[k] != null) map[k] = { min: Number(cur[k]), max: Number(cur[k]), label: 'latest forecast price' };
    });
    return map;
  }

  async function init() {
    bindDropdown();
    bindModal();
    bindScrollTop();

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
      renderCategoryDropdown();
      renderCards();
    } catch (e) {
      const wrap = document.getElementById('rc-cards');
      if (wrap) wrap.innerHTML = `<div class="rc-empty">Cannot reach the price service right now.</div>`;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
