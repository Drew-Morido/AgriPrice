/* AgriPricePH — public NCR "Rice Catalog".
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

  const peso = (v) => (v == null || isNaN(v)) ? null : `₱${Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  let CATS = {};        // canonical_key -> category (with brands[])
  let PRICE = {};       // canonical_key -> { min, max, label } (category-level forecast range)
  let BRAND_INFO = {};  // brand id -> { price, estimated, weight_pct, sample_date, sample_locations, sample_n, source_notes }
  let OUTLOOK = {};     // canonical_key -> { dir, delta, days } (category-level 3-day forecast direction)
  let active = 'locRegular';
  // Grades the market survey found no branded product for, with the reason it recorded.
  const EMPTY_NOTE = {
    impRegular: 'Imported regular-milled rice is not sold under a brand name in the Philippines, so there are no products to list.',
  };
  let query = '';       // search text; when set, results span ALL categories
  const FLAT_BAND = 0.25; // moves smaller than this (~half the model's typical error) read as 'steady', not a trend
  // "About this listing": each grade explained by the DA's own rice classification — the basis the
  // survey used to classify every product (DA SRP notice; PNS/BAFS 290).
  const DA_GRADE_NOTE = {
    Special: 'Special rice under the DA rice classification — aromatic, glutinous or pigmented rice, such as Dinorado, Malagkit, and red, black or brown rice.',
    Premium: 'Premium rice under the DA rice classification — well-milled rice with no more than 5% broken grains.',
    WellMilled: 'Well-milled rice under the DA rice classification — milled until only about 1–19% of the bran layer remains.',
    Regular: 'Regular-milled rice under the DA rice classification — milled with about 20–40% of the bran layer remaining.',
  };
  const gradeOf = (key) => String(key || '').replace(/^(loc|imp)/, '');
  const INFO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r=".6" fill="currentColor"/></svg>';
  // A small (i) the reader can hover, focus or tap for details that do not need to be on the page.
  const infoTip = (text) => `<span class="rc-tip" tabindex="0" role="note" aria-label="${esc(text)}" data-tip="${esc(text)}">${INFO_SVG}</span>`;
  const SURVEY_DAYS = 30;  // the canvass ran 30 consecutive days, ending on each brand's sample_date

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function fmtDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
    return new Date(iso.slice(0, 10) + 'T12:00:00')
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  const noYear = (label) => (label ? label.replace(/, \d{4}$/, '') : label);

  function ageDays(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
    return Math.floor((Date.now() - new Date(iso.slice(0, 10) + 'T12:00:00').getTime()) / 86400000);
  }

  function withUnit(text) {
    return String(text).replace(/\/(\d+(?:\.\d+)?)?kg/g, (m) => `<span class="rc-unit">${m}</span>`);
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

  // A product sold in several pack sizes (1kg, 2kg, 5kg, 10kg, 25kg…) shows as one card PER PACK,
  // so a shopper sees each size and its price side by side. `_cid` identifies the card; `_pack` is
  // the pack it shows. A product with one pack (or none recorded) stays a single card.
  function entriesOf(b) {
    const info = BRAND_INFO[b.id] || {};
    const packs = Array.isArray(info.packs) ? info.packs : [];
    if (packs.length < 2) return [Object.assign({}, b, { _pack: packs[0] || null, _cid: `${b.id}` })];
    return packs.map((p, i) => Object.assign({}, b, { _pack: p, _cid: `${b.id}-${i}` }));
  }

  function brandCount(key) {
    const cat = CATS[key];
    return cat && cat.brands ? cat.brands.flatMap(entriesOf).length : 0;
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

  const gradeName = (key) => (TABS.find(t => t.key === key) || {}).label || 'category';

  /** Price text plus short, vendor-facing pieces: one "checked" date, a one-line note, and the
   *  fuller "how it's worked out" text that the modal keeps behind a collapsed section. */
  function brandPriceInfo(b, catRange, key) {
    const info = BRAND_INFO[b.id] || {};
    const grade = gradeName(key);
    const catAsOf = catRange && catRange.asOf ? fmtDate(catRange.asOf) : null;
    const catSrc = !catRange ? 'no price data'
      : catRange.source === 'da' ? 'the DA prevailing range'
      : catRange.source === 'forecast' ? "the model's forecast range"
      : 'the latest category price';
    const surveyed = fmtDate(info.sample_date);
    const sMin = info.surveyed_price_min, sMax = info.surveyed_price_max;
    const shelf = sMin == null ? null
      : (Math.abs(sMax - sMin) < 0.005 ? `${peso(sMin)}/kg` : `${peso(sMin)}–${peso(sMax)}/kg`);
    // The canvass ran 30 days; sample_date is its 30th and last day, so the window is
    // sample_date − 29 days … sample_date (Aug 6 – Sep 4, 2026). No "may have changed" warning: the
    // shelf price is re-anchored to the DA range every day, so it moves when the DA price moves.
    const window30 = (() => {
      if (!info.sample_date || !/^\d{4}-\d{2}-\d{2}/.test(info.sample_date)) return null;
      const end = new Date(info.sample_date.slice(0, 10) + 'T12:00:00');
      const start = new Date(end); start.setDate(end.getDate() - (SURVEY_DAYS - 1));
      const md = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return { start: md(start), end: `${md(end)}, ${end.getFullYear()}`, endShort: md(end) };
    })();
    const stale = false;
    const staleNote = '';
    const checked = '';   // the canvass window lives in the (i) next to "Last verified"
    const surveyStory = window30
      ? `Prices were canvassed in local markets every day for ${SURVEY_DAYS} days, from ${window30.start} to ${window30.end}. ${window30.endShort} was the ${SURVEY_DAYS}th and last day, so its prices are the ones used.`
      : '';
    const follows = catRange && catRange.source === 'forecast'
      ? `Because it is tied to the ${grade} price forecast, which is built from DA prices, it rises when DA prices rise and falls when they fall.`
      : `Because it is tied to the DA price, it rises when the DA price rises and falls when it falls.`;

    if (info.fixed_price && info.price != null) {
      return {
        text: `${peso(info.price)}/kg`, stale, shelf, fixed: true, survey: surveyStory,
        asOf: checked,
        note: 'Government-set price — it does not move with the market range.',
        how: 'This price is set by the government, so it is shown as one figure and is not adjusted with the market range.',
      };
    }
    const pk = b._pack;
    if (pk && info.estimated && info.weight_pct != null && catRange && info.price != null) {
      // This pack's own premium over the grade: its per-kg shelf price vs the grade's base price
      // (base recovered from the product's price = base × (1 + weight)). Scaled onto today's grade
      // range exactly like every other brand price, then multiplied up to the pack's weight.
      const base = Number(info.price) / (1 + Number(info.weight_pct) / 100);
      const f = Number(pk.per_kg) / base;
      const kg = pk.pack_kg ? Number(pk.pack_kg) : 1;
      const lo = catRange.min * f, hi = catRange.max * f;
      const range = (a, z, unit) => (Math.abs(z - a) < 0.005 ? `${peso(a)}${unit}` : `${peso(a)}–${peso(z)}${unit}`);
      return {
        // a 1kg pack's price IS its per-kilo price — show it once, as /kg
        text: kg > 1 ? range(lo * kg, hi * kg, `/${kg}kg`) : range(lo, hi, '/kg'),
        perKg: kg > 1 ? `${range(lo, hi, '')} per kilo` : '',
        stale, asOf: checked, note: staleNote,
        shelf: pk.pack_kg ? `${peso(pk.pack_price)} for ${kg}kg (${peso(pk.per_kg)}/kg)` : `${peso(pk.per_kg)}/kg`,
        survey: surveyStory,
        how: `This ${pk.pack_kg ? `${kg}kg pack` : 'product'} sells for ${pk.pack_kg ? `${peso(pk.pack_price)} (${peso(pk.per_kg)} per kilo)` : `${peso(pk.per_kg)} per kilo`}. We keep the same difference between that price and the ${grade} price, and apply it to ${catSrc}${catAsOf ? ` (as of ${catAsOf})` : ''}. ${follows}`,
      };
    }
    if (info.estimated && info.weight_pct != null && catRange) {
      const factor = 1 + Number(info.weight_pct) / 100;
      const w = Math.abs(Number(info.weight_pct));
      const rel = w < 0.5 ? `about the same as the ${grade} category price`
        : `about ${w.toFixed(1)}% ${info.weight_pct > 0 ? 'above' : 'below'} the ${grade} category price`;
      return {
        text: formatRange(catRange.min * factor, catRange.max * factor), stale, shelf,
        asOf: checked,
        note: staleNote,
        survey: surveyStory,
        how: `This brand sells ${rel}, so we apply that same difference to ${catSrc}${catAsOf ? ` (as of ${catAsOf})` : ''}. ${follows}`,
      };
    }
    return {
      text: catRange ? formatRange(catRange.min, catRange.max) : '—', stale: false, shelf,
      asOf: catAsOf ? `Category range as of ${catAsOf}` : '',
      note: catRange ? `No store price for this brand yet — showing the ${grade} category range.` : 'No price data available yet.',
      how: catRange ? `This brand has not been priced in stores yet, so we show the range for ${grade} rice from ${catSrc}.` : '',
    };
  }

  /** Category-level 3-day direction, from the same /api/predictions rows the Price Forecast page
   *  uses. It is the CATEGORY's outlook — never presented as a brand-specific forecast. */
  function buildOutlook(pred) {
    const out = {};
    const fbk = (pred && pred.forecasts_by_key) || {};
    const cur = (pred && pred.current_prices) || {};
    Object.keys(fbk).forEach(k => {
      const rows = fbk[k] || [];
      const last = rows[rows.length - 1];
      if (!last || last.price == null || cur[k] == null) return;
      const delta = Number(last.price) - Number(cur[k]);
      out[k] = { delta, days: rows.length, dir: Math.abs(delta) < FLAT_BAND ? 'flat' : delta > 0 ? 'up' : 'down' };
    });
    return out;
  }

  const TREND_TEXT = { up: ['▲', 'Rising'], down: ['▼', 'Easing'], flat: ['●', 'Steady'] };

  function outlookHtml(key, brandId) {
    const o = OUTLOOK[key];
    if (!o) return '';
    const [icon, word] = TREND_TEXT[o.dir];
    const move = o.dir === 'flat' ? 'to stay about the same'
      : `to ${o.dir === 'up' ? 'rise' : 'ease'} about ₱${Math.abs(o.delta).toFixed(2)}/kg`;
    const link = `current-prices.html?grade=${encodeURIComponent(key)}${brandId != null ? `&brand=${encodeURIComponent(brandId)}` : ''}`;
    return `<span class="rc-trend rc-trend--${o.dir}">${icon} ${word}</span>
      <span>${esc(gradeName(key))} is forecast ${move} over the next ${o.days} days
      (a category forecast, not specific to this brand). <a class="rc-modal-link" href="${link}">See the ${o.days}-day forecast →</a></span>`;
  }

  // Variety names (Sinandomeng, Dinorado, Malagkit…) come from the shared rules in
  // public-varieties.js so the homepage's "Popular rice" strip and this catalog always agree.
  const varietiesOf = (b) => AgriPricePH.Varieties.varietiesOf(b);

  // Local rice is grown in the Philippines. For imported rice, the recorded origin is shown only
  // when it actually names a country ("Thailand"); placeholders like "origin unspecified" or "NCR"
  // are left out rather than displayed.
  function originOf(b) {
    if (!/^imp/.test(b._key || '')) {
      const place = String(b.location || '').trim();
      return (!place || /^(ncr|philippines|metro manila)\b/i.test(place) || /unspecified/i.test(place)) ? 'Philippines' : `${place}, Philippines`;
    }
    const loc = String(b.location || '').trim();
    return (!loc || /unspecified|^ncr\b|^imported\b|^philippines$/i.test(loc)) ? '' : loc;
  }

  // Other products sold under the same brand name, in any category (each is its own card).
  function siblingsOf(b) {
    return allBrands().filter(x => x.brand_name === b.brand_name && x._cid !== b._cid);
  }

  function varietyLine(b) {
    const v = varietiesOf(b);
    if (!v.length) return '';   // caller renders the uniform "not listed" placeholder
    return v.length > 2 ? `${v.slice(0, 2).join(', ')} +${v.length - 2}` : v.join(', ');
  }

  function brandMedia(b, cls) {
    return b.image_path
      ? `<img class="${cls}" src="${esc(resolveImageUrl(b.image_path))}" alt="${esc(b.brand_name)}" loading="lazy">`
      : `<div class="rc-card-placeholder">${PLACEHOLDER_SVG}</div>`;
  }

  function gradeChip(label) {
    const cls = /^imported/i.test(label) ? 'imported' : 'local';
    return `<span class="rc-grade-chip rc-grade-chip--${cls}">${esc(label)}</span>`;
  }

  const moreCount = (b) => siblingsOf(b).length;

  // Pack sizes a product is sold in (from the survey's brand_pack_price rows). null = sold per kilo.
  function packsOf(b) {
    const info = BRAND_INFO[b.id] || {};
    return Array.isArray(info.packs) ? info.packs : [];
  }
  const packLabel = (p) => (p.pack_kg ? `${Number(p.pack_kg)}kg` : 'Per kilo');
  const packChip = (p) => (p ? (p.pack_kg ? `${Number(p.pack_kg)}kg pack` : 'Sold per kilo') : '');

  function cardHtml(b) {
    const typeLabel = gradeName(b._key);
    const price = brandPriceInfo(b, PRICE[b._key] || null, b._key);
    const sourceHtml = b.source_url
      ? `<a class="rc-reveal-link" href="${esc(b.source_url)}" target="_blank" rel="noopener">${esc(b.source || 'Source')}</a>`
      : esc(b.source || '');
    const metaLine = esc(originOf(b));   // the source is in the detail popup, not on the hover
    return `
      <article class="rc-card" data-cid="${b._cid}" tabindex="0" role="button"
        aria-haspopup="dialog" aria-label="${esc(b.brand_name)}${b._pack ? ` ${esc(packChip(b._pack))}` : ''} — view details">
        <div class="rc-card-media">
          ${brandMedia(b, 'rc-card-img')}
          <div class="rc-card-reveal">
            ${verificationBadge(b.verification_status, 'rc-badge', 'rc-reveal-badge')}
            <span class="rc-reveal-line">${metaLine || '—'}</span>
          </div>
        </div>
        <div class="rc-card-body">
          <h3 class="rc-card-name">${esc(b.brand_name)}</h3>
          ${varietyLine(b)
            ? `<p class="rc-card-variety">${esc(varietyLine(b))}</p>`
            : `<p class="rc-card-variety rc-card-variety--general">Milled rice</p>`}
          <p class="rc-card-type">${gradeChip(typeLabel)}</p>
          <p class="rc-card-price">${withUnit(esc(price.text))}</p>
          ${price.perKg ? `<p class="rc-card-perkg">${esc(price.perKg)}</p>` : ''}
          ${b._pack ? `<p class="rc-card-pack${b._pack.pack_kg ? '' : ' is-loose'}">${esc(packChip(b._pack))}</p>` : ''}
          ${moreCount(b) ? `<p class="rc-card-more">+${moreCount(b)} more from this brand</p>` : ''}
        </div>
      </article>`;
  }

  let CURRENT_BRANDS = [];   // brands currently on screen, for the click-to-open-modal lookup

  /* ---- Search ---- */
  const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // Every brand, in category-tab order. `_key` is the brand's OWN category, so a search result
  // (which spans all categories) still prices, labels and links to the right grade.
  function allBrands() {
    return TABS.flatMap(t => ((CATS[t.key] && CATS[t.key].brands) || [])
      .map(b => Object.assign(b, { _key: t.key })).flatMap(entriesOf));
  }

  // ?variety=Jasmine (from the homepage "Popular rice" cards) opens an EXACT-variety view, so the
  // count on the card matches what the catalog shows. It applies only while the search box still
  // holds that name; typing anything else falls back to the ordinary text search.
  let exactVariety = '';

  function searchBrands(q) {
    if (exactVariety && norm(q).trim() === exactVariety) {
      return allBrands().filter(b => varietiesOf(b).some(v => norm(v) === exactVariety));
    }
    const tokens = norm(q).split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    return allBrands().filter(b => {
      const hay = norm([b.brand_name, b.package, varietiesOf(b).join(' '), gradeName(b._key), b._key.startsWith('imp') ? 'imported' : 'local'].join(' '));
      return tokens.every(t => hay.includes(t));
    });
  }

  function renderSearchState(n) {
    const toolbar = document.querySelector('.rc-toolbar');
    const status = document.getElementById('rc-search-status');
    const clear = document.getElementById('rc-search-clear');
    const searching = !!query.trim();
    if (toolbar) toolbar.classList.toggle('is-searching', searching);
    if (clear) clear.hidden = !query;
    if (status) {
      status.hidden = !searching;
      status.textContent = !searching ? ''
        : n ? `${n} result${n === 1 ? '' : 's'} for “${query.trim()}” across all categories`
            : `No brands match “${query.trim()}”.`;
    }
  }

  function renderCards() {
    const wrap = document.getElementById('rc-cards');
    const cat = CATS[active];
    const searching = !!query.trim();

    const brands = searching
      ? searchBrands(query)
      : ((cat && cat.brands) ? cat.brands.map(b => Object.assign(b, { _key: active })).flatMap(entriesOf) : []);
    CURRENT_BRANDS = brands;
    renderSearchState(brands.length);
    const countEl = document.getElementById('rc-result-count');
    const labelEl = document.getElementById('rc-count-label');
    if (countEl) countEl.textContent = `${brands.length} product${brands.length === 1 ? '' : 's'}`;
    if (labelEl) labelEl.textContent = searching ? 'Results' : 'Showing';

    if (!wrap) return;
    if (!brands.length) {
      wrap.innerHTML = searching
        ? `<div class="rc-empty">No brands match “${esc(query.trim())}”. Try a brand name or a variety such as Sinandomeng or Dinorado.</div>`
        : `<div class="rc-empty">${esc(EMPTY_NOTE[active] || 'No verified NCR rice products available for this category yet.')}</div>`;
      return;
    }
    wrap.innerHTML = brands.map(b => cardHtml(b)).join('');

    wrap.querySelectorAll('.rc-card').forEach(card => {
      const select = (e) => {
        if (e.target.closest('a')) return; // let the source link navigate, not open the modal
        card.classList.remove('is-selected');
        // eslint-disable-next-line no-unused-expressions
        card.offsetWidth; // restart the pop animation if the same card is clicked again
        card.classList.add('is-selected');
        const b = CURRENT_BRANDS.find(x => x._cid === card.dataset.cid);
        if (b) openBrandModal(b);
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

  function openBrandModal(b) {
    const overlay = document.getElementById('rc-modal-overlay');
    if (!overlay) return;
    const key = b._key || active;
    const typeLabel = gradeName(key);
    const price = brandPriceInfo(b, PRICE[key] || null, key);

    document.getElementById('rc-modal-media').innerHTML = brandMedia(b, 'rc-modal-img');
    document.getElementById('rc-modal-title').textContent = b.brand_name;
    document.getElementById('rc-modal-type').innerHTML = gradeChip(typeLabel)
      + (b._pack ? ` <span class="rc-modal-pack">${esc(packChip(b._pack))}</span>` : '');
    document.getElementById('rc-modal-badge').innerHTML = verificationBadge(b.verification_status, 'rc-modal-badge', '');
    document.getElementById('rc-modal-price').innerHTML = withUnit(esc(price.text))
      + (price.perKg ? `<span class="rc-modal-perkg">${esc(price.perKg)}</span>` : '');
    document.getElementById('rc-modal-asof').textContent = price.asOf;
    const noteP = document.getElementById('rc-modal-price-note');
    noteP.textContent = price.note;
    noteP.hidden = !price.note;
    noteP.classList.toggle('is-stale', !!price.stale);
    const howEl = document.getElementById('rc-modal-how');
    if (howEl) {
      howEl.hidden = !price.how;
      howEl.open = false;
      document.getElementById('rc-modal-how-text').textContent = price.how || '';
    }
    const outEl = document.getElementById('rc-modal-outlook');
    const outHtml = price.fixed ? '' : outlookHtml(key, b.id);  // a fixed price doesn't follow the market forecast
    outEl.hidden = !outHtml;
    outEl.innerHTML = outHtml;

    const item = (label, value) => value
      ? `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>` : '';
    const sourceHtml = b.source_url
      ? `<a class="rc-modal-link" href="${esc(b.source_url)}" target="_blank" rel="noopener">${esc(b.source || 'Source')}</a>`
      : esc(b.source || '');
    document.getElementById('rc-modal-meta').innerHTML =
      item('Store price seen', price.shelf ? esc(price.shelf) : '') +
      item(packsOf(b).length > 1 ? 'All sizes (store prices)' : '', packsOf(b).map(p => {
        const here = b._pack && p.pack_kg === b._pack.pack_kg;
        const line = p.pack_kg
          ? `${esc(packLabel(p))} &mdash; ${peso(p.pack_price)} <span class="rc-pack-kg">(${peso(p.per_kg)}/kg)</span>`
          : `Per kilo &mdash; ${peso(p.per_kg)}`;
        return here ? `<strong>${line}</strong>` : line;
      }).join('<br>')) +
      item('Varieties', esc(varietiesOf(b).join(', '))) +
      item('Origin', esc(originOf(b))) +
      item('Source', sourceHtml) +
      item('Last verified', b.last_verified
        ? `${esc(fmtDate(b.last_verified) || b.last_verified)}${price.survey ? ` ${infoTip(price.survey)}` : ''}`
        : '');

    const sibEl = document.getElementById('rc-modal-siblings');
    if (sibEl) {
      const sibs = siblingsOf(b);
      sibEl.hidden = !sibs.length;
      sibEl.innerHTML = !sibs.length ? '' :
        `<div class="rc-sib-title">More from ${esc(b.brand_name)}</div>` +
        sibs.map(x => `<button type="button" class="rc-sib" data-sib-id="${x._cid}">
          <span class="rc-sib-name">${esc(varietyLine(x) || 'Milled rice')}${x._pack ? ` <span class="rc-sib-pack">· ${esc(packChip(x._pack))}</span>` : ''}</span>
          <span class="rc-sib-grade">${esc(gradeName(x._key))}</span></button>`).join('');
      sibEl.onclick = (e) => {
        const btn = e.target.closest('[data-sib-id]');
        const next = btn && allBrands().find(x => x._cid === btn.dataset.sibId);
        if (next) openBrandModal(next);
      };
    }

    const noteEl = document.getElementById('rc-modal-note');
    const noteParts = [];
    const daNote = DA_GRADE_NOTE[gradeOf(key)];
    if (daNote) noteParts.push(`<strong>About this listing —</strong> ${esc(daNote)}`);
    // Import-pipeline bookkeeping ("SKUs merged", "Source price") is shown structurally above, not as text.
    const extra = String(b.notes || '').split(/\.\s+/).map(x => x.trim().replace(/\.$/, ''))
      .filter(x => x && !/^SKUs merged:/i.test(x) && !/^Source price:/i.test(x));
    if (extra.length) noteParts.push(esc(extra.join('. ')));
    if (noteEl) {
      noteEl.hidden = !noteParts.length;
      noteEl.innerHTML = noteParts.join('<br><br>');
    }

    _lastFocusedEl = document.activeElement;
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('is-open'));
    // Lock scrolling on <html> — the element that actually scrolls (see landpage-nav.css).
    document.documentElement.classList.add('public-scroll-locked');
    overlay.querySelector('.rc-modal')?.focus();
  }

  function closeBrandModal() {
    const overlay = document.getElementById('rc-modal-overlay');
    if (!overlay || overlay.hidden) return;
    overlay.classList.remove('is-open');
    document.documentElement.classList.remove('public-scroll-locked');
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
    return `${t.label} — ${brandCount(t.key)} product${brandCount(t.key) === 1 ? '' : 's'}`;
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

  /* ================= Search suggestions =================
     Built from the loaded catalog: variety names (from pack text), brand names, and the eight
     grades. Typing shows the closest few; picking one runs that search. */
  let SUGGEST = [];
  let sugItems = [];
  let sugIndex = -1;

  function buildSuggestions() {
    const map = new Map();   // norm(label) -> { label, type }
    const add = (label, type) => {
      const k = norm(label);
      if (k && !map.has(k)) map.set(k, { label, type });
    };
    const brands = allBrands();
    brands.forEach(b => varietiesOf(b).forEach(v => add(v, 'Variety')));
    brands.forEach(b => add(b.brand_name, 'Brand'));
    TABS.forEach(t => add(t.label, 'Grade'));
    SUGGEST = [...map.values()];
  }

  function suggestFor(q) {
    const nq = norm(q).trim();
    if (!nq) return [];
    const rank = (s) => {
      const n = norm(s.label);
      if (n.startsWith(nq)) return 0;
      if (n.split(/[\s-]+/).some(w => w.startsWith(nq))) return 1;
      return n.includes(nq) ? 2 : 9;
    };
    const typeOrder = { Variety: 0, Brand: 1, Grade: 2 };
    return SUGGEST.map(s => ({ s, r: rank(s) })).filter(x => x.r < 9)
      .sort((a, b) => a.r - b.r || typeOrder[a.s.type] - typeOrder[b.s.type] || a.s.label.localeCompare(b.s.label))
      .slice(0, 7).map(x => Object.assign({}, x.s, { count: searchBrands(x.s.label).length }));
  }

  function closeSuggest() {
    const box = document.getElementById('rc-suggest');
    const input = document.getElementById('rc-search-input');
    if (box) box.hidden = true;
    if (input) input.setAttribute('aria-expanded', 'false');
    sugIndex = -1;
  }

  function renderSuggest() {
    const box = document.getElementById('rc-suggest');
    const input = document.getElementById('rc-search-input');
    if (!box || !input) return;
    sugItems = suggestFor(input.value);
    sugIndex = -1;
    if (!sugItems.length || document.activeElement !== input) { closeSuggest(); return; }
    box.innerHTML = sugItems.map((s, i) => `
      <div class="rc-suggest-item" role="option" id="rc-sug-${i}" data-i="${i}" aria-selected="false">
        <span class="rc-suggest-label">${esc(s.label)}</span>
        <span class="rc-suggest-meta"><span class="rc-suggest-type">${s.type}</span>${s.count} brand${s.count === 1 ? '' : 's'}</span>
      </div>`).join('');
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function highlightSuggest(i) {
    const box = document.getElementById('rc-suggest');
    const input = document.getElementById('rc-search-input');
    if (!box) return;
    sugIndex = i;
    box.querySelectorAll('.rc-suggest-item').forEach((el, idx) => {
      el.classList.toggle('is-active', idx === i);
      el.setAttribute('aria-selected', idx === i ? 'true' : 'false');
    });
    if (input) {
      if (i >= 0) input.setAttribute('aria-activedescendant', `rc-sug-${i}`);
      else input.removeAttribute('aria-activedescendant');
    }
  }

  function pickSuggestion(i) {
    const s = sugItems[i];
    const input = document.getElementById('rc-search-input');
    if (!s || !input) return;
    input.value = s.label;
    query = s.label;
    closeSuggest();
    renderCards();
  }

  /* ================= Search box ================= */
  function clearSearch(silent) {
    query = '';
    const input = document.getElementById('rc-search-input');
    if (input) input.value = '';
    if (!silent) { renderCards(); input && input.focus(); }
  }

  function bindSearch() {
    const input = document.getElementById('rc-search-input');
    const clear = document.getElementById('rc-search-clear');
    const box = document.getElementById('rc-suggest');
    if (!input) return;
    let timer = null;
    input.addEventListener('input', () => {
      query = input.value;
      clearTimeout(timer);
      timer = setTimeout(renderCards, 120);   // light debounce; the catalog is small
      if (clear) clear.hidden = !query;
      renderSuggest();
    });
    input.addEventListener('focus', renderSuggest);
    input.addEventListener('blur', () => setTimeout(closeSuggest, 120));
    input.addEventListener('keydown', (e) => {
      const open = box && !box.hidden;
      if (e.key === 'ArrowDown' && open) { e.preventDefault(); highlightSuggest((sugIndex + 1) % sugItems.length); }
      else if (e.key === 'ArrowUp' && open) { e.preventDefault(); highlightSuggest((sugIndex - 1 + sugItems.length) % sugItems.length); }
      else if (e.key === 'Enter' && open && sugIndex >= 0) { e.preventDefault(); pickSuggestion(sugIndex); }
      else if (e.key === 'Escape') {
        if (open) { e.preventDefault(); closeSuggest(); }
        else if (query) { e.preventDefault(); clearSearch(); }
      }
    });
    // mousedown (not click) so the pick lands before the input's blur closes the list
    if (box) box.addEventListener('mousedown', (e) => {
      const el = e.target.closest('.rc-suggest-item');
      if (el) { e.preventDefault(); pickSuggestion(Number(el.dataset.i)); }
    });
    if (clear) clear.addEventListener('click', () => { closeSuggest(); clearSearch(); });
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
      clearSearch(true);
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
        map[bk.canonical_key] = { min: Number(bk.price_min), max: Number(bk.price_max), label: 'prevailing range · DA', source: 'da', asOf: bk.effective_date };
      }
    });
    // No DA bracket for this category — fall back to the model's own calibrated forecast band
    // (tomorrow's interval), a real computed range rather than a single guessed figure.
    const fbk = (predictions && predictions.forecasts_by_key) || {};
    Object.keys(fbk).forEach(k => {
      if (map[k]) return;
      const row = (fbk[k] || [])[0];
      if (row && row.low != null && row.high != null) {
        map[k] = { min: Number(row.low), max: Number(row.high), label: `forecast range · ${row.interval_pct || 90}% confidence`, source: 'forecast', asOf: (predictions && (predictions.as_of_date || predictions.last_data_date)) || null };
      }
    });
    // Last resort — no band data at all, just a plain current price (renders as a single figure).
    const cur = (predictions && predictions.current_prices) || {};
    Object.keys(cur).forEach(k => {
      if (!map[k] && cur[k] != null) map[k] = { min: Number(cur[k]), max: Number(cur[k]), label: 'latest forecast price', source: 'latest', asOf: (predictions && (predictions.as_of_date || predictions.last_data_date)) || null };
    });
    return map;
  }

  async function init() {
    bindDropdown();
    bindSearch();
    bindModal();
    bindScrollTop();

    // The forecast is requested up front but NOT waited on. It is the slowest call (the first one
    // after a backend restart loads 8 Keras models), and it only adds the 3-day outlook plus a
    // fallback price band for categories without a DA bracket. The products render as soon as
    // the catalog arrives; the forecast is merged in when (and if) it arrives.
    const predPromise = AgriPricePH.API.predictions().catch(() => null);
    try {
      const [cat, brk, bp] = await Promise.all([
        AgriPricePH.API.catalog(),
        AgriPricePH.API.priceBrackets().catch(() => ({})),
        AgriPricePH.API.brandPrices().catch(() => ({})),
      ]);
      CATS = {};
      (cat.categories || []).forEach(c => { CATS[c.canonical_key] = c; });
      PRICE = buildPriceMap(brk, null);
      OUTLOOK = {};
      predPromise.then(pred => {
        if (!pred || pred.ready === false) return;
        PRICE = buildPriceMap(brk, pred);
        OUTLOOK = buildOutlook(pred);
        renderCards();
      });
      BRAND_INFO = {};
      (bp.categories || []).forEach(c => (c.brands || []).forEach(b => { BRAND_INFO[b.id] = b; }));

      const note = document.getElementById('rc-note');
      const anyBrands = (cat.categories || []).some(c => c.brands && c.brands.length);
      if (note) {
        note.innerHTML =
          '<strong>About the data.</strong> A brand\'s price is its category\'s range (DA Bantay Presyo ' +
          'prevailing range or the latest forecast) adjusted by how that brand usually sells against it, ' +
          'so it can sit above or below the category range. Brands, pack sizes and store prices are ' +
          'verified by the local government' + infoTip('Store prices were canvassed in local markets every day for 30 days (Aug 6 – Sep 4, 2026); the 30th and last day, Sep 4, is the one used.') + '. ' +
          'Many milled-rice categories are sold <em>by classification, not by brand</em> (per DA\'s ' +
          '2018 labeling rule), so they may show no branded products. ' +
          (anyBrands ? '' : 'No verified branded products are loaded yet.');
      }
      buildSuggestions();
      renderCategoryDropdown();
      try {
        const params = new URLSearchParams(location.search);
        const grade = params.get('grade');
        if (grade && TABS.some(t => t.key === grade)) { active = grade; renderCategoryDropdown(); }
        const q = params.get('variety') || params.get('q');
        if (params.get('variety')) exactVariety = norm(params.get('variety')).trim();
        if (q) {
          query = q.trim();
          const input = document.getElementById('rc-search-input');
          if (input) input.value = query;
        }
      } catch { /* no query string (file://) */ }
      renderCards();
    } catch (e) {
      const wrap = document.getElementById('rc-cards');
      if (wrap) wrap.innerHTML = `<div class="rc-empty">Cannot reach the price service right now.</div>`;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
