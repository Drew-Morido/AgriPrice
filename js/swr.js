/* AgriPricePH — tiny "stale-while-revalidate" cache for public data pages.
 *
 * Price Forecast, Rice Catalog and Price History all used to render nothing until their live
 * fetch resolved — on a cold backend (LSTM warm-up can take ~50s, see model/predict.py) that left
 * whole sections stuck on a static "Loading…" placeholder. The fix is the standard cache-then-
 * network pattern (what SWR/React Query do under the hood): read the last successful response
 * from localStorage and paint it immediately, then let the real fetch run in the background and
 * silently repaint when it lands. Only a visitor's very first-ever load has nothing to show yet.
 *
 * Deliberately minimal — no TTL/expiry, no dedupe/subscription machinery. Every write just
 * replaces "the last known good response" for that key; callers decide what counts as good
 * enough to cache (e.g. only a `ready:true` payload).
 */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.SWR = (function () {
  const PREFIX = 'agriprice_swr_';

  function read(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed : null;
    } catch {
      return null;
    }
  }

  function write(key, data) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify({ data, ts: Date.now() }));
    } catch {
      /* storage full or unavailable (private browsing) — degrade to network-only, no crash */
    }
  }

  function clear(key) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
  }

  return { read, write, clear };
})();
