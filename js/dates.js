/* AgriPricePH — dynamic dates (hindi hardcoded sa HTML) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Dates = (function () {

  function today() {
    return new Date();
  }

  function formatDisplay(d) {
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  function formatShort(d) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Local calendar date. toISOString() is UTC, which in the Philippines (UTC+8) is still
  // "yesterday" until 8 AM.
  function iso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    const refreshers = document.querySelectorAll('[data-dynamic-date="refresh"]');
    if (!refreshers.length) return;

    const tick = () => {
      // If the router has replaced the page, these nodes are detached — stop the timer.
      if (![...refreshers].some(el => el.isConnected)) {
        clearInterval(_tickHandle);
        _tickHandle = null;
        return;
      }
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

    // The "updated" counter ticks every second rather than being written once on load, where it
    // would sit at "Just now" for as long as the tab stayed open.
    _startLiveTicker(today());

    const heroSub = document.querySelector('[data-dynamic-date="forecast-subtitle"]');
    const fc = apiData?.forecast;
    if (heroSub && fc?.length) {
      // Derive the horizon from the API response instead of hardcoding "2-day": the model
      // forecasts HORIZON days (currently 3) and this line used to disagree with the table
      // rendered right below it. Stated as a plain date range rather than naming the model or its
      // window size — that's an implementation detail, not something a reader needs to make a
      // decision from.
      const days = fc.length;
      const toDate = (iso) => new Date(iso + 'T12:00:00');
      const span = days === 1
        ? formatShort(toDate(fc[0].date_iso))
        : `${formatShort(toDate(fc[0].date_iso))} – ${formatShort(toDate(fc[days - 1].date_iso))}`;
      heroSub.textContent = `Forecast for ${span}`;
      heroSub.title = `Prices as of ${asOf}`;
    }
  }

  return { today, formatDisplay, formatShort, formatClock, iso, relativeTime, applyPageDates };
})();
