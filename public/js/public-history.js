/* AgriPricePH — Price History insights (public)
 *
 * Four panels, each answering a question ONLY the price record can answer:
 *   A  Is today expensive?      today vs what this variety usually costs
 *   E  Then vs now              this month against the same month in past years
 *   D  Cheapest time to buy     11-year seasonal pattern
 *   F  Biggest price swings     the largest 30-day moves on record
 *
 * A deliberate rule runs through all of it: statistics are computed from days that were actually
 * recorded, never from forward-filled ones. The merged series repeats the previous price on days
 * the source published nothing, and averaging those repeats makes rice look far steadier than it
 * is — the old "Avg Daily Move ₱0.05" card was 81 zeros out of 89. `observed` keeps the two apart.
 */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.History = (function () {
  const RICE = AgriPricePH.RiceTypes || [];
  const SACK_KG = 25;
  const DEFAULT_KEY = 'locWellMilled';

  let store = null;          // { iso: [...], byKey: { key: { values, observed } } }
  let riceKey = DEFAULT_KEY;
  let unit = 'kg';           // 'kg' | 'sack'

  /* ─────────────────────────── data ─────────────────────────── */

  function parseLabel(label) {
    const s = String(label || '').trim();
    let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);          // MM/DD/YYYY
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                  // ISO
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Local-date ISO. Using toISOString() here would shift every date back a day in PH time.
  function iso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * Build a calendar-continuous daily series per rice type, remembering which days were real.
   *
   * The source has duplicate dates (~142 of them) and multi-week holes, so a raw array index is
   * not a day. Everything downstream works off real dates.
   */
  function build(payload) {
    const labels = Array.isArray(payload?.labels) ? payload.labels : [];
    const hist = payload?.historical || {};
    if (!labels.length) return null;

    const dates = labels.map(parseLabel);
    const first = dates.filter(Boolean).sort((a, b) => a - b)[0];
    const last = dates.filter(Boolean).sort((a, b) => a - b).pop();
    if (!first || !last) return null;

    const isoList = [];
    for (const c = new Date(first); c <= last; c.setDate(c.getDate() + 1)) isoList.push(iso(c));
    const slot = new Map(isoList.map((d, i) => [d, i]));

    const byKey = {};
    RICE.forEach(({ key }) => {
      const src = hist[key];
      if (!Array.isArray(src) || !src.length) return;
      const values = new Array(isoList.length).fill(null);
      const observed = new Array(isoList.length).fill(false);
      labels.forEach((label, i) => {
        const d = dates[i];
        if (!d) return;
        const at = slot.get(iso(d));
        if (at == null) return;
        const v = Number(src[i]);
        if (!Number.isFinite(v) || v <= 0) return;
        values[at] = v;                 // a duplicated date keeps the last reading
        observed[at] = true;
      });
      // Carry forward for anything that needs a continuous line; `observed` still marks the truth.
      let prev = null;
      for (let i = 0; i < values.length; i++) {
        if (values[i] == null) values[i] = prev;
        else prev = values[i];
      }
      byKey[key] = { values, observed };
    });

    return Object.keys(byKey).length ? { iso: isoList, byKey } : null;
  }

  function current() {
    return store?.byKey?.[riceKey] || null;
  }

  function meta() {
    return RICE.find((r) => r.key === riceKey) || RICE[0] || { label: 'Rice', color: '#4CAF6E' };
  }

  /** Observed {date, value} pairs, optionally limited to the last `days` calendar days. */
  function observedPoints(days) {
    const c = current();
    if (!c) return [];
    const start = days ? store.iso.length - days : 0;
    const out = [];
    for (let i = Math.max(0, start); i < store.iso.length; i++) {
      if (c.observed[i] && c.values[i] != null) out.push({ iso: store.iso[i], v: c.values[i] });
    }
    return out;
  }

  /* ─────────────────────────── formatting ─────────────────────────── */

  const mult = () => (unit === 'sack' ? SACK_KG : 1);
  const unitSuffix = () => (unit === 'sack' ? `/${SACK_KG}kg sack` : '/kg');

  function peso(v, opts = {}) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v) * (opts.raw ? 1 : mult());
    return `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function signedPeso(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v) * mult();
    return `${n >= 0 ? '+' : '−'}₱${Math.abs(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function prettyDate(isoStr) {
    const d = parseLabel(isoStr);
    return d ? `${MON_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : isoStr;
  }

  function info(text) {
    return `<i class="ti ti-info-circle ph-info" tabindex="0" role="img" data-tip="${esc(text)}"></i>`;
  }

  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const quantile = (a, q) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (pos - lo);
  };

  /* ─────────────────────── A · Is today expensive? ─────────────────────── */

  /**
   * Compares today against the middle half (25th–75th percentile) of a window rather than a plain
   * average: with a skewed price run the average alone would call almost every day "expensive".
   * Two windows are always shown together because they can disagree — right now rice is below its
   * 6-month typical but well above its 1-year typical, and showing only one of those would be a
   * half-truth the reader could not detect.
   */
  function verdictFor(days) {
    const pts = observedPoints(days);
    if (pts.length < 8) return null;
    const vals = pts.map((p) => p.v);
    const today = current().values[store.iso.length - 1];
    const mid = median(vals);
    const p25 = quantile(vals, 0.25);
    const p75 = quantile(vals, 0.75);
    const state = today < p25 ? 'low' : today > p75 ? 'high' : 'mid';
    return {
      days, today, mid, p25, p75, state, n: pts.length, diff: today - mid,
      lo: Math.min(...vals, today), hi: Math.max(...vals, today),
    };
  }

  /**
   * "Where today sits" — the same 25th/75th-percentile bands the verdict uses, drawn as a
   * three-zone bar from the window's lowest to highest recorded price, with a pin for today.
   * It is the verdict made visible, not a new statistic.
   */
  function gaugeHtml(v, label) {
    const span = v.hi - v.lo;
    if (!(span > 0.005)) return '';
    const at = (x) => Math.min(100, Math.max(0, ((x - v.lo) / span) * 100));
    const a = at(v.p25);
    const b = at(v.p75);
    const pos = at(v.today);
    const edge = pos < 12 ? ' edge-l' : pos > 88 ? ' edge-r' : '';
    return `<div class="ph-gauge">
      <div class="ph-gauge-title">Where today&rsquo;s price sits in the last ${label}
        ${info('The bar runs from the lowest to the highest recorded price in the window. The middle zone holds the middle half of those days — the usual range. Left of it is cheaper than usual, right of it is pricier.')}
      </div>
      <div class="ph-gauge-track" role="img" aria-label="Today ${peso(v.today)}, usual range ${peso(v.p25)} to ${peso(v.p75)}">
        <span class="ph-gauge-zone low" style="width:${a}%">${a > 14 ? 'Cheaper' : ''}</span>
        <span class="ph-gauge-zone mid" style="width:${b - a}%">${b - a > 16 ? 'Usual range' : ''}</span>
        <span class="ph-gauge-zone high" style="width:${100 - b}%">${100 - b > 14 ? 'Pricier' : ''}</span>
        <span class="ph-gauge-pin${edge}" style="--pos:${pos}%"><b>Today ${peso(v.today)}</b></span>
      </div>
      <div class="ph-gauge-scale"><span>Lowest ${peso(v.lo)}</span><span>Highest ${peso(v.hi)}</span></div>
    </div>`;
  }

  /**
   * Today's verdict drives three colours: entry 01's tab dot (always — a passive hint while other
   * entries are open), and the big price plus the "Today ₱…" bar label (only while entry 01 is in
   * view; see watchVerdictInView). CSS reads data-verdict = low | mid | high.
   */
  function setVerdictState(state, words) {
    const host = document.getElementById('ph-verdict');
    const tab = document.getElementById('tab-today');
    const dot = tab && tab.querySelector('.ph-tab-dot');
    const sr = document.getElementById('tab-today-verdict');
    [host, tab].forEach((el) => {
      if (!el) return;
      if (state) el.dataset.verdict = state;
      else delete el.dataset.verdict;
    });
    const text = state ? `Today's price: ${words.toLowerCase()}` : '';
    if (dot) dot.title = text;
    if (sr) sr.textContent = text ? ` — ${text}` : '';
  }

  /** Entry 01 counts as "in view" while any of its panel is on screen; a hidden tab never is. */
  function watchVerdictInView() {
    const panel = document.getElementById('panel-today');
    const host = document.getElementById('ph-verdict');
    if (!panel || !host) return;
    if (typeof IntersectionObserver === 'undefined') { host.classList.add('is-live'); return; }
    new IntersectionObserver((entries) => {
      host.classList.toggle('is-live', entries.some((e) => e.isIntersecting));
    }, { threshold: 0 }).observe(panel);
  }

  function renderVerdict() {
    const host = document.getElementById('ph-verdict');
    if (!host) return;
    const six = verdictFor(182);
    const year = verdictFor(365);
    const m = meta();
    if (!six && !year) {
      host.innerHTML = `<div class="ph-empty">Not enough recorded prices for ${esc(m.label)} yet.</div>`;
      setVerdictState(null);
      return;
    }
    const lead = six || year;
    const WORD = {
      low: { t: 'Cheaper than usual', cls: 'good', ico: 'thumb-up' },
      mid: { t: 'About the usual price', cls: 'mid', ico: 'equal' },
      high: { t: 'Pricier than usual', cls: 'bad', ico: 'alert-triangle' },
    };
    const w = WORD[lead.state];
    setVerdictState(lead.state, w.t);

    // The word follows the sign of the gap, not the verdict: a price can sit a few centavos below
    // the middle price and still be "about usual", and "−₱0.68 in line with" reads as a mistake.
    // The badge carries the verdict; this row just states the gap.
    const line = (v, label) => {
      if (!v) return '';
      const word = Math.abs(v.diff) < 0.005 ? 'same as usual' : v.diff < 0 ? 'below usual' : 'above usual';
      return `<div class="ph-v-row">
        <span class="ph-v-window">Last ${label}</span>
        <span class="ph-v-usual">Usual price: ${peso(v.mid)}</span>
        <span class="ph-v-delta ${v.state}">${signedPeso(Math.abs(v.diff) < 0.005 ? 0 : v.diff)}<small>${esc(word)}</small></span>
      </div>`;
    };

    host.innerHTML = `
      <div class="ph-verdict-top">
        <div class="ph-verdict-main">
          <div class="ph-v-label">${esc(m.label)} &middot; today</div>
          <div class="ph-v-price">${peso(lead.today)}<span>${unitSuffix()}</span></div>
          <div class="ph-v-badge ${w.cls}"><i class="ti ti-${w.ico}" aria-hidden="true"></i>${w.t}</div>
        </div>
        <div class="ph-verdict-side">
          <div class="ph-sec-label">Compared with the usual price
            ${info('"Usual" is the middle price of the days actually recorded in that window — not a simple average, so one unusual stretch does not label every day expensive. Two windows are shown because they can disagree.')}
          </div>
          <div class="ph-v-list">
            ${line(six, '6 months')}
            ${line(year, '12 months')}
          </div>
        </div>
      </div>
      ${gaugeHtml(lead, six ? '6 months' : '12 months')}`;
  }

  /* ─────────────────────── E · Then vs now ─────────────────────── */

  function monthMean(year, month) {
    const c = current();
    if (!c) return null;
    const vals = [];
    store.iso.forEach((d, i) => {
      if (!c.observed[i] || c.values[i] == null) return;
      const dt = parseLabel(d);
      if (dt && dt.getFullYear() === year && dt.getMonth() === month) vals.push(c.values[i]);
    });
    return vals.length ? { mean: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length } : null;
  }

  function renderThenNow() {
    const host = document.getElementById('ph-thennow');
    if (!host) return;
    const lastIso = store.iso[store.iso.length - 1];
    const now = parseLabel(lastIso);
    const month = now.getMonth();
    const year = now.getFullYear();
    const base = monthMean(year, month);
    if (!base) { host.innerHTML = `<div class="ph-empty">No recorded prices for this month yet.</div>`; return; }

    const rows = [];
    for (let back = 1; back <= 3; back++) {
      const past = monthMean(year - back, month);
      if (!past) continue;
      const diff = base.mean - past.mean;
      const pct = (diff / past.mean) * 100;
      rows.push({ year: year - back, mean: past.mean, diff, pct });
    }
    if (!rows.length) { host.innerHTML = `<div class="ph-empty">No earlier ${MONTHS[month]} on record to compare with.</div>`; return; }

    const widest = Math.max(...rows.map((r) => Math.abs(r.pct)), 1);
    host.innerHTML = `
      <div class="ph-tn-now">
        <span class="ph-tn-now-label">${MONTHS[month]} ${year}<small>This month&rsquo;s average so far</small></span>
        <span class="ph-tn-now-val">${peso(base.mean)}<small>${unitSuffix()}</small></span>
      </div>
      <div class="ph-tn-grid" role="table" aria-label="${MONTHS[month]} average price by year">
        <span class="ph-tn-hd" role="columnheader">Same month in</span>
        <span class="ph-tn-hd" role="columnheader">Average then</span>
        <span class="ph-tn-hd" role="columnheader">Size of change</span>
        <span class="ph-tn-hd" role="columnheader">Now vs then</span>
        ${rows.map((r, i) => {
          const up = r.diff >= 0;
          return `
            <span class="ph-tn-cell ph-tn-year" role="cell">${MONTHS[month]} ${r.year}<small>${peso(r.mean)}</small></span>
            <span class="ph-tn-cell ph-tn-was" role="cell">${peso(r.mean)}</span>
            <span class="ph-tn-cell ph-tn-barcell" role="cell"><span class="ph-tn-bar-wrap">
              <span class="ph-tn-bar ${up ? 'up' : 'down'}" style="--i:${i};width:${Math.max(6, (Math.abs(r.pct) / widest) * 100)}%"></span>
            </span></span>
            <span class="ph-tn-cell ph-tn-diff ${up ? 'up' : 'down'}" role="cell">${signedPeso(r.diff)}<small>${up ? 'dearer' : 'cheaper'} now (${up ? '+' : '−'}${Math.abs(r.pct).toFixed(1)}%)</small></span>`;
        }).join('')}
      </div>
      <div class="ph-howto"><i class="ti ti-bulb" aria-hidden="true"></i>
        <span><strong>How to read this:</strong> a red bar means rice costs more now than in that year; green means it is cheaper now. Longer bar = bigger difference.
        ${info('Each figure is the average of the days actually recorded in that month. Comparing the same month every year keeps harvest seasons lined up, so the change shown is the real year-on-year change.')}</span>
      </div>`;
  }

  /* ─────────────────────── D · Cheapest time to buy ─────────────────────── */

  /**
   * Month-of-year pattern, de-trended per year.
   *
   * Rice cost far more in 2026 than in 2015, so raw monthly averages across 11 years would only
   * measure inflation. Each year's prices are expressed relative to that year's own average first;
   * what survives is the seasonal shape — harvest months cheap, lean months dear.
   */
  function seasonal() {
    const c = current();
    if (!c) return null;
    const byYear = new Map();
    store.iso.forEach((d, i) => {
      if (!c.observed[i] || c.values[i] == null) return;
      const dt = parseLabel(d);
      if (!dt) return;
      const y = dt.getFullYear();
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push({ m: dt.getMonth(), v: c.values[i] });
    });

    const buckets = Array.from({ length: 12 }, () => []);
    let years = 0;
    byYear.forEach((rows) => {
      if (rows.length < 24) return;                 // too thin a year to de-trend meaningfully
      years++;
      const mean = rows.reduce((a, r) => a + r.v, 0) / rows.length;
      rows.forEach((r) => buckets[r.m].push((r.v / mean) * 100 - 100));
    });
    if (years < 3) return null;

    const months = buckets.map((b, m) => ({
      m,
      pct: b.length ? b.reduce((a, x) => a + x, 0) / b.length : null,
      n: b.length,
    })).filter((x) => x.pct != null);
    if (months.length < 8) return null;

    const sorted = [...months].sort((a, b) => a.pct - b.pct);
    return { months, years, cheapest: sorted.slice(0, 2), priciest: sorted.slice(-2).reverse() };
  }

  function renderSeasonal() {
    const host = document.getElementById('ph-seasonal');
    if (!host) return;
    const s = seasonal();
    if (!s) { host.innerHTML = `<div class="ph-empty">Not enough years on record to show a seasonal pattern.</div>`; return; }

    const lo = Math.min(...s.months.map((x) => x.pct));
    const hi = Math.max(...s.months.map((x) => x.pct));
    const span = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    const typical = median(observedPoints(365).map((p) => p.v)) || 0;

    // The two cheapest and two priciest months are the answer, so only those get a printed value
    // and full-strength colour; the rest stay visible but quieter, with their figure on hover.
    const keyMonths = new Set([...s.cheapest, ...s.priciest].map((x) => x.m));
    const bars = s.months.map((x, i) => {
      const up = x.pct >= 0;
      const hPct = Math.max(3, (Math.abs(x.pct) / span) * 40);      // % of the slot; 40 of 50 leaves room for the label
      const inPeso = (typical * x.pct) / 100;
      const tip = `${MONTHS[x.m]}: usually ${Math.abs(x.pct).toFixed(1)}% ${up ? 'above' : 'below'} the year's average `
        + `(about ${peso(Math.abs(inPeso))}${unit === 'sack' ? ' per sack' : ' per kilo'}) · ${s.years} years of data`;
      const key = keyMonths.has(x.m);
      const val = key
        ? `<span class="ph-se-val ${up ? 'up' : 'down'}" style="${up ? `bottom:calc(50% + ${hPct}% + 4px)` : `top:calc(50% + ${hPct}% + 4px)`}">${up ? '+' : '−'}${Math.abs(x.pct).toFixed(1)}%</span>`
        : '';
      return `<div class="ph-se-col${key ? ' key' : ''}" data-tip="${esc(tip)}" tabindex="0">
        <div class="ph-se-slot">
          <span class="ph-se-bar ${up ? 'up' : 'down'}" style="--i:${i};height:${hPct}%;${up ? 'bottom:50%' : 'top:50%'}"></span>
          ${val}
        </div>
        <span class="ph-se-mon">${MON_SHORT[x.m]}</span>
      </div>`;
    }).join('');

    const name = (arr) => arr.map((x) => MONTHS[x.m]).join(' and ');
    host.innerHTML = `
      <div class="ph-se-summary">
        <div class="ph-se-pick good">
          <i class="ti ti-arrow-down-circle" aria-hidden="true"></i>
          <span><span class="ph-se-pick-lbl">Usually cheapest</span>
          <span class="ph-se-pick-val">${name(s.cheapest)}</span></span>
        </div>
        <div class="ph-se-pick bad">
          <i class="ti ti-arrow-up-circle" aria-hidden="true"></i>
          <span><span class="ph-se-pick-lbl">Usually priciest</span>
          <span class="ph-se-pick-val">${name(s.priciest)}</span></span>
        </div>
      </div>
      <div class="ph-sec-label">Price by month, compared with the year&rsquo;s average</div>
      <div class="ph-se-wrap">
        <div class="ph-se-y" aria-hidden="true">
          <span class="t">Pricier<br>&uarr;</span>
          <span class="m">Year&rsquo;s<br>average</span>
          <span class="b">&darr;<br>Cheaper</span>
        </div>
        <div class="ph-se-chart" role="img" aria-label="Average price by month relative to the yearly average">
          <span class="ph-se-axis"></span>
          ${bars}
        </div>
      </div>
      <div class="ph-howto"><i class="ti ti-bulb" aria-hidden="true"></i>
        <span><strong>How to read this:</strong> bars below the dashed line are months when rice is usually cheaper; bars above are pricier. Point at or tap any month for its figure. Based on ${s.years} years, so treat it as a tendency, not a promise.
        ${info('Each year is compared against its own average first, so this shows the seasonal shape rather than inflation. Year-to-year variation is larger than the seasonal swing, so some years will not follow it.')}</span>
      </div>`;
  }

  /* ─────────────────────── F · Biggest price swings ─────────────────────── */

  // A window whose entire move happened in one step is a break in the record, not a market move.
  // Two kinds of one-step windows exist in the record: 2015 - Sep 2019 is PSA's monthly figure (each month's
  // change lands on the 1st), and Oct 1, 2019 is the hand-over from PSA's NCR average to DA's prevailing
  // price (a level shift between two agencies, not a market move). The real August-2023 price crisis, by
  // contrast, climbed over several steps and held. Anything above this share is withheld.
  const STEP_SHARE_LIMIT = 0.75;

  /**
   * Largest 30-day moves on record, spaced at least 120 days apart so one long climb is reported
   * once rather than filling the list with overlapping windows of the same event.
   */
  function bigMoves(limit = 4) {
    const c = current();
    if (!c) return [];
    const moves = [];
    for (let i = 30; i < c.values.length; i++) {
      const a = c.values[i - 30];
      const b = c.values[i];
      if (a == null || b == null) continue;
      const diff = b - a;
      if (Math.abs(diff) < 0.01) continue;
      let biggestStep = 0;
      for (let k = i - 29; k <= i; k++) {
        const step = Math.abs((c.values[k] ?? 0) - (c.values[k - 1] ?? 0));
        if (step > biggestStep) biggestStep = step;
      }
      if (biggestStep / Math.abs(diff) > STEP_SHARE_LIMIT) continue;
      moves.push({ i, from: a, to: b, diff });
    }
    moves.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
    const picked = [];
    for (const mv of moves) {
      if (picked.some((p) => Math.abs(p.i - mv.i) < 120)) continue;
      picked.push(mv);
      if (picked.length >= limit) break;
    }
    return picked.sort((a, b) => b.i - a.i);
  }

  function renderMoves() {
    const host = document.getElementById('ph-moves');
    if (!host) return;
    const moves = bigMoves();
    if (!moves.length) { host.innerHTML = `<div class="ph-empty">No large swings on record yet.</div>`; return; }

    const c = current();
    host.innerHTML = moves.map((mv, n) => {
      const up = mv.diff >= 0;
      const end = parseLabel(store.iso[mv.i]);
      const pct = (mv.diff / mv.from) * 100;
      return `<div class="ph-mv ${up ? 'up' : 'down'}" style="--i:${n}">
        <div class="ph-mv-top">
          <span class="ph-mv-ico" aria-hidden="true"><i class="ti ti-${up ? 'trending-up' : 'trending-down'}"></i></span>
          <span class="ph-mv-amt">
            <strong>${signedPeso(mv.diff)}</strong>
            <span>${up ? 'Went up' : 'Went down'} ${Math.abs(pct).toFixed(1)}% in 30 days</span>
          </span>
          <span class="ph-mv-when">${MONTHS[end.getMonth()]} ${end.getFullYear()}</span>
        </div>
        ${spark(c.values.slice(mv.i - 30, mv.i + 1))}
        <div class="ph-mv-sub">${peso(mv.from)} &rarr; ${peso(mv.to)}
          <span class="ph-mv-range">${prettyDate(store.iso[mv.i - 30])} to ${prettyDate(store.iso[mv.i])}</span>
        </div>
      </div>`;
    }).join('');
  }

  /** A tiny 30-day line for a swing card — the shape of the move, drawn in as the card appears. */
  function spark(vals) {
    const pts = vals.filter((v) => v != null);
    if (pts.length < 2) return '';
    const lo = Math.min(...pts);
    const hi = Math.max(...pts);
    const w = 300;
    const h = 44;
    const d = pts.map((v, i) => {
      const x = (i / (pts.length - 1)) * (w - 4) + 2;
      const y = hi - lo < 1e-9 ? h / 2 : h - 4 - ((v - lo) / (hi - lo)) * (h - 8);
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg class="ph-mv-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" pathLength="100"/></svg>`;
  }

  /* ─────────────────────── coverage honesty ─────────────────────── */

  function renderCoverage() {
    const host = document.getElementById('ph-coverage');
    if (!host) return;
    const c = current();
    if (!c) { host.hidden = true; return; }
    const window90 = 90;
    let seen = 0;
    for (let i = Math.max(0, store.iso.length - window90); i < store.iso.length; i++) {
      if (c.observed[i]) seen++;
    }
    // Silent when coverage is good; only speaks up when the numbers above rest on few real days.
    if (seen >= window90 * 0.8) { host.hidden = true; return; }
    host.hidden = false;
    host.innerHTML = `<i class="ti ti-alert-triangle"></i>
      <span><strong>${seen} of the last ${window90} days</strong> have a recorded price for
      ${esc(meta().label)}. The rest repeat the previous day, so recent figures rest on
      ${seen} real readings.</span>
      <button type="button" class="ph-coverage-x" aria-label="Hide this notice">
        <i class="ti ti-x"></i>
      </button>`;
    // Dismissed for this view only. Switching variety re-renders it, because coverage differs per
    // variety and a reader who dismissed it for one should still see it for another.
    host.querySelector('.ph-coverage-x')?.addEventListener('click', () => { host.hidden = true; });
  }

  /* ─────────────────────── chart read-out ─────────────────────── */

  /**
   * One plain sentence describing the window the chart is showing.
   *
   * The chart itself only draws a line; a reader still has to work out whether it went up, by how
   * much, and how much of it is real. This says it outright, and repeats the coverage figure for
   * the window on screen rather than the fixed 90-day one used by the banner.
   */
  function renderChartNote() {
    const host = document.getElementById('ph-chart-note');
    const c = current();
    if (!host || !c) return;

    const raw = period;
    const days = raw === 'all' ? store.iso.length : parseInt(raw, 10);
    const from = Math.max(0, store.iso.length - days);

    let seen = 0;
    for (let i = from; i < store.iso.length; i++) if (c.observed[i]) seen++;
    const first = c.values[from];
    const last = c.values[store.iso.length - 1];
    if (first == null || last == null) { host.textContent = ''; return; }

    const diff = last - first;
    const pct = (diff / first) * 100;
    const word = Math.abs(pct) < 0.5 ? 'held steady' : diff > 0 ? 'rose' : 'fell';
    const span = raw === 'all' ? 'the whole record' : `the last ${days} days`;

    const move = Math.abs(pct) < 0.5
      ? ''
      : ` (${diff > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`;
    const total = days === store.iso.length ? store.iso.length : days;
    const dir = Math.abs(pct) < 0.5 ? 'flat' : diff > 0 ? 'up' : 'down';
    const ico = { up: 'trending-up', down: 'trending-down', flat: 'arrows-horizontal' }[dir];
    host.className = `ph-chart-note ${dir}`;
    host.innerHTML = `<i class="ti ti-${ico}" aria-hidden="true"></i><span>`
      + `Over ${span}, <strong>${esc(meta().label)}</strong> ${word} from `
      + `${peso(first)} to <strong>${peso(last)}</strong>${move}. `
      + `${seen} of these ${total} days have a recorded price`
      + `${info('Days with no published price repeat the previous price so the line stays continuous. They are drawn dashed on the chart.')}</span>`;
  }

  /* ─────────────────────── the chart ─────────────────────── */

  let chart = null;
  let period = '90';

  /**
   * One line: the selected variety over the selected window.
   *
   * This module draws it rather than public-data.js because the chart is no longer a comparison of
   * eight varieties behind a toggle grid — it answers about the one variety the whole page is set
   * to, chosen from the dropdown in the card header.
   *
   * Days the source never published are drawn as gaps (`spanGaps: false`) instead of a straight
   * line across them. A flat line through a two-month hole reads as a period of perfectly stable
   * prices, which is the opposite of what it means.
   */
  function renderChart() {
    const canvas = document.getElementById('chart-historical');
    const c = current();
    if (!canvas || !c || typeof Chart === 'undefined') return;

    const days = period === 'all' ? store.iso.length : parseInt(period, 10);
    const from = Math.max(0, store.iso.length - days);
    const labels = store.iso.slice(from).map(prettyDate);
    const line = [];
    const dots = [];
    for (let i = from; i < store.iso.length; i++) {
      const v = c.values[i] == null ? null : c.values[i] * mult();
      line.push(v);
      dots.push(c.observed[i] ? 2.6 : 0);   // only real readings get a point
    }

    const m = meta();
    if (chart) chart.destroy();

    // Sizing is done here rather than by Chart.js. Its own responsive mode measured the container
    // before the grid had settled, then kept that first (wrong) number — `resize()`, `resize(w,h)`
    // and rebuilding all failed to shift it. With `responsive: false` the canvas attributes are
    // the single source of truth, so the chart is exactly as big as its box, every time.
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const boxW = Math.max(1, wrap.clientWidth);
    const boxH = Math.max(1, wrap.clientHeight);
    canvas.style.width = `${boxW}px`;
    canvas.style.height = `${boxH}px`;
    canvas.width = Math.round(boxW * dpr);
    canvas.height = Math.round(boxH * dpr);

    // "The Daily Ledger" — a plain ink line rather than a filled dashboard-style area chart: no
    // fill, hollow rings for real readings, light horizontal gridlines, and titled axes so a
    // reader never has to guess what the numbers are.
    // Colours come from the page's own theme tokens, so the chart follows light/dark paper.
    const css = getComputedStyle(document.documentElement);
    const tok = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const INK = tok('--ink', '#211d13');
    const INK_MUTED = tok('--ink-3', '#8c8570');
    const CARD = tok('--card', '#ffffff');
    const GRID = tok('--line-soft', 'rgba(38,58,32,0.09)');
    const MONO = "'JetBrains Mono', monospace";
    const BODY = "'Plus Jakarta Sans', system-ui, sans-serif";
    const axisTitle = (text) => ({ display: true, text, color: INK_MUTED, font: { size: 13, family: BODY, weight: '600' }, padding: { top: 6, bottom: 6 } });
    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: m.label,
          data: line,
          borderColor: m.color,
          backgroundColor: 'transparent',
          borderWidth: 2.6,
          fill: false,
          tension: 0.2,
          // `spanGaps` was pointless here: build() forward-fills `values`, so the series never
          // contains a null and there was nothing to break. The long flat stretches WERE the
          // forward-fill, drawn as a confident solid line. Carried-forward stretches are dashed
          // instead — the shape stays readable, but it is obvious which parts were measured.
          segment: {
            borderDash: (ctx) => (c.observed[from + ctx.p1DataIndex] ? undefined : [3, 3]),
            borderColor: (ctx) => (c.observed[from + ctx.p1DataIndex] ? undefined : `${m.color}66`),
          },
          pointRadius: dots,
          pointHoverRadius: 7,
          pointStyle: 'circle',
          pointBackgroundColor: CARD,
          pointBorderColor: m.color,
          pointBorderWidth: 1.6,
          pointHoverBackgroundColor: m.color,
          pointHoverBorderColor: CARD,
        }],
      },
      options: {
        responsive: false,          // sized above; see the note before `new Chart`
        maintainAspectRatio: false,
        devicePixelRatio: dpr,
        // The canvas fills its box edge to edge, so all the breathing room comes from here. The
        // line was running into the axis labels and the top of the plot without it.
        layout: { padding: { top: 18, right: 12, bottom: 8, left: 4 } },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: CARD,
            titleColor: INK_MUTED,
            bodyColor: INK,
            borderColor: GRID,
            borderWidth: 1,
            cornerRadius: 10,
            padding: 12,
            titleFont: { size: 13, family: BODY, weight: '600' },
            bodyFont: { size: 16, family: MONO, weight: '700' },
            displayColors: false,
            callbacks: {
              // Says whether the hovered day was actually published or carried forward — the one
              // thing a reader cannot tell by looking at the line.
              label: (ctx) => {
                const idx = from + ctx.dataIndex;
                const real = c.observed[idx];
                return `${peso(c.values[idx])}${unitSuffix()}${real ? '' : '  ·  carried forward'}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            // Fewer, better-spaced dates: at 7 the labels were touching each other in a
            // half-width column, and the axis read as a solid grey band.
            ticks: {
              maxTicksLimit: 5, maxRotation: 0, autoSkipPadding: 18,
              font: { size: 12.5, family: BODY, weight: '600' }, color: INK_MUTED, padding: 10,
            },
            title: axisTitle('Date'),
          },
          y: {
            // A few flat reference lines read faster than the eye tracing back to the axis
            // labels — functional, not decorative, which is why this replaced the card's old
            // ruled-paper background texture instead of just sitting on top of it.
            grid: { color: GRID, drawTicks: false },
            border: { display: false },
            ticks: {
              maxTicksLimit: 5, font: { size: 12.5, family: MONO, weight: '600' }, color: INK_MUTED, padding: 10,
              callback: (v) => peso(v, { raw: true }),
            },
            title: axisTitle(unit === 'sack' ? 'Price per 25kg sack' : 'Price per kilo'),
          },
        },
      },
    });

    // Chart.js measures the container once, at construction, and the card sits in a CSS grid that
    // has not settled by then. `resize()` with no arguments reuses that stale measurement, so the
    // box is passed explicitly — otherwise the canvas keeps its first size through every layout
    // change, including the switch to the mobile breakpoint.
    // With responsive mode off, nothing keeps the canvas and its box in step on its own. The test
    // is against the canvas's ACTUAL size rather than a remembered box, so it also corrects the
    // first paint — the box is still settling when the chart is built, and comparing against a
    // cached measurement would treat that stale value as correct and never fix it. A pass that
    // matches makes them equal, so this converges after one redraw and cannot loop.
    if (wrap && !wrap._sized && typeof ResizeObserver !== 'undefined') {
      let timer = null;
      wrap._sized = new ResizeObserver(() => {
        if (!wrap.clientWidth || !wrap.clientHeight) return;
        const offW = Math.abs(canvas.clientWidth - wrap.clientWidth);
        const offH = Math.abs(canvas.clientHeight - wrap.clientHeight);
        if (offW < 2 && offH < 2) return;
        clearTimeout(timer);
        timer = setTimeout(renderChart, 80);
      });
      wrap._sized.observe(wrap);
    }

    const legend = document.getElementById('hcc-legend');
    if (legend) {
      legend.innerHTML = `
        <span class="hcc-legend-item">
          <span class="hcc-legend-swatch" style="background:${m.color}"></span>${esc(m.label)} price
        </span>
        <span class="hcc-legend-item">
          <span class="hcc-legend-dot" style="color:${m.color}"></span>A day with a recorded price
        </span>
        <span class="hcc-legend-item">
          <span class="hcc-legend-swatch dashed" style="color:${m.color}"></span>No reading that day (last price repeated)
          ${info('The source did not publish a price that day, so the previous price is carried forward to keep the line continuous.')}
        </span>`;
    }
  }

  function bindChartControls() {
    const tabs = document.querySelector('.hist-chart-card .hist-period-tabs');
    if (tabs && !tabs.dataset.bound) {
      tabs.dataset.bound = '1';
      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-period]');
        if (!btn) return;
        tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        period = btn.dataset.period || '90';
        renderChart();
        renderChartNote();
      });
    }

    // The chart's own variety dropdown and the one at the top of the page are the same choice, so
    // picking in either moves both — two controls that could disagree would be worse than one.
    const sel = document.getElementById('hcc-rice');
    if (sel && !sel.dataset.bound) {
      fillRiceSelect(sel);
      sel.addEventListener('change', () => { selectRice(sel.value); });
      sel.dataset.bound = '1';
    }
  }

  function fillRiceSelect(sel) {
    const available = RICE.filter((r) => store.byKey[r.key]);
    const group = (g) => available.filter((r) => r.group === g)
      .map((r) => `<option value="${r.key}">${esc(r.label)}</option>`).join('');
    sel.innerHTML = `<optgroup label="Local">${group('local')}</optgroup>`
      + `<optgroup label="Imported">${group('imported')}</optgroup>`;
    sel.value = riceKey;
  }

  function selectRice(key) {
    if (!store.byKey[key]) return;
    riceKey = key;
    ['ph-rice', 'hcc-rice'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.value !== key) el.value = key;
    });
    renderAll();
  }

  /* ─────────────────────── variety dropdown ─────────────────────── */

  /**
   * A ledger-styled button + listbox in place of the native <select>'s OS-drawn menu (a plain
   * white system list that ignored the page's paper/ink/green). The <select id="ph-rice"> stays,
   * hidden, as the value holder: a pick sets its value and fires its normal `change`, so
   * selectRice() and everything downstream are unchanged. WAI-ARIA listbox pattern: the button
   * opens it (click, Enter, Space, ↑/↓); in the list ↑/↓/Home/End move, Enter/Space pick, Esc
   * closes, a letter jumps to the next variety starting with it.
   */
  const CHECK_ICON = '<i class="ti ti-check ph-dd-check" aria-hidden="true"></i>';

  function latestValue(key) {
    const v = store?.byKey?.[key]?.values || [];
    for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i];
    return null;
  }

  function buildRiceDropdown(sel) {
    if (document.getElementById('ph-rice-dd')) return;
    const dd = document.createElement('div');
    dd.className = 'ph-dd';
    dd.id = 'ph-rice-dd';
    dd.innerHTML = `
      <button type="button" class="ph-dd-btn" id="ph-rice-btn" aria-haspopup="listbox" aria-expanded="false"
        aria-controls="ph-rice-list" aria-labelledby="ph-rice-label ph-rice-val">
        <span class="ph-dd-value" id="ph-rice-val"></span>
        <span class="ph-dd-chev" aria-hidden="true"><i class="ti ti-chevron-down"></i></span>
      </button>
      <div class="ph-dd-panel" id="ph-rice-list" role="listbox" tabindex="-1" aria-labelledby="ph-rice-label" hidden></div>`;
    sel.after(dd);
    sel.hidden = true;
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    // A <label for> pointing at a button would "click" it, so the (i) inside the label would open
    // the list. The button is named with aria-labelledby instead.
    document.getElementById('ph-rice-label')?.removeAttribute('for');

    const btn = dd.querySelector('.ph-dd-btn');
    const panel = dd.querySelector('.ph-dd-panel');
    const opts = () => [...panel.querySelectorAll('.ph-dd-opt')];
    let active = -1;
    let closeTimer = null;

    const setActive = (i) => {
      const list = opts();
      if (!list.length) return;
      active = Math.max(0, Math.min(list.length - 1, i));
      list.forEach((o, n) => o.classList.toggle('is-active', n === active));
      panel.setAttribute('aria-activedescendant', list[active].id);
      list[active].scrollIntoView({ block: 'nearest' });
    };
    const open = () => {
      if (dd.classList.contains('is-open')) return;
      clearTimeout(closeTimer);
      renderRiceOptions();
      panel.hidden = false;
      void panel.offsetWidth;          // commit the closed state so the open transition runs
      dd.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      setActive(opts().findIndex((o) => o.dataset.key === riceKey));
      panel.focus({ preventScroll: true });
    };
    const close = (refocus = true) => {
      if (!dd.classList.contains('is-open')) return;
      dd.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      panel.removeAttribute('aria-activedescendant');
      closeTimer = setTimeout(() => { if (!dd.classList.contains('is-open')) panel.hidden = true; }, 200);
      if (refocus) btn.focus({ preventScroll: true });
    };
    const pick = (i) => {
      const o = opts()[i];
      if (!o) return;
      o.classList.remove('is-picked');
      void o.offsetWidth;
      o.classList.add('is-picked');    // brief press flash on the chosen row before the list closes
      const key = o.dataset.key;
      setTimeout(() => {
        close();
        if (key !== riceKey) {
          sel.value = key;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, 150);
    };

    btn.addEventListener('click', () => (dd.classList.contains('is-open') ? close() : open()));
    btn.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
    });
    panel.addEventListener('keydown', (e) => {
      const n = opts().length;
      if (e.key === 'ArrowDown') setActive(active + 1);
      else if (e.key === 'ArrowUp') setActive(active - 1);
      else if (e.key === 'Home') setActive(0);
      else if (e.key === 'End') setActive(n - 1);
      else if (e.key === 'Enter' || e.key === ' ') pick(active);
      else if (e.key === 'Escape') close();
      else if (e.key === 'Tab') { close(false); return; }
      else if (/^[a-z]$/i.test(e.key)) {
        const list = opts();
        for (let k = 1; k <= n; k++) {
          const i = (active + k) % n;
          if ((list[i].dataset.name || '').toLowerCase().startsWith(e.key.toLowerCase())) { setActive(i); break; }
        }
      } else return;
      e.preventDefault();
    });
    panel.addEventListener('mousemove', (e) => {
      const o = e.target.closest('.ph-dd-opt');
      if (o) { const i = opts().indexOf(o); if (i !== active) setActive(i); }
    });
    panel.addEventListener('click', (e) => {
      const o = e.target.closest('.ph-dd-opt');
      if (o) pick(opts().indexOf(o));
    });
    document.addEventListener('pointerdown', (e) => { if (!dd.contains(e.target)) close(false); });
  }

  /** Options (with each variety's latest price, in the current unit) and the button's label. */
  function renderRiceOptions() {
    const panel = document.getElementById('ph-rice-list');
    const val = document.getElementById('ph-rice-val');
    if (!panel || !store) return;
    const available = RICE.filter((r) => store.byKey[r.key]);
    const perUnit = unit === 'sack' ? `per ${SACK_KG}kg sack` : 'per kilo';
    const group = (g, title) => {
      const items = available.filter((r) => r.group === g);
      if (!items.length) return '';
      return `<div class="ph-dd-group" role="group" aria-labelledby="ph-dd-g-${g}">
        <div class="ph-dd-glabel" id="ph-dd-g-${g}">${title}</div>
        ${items.map((r) => {
          const name = r.label.replace(/^(Local|Imported)\s+/, '');
          const price = peso(latestValue(r.key));
          return `<div class="ph-dd-opt" role="option" id="ph-opt-${r.key}" data-key="${r.key}" data-name="${esc(name)}"
              aria-selected="${r.key === riceKey}" aria-label="${esc(r.label)}, latest ${price} ${perUnit}">
              ${CHECK_ICON}<span class="ph-dd-name">${esc(name)}</span><span class="ph-dd-price">${price}</span>
            </div>`;
        }).join('')}
      </div>`;
    };
    panel.innerHTML = group('local', 'Local') + group('imported', 'Imported')
      + `<div class="ph-dd-foot" aria-hidden="true">Latest recorded DA price, ${perUnit}</div>`;
    if (val && val.textContent !== meta().label) {
      const changed = !!val.textContent;
      val.textContent = meta().label;
      if (changed) {             // the new name slides in — the visible result of the pick
        val.classList.remove('is-swapping');
        void val.offsetWidth;
        val.classList.add('is-swapping');
      }
    }
  }

  /* ─────────────────────── tabs ─────────────────────── */

  /**
   * One entry at a time instead of five stacked panels. Standard WAI-ARIA tabs: click, or
   * Left/Right/Home/End on the focused tab. The open tab is kept in the URL hash (replaceState, so
   * the Back button and scroll position are untouched) — a link to #chart opens the chart.
   *
   * The chart needs a redraw when its tab opens: while hidden its box measures 0×0, and the canvas
   * is sized from that box (see renderChart).
   */
  const TABS = ['today', 'chart', 'years', 'season', 'swings'];

  function showTab(name, { focus = false, animate = true } = {}) {
    if (!TABS.includes(name)) name = 'today';
    TABS.forEach((t) => {
      const tab = document.getElementById(`tab-${t}`);
      const panel = document.getElementById(`panel-${t}`);
      const on = t === name;
      if (tab) {
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
        if (on && focus) tab.focus();
        if (on) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      if (panel) {
        panel.hidden = !on;
        panel.classList.toggle('is-entering', on && animate);
      }
    });
    fitCardToScreen();
    try { history.replaceState(null, '', `#${name}`); } catch { /* file:// or sandboxed */ }
    // Synchronous on purpose: reading the box's size forces layout, so it is already correct here,
    // and a requestAnimationFrame never fires while the browser tab is in the background.
    if (name === 'chart' && store) {
      renderChartNote();
      renderChart();
    }
  }

  function bindTabs() {
    const list = document.querySelector('.ph-tabs');
    if (!list || list.dataset.bound) return;
    list.dataset.bound = '1';
    list.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) showTab(tab.dataset.tab);
    });
    list.addEventListener('keydown', (e) => {
      const cur = TABS.indexOf(document.activeElement?.dataset?.tab);
      if (cur < 0) return;
      const to = { ArrowRight: cur + 1, ArrowLeft: cur - 1, Home: 0, End: TABS.length - 1 }[e.key];
      if (to == null) return;
      e.preventDefault();
      showTab(TABS[(to + TABS.length) % TABS.length], { focus: true });
    });
    // Switching tabs from further down the page (the pinned tab bar, or a Next button at the foot
    // of a card) lands on the top of the new card instead of leaving the reader mid-page. Clicking a
    // tab while the banner is still in view does not move the page.
    list.addEventListener('click', (e) => { if (e.target.closest('[data-tab]')) toCardTop(); });
    document.querySelectorAll('.ph-next[data-go]').forEach((btn) => {
      btn.addEventListener('click', () => {
        showTab(btn.dataset.go, { focus: true });
        toCardTop();
      });
    });
    showTab((location.hash || '').slice(1), { animate: false });
    trackStickyTop();
    watchFit();
    bindTipEdges();
    watchVerdictInView();
  }

  /* ── Fit to one screen (laptop / desktop) ──
     Matches the CSS block "FIT TO ONE SCREEN" in historical.html. The open card gets exactly the
     height left below the banner and tabs, so the module needs no scrolling. Measured from the
     panel (not the card, which slides in with a transform), and set before the chart is drawn so
     the canvas is sized against the final box. */
  const FIT_QUERY = '(min-width: 900px) and (min-height: 500px)';
  const fitsScreen = () => typeof window.matchMedia === 'function' && window.matchMedia(FIT_QUERY).matches;

  function fitCardToScreen() {
    const root = document.documentElement;
    if (!fitsScreen()) { root.style.removeProperty('--ph-card-h'); return; }
    const panel = document.querySelector('.ph-tabpanel:not([hidden])');
    if (!panel) return;
    const scroller = document.scrollingElement || root;
    const cs = getComputedStyle(panel);
    const top = panel.getBoundingClientRect().top + scroller.scrollTop + (parseFloat(cs.paddingTop) || 0);
    const room = window.innerHeight - top - (parseFloat(cs.paddingBottom) || 0);
    // Capped on tall screens: past ~720px the card only adds empty space around its content.
    root.style.setProperty('--ph-card-h', `${Math.max(300, Math.min(720, Math.floor(room)))}px`);
    fitBody();
  }

  /**
   * Make the open card's content fit its box with no scrollbar. When the window is too short for
   * the content at full size, the whole content block is scaled down as one piece (text, gauges,
   * bars keep their proportions), never cropped or scrolled. The chart tab is left alone: its plot
   * already stretches or shrinks with the box. Undone on phones, where the page scrolls normally.
   */
  function fitBody() {
    const body = document.querySelector('.ph-tabpanel:not([hidden]) .ph-card-body');
    if (!body || body.querySelector('#chart-historical')) return;
    let wrap = body.querySelector(':scope > .ph-fit');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'ph-fit';
      while (body.firstChild) wrap.appendChild(body.firstChild);
      body.appendChild(wrap);
    }
    wrap.style.transform = '';
    wrap.style.marginBottom = '';
    if (!fitsScreen()) return;
    const room = body.clientHeight;
    const need = wrap.offsetHeight;
    if (!room || need <= room) return;
    const scale = Math.max(0.55, room / need);
    wrap.style.transform = `scale(${scale.toFixed(4)})`;
    // A transform does not change the space the element takes, so give the difference back.
    wrap.style.marginBottom = `${-(need * (1 - scale)).toFixed(1)}px`;
  }

  /** On a fitted screen each card's "How to read this" note is shown as an ⓘ tip in its header. */
  function syncHowtoTips() {
    document.querySelectorAll('.ph-card').forEach((card) => {
      const note = card.querySelector('.ph-howto > span');
      const h2 = card.querySelector('.ph-tp-head h2');
      if (!note || !h2) return;
      const extra = [...note.querySelectorAll('[data-tip]')].map((el) => el.dataset.tip).join(' ');
      const text = `${note.textContent} ${extra}`.replace(/\s+/g, ' ').trim();
      let tip = h2.querySelector('.ph-howto-tip');
      if (!tip) {
        tip = document.createElement('i');
        tip.className = 'ti ti-bulb ph-info ph-howto-tip';
        tip.tabIndex = 0;
        tip.setAttribute('role', 'img');
        h2.appendChild(tip);
      }
      tip.dataset.tip = text;
      tip.setAttribute('aria-label', text);
    });
  }

  function watchFit() {
    let raf = 0;
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fitCardToScreen);
    };
    window.addEventListener('resize', refit, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(fitCardToScreen);
      ['.ledger-masthead', '#ph-coverage', '.ph-tabs', '#public-navbar-host'].forEach((sel) => {
        const el = document.querySelector(sel);
        if (el) ro.observe(el);
      });
    }
    document.fonts?.ready?.then(fitCardToScreen);
  }

  /** Scroll so the tab bar sits in its pinned spot, if the page is already scrolled past it. */
  function toCardTop() {
    if (fitsScreen()) return;   // the whole module is on screen — nothing to scroll to
    const list = document.querySelector('.ph-tabs');
    const scroller = document.scrollingElement || document.documentElement;
    if (!list) return;
    const pinned = parseFloat(getComputedStyle(list).top) || 0;
    const tabsTop = list.getBoundingClientRect().top;
    if (tabsTop > pinned + 1) return;                        // banner still showing — stay put
    const panel = document.querySelector('.ph-tabpanel:not([hidden])');
    if (!panel) return;
    const target = scroller.scrollTop + panel.getBoundingClientRect().top - pinned - list.offsetHeight;
    scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }

  /**
   * The tab bar pins directly under the site nav. The nav is pinned by its wrapper,
   * #public-navbar-host (landpage-nav.css), so that wrapper is what gets measured: its height
   * changes when the nav wraps on narrow screens. If it is not pinned (a page without the shared
   * shell, or an older stylesheet), the tabs pin to the very top instead of leaving an empty strip.
   * The card height (CSS clamp on --ph-chrome) follows the same numbers.
   */
  function trackStickyTop() {
    const nav = document.getElementById('public-navbar-host') || document.querySelector('.lp-site-nav');
    const set = () => {
      const pos = nav ? getComputedStyle(nav).position : '';
      const canPin = pos === 'sticky' || pos === 'fixed';
      const top = canPin ? nav.offsetHeight : 0;
      const tabs = document.querySelector('.ph-tabs');
      document.documentElement.style.setProperty('--ph-sticky-top', `${top}px`);
      document.documentElement.style.setProperty('--ph-chrome', `${top + (tabs ? tabs.offsetHeight : 0)}px`);
    };
    set();
    window.addEventListener('resize', set, { passive: true });
    if (nav && typeof ResizeObserver !== 'undefined') new ResizeObserver(set).observe(nav);
  }

  /**
   * Tooltips open centred above their icon by default; near a screen edge that pushes part of the
   * bubble off-screen (or up under the pinned tab bar). Just before one shows, slide it sideways
   * by exactly the amount needed to stay inside the window, and open it below the icon when there
   * is no room above.
   */
  /**
   * Bottom edge of whatever is pinned over the page above `r`: the site nav, plus the tab bar only
   * while it is actually pinned and `r` sits below it. This used to assume the tab bar was always
   * pinned, so near the top of the page — where it is not — tooltips in the banner opened
   * downward for no reason.
   */
  function obstructionBottom(r) {
    const nav = document.getElementById('public-navbar-host') || document.querySelector('.lp-site-nav');
    let bottom = nav ? Math.max(0, nav.getBoundingClientRect().bottom) : 0;
    const tabs = document.querySelector('.ph-tabs');
    if (tabs) {
      const t = tabs.getBoundingClientRect();
      const pinnedAt = parseFloat(getComputedStyle(tabs).top) || 0;
      if (t.top <= pinnedAt + 1 && r.top >= t.bottom) bottom = Math.max(bottom, t.bottom);
    }
    return bottom;
  }

  function bindTipEdges() {
    if (document.body.dataset.tipEdges) return;
    document.body.dataset.tipEdges = '1';
    const GUTTER = 12;
    const ROOM_Y = 150;
    const place = (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      // Widest the bubble can be (CSS: max-width min(300px, 80vw)); assuming the widest keeps it
      // on screen even when the text is long enough to reach it.
      const w = Math.min(300, vw * 0.8) + 26;
      const cx = r.left + r.width / 2;
      const clamped = Math.min(Math.max(cx, GUTTER + w / 2), vw - GUTTER - w / 2);
      el.style.setProperty('--tip-shift', `${Math.round(clamped - cx)}px`);
      el.dataset.tipY = r.top - obstructionBottom(r) < ROOM_Y ? 'below' : '';
    };
    document.addEventListener('pointerover', place, true);
    document.addEventListener('focusin', place, true);
  }

  /* ─────────────────────── controls ─────────────────────── */

  function renderControls() {
    const available = RICE.filter((r) => store.byKey[r.key]);
    if (!available.some((r) => r.key === riceKey)) riceKey = available[0]?.key || riceKey;

    const sel = document.getElementById('ph-rice');
    if (sel && !sel.dataset.bound) {
      fillRiceSelect(sel);
      sel.addEventListener('change', () => { selectRice(sel.value); });
      sel.dataset.bound = '1';
      buildRiceDropdown(sel);
    }

    const unitWrap = document.getElementById('ph-unit');
    if (unitWrap && !unitWrap.dataset.bound) {
      unitWrap.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-unit]');
        if (!btn) return;
        unit = btn.dataset.unit === 'sack' ? 'sack' : 'kg';
        unitWrap.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        renderAll();
      });
      unitWrap.dataset.bound = '1';
    }
  }

  function renderAll() {
    renderRiceOptions();
    renderCoverage();
    renderVerdict();
    renderThenNow();
    renderSeasonal();
    renderMoves();
    // The note goes in BEFORE the chart. It sits in the same card, so writing it afterwards shrank
    // the plot's box after the canvas had already been sized against the taller one — the chart
    // measured 382px inside what became a 245px slot.
    renderChartNote();
    renderChart();
    syncHowtoTips();
    fitCardToScreen();   // the coverage note may have changed the room; the content its size
  }

  async function init() {
    if (!document.getElementById('ph-verdict')) return;
    bindTabs();
    let payload = null;
    try { payload = await AgriPricePH.API.historical(); } catch { /* handled below */ }
    store = build(payload);
    if (!store) {
      document.querySelectorAll('.ph-panel-body').forEach((el) => {
        el.innerHTML = '<div class="ph-empty">Price history is unavailable — start the backend to load it.</div>';
      });
      return;
    }
    renderControls();
    bindChartControls();
    renderAll();
    syncHowtoTips();
    fitCardToScreen();
    // Once more after fonts and late-wrapping text settle.
    setTimeout(fitCardToScreen, 350);
    // One correction pass once fonts and wrapped text have settled. On a narrow screen the note
    // and legend take an extra line each, which shrinks the plot's box after the canvas has been
    // sized — a redraw here lands on the final measurement.
    setTimeout(renderChart, 300);
  }

  return { init };
})();
