/* AgriPricePH — dynamic dates (hindi hardcoded sa HTML) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Dates = (function () {

  function today() {
    return new Date();
  }

  // Respect the user's date-format preference (public Settings → Preferences): mdy | dmy | iso.
  function _pref() {
    try { return localStorage.getItem('agriprice_date_format') || 'mdy'; } catch { return 'mdy'; }
  }

  function formatDisplay(d) {
    const f = _pref();
    if (f === 'iso') return iso(d);
    return d.toLocaleDateString(f === 'dmy' ? 'en-GB' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  function formatShort(d) {
    const f = _pref();
    if (f === 'iso') return iso(d);
    return d.toLocaleDateString(f === 'dmy' ? 'en-GB' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function iso(d) {
    return d.toISOString().slice(0, 10);
  }

  function relativeTime(d) {
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} min${mins > 1 ? 's' : ''} ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
    return formatShort(d);
  }

  function formatClock(d) {
    return d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  }

  // One shared ticker drives every live element on the page. A per-element interval would keep
  // firing after the SPA router swapped the page out, so the handle is stored module-side and the
  // previous one cleared whenever applyPageDates runs again.
  let _tickHandle = null;

  function _startLiveTicker(lastUpdated) {
    if (_tickHandle) clearInterval(_tickHandle);
    const tags = document.querySelectorAll('[data-dynamic-date="forecast-tag"]');
    const refreshers = document.querySelectorAll('[data-dynamic-date="refresh"]');
    if (!tags.length && !refreshers.length) return;

    const tick = () => {
      // If the router has replaced the page, these nodes are detached — stop the timer.
      if (![...tags, ...refreshers].some(el => el.isConnected)) {
        clearInterval(_tickHandle);
        _tickHandle = null;
        return;
      }
      const now = today();
      tags.forEach(el => { el.textContent = `Realtime — ${formatClock(now)} · ${formatDisplay(now)}`; });
      // Counts up from when the data was actually fetched, so "Just now" becomes "1 min ago" on
      // its own instead of staying frozen at the value it had on first paint.
      refreshers.forEach(el => { el.textContent = `Updated ${relativeTime(lastUpdated)}`; });
    };
    tick();
    _tickHandle = setInterval(tick, 1000);
  }

  /** I-update ang mga placeholder sa page base sa API o system date */
  function applyPageDates(apiData) {
    const asOf = apiData?.as_of_display
      || (apiData?.as_of_date ? formatDisplay(new Date(apiData.as_of_date + 'T12:00:00')) : null)
      || formatDisplay(today());

    // The clock and the "updated" counter tick every second rather than being written once on
    // load, where they would sit at "Just now" for as long as the tab stayed open.
    _startLiveTicker(today());

    // The wall clock is not the same thing as the date the data covers, so the as-of date moves to
    // the tag's hover rather than being dropped.
    document.querySelectorAll('[data-dynamic-date="forecast-tag"]').forEach(el => {
      el.title = `Prices as of ${asOf}`;
    });

    const heroSub = document.querySelector('[data-dynamic-date="forecast-subtitle"]');
    const fc = apiData?.forecast;
    if (heroSub && fc?.length) {
      // Derive the horizon from the API response instead of hardcoding "2-day": the model
      // forecasts HORIZON days (currently 3) and this line used to disagree with the table
      // rendered right below it.
      const days = fc.length;
      const span = days === 1
        ? fc[0].date_iso
        : `${fc[0].date_iso} – ${fc[days - 1].date_iso}`;
      heroSub.textContent =
        `Powered by LSTM · ${days}-day ahead (${span}) · 30-day sliding window`;
    }
  }

  return { today, formatDisplay, formatShort, formatClock, iso, relativeTime, applyPageDates };
})();
