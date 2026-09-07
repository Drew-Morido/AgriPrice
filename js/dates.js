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

  return { today, formatDisplay, formatShort, iso, relativeTime, applyPageDates };
})();
