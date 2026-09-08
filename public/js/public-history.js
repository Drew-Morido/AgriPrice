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
    return { days, today, mid, p25, p75, state, n: pts.length, diff: today - mid };
  }

  function renderVerdict() {
    const host = document.getElementById('ph-verdict');
    if (!host) return;
    const six = verdictFor(182);
    const year = verdictFor(365);
    const m = meta();
    if (!six && !year) {
      host.innerHTML = `<div class="ph-empty">Not enough recorded prices for ${esc(m.label)} yet.</div>`;
      return;
    }
    const lead = six || year;
    const WORD = {
      low: { t: 'Cheaper than usual', cls: 'good' },
      mid: { t: 'About the usual price', cls: 'mid' },
      high: { t: 'Pricier than usual', cls: 'bad' },
    };
    const w = WORD[lead.state];

    // The word follows the sign of the gap, not the verdict: a price can sit a few centavos below
    // the middle price and still be "about usual", and "−₱0.68 in line with" reads as a mistake.
    // The badge above carries the verdict; this row just states the gap.
    const line = (v, label) => {
      if (!v) return '';
      const word = Math.abs(v.diff) < 0.005 ? 'the usual' : v.diff < 0 ? 'below usual' : 'above usual';
      return `<div class="ph-v-row">
        <span class="ph-v-window">vs the last ${label}</span>
        <span class="ph-v-usual">usually ${peso(v.mid)}</span>
        <span class="ph-v-delta ${v.state}">${signedPeso(Math.abs(v.diff) < 0.005 ? 0 : v.diff)} ${esc(word)}</span>
      </div>`;
    };

    host.innerHTML = `
      <div class="ph-verdict-main">
        <div class="ph-v-label">${esc(m.label)} today</div>
        <div class="ph-v-price">${peso(lead.today)}<span>${unitSuffix()}</span></div>
        <div class="ph-v-badge ${w.cls}">${w.t}</div>
      </div>
      <div class="ph-verdict-side">
        ${line(six, '6 months')}
        ${line(year, 'year')}
        <p class="ph-v-note">
          "Usual" is the middle price of the days actually recorded in that window
          ${info('Compared against the middle half of prices in the window (25th–75th percentile), not a simple average, so one unusual stretch does not label every day expensive. Forward-filled days are excluded.')}
        </p>
      </div>`;
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
        <span class="ph-tn-now-label">${MONTHS[month]} ${year}</span>
        <span class="ph-tn-now-val">${peso(base.mean)}<small>${unitSuffix()}</small></span>
      </div>
      <div class="ph-tn-rows">
        ${rows.map((r) => {
          const up = r.diff >= 0;
          return `<div class="ph-tn-row">
            <span class="ph-tn-year">${MON_SHORT[month]} ${r.year}</span>
            <span class="ph-tn-was">${peso(r.mean)}</span>
            <span class="ph-tn-bar-wrap">
              <span class="ph-tn-bar ${up ? 'up' : 'down'}" style="width:${Math.max(6, (Math.abs(r.pct) / widest) * 100)}%"></span>
            </span>
            <span class="ph-tn-diff ${up ? 'up' : 'down'}">${signedPeso(r.diff)} <small>(${up ? '+' : '−'}${Math.abs(r.pct).toFixed(1)}%)</small></span>
          </div>`;
        }).join('')}
      </div>
      <p class="ph-foot">Same month each year, so harvest seasons line up and the comparison is fair
        ${info('Each figure is the average of the days actually recorded in that month. Comparing the same month across years removes the seasonal swing, leaving the year-on-year change.')}
      </p>`;
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

    const bars = s.months.map((x) => {
      const up = x.pct >= 0;
      const h = Math.max(4, (Math.abs(x.pct) / span) * 46);
      const inPeso = (typical * x.pct) / 100;
      const tip = `${MONTHS[x.m]}: typically ${up ? 'above' : 'below'} the year's average by `
        + `${Math.abs(x.pct).toFixed(1)}% (about ${peso(Math.abs(inPeso))}${unit === 'sack' ? '' : '/kg'}) · ${s.years} years of data`;
      return `<div class="ph-se-col" data-tip="${esc(tip)}" tabindex="0">
        <div class="ph-se-slot">
          <span class="ph-se-bar ${up ? 'up' : 'down'}" style="height:${h}px;${up ? 'bottom:50%' : 'top:50%'}"></span>
        </div>
        <span class="ph-se-mon">${MON_SHORT[x.m]}</span>
      </div>`;
    }).join('');

    const name = (arr) => arr.map((x) => MONTHS[x.m]).join(' and ');
    host.innerHTML = `
      <div class="ph-se-summary">
        <div class="ph-se-pick good">
          <span class="ph-se-pick-lbl">Usually cheapest</span>
          <span class="ph-se-pick-val">${name(s.cheapest)}</span>
        </div>
        <div class="ph-se-pick bad">
          <span class="ph-se-pick-lbl">Usually priciest</span>
          <span class="ph-se-pick-val">${name(s.priciest)}</span>
        </div>
      </div>
      <div class="ph-se-chart" role="img" aria-label="Average price by month relative to the yearly average">
        <span class="ph-se-axis"></span>
        ${bars}
      </div>
      <p class="ph-foot">Averaged over ${s.years} years — a tendency, not a promise
        ${info('Each year is compared against its own average first, so this shows the seasonal shape rather than inflation. Year-to-year variation is larger than the seasonal swing, so treat it as a general pattern: some years will not follow it.')}
      </p>`;
  }

  /* ─────────────────────── F · Biggest price swings ─────────────────────── */

  // A window whose entire move happened in one step is a break in the record, not a market move.
  // Measured on the four largest swings in the series: 2020-11 put 96% of an ₱11.50 rise into a
  // single day and 2019-09 put 117% into one (it overshot, then partly retraced) — both are
  // reconstruction seams in the pre-2020 data. The real August-2023 price crisis, by contrast,
  // climbed over several steps and held. Anything above this share is withheld.
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

    host.innerHTML = moves.map((mv) => {
      const up = mv.diff >= 0;
      const end = parseLabel(store.iso[mv.i]);
      const start = parseLabel(store.iso[mv.i - 30]);
      const pct = (mv.diff / mv.from) * 100;
      return `<div class="ph-mv ${up ? 'up' : 'down'}">
        <span class="ph-mv-ico"><i class="ti ti-${up ? 'trending-up' : 'trending-down'}"></i></span>
        <div class="ph-mv-body">
          <div class="ph-mv-top">
            <strong>${signedPeso(mv.diff)}</strong>
            <span class="ph-mv-pct">${up ? '+' : '−'}${Math.abs(pct).toFixed(1)}%</span>
            <span class="ph-mv-when">${MON_SHORT[end.getMonth()]} ${end.getFullYear()}</span>
          </div>
          <div class="ph-mv-sub">${peso(mv.from)} → ${peso(mv.to)} in 30 days
            <span class="ph-mv-range">(${prettyDate(store.iso[mv.i - 30])} – ${prettyDate(store.iso[mv.i])})</span>
          </div>
        </div>
      </div>`;
    }).join('');
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
    host.innerHTML = `Over ${span}, <strong>${esc(meta().label)}</strong> ${word} from `
      + `${peso(first)} to <strong>${peso(last)}</strong>${move}. `
      + `${seen} of these ${total} days have a recorded price.`;
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

    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: m.label,
          data: line,
          borderColor: m.color,
          backgroundColor: `${m.color}1f`,
          borderWidth: 2.4,
          fill: true,
          tension: 0.28,
          // `spanGaps` was pointless here: build() forward-fills `values`, so the series never
          // contains a null and there was nothing to break. The long flat stretches WERE the
          // forward-fill, drawn as a confident solid line. Carried-forward stretches are dashed
          // instead — the shape stays readable, but it is obvious which parts were measured.
          segment: {
            borderDash: (ctx) => (c.observed[from + ctx.p1DataIndex] ? undefined : [4, 4]),
            borderColor: (ctx) => (c.observed[from + ctx.p1DataIndex] ? undefined : `${m.color}66`),
          },
          pointRadius: dots,
          pointHoverRadius: 6,
          pointBackgroundColor: m.color,
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
        }],
      },
      options: {
        responsive: false,          // sized above; see the note before `new Chart`
        maintainAspectRatio: false,
        devicePixelRatio: dpr,
        // The canvas fills its box edge to edge, so all the breathing room comes from here. The
        // line was running into the axis labels and the top of the plot without it.
        layout: { padding: { top: 18, right: 20, bottom: 10, left: 10 } },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0b1d14',
            padding: 11,
            titleFont: { size: 12 },
            bodyFont: { size: 12.5 },
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
              font: { size: 10 }, color: '#8aaa97', padding: 8,
            },
          },
          y: {
            grid: { color: 'rgba(0,0,0,.05)' },
            border: { display: false },
            ticks: {
              maxTicksLimit: 5, font: { size: 10 }, color: '#8aaa97', padding: 8,
              callback: (v) => peso(v, { raw: true }),
            },
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
          <span class="hcc-legend-swatch" style="background:${m.color}"></span>${esc(m.label)}
        </span>
        <span class="hcc-legend-item" style="color:rgba(255,255,255,.42)">
          <span class="hcc-legend-swatch dashed" style="color:${m.color}"></span>Dashed = price carried forward, no reading that day
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

  /* ─────────────────────── controls ─────────────────────── */

  function renderControls() {
    const available = RICE.filter((r) => store.byKey[r.key]);
    if (!available.some((r) => r.key === riceKey)) riceKey = available[0]?.key || riceKey;

    const sel = document.getElementById('ph-rice');
    if (sel && !sel.dataset.bound) {
      fillRiceSelect(sel);
      sel.addEventListener('change', () => { selectRice(sel.value); });
      sel.dataset.bound = '1';
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
  }

  async function init() {
    if (!document.getElementById('ph-verdict')) return;
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
    // One correction pass once fonts and wrapped text have settled. On a narrow screen the note
    // and legend take an extra line each, which shrinks the plot's box after the canvas has been
    // sized — a redraw here lands on the final measurement.
    setTimeout(renderChart, 300);
  }

  return { init };
})();
