/* AgriPricePH — Charts & Stats (public)
 *
 * Four cards, each answering one question from the live DA price record (/api/historical-data):
 *   01  What got cheaper, what got pricier?     change per rice type over the chosen period
 *   02  Local or imported — which costs less?   today's local vs imported price per grade
 *   03  How did one rice type move?             daily line, average, lowest, highest
 *   04  What will my rice cost?                 monthly cost from today's prices × how much you buy
 *
 * Two data rules, the same spirit as Price History (public-history.js):
 *  - Only days the DA actually recorded count. The merged series repeats the last price on days with
 *    no bulletin; averaging those repeats would make rice look steadier than it is.
 *  - A reading that sits more than 5% away from the median of its surrounding week (three readings
 *    each side) is treated as a recording error and left out. Real daily moves are well under 2%;
 *    the rows it was written for were scrape errors (Sep 19, 20 and 22, 2026: three imported grades
 *    saved one column off). Those rows have since been repaired in the database from the DA
 *    bulletins (datasets/repair_ws_rice_from_bulletins.py), so this is now a safety net for any
 *    future bad reading. A real price jump that lasts survives, because after it the surrounding
 *    week agrees with it. Every skipped reading is disclosed on the card it affects.
 *
 * No sample-data fallback: if the backend is down, the page says so instead of drawing fake numbers.
 */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Stats = (function () {
  const RICE = AgriPricePH.RiceTypes || [];
  const SACK_KG = 25;
  const STEADY = 0.10;        // ₱/kg — smaller changes read as "about the same"
  const SPIKE = 0.05;         // 5% away from the local median → recording error (real daily moves stay under ~3%)
  const WEEKS_PER_MONTH = 52 / 12;
  const GRADES = [
    { g: 'Special', label: 'Special', note: 'Aromatic or glutinous' },
    { g: 'Premium', label: 'Premium', note: 'Up to 5% broken' },
    { g: 'WellMilled', label: 'Well-milled', note: 'Most bran removed' },
    { g: 'Regular', label: 'Regular', note: 'Some bran left' },
  ];

  let store = null;           // { iso: [...], byKey: { key: { values:[v|null], skipped:Set<i> } } }
  let forecast = {};          // key -> day-1 forecast
  let period = 30;
  let unit = 'kg';
  let trendKey = 'locWellMilled';
  let chart = null;
  const budget = { qty: 5, per: 'week' };

  const $ = (id) => document.getElementById(id);

  /* ─────────────────────────── data ─────────────────────────── */

  function parseLabel(label) {
    const s = String(label || '').trim();
    let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Local-date ISO — toISOString() would shift dates back a day in PH time.
  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const median = (a) => {
    const s = a.filter((x) => x != null).sort((x, y) => x - y);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

  /** Calendar-continuous series per type; null = no DA reading that day (or a skipped error). */
  function build(payload) {
    const labels = Array.isArray(payload?.labels) ? payload.labels : [];
    const hist = payload?.historical || {};
    if (!labels.length) return null;
    const dates = labels.map(parseLabel);
    const valid = dates.filter(Boolean).sort((a, b) => a - b);
    if (!valid.length) return null;
    // Only the last 90 days (+ one week of context for the error check) are ever shown.
    const last = valid[valid.length - 1];
    const first = new Date(last); first.setDate(first.getDate() - 96);

    const iso = [];
    for (const c = new Date(first); c <= last; c.setDate(c.getDate() + 1)) iso.push(isoOf(c));
    const slot = new Map(iso.map((d, i) => [d, i]));

    const byKey = {};
    RICE.forEach(({ key }) => {
      const src = hist[key];
      if (!Array.isArray(src)) return;
      const values = new Array(iso.length).fill(null);
      labels.forEach((_, i) => {
        const d = dates[i];
        const at = d ? slot.get(isoOf(d)) : null;
        if (at == null) return;
        const v = Number(src[i]);
        if (Number.isFinite(v) && v > 0) values[at] = v;       // duplicate dates keep the last reading
      });
      // Recording-error check against the surrounding week of real readings.
      const idx = values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
      const skipped = new Set();
      idx.forEach((i, j) => {
        const m = median(idx.slice(Math.max(0, j - 3), j + 4).map((k) => values[k]));
        if (m && Math.abs(values[i] - m) / m > SPIKE) skipped.add(i);
      });
      skipped.forEach((i) => { values[i] = null; });
      if (values.some((v) => v != null)) byKey[key] = { values, skipped };
    });
    return Object.keys(byKey).length ? { iso, byKey } : null;
  }

  const windowStart = () => Math.max(0, store.iso.length - period);

  /** Real readings in the chosen period: [{ i, iso, v }]. */
  function points(key) {
    const s = store.byKey[key];
    if (!s) return [];
    const out = [];
    for (let i = windowStart(); i < store.iso.length; i++) {
      if (s.values[i] != null) out.push({ i, iso: store.iso[i], v: s.values[i] });
    }
    return out;
  }

  function skippedIn(key) {
    const s = store.byKey[key];
    if (!s) return [];
    const from = windowStart();
    return [...s.skipped].filter((i) => i >= from).sort((a, b) => a - b).map((i) => store.iso[i]);
  }

  /** Latest real reading of a type (anywhere in the loaded range). */
  function latest(key) {
    const s = store.byKey[key];
    if (!s) return null;
    for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] != null) return { iso: store.iso[i], v: s.values[i] };
    return null;
  }

  /**
   * Change over the period: the average of the last three readings against the average of the first
   * three, so one unusual day at either end cannot decide the result on its own.
   */
  function change(key) {
    const pts = points(key);
    if (pts.length < 4) return null;
    const k = Math.min(3, Math.floor(pts.length / 2));
    const from = mean(pts.slice(0, k).map((p) => p.v));
    const to = mean(pts.slice(-k).map((p) => p.v));
    const d = to - from;
    return { key, from, to, d, pct: from ? (d / from) * 100 : 0, dir: Math.abs(d) < STEADY ? 'flat' : d > 0 ? 'up' : 'down' };
  }

  /* ─────────────────────────── formatting ─────────────────────────── */

  const mult = () => (unit === 'sack' ? SACK_KG : 1);
  const perTxt = () => (unit === 'sack' ? 'a sack' : 'a kilo');
  const perShort = () => (unit === 'sack' ? '/sack' : '/kg');
  const perWord = () => (unit === 'sack' ? 'per sack' : 'per kilo');
  const money = (n, dp = 2) => `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
  const peso = (v) => (v == null ? '—' : money(v * mult()));
  const signed = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${money(Math.abs(v * mult()))}`);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const shortDate = (iso) => { const d = parseLabel(iso); return d ? `${MON[d.getMonth()]} ${d.getDate()}` : iso; };
  const longDate = (iso) => { const d = parseLabel(iso); return d ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : iso; };
  const metaOf = (key) => RICE.find((r) => r.key === key) || { key, label: key, color: '#65be82' };
  const listDates = (arr) => arr.map(shortDate).join(', ');

  /** Count a number up from 0 — a finishing timer sets the final text even if frames never run. */
  function countUp(el, value, fmt) {
    if (!el) return;
    const final = fmt(value);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !Number.isFinite(value)) { el.textContent = final; return; }
    const t0 = performance.now();
    const dur = 900;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = fmt(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(() => { el.textContent = final; }, dur + 120);
  }

  /* ─────────────────────────── hero ─────────────────────────── */

  function renderHero() {
    const today = RICE.map((r) => ({ r, l: latest(r.key) })).filter((x) => x.l);
    const lastIso = today.reduce((m, x) => (x.l.iso > m ? x.l.iso : m), '');
    $('st-asof').textContent = lastIso ? `Latest DA reading: ${longDate(lastIso)}` : 'No recent DA reading';
    $('ft-latest').textContent = lastIso ? shortDate(lastIso) : '—';
    $('ft-days').textContent = String(period);
  }

  /* ─────────────────────── 01 · movers ─────────────────────── */

  function renderMovers() {
    const host = $('st-movers');
    const rows = RICE.map((r) => change(r.key)).filter(Boolean).sort((a, b) => b.d - a.d);
    if (!rows.length) { host.innerHTML = '<div class="st-empty">Not enough DA readings in this period to compare.</div>'; return; }
    const maxAbs = Math.max(...rows.map((c) => Math.abs(c.d)), STEADY);
    const nUp = rows.filter((c) => c.dir === 'up').length;
    const nDown = rows.filter((c) => c.dir === 'down').length;
    const nFlat = rows.length - nUp - nDown;
    const biggest = rows.reduce((a, b) => (Math.abs(b.d) > Math.abs(a.d) ? b : a));
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    // The first group named carries "rice type(s)"; the rest read on from it ("…, 5 got pricier").
    const groups = [[nDown, 'got cheaper'], [nUp, 'got pricier'], [nFlat, 'stayed about the same']].filter(([n]) => n);
    const parts = groups.map(([n, verb], i) => `<b>${i === 0 ? plural(n, 'rice type', 'rice types') : n} ${verb}</b>`);
    const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    const bigTxt = biggest.dir === 'flat'
      ? 'No rice type moved by more than 10 centavos a kilo.'
      : `The biggest change was <b>${esc(metaOf(biggest.key).label)}</b>, ${biggest.d > 0 ? 'up' : 'down'} ${money(Math.abs(biggest.d) * mult())} ${perTxt()}.`;

    // Name each rice type with the days that were left out, so the reader can see exactly what was skipped.
    const skipped = RICE.map((r) => ({ label: r.label, days: skippedIn(r.key) })).filter((x) => x.days.length);

    host.innerHTML = `
      <p class="st-summary">In the last ${period} days, ${joined}. <span class="st-more">${bigTxt}</span></p>
      <div class="mv-scale" aria-hidden="true"><span></span><span class="mv-scale-mid"><span class="d">&larr; Cheaper</span><span class="u">Pricier &rarr;</span></span><span></span></div>
      <div class="mv-list">
        ${rows.map((c) => {
          const m = metaOf(c.key);
          const w = c.dir === 'flat' ? 0 : (Math.abs(c.d) / maxAbs) * 50;
          const word = c.dir === 'flat' ? 'about the same' : c.dir === 'up' ? 'pricier' : 'cheaper';
          return `<button type="button" class="mv-row" data-rice="${c.key}" aria-label="${esc(m.label)}: ${word}, ${signed(c.d)} ${perTxt()}. Open its chart.">
            <div class="mv-name"><span class="mv-dot" style="background:${m.color}"></span>${esc(m.label)}</div>
            <div class="mv-track"><div class="mv-bar ${c.dir}" style="width:${w.toFixed(2)}%"></div></div>
            <div class="mv-val ${c.dir}">${c.dir === 'flat' ? 'Same' : signed(c.d)}<small>${c.dir === 'flat' ? `${signed(c.d)} ${perWord()}` : `${c.pct >= 0 ? '+' : '−'}${Math.abs(c.pct).toFixed(1)}% · ${perWord()}`}</small></div>
          </button>`;
        }).join('')}
      </div>
      ${skipped.length ? `<p class="st-note">Left out as likely recording errors (they did not match the days around them): ${skipped.map((x) => `${esc(x.label)} on ${listDates(x.days)}`).join('; ')}.</p>` : ''}`;

    $('st-movers-sub').textContent = `How much each rice type’s price changed in the last ${period} days, from the biggest rise to the biggest drop.`;
    $('st-movers-tip').dataset.tip = `We compare the average of the three latest DA readings with the average of the first three readings in the period, so a single unusual day cannot swing the result. Changes smaller than 10 centavos a kilo count as "about the same". Readings more than 5% away from the days around them are treated as recording errors and left out.`;
  }

  /* ─────────────────── 02 · local vs imported ─────────────────── */

  function renderOrigin() {
    const host = $('st-origin');
    const rows = GRADES.map(({ g, label, note }) => {
      const loc = latest(`loc${g}`);
      const imp = latest(`imp${g}`);
      if (!loc || !imp) return null;
      // Average gap over the period, on days where both were recorded.
      const lp = new Map(points(`loc${g}`).map((p) => [p.i, p.v]));
      const gaps = points(`imp${g}`).filter((p) => lp.has(p.i)).map((p) => p.v - lp.get(p.i));
      return { g, label, note, loc: loc.v, imp: imp.v, gap: imp.v - loc.v, avgGap: mean(gaps) };
    }).filter(Boolean);
    if (!rows.length) { host.innerHTML = '<div class="st-empty">No local and imported prices to compare yet.</div>'; return; }

    const all = rows.flatMap((r) => [r.loc, r.imp]);
    const lo = Math.floor(Math.min(...all) - 1);
    const hi = Math.ceil(Math.max(...all) + 1);
    const at = (v) => ((v - lo) / (hi - lo)) * 100;
    const step = (hi - lo) > 16 ? 4 : 2;
    const ticks = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);

    const locCheaper = rows.filter((r) => r.gap >= STEADY).length;
    const impCheaper = rows.filter((r) => r.gap <= -STEADY).length;
    const best = rows.reduce((a, b) => (Math.abs(b.gap) > Math.abs(a.gap) ? b : a));
    let lead;
    if (locCheaper === rows.length) lead = `Today, <b>local rice is cheaper in all ${rows.length} grades</b>.`;
    else if (impCheaper === rows.length) lead = `Today, <b>imported rice is cheaper in all ${rows.length} grades</b>.`;
    else lead = `Today, <b>local rice is cheaper in ${locCheaper} of ${rows.length} grades</b>${impCheaper ? ` and imported is cheaper in ${impCheaper}` : ''}.`;
    const bestTxt = Math.abs(best.gap) >= STEADY
      ? ` The biggest gap is in <b>${best.label}</b>: ${best.gap > 0 ? 'local' : 'imported'} saves you ${money(Math.abs(best.gap) * mult())} ${perTxt()}.`
      : '';

    host.innerHTML = `
      <p class="st-summary">${lead}<span class="st-more">${bestTxt}</span></p>
      <div class="og-legend"><span><i style="background:var(--loc)"></i>Local rice</span><span><i style="background:var(--imp)"></i>Imported rice</span></div>
      <div class="og-list">
      ${rows.map((r) => {
        const a = at(r.loc); const b = at(r.imp);
        const left = Math.min(a, b); const right = Math.max(a, b);
        // Local prices are labelled above the line and imported below it, so the two labels never
        // collide however close the prices are. Each sits centred on its dot, and is pinned to the
        // track's edge instead when centring would push it outside the card.
        const lab = (cls, x, v) => {
          const pos = x < 14 ? 'left:0' : x > 86 ? 'right:0' : `left:${x.toFixed(2)}%;transform:translateX(-50%)`;
          return `<span class="og-lab ${cls} ${cls === 'loc' ? 'top' : 'bot'}" style="${pos}">${peso(v)}</span>`;
        };
        const same = Math.abs(r.gap) < STEADY;
        const verdict = same
          ? `<div class="og-verdict same">About the same price</div>`
          : `<div class="og-verdict ${r.gap > 0 ? 'loc' : 'imp'}">${r.gap > 0 ? 'Local' : 'Imported'} is ${money(Math.abs(r.gap) * mult())} cheaper${unit === 'sack' ? ' a sack' : ' a kilo'}</div>`;
        const avg = r.avgGap == null ? '' : `<small>${period}-day average: ${Math.abs(r.avgGap) < STEADY ? 'about the same' : `${r.avgGap > 0 ? 'local' : 'imported'} ${money(Math.abs(r.avgGap) * mult())} cheaper`}</small>`;
        return `<div class="og-row">
          <div class="og-grade">${r.label}<small>${r.note}</small></div>
          <div class="og-track" role="img" aria-label="${r.label}: local ${peso(r.loc)}, imported ${peso(r.imp)}">
            <span class="og-link" style="left:${left.toFixed(2)}%;width:${(right - left).toFixed(2)}%"></span>
            <span class="og-dot loc" style="left:${a.toFixed(2)}%"></span>
            <span class="og-dot imp" style="left:${b.toFixed(2)}%"></span>
            ${lab('loc', a, r.loc)}${lab('imp', b, r.imp)}
          </div>
          <div>${verdict.replace('</div>', `${avg}</div>`)}</div>
        </div>`;
      }).join('')}
      </div>
      <div class="og-axis" aria-hidden="true"><span></span><div class="og-ticks">${ticks.map((t) => `<span style="left:${at(t).toFixed(2)}%">${money(t * mult(), 0)}</span>`).join('')}</div><span></span></div>`;
  }

  /* ─────────────────────── 03 · trend ─────────────────────── */

  function fillRiceSelect() {
    const sel = $('st-rice');
    if (sel.dataset.bound) return;
    const avail = RICE.filter((r) => store.byKey[r.key]);
    if (!avail.some((r) => r.key === trendKey)) trendKey = avail[0]?.key || trendKey;
    const group = (g, title) => `<optgroup label="${title}">${avail.filter((r) => r.group === g).map((r) => `<option value="${r.key}">${esc(r.label)}</option>`).join('')}</optgroup>`;
    sel.innerHTML = group('local', 'Local rice') + group('imported', 'Imported rice');
    sel.value = trendKey;
    sel.addEventListener('change', () => { trendKey = sel.value; renderTrend(); });
    sel.dataset.bound = '1';
  }

  function renderTrend() {
    const host = $('st-trend');
    const pts = points(trendKey);
    const m = metaOf(trendKey);
    const wrap = $('st-chart-wrap');
    if (pts.length < 2) {
      host.innerHTML = '<div class="st-empty">Not enough DA readings in this period for this rice type.</div>';
      wrap.hidden = true;
      return;
    }
    const vals = pts.map((p) => p.v);
    const avg = mean(vals);
    const low = pts.reduce((a, b) => (b.v < a.v ? b : a));
    const high = pts.reduce((a, b) => (b.v > a.v ? b : a));
    const now = pts[pts.length - 1];
    const vsAvg = now.v - avg;
    const skipped = skippedIn(trendKey);

    host.innerHTML = `
      <p class="st-summary"><b>${esc(m.label)}</b> is ${peso(now.v)} ${perTxt()} today — ${Math.abs(vsAvg) < STEADY
        ? `right at its ${period}-day average.`
        : `<b>${money(Math.abs(vsAvg) * mult())} ${vsAvg > 0 ? 'above' : 'below'}</b> its ${period}-day average of ${peso(avg)}.`}
        ${vsAvg <= -STEADY ? 'A good time to buy compared with recent weeks.' : vsAvg >= STEADY ? 'Higher than usual for this period.' : ''}</p>
      <div class="tr-stats">
        <div class="tr-stat today"><div class="l">Today</div><div class="v">${peso(now.v)}</div><div class="s">${shortDate(now.iso)}</div></div>
        <div class="tr-stat"><div class="l">Average</div><div class="v">${peso(avg)}</div><div class="s">dashed line</div></div>
        <div class="tr-stat low"><div class="l">Lowest</div><div class="v">${peso(low.v)}</div><div class="s">${shortDate(low.iso)}</div></div>
        <div class="tr-stat high"><div class="l">Highest</div><div class="v">${peso(high.v)}</div><div class="s">${shortDate(high.iso)}</div></div>
      </div>
      ${skipped.length ? `<p class="st-note" style="margin:-6px 0 14px">Readings on ${listDates(skipped)} were left out: they did not match the days around them (a likely recording error).</p>` : ''}`;

    $('st-trend-sub').textContent = `The daily price of the rice type you choose over the last ${period} days, with its average, lowest and highest.`;
    $('st-trend-tip').dataset.tip = `Each point is the Department of Agriculture's average retail price for ${m.label} on that day. Days without a DA reading are bridged by the line. The dashed line is the average of all ${pts.length} readings in the period.`;
    wrap.hidden = false;

    const next = forecast[trendKey];
    const link = $('st-next');
    if (next && Number.isFinite(next.price)) {
      link.hidden = false;
      link.href = `current-prices.html?grade=${encodeURIComponent(trendKey)}`;
      link.innerHTML = `Tomorrow, expected <b>${peso(next.price)}</b> &rarr;`;
    } else {
      link.hidden = true;
    }
    if (!$('card-trend').hidden) drawChart(pts, avg, low, high, m);
  }

  function drawChart(pts, avg, low, high, m) {
    const canvas = $('st-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (chart) { chart.destroy(); chart = null; }
    const k = mult();
    const from = windowStart();
    const days = store.iso.slice(from);
    const byI = new Map(pts.map((p) => [p.i, p.v]));
    const data = days.map((_, j) => (byI.has(from + j) ? +(byI.get(from + j) * k).toFixed(2) : null));
    const lowJ = low.i - from;
    const highJ = high.i - from;
    const dark = '#0b1d13';
    const ctx = canvas.getContext('2d');
    const h = canvas.parentElement.clientHeight || 320;
    const fill = ctx.createLinearGradient(0, 0, 0, h);
    fill.addColorStop(0, hexA(m.color, 0.32));
    fill.addColorStop(1, hexA(m.color, 0));
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: days.map(shortDate),
        datasets: [
          {
            label: 'Daily price', data, spanGaps: true, borderColor: m.color, backgroundColor: fill, fill: true,
            // monotone: the curve never bulges past a real reading, so the lowest/highest dots stay the extremes
            tension: 0.3, cubicInterpolationMode: 'monotone', borderWidth: 3,
            pointRadius: (c) => (c.dataIndex === lowJ || c.dataIndex === highJ ? 7 : 0),
            pointBackgroundColor: (c) => (c.dataIndex === lowJ ? '#6fd197' : '#f2946f'),
            pointBorderColor: dark, pointBorderWidth: 2,
            pointHoverRadius: 7, pointHoverBackgroundColor: m.color, pointHoverBorderColor: '#fff', pointHitRadius: 16,
          },
          {
            label: 'Average', data: days.map(() => +(avg * k).toFixed(2)), borderColor: 'rgba(255,255,255,0.55)',
            borderDash: [7, 5], borderWidth: 2, pointRadius: 0, pointHitRadius: 0, fill: false,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: reduce ? false : { duration: 900, easing: 'easeOutQuart' },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: (item) => item.datasetIndex === 0 && item.parsed.y != null,
            backgroundColor: 'rgba(6,16,10,0.96)', titleColor: '#cfe6d8', bodyColor: '#fff',
            borderColor: hexA(m.color, 0.6), borderWidth: 1, cornerRadius: 10, padding: 12, displayColors: false,
            titleFont: { family: "'Plus Jakarta Sans', sans-serif", size: 13, weight: '700' },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 14, weight: '600' },
            callbacks: {
              title: (items) => (items[0] ? longDate(days[items[0].dataIndex]) : ''),
              label: (c) => {
                const d = c.parsed.y - avg * k;
                const tag = c.dataIndex === lowJ ? '  · lowest' : c.dataIndex === highJ ? '  · highest' : '';
                return [`${money(c.parsed.y)} ${perShort()}${tag}`, `${d >= 0 ? '+' : '−'}${money(Math.abs(d))} vs average`];
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false }, border: { color: 'rgba(255,255,255,0.18)' },
            title: { display: true, text: 'Date', color: 'rgba(233,247,238,0.7)', font: { family: "'Plus Jakarta Sans', sans-serif", size: 13, weight: '700' } },
            ticks: { color: 'rgba(233,247,238,0.72)', font: { family: "'Plus Jakarta Sans', sans-serif", size: 12.5 }, maxRotation: 0, autoSkip: true, maxTicksLimit: period <= 7 ? 7 : 8 },
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.07)' }, border: { display: false },
            title: { display: true, text: unit === 'sack' ? 'Price (₱ per 25-kg sack)' : 'Price (₱ per kilo)', color: 'rgba(233,247,238,0.7)', font: { family: "'Plus Jakarta Sans', sans-serif", size: 13, weight: '700' } },
            ticks: { color: 'rgba(233,247,238,0.72)', font: { family: "'JetBrains Mono', monospace", size: 12.5 }, maxTicksLimit: 6, callback: (v) => money(v, unit === 'sack' ? 0 : 2) },
            grace: '12%',
          },
        },
      },
      plugins: [{
        // A light vertical guide under the hovered day.
        id: 'stGuide',
        afterDatasetsDraw(c) {
          const act = c.tooltip?.getActiveElements?.();
          if (!act?.length) return;
          const x = act[0].element.x;
          const { top, bottom } = c.chartArea;
          c.ctx.save();
          c.ctx.strokeStyle = 'rgba(255,255,255,0.25)'; c.ctx.setLineDash([4, 4]); c.ctx.lineWidth = 1;
          c.ctx.beginPath(); c.ctx.moveTo(x, top); c.ctx.lineTo(x, bottom); c.ctx.stroke();
          c.ctx.restore();
        },
      }],
    });
  }

  function hexA(hex, a) {
    const h = String(hex).replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* ─────────────────────── 04 · budget ─────────────────────── */

  function renderBudget() {
    const list = $('bd-list');
    const kgMonth = budget.per === 'week' ? budget.qty * WEEKS_PER_MONTH : budget.qty;
    const rows = RICE.map((r) => ({ r, l: latest(r.key) })).filter((x) => x.l)
      .map((x) => ({ ...x, cost: Math.round(x.l.v * kgMonth) })).sort((a, b) => a.cost - b.cost);
    if (!rows.length || !(kgMonth > 0)) {
      list.innerHTML = '';
      $('bd-summary').textContent = 'Enter how many kilos you buy to see the monthly cost.';
      return;
    }
    const max = rows[rows.length - 1].cost;
    const lo = rows[0]; const hi = rows[rows.length - 1];
    const qtyTxt = `${budget.qty.toLocaleString('en-PH', { maximumFractionDigits: 1 })} kg ${budget.per === 'week' ? 'a week' : 'a month'}`;
    $('bd-summary').innerHTML = `For <b>${qtyTxt}</b>, your rice costs from <b>${money(lo.cost, 0)}</b> a month (${esc(lo.r.label)}) to <b>${money(hi.cost, 0)}</b> (${esc(hi.r.label)}) — a difference of <b>${money(hi.cost - lo.cost, 0)} a month</b>.`;
    list.innerHTML = rows.map((x, i) => {
      const tag = i === 0 ? '<span class="bd-tag low">Lowest</span>' : i === rows.length - 1 ? '<span class="bd-tag high">Highest</span>' : '';
      return `<button type="button" class="bd-row${i === 0 ? ' cheapest' : ''}${i === rows.length - 1 ? ' priciest' : ''}" data-rice="${x.r.key}" aria-label="${esc(x.r.label)}: ${money(x.cost, 0)} a month. Open its chart.">
        <div class="bd-name"><span class="mv-dot" style="background:${x.r.color}"></span>${esc(x.r.label)} ${tag}</div>
        <div class="bd-bar-track"><div class="bd-bar" style="width:${((x.cost / max) * 100).toFixed(1)}%"></div></div>
        <div class="bd-cost">${money(x.cost, 0)}<span> /mo</span></div>
      </button>`;
    }).join('');
  }

  function bindBudget() {
    const qty = $('bd-qty');
    const perWrap = $('bd-per');
    const setPer = (per) => {
      budget.per = per;
      perWrap.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.per === per));
    };
    qty.addEventListener('input', () => {
      const v = parseFloat(qty.value);
      budget.qty = Number.isFinite(v) && v > 0 ? Math.min(v, 5000) : 0;
      renderBudget();
    });
    perWrap.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-per]');
      if (!b) return;
      setPer(b.dataset.per);
      renderBudget();
    });
    document.querySelectorAll('.bd-presets button').forEach((b) => b.addEventListener('click', () => {
      budget.qty = parseFloat(b.dataset.qty);
      qty.value = String(budget.qty);
      setPer(b.dataset.per);
      renderBudget();
    }));
  }

  /* ─────────────────────── page plumbing ─────────────────────── */

  /** The period / unit controls appear on cards 01-03; every copy drives, and shows, the same state. */
  function bindToolbar() {
    document.addEventListener('click', (e) => {
      const b = e.target.closest('.st-seg[data-ctl] button');
      if (!b) return;
      const ctl = b.parentElement.dataset.ctl;
      if (ctl === 'period') period = parseInt(b.dataset.days, 10) || 30;
      else unit = b.dataset.unit === 'sack' ? 'sack' : 'kg';
      document.querySelectorAll(`.st-seg[data-ctl="${ctl}"] button`).forEach((x) => {
        x.classList.toggle('active', ctl === 'period' ? parseInt(x.dataset.days, 10) === period : x.dataset.unit === unit);
      });
      renderAll();
    });
  }

  /** The tab bar pins right under the site nav, whose height changes when it wraps; the open card is
   *  then sized by sizeCards() so banner + tabs + card fit the window. */
  function trackStickyTop() {
    const nav = document.getElementById('public-navbar-host');
    const bar = document.querySelector('.st-bar');
    const set = () => {
      const pinned = nav && ['sticky', 'fixed'].includes(getComputedStyle(nav).position);
      const navH = pinned ? nav.offsetHeight : 0;
      document.documentElement.style.setProperty('--st-sticky-top', `${navH}px`);
    };
    set();
    sizeCards();
    const onResize = () => { set(); sizeCards(); };
    window.addEventListener('resize', onResize, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(onResize);
      if (nav) ro.observe(nav);
      if (bar) ro.observe(bar);
      const hero = document.querySelector('.hero');
      if (hero) ro.observe(hero);
    }
  }

  /**
   * Make the open card end at the bottom of the window AS THE PAGE FIRST APPEARS — banner, tab bar
   * and all — so nothing has to be scrolled to be read. The card's distance from the top of the page
   * (not of the viewport) is used, so the size does not change as the reader scrolls. Floor of 400px
   * keeps a very short window usable; its body scrolls on its own below that.
   */
  function sizeCards() {
    const card = document.querySelector('.st-card:not([hidden])') || document.querySelector('.st-card');
    if (!card) return;
    // Layout position (offsetTop chain), not getBoundingClientRect: the card's entrance animation
    // moves it with a transform, which would make it measure ~10px lower mid-animation.
    let top = 0;
    for (let el = card; el; el = el.offsetParent) top += el.offsetTop;
    const h = Math.round(Math.max(400, Math.min(780, window.innerHeight - top - 14)));
    document.documentElement.style.setProperty('--st-card-h', `${h}px`);
  }

  /* ─────────────────────── tabs ─────────────────────── */

  // One card at a time, like the Price History page. Standard WAI-ARIA tabs: click, or
  // Left/Right/Home/End on the focused tab; the open tab is kept in the URL hash (#trend opens card 03).
  const TABS = ['changes', 'origin', 'trend', 'budget'];

  function showTab(name, { focus = false } = {}) {
    if (!TABS.includes(name)) name = 'changes';
    TABS.forEach((t) => {
      const tab = $(`tab-${t}`);
      const card = $(`card-${t}`);
      const on = t === name;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
      card.hidden = !on;
      card.classList.remove('is-entering');
      if (on) { void card.offsetWidth; card.classList.add('is-entering'); }   // replay the entrance
    });
    try { history.replaceState(null, '', `#${name}`); } catch { /* sandboxed */ }
    if (name === 'trend' && store) renderTrend();      // the chart needs a visible box to size itself
  }

  /** If the page is scrolled past the banner, bring the new card's top to just under the tab bar. */
  function toCardTop() {
    const bar = document.querySelector('.st-bar');
    const card = document.querySelector('.st-card:not([hidden])');
    if (!bar || !card || getComputedStyle(bar).position !== 'sticky') return;
    const pinnedAt = parseFloat(getComputedStyle(bar).top) || 0;
    if (bar.getBoundingClientRect().top > pinnedAt + 1) return;          // banner still in view
    const scroller = document.scrollingElement || document.documentElement;
    const y = scroller.scrollTop + card.getBoundingClientRect().top - pinnedAt - bar.offsetHeight - 12;
    scroller.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }

  /** Open card 03 on a given rice type — used by the tappable rows in cards 01 and 04. */
  function openRice(key) {
    if (!key || !store?.byKey[key]) return;
    trendKey = key;
    const sel = $('st-rice');
    if (sel) sel.value = key;
    showTab('trend');
    toCardTop();
  }

  function bindTabs() {
    const list = document.querySelector('.st-tabs');
    list.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (!tab) return;
      showTab(tab.dataset.tab);
      toCardTop();
    });
    list.addEventListener('keydown', (e) => {
      const cur = TABS.indexOf(document.activeElement?.dataset?.tab);
      if (cur < 0) return;
      const to = { ArrowRight: cur + 1, ArrowLeft: cur - 1, Home: 0, End: TABS.length - 1 }[e.key];
      if (to == null) return;
      e.preventDefault();
      showTab(TABS[(to + TABS.length) % TABS.length], { focus: true });
    });
    document.querySelectorAll('.st-next[data-go]').forEach((btn) => btn.addEventListener('click', () => {
      showTab(btn.dataset.go, { focus: true });
      toCardTop();
    }));
    // Rows in cards 01 and 04 open that rice's chart.
    ['st-movers', 'bd-list'].forEach((id) => $(id)?.addEventListener('click', (e) => {
      const row = e.target.closest('[data-rice]');
      if (row) openRice(row.dataset.rice);
    }));
    showTab((location.hash || '').slice(1));
  }

  function renderAll() {
    renderHero();
    renderMovers();
    renderOrigin();
    renderTrend();
    renderBudget();
  }

  function showUnavailable() {
    const msg = '<div class="st-empty">Live prices are unavailable right now. Please try again in a moment.</div>';
    ['st-movers', 'st-origin', 'st-trend'].forEach((id) => { $(id).innerHTML = msg; });
    $('bd-summary').textContent = 'Live prices are unavailable right now.';
    $('st-asof').textContent = 'Live prices are unavailable right now';
  }

  async function init() {
    if (!$('st-movers')) return;
    trackStickyTop();
    let payload = null;
    try { payload = await AgriPricePH.API.historical(); } catch { /* handled below */ }
    store = build(payload);
    if (!store) { showUnavailable(); return; }
    fillRiceSelect();
    bindToolbar();
    bindBudget();
    renderAll();
    bindTabs();
    // Tomorrow's forecast is a bonus on card 03; the page works without it.
    try {
      const p = await AgriPricePH.API.predictions();
      Object.entries(p?.forecasts_by_key || {}).forEach(([k, days]) => {
        const d1 = Array.isArray(days) ? days.find((d) => d.day === 1) || days[0] : null;
        if (d1) forecast[k] = { price: Number(d1.price) };
      });
      renderTrend();
    } catch { /* no forecast link */ }
  }

  return { init };
})();
