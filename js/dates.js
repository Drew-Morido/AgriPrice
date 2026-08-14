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

  /** I-update ang mga placeholder sa page base sa API o system date */
  function applyPageDates(apiData) {
    const asOf = apiData?.as_of_display
      || (apiData?.as_of_date ? formatDisplay(new Date(apiData.as_of_date + 'T12:00:00')) : null)
      || formatDisplay(today());

    document.querySelectorAll('[data-dynamic-date="forecast-tag"]').forEach(el => {
      el.textContent = `Live — ${asOf}`;
    });

    document.querySelectorAll('[data-dynamic-date="refresh"]').forEach(el => {
      el.textContent = `Updated ${relativeTime(today())}`;
    });

    const heroSub = document.querySelector('[data-dynamic-date="forecast-subtitle"]');
    if (heroSub && apiData?.forecast?.length >= 2) {
      const d1 = apiData.forecast[0].date_iso;
      const d2 = apiData.forecast[1].date_iso;
      heroSub.textContent =
        `Powered by LSTM · 2-day ahead (${d1} & ${d2}) · 30-day sliding window`;
    }
  }

  return { today, formatDisplay, formatShort, iso, relativeTime, applyPageDates };
})();
