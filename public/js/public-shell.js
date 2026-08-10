/* AgriPricePH — Single public navbar (one source of truth for all public pages) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.PublicShell = (function () {
  const NAV_HOST_ID = 'public-navbar-host';

  /* Same leaf logo as admin UI (admin/index.html sidebar) */
  const BRAND_LOGO_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/>
    <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>
  </svg>`;

  const NAV_ITEMS = [
    { id: 'current', href: 'current-prices.html', label: 'Price Forecast' },
    { id: 'catalog', href: 'rice-catalog.html', label: 'Rice Catalog' },
    { id: 'historical', href: 'historical.html', label: 'Price History' },
    { id: 'statistics', href: 'statistics.html', label: 'Charts & Stats' },
    { id: 'settings', href: 'settings.html', label: 'Settings' },
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
            <div class="lp-nav-user" id="public-topbar-user" hidden>
              <span class="lp-nav-user-name" id="public-user-name">Guest</span>
            </div>
            <button type="button" class="lp-nav-btn lp-nav-btn--ghost" id="public-btn-login">Log in</button>
            <button type="button" class="lp-nav-btn lp-nav-btn--primary" id="public-btn-signup">Sign up free →</button>
            <button type="button" class="lp-nav-btn lp-nav-btn--ghost" id="public-btn-logout" hidden>Log out</button>
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
