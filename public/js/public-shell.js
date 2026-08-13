/* AgriPricePH — Single public navbar (one source of truth for all public pages) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.PublicShell = (function () {
  const NAV_HOST_ID = 'public-navbar-host';

  /* Same leaf logo as admin UI (admin/index.html sidebar) */
  const BRAND_LOGO_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/>
    <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>
  </svg>`;

  // Primary nav — Settings is intentionally NOT here (it lives in the burger menu for logged-in
  // users). Keeping it out of NAV_ITEMS is what makes it consistently absent on every page.
  const NAV_ITEMS = [
    { id: 'current', href: 'current-prices.html', label: 'Price Forecast' },
    { id: 'catalog', href: 'rice-catalog.html', label: 'Rice Catalog' },
    { id: 'historical', href: 'historical.html', label: 'Price History' },
    { id: 'statistics', href: 'statistics.html', label: 'Charts & Stats' },
  ];

  function isAdminPath() {
    return (window.location.pathname || '').replace(/\\/g, '/').includes('/admin/');
  }

  function homeHref() {
    return isAdminPath() ? '../public/landpage.html' : 'landpage.html';
  }

  function getActivePage() {
    return document.body.dataset.page || '';
  }

  /** Only place that defines public navbar markup */
  function buildNavbar(active) {
    const links = NAV_ITEMS.map((item) => {
      const cls = item.id === active ? 'active' : '';
      return `<li><a href="${item.href}" class="${cls}">${item.label}</a></li>`;
    }).join('');

    return `
      <nav class="lp-site-nav" aria-label="Main navigation">
        <div class="nav-inner">
          <a href="${homeHref()}" class="brand" aria-label="AgriPricePH home">
            <div class="brand-icon logo-icon">${BRAND_LOGO_SVG}</div>
            <span class="brand-name">AgriPricePH</span>
          </a>
          <ul class="nav-links">
            ${links}
          </ul>
          <div class="nav-actions" id="public-auth-buttons">
            <div class="lp-nav-user" id="public-topbar-user" hidden style="display:flex;align-items:center;gap:10px;position:relative;">
              <span class="lp-nav-user-name" id="public-user-name">Guest</span>
              <a href="settings.html#account" class="lp-nav-profile" id="public-btn-profile" title="Account settings" aria-label="Account settings"
                 style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;border:1px solid var(--border-color,#cfe0d4);background:var(--accent-soft,#e8f3ec);color:var(--accent,#2d6a4f);text-decoration:none;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>
              </a>
              <button type="button" class="lp-nav-burger" id="public-btn-burger" aria-label="Menu" aria-haspopup="true" aria-expanded="false"
                 style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;border:1px solid var(--border-color,#cfe0d4);background:var(--card-bg,#fff);color:var(--text-primary,#1f3d2c);cursor:pointer;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
              </button>
              <div class="lp-nav-menu" id="public-nav-menu" hidden
                 style="position:absolute;top:44px;right:0;min-width:170px;background:var(--card-bg,#fff);border:1px solid var(--border-color,#cfe0d4);border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,0.14);padding:6px;z-index:60;">
                <a href="settings.html" id="public-menu-settings" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:7px;text-decoration:none;color:var(--text-primary,#1f3d2c);font-size:13px;">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                  Settings
                </a>
              </div>
            </div>
            <button type="button" class="lp-nav-btn lp-nav-btn--ghost" id="public-btn-login">Log in</button>
            <button type="button" class="lp-nav-btn lp-nav-btn--primary" id="public-btn-signup">Sign up free →</button>
          </div>
        </div>
      </nav>
    `;
  }

  /** Inject or refresh the one shared navbar at the top of the page */
  function injectNavbar(active) {
    const page = active ?? getActivePage();
    let host = document.getElementById(NAV_HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = NAV_HOST_ID;
      document.body.insertBefore(host, document.body.firstChild);
    }
    host.innerHTML = buildNavbar(page);
    document.documentElement.classList.add('public-site');
    document.body.classList.add('has-public-nav');
    AgriPricePH.PublicAuth?.updateTopbarUser?.();
  }

  function mountModuleLayout() {
    const content = document.getElementById('public-page-content');
    if (!content) return;

    injectNavbar(getActivePage());

    if (document.getElementById('public-app')) return;

    const app = document.createElement('div');
    app.id = 'public-app';
    app.innerHTML = '<div class="main-content public-module-main"></div>';
    const main = app.querySelector('.main-content');
    content.classList.add('active');
    main.appendChild(content);

    const host = document.getElementById(NAV_HOST_ID);
    if (host) host.after(app);
    else document.body.appendChild(app);

    document.body.classList.add('public-body');
  }

  function mountAuthLayout() {
    document.body.classList.add('public-auth-body');
    injectNavbar(getActivePage());
  }

  function init() {
    if (document.body.dataset.shell === 'off') return;

    const layout = document.body.dataset.layout;
    if (layout === 'auth') {
      mountAuthLayout();
      return;
    }

    if (document.getElementById('public-page-content')) {
      mountModuleLayout();
      return;
    }

    if (getActivePage() === 'home' || document.body.dataset.publicNav === 'true') {
      injectNavbar('home');
    }
  }

  return {
    init,
    injectNavbar,
    buildNavbar,
    homeHref,
    NAV_ITEMS,
  };
})();

document.addEventListener('DOMContentLoaded', () => {
  AgriPricePH.PublicShell.init();
});
