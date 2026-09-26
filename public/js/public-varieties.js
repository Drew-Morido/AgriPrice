/* AgriPricePH — variety names, shared by the Rice Catalog and the homepage "Popular rice" strip.
 *
 * One set of rules decides what a brand's variety is, so both pages agree on the names:
 *   - a verified name recorded on the brand (rice_brand.variety_names, with a source), else
 *   - the brand's recorded pack text, split on "N varieties: A, B, …", with grade words, packing
 *     codes (RC-160), "5% broken" spec text and the brand's own name dropped.
 * Nothing is invented — a brand with no recorded variety simply has none.
 *
 * summarize() turns GET /api/brand-prices into one row per variety: how many brands sell it, the
 * range of SHOP PRICES SEEN in the survey (the price a shopper was actually quoted, not the scaled
 * category estimate), which grades it is filed under, and the survey date. That is a range across
 * brands from one survey — not a daily market price and not a forecast; callers must label it so.
 */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Varieties = (function () {
  const GRADE_LABEL = {
    locRegular: 'Local Regular-Milled', locWellMilled: 'Local Well-Milled',
    locPremium: 'Local Premium', locSpecial: 'Local Special',
    impRegular: 'Imported Regular-Milled', impWellMilled: 'Imported Well-Milled',
    impPremium: 'Imported Premium', impSpecial: 'Imported Special',
  };

  const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  const NOT_A_VARIETY = /%|\bbroken\b|\b(regular[- ]?milled|well[- ]?milled|premium|special)\b|^unknown$|^[a-z]{1,4}-?\d+$|whole grain|(long|fine) grain/i;
  const cache = new Map();

  function varietiesOf(b) {
    if (cache.has(b.id)) return cache.get(b.id);
    if (b.variety_names) {
      const listed = String(b.variety_names).split(/[;,]/).map((x) => x.trim()).filter(Boolean);
      cache.set(b.id, listed);
      return listed;
    }
    const pkg = String(b.package || '').trim();
    const multi = pkg.match(/^\d+\s+varieties?:\s*(.+)$/i);
    const nb = norm(b.brand_name);
    const seen = new Set();
    const out = [];
    (multi ? multi[1].split(',') : [pkg]).forEach((raw) => {
      // "Local Sinandomeng" is Sinandomeng: the origin word is not part of the variety name.
      let v = raw.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().replace(/^(local|imported)\s+/i, '');
      if (nb && norm(v).startsWith(nb + ' ')) v = v.slice(b.brand_name.length).trim().replace(/\s+Rice$/i, '');
      if (!v || norm(v) === nb || NOT_A_VARIETY.test(v)) return;
      const k = norm(v);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(v.charAt(0).toUpperCase() + v.slice(1));
    });
    cache.set(b.id, out);
    return out;
  }

  // Names that describe a pack spec or a milling grade rather than a rice people ask for by name
  // ("Thai Rice (5% broken)", "Long Grain Soft Rice", "NFA well-milled rice"). They are correct
  // product descriptions on the brand's own card, but they are not "popular rice" names.
  const NOT_A_NAMED_RICE = /%|\bbroken\b|\blong grain\b|\bwhite rice\b|\bsoft rice\b|\bwell-?milled\b|\bregular\b|\bvariety\b|\binbred\b|\bfancy\b|\bmilled rice\b/i;

  /** Shop price seen for a product: the API's surveyed_price_min/max, or — from an older backend
   *  that does not send those yet — the "Source price: ₱52.00/kg" note on the same row. */
  function shopPrice(b) {
    if (b.surveyed_price_min != null) {
      return { min: Number(b.surveyed_price_min), max: Number(b.surveyed_price_max ?? b.surveyed_price_min) };
    }
    const m = String(b.notes || '').match(/Source price:\s*₱?\s*([\d.]+)(?:\s*[–-]\s*₱?\s*([\d.]+))?/);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    return Number.isFinite(lo) ? { min: Math.min(lo, hi), max: Math.max(lo, hi) } : null;
  }

  /**
   * One row per variety, most-listed first (ties: more products, then A–Z).
   * `payload` is the /api/brand-prices response: { categories: [{ canonical_key, brands: [...] }] }.
   */
  function summarize(payload) {
    const map = new Map();
    (payload?.categories || []).forEach((cat) => {
      (cat.brands || []).forEach((b) => {
        if (b.fixed_price || /^nfa\b/i.test(String(b.brand_name || '').trim())) return;   // government-set price — not a market variety price
        const shop = shopPrice(b);
        if (!shop) return;                                  // no shop price seen for this product
        varietiesOf(b).forEach((name) => {
          if (NOT_A_NAMED_RICE.test(name)) return;
          const k = norm(name);
          let v = map.get(k);
          if (!v) map.set(k, (v = { name, key: k, brandNames: new Set(), products: 0, min: Infinity, max: -Infinity, grades: new Set(), asOf: null }));
          v.brandNames.add(norm(b.brand_name));
          v.products += 1;
          v.min = Math.min(v.min, shop.min);
          v.max = Math.max(v.max, shop.max);
          v.grades.add(cat.canonical_key);
          if (b.sample_date && (!v.asOf || b.sample_date > v.asOf)) v.asOf = b.sample_date;
        });
      });
    });
    return [...map.values()]
      .map((v) => ({ ...v, brands: v.brandNames.size, grades: [...v.grades], gradeLabels: [...v.grades].map((g) => GRADE_LABEL[g] || g) }))
      .sort((a, b) => b.brands - a.brands || b.products - a.products || a.name.localeCompare(b.name));
  }

  /** Per grade (canonical key): how many brands, their shop-price range, the best-known names. */
  function byGrade(payload) {
    const out = {};
    (payload?.categories || []).forEach((cat) => {
      const brands = cat.brands || [];
      const names = [...new Set(brands.map((b) => b.brand_name))];
      let min = Infinity;
      let max = -Infinity;
      let asOf = null;
      brands.forEach((b) => {
        // A government-set price (NFA) is not a market shelf price — it would drag the range down
        // to ₱21. The API flags it as fixed_price; an older backend doesn't, so match the name too.
        if (b.fixed_price || /^nfa\b/i.test(String(b.brand_name || '').trim())) return;
        const p = shopPrice(b);
        if (p) { min = Math.min(min, p.min); max = Math.max(max, p.max); }
        if (b.sample_date && (!asOf || b.sample_date > asOf)) asOf = b.sample_date;
      });
      out[cat.canonical_key] = {
        brands: names.length, products: brands.length, names,
        min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null, asOf,
      };
    });
    return out;
  }

  return { varietiesOf, summarize, byGrade, shopPrice, norm, GRADE_LABEL };
})();
