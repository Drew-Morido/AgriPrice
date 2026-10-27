/* AgriPricePH — the short automatic summary under the forecast graph (public Price Forecast and admin
   Price Forecast). Every sentence is built from the numbers already on the page: the latest DA price, the
   recent bulletins, the 3-day forecast with its likely range, and how close past forecasts landed. It says
   nothing the numbers do not support, and moves under ₱0.10 are called "about the same" (predict.STEADY_PESO). */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.ForecastNarrative = (function () {
  const STEADY = 0.10;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const finite = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const peso = (v) => `₱${Number(v).toFixed(2)}`;

  /** "2026-10-26" / "10/26/2026" / "Oct 26" -> "Oct 26". */
  function day(v) {
    if (!v) return '';
    const s = String(v);
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}`;
    return s;
  }

  function versus(next, base) {
    const diff = next - base;
    if (Math.abs(diff) < STEADY) return 'about the same as now';
    return `${peso(Math.abs(diff))} ${diff > 0 ? 'higher' : 'lower'} than now`;
  }

  /**
   * opts: { name, today, todayDate, history: [numbers], days: [{date, price, low, high}],
   *         hit050: % of past next-day forecasts within ₱0.50 (optional), audience: 'public' | 'admin' }
   * Returns plain text (set it with textContent), or '' when there is not enough to say.
   */
  function build(opts) {
    const o = opts || {};
    const days = (o.days || []).filter((d) => d && finite(d.price));
    if (!finite(o.today) || !days.length) return '';
    const today = Number(o.today);
    const name = o.name || 'This rice';
    const out = [];

    out.push(`${name} was ${peso(today)} per kilo in the latest DA bulletin${o.todayDate ? ` (${day(o.todayDate)})` : ''}.`);

    const hist = (o.history || []).map(Number).filter((v) => Number.isFinite(v) && v > 0);
    if (hist.length >= 5) {
      const recent = hist.slice(-7);
      const lo = Math.min(...recent), hi = Math.max(...recent);
      const net = recent[recent.length - 1] - recent[0];
      const drift = Math.abs(net) < STEADY ? 'ending about where it started'
        : `${net > 0 ? 'up' : 'down'} ${peso(Math.abs(net))} overall`;
      out.push(hi - lo < STEADY
        ? `It has barely moved over the last ${recent.length} bulletins.`
        : `Over the last ${recent.length} bulletins it moved between ${peso(lo)} and ${peso(hi)}, ${drift}.`);
    }

    const d1 = days[0];
    const range1 = finite(d1.low) && finite(d1.high) ? ` (likely range ${peso(d1.low)} – ${peso(d1.high)})` : '';
    let fc = `The forecast expects ${peso(d1.price)} on ${day(d1.date)}${range1}, ${versus(Number(d1.price), today)}`;
    const last = days[days.length - 1];
    if (days.length > 1) {
      fc += `, and ${peso(last.price)} by ${day(last.date)}`;
    }
    out.push(fc + '.');

    if (finite(o.hit050)) {
      out.push(`About ${Math.round(Number(o.hit050))} in 100 past next-day forecasts for this rice landed within ₱0.50 of the real price.`);
    }
    out.push(o.audience === 'admin'
      ? 'Daily prices move in small, mostly random steps, so read the range rather than the single figure.'
      : 'Prices move in small steps from day to day, so use the range as your guide, not the single figure.');
    return out.join(' ');
  }

  return { build };
})();
