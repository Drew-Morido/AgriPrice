/* AgriPricePH — Per-page init for public site */
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  const D = AgriPricePH.PublicData;
  const A = AgriPricePH.PublicAuth;
  const Modal = AgriPricePH.PublicAuthModal;
  const Alert = AgriPricePH.PublicAlert;

  if (page === 'home') {
    AgriPricePH.Landpage?.init?.();
    D?.checkApiStatus?.();
  }

  if (page === 'current') {
    AgriPricePH.PublicForecast?.init?.();
  }

  if (page === 'forecast') {
    D?.loadPredictions?.();
  }

  if (page === 'historical') {
    Modal?.initGatedPage?.({
      feature: 'historical',
      next: 'historical.html',
      onUnlock: () => D?.initHistoricalPage?.(),
    });
  }

  if (page === 'statistics') {
    Modal?.initGatedPage?.({
      feature: 'statistics',
      next: 'statistics.html',
      onUnlock: () => D?.initStatisticsPage?.(),
    });
  }

  if (page === 'settings') {
    AgriPricePH.PublicSettings?.initSettingsPage?.();
  }

  if (page === 'login') {
    if (A?.isLoggedIn?.()) {
      const next = new URLSearchParams(window.location.search).get('next') || 'historical.html';
      window.location.replace(next);
      return;
    }
    const next = new URLSearchParams(window.location.search).get('next') || 'historical.html';
    window.location.replace(`${next}?auth=login&next=${encodeURIComponent(next)}`);
    return;
  }

  if (page === 'signup') {
    if (A?.isLoggedIn?.()) {
      window.location.replace('historical.html');
      return;
    }
    window.location.replace('historical.html?auth=signup');
    return;
  }

  if (page === 'admin') {
    try {
      const s = JSON.parse(sessionStorage.getItem('agriprice_admin_session') || 'null');
      if (s?.token && (!s.expiresAt || Date.now() < s.expiresAt)) {
        window.location.replace('../admin/index.html');
        return;
      }
    } catch { /* continue */ }
    // On admin login page without active token, stay on page.
    // Previous redirect used a relative URL that could resolve to /admin/landpage.html.
    return;
  }
});
