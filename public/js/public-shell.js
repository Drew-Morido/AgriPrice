/* AgriPricePH — Single public navbar (one source of truth for all public pages) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.PublicShell = (function () {
  const NAV_HOST_ID = 'public-navbar-host';

  /* Same leaf logo as admin UI (admin/index.html sidebar) */
  const BRAND_LOGO_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/>
    <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>
  </svg>`;

  // Primary nav — Settings/Profile are intentionally NOT here (they live in the topbar icon pair
  // for logged-in users, see public-btn-profile/public-btn-settings below). Keeping them out of
  // NAV_ITEMS is what makes them consistently absent from the primary links on every page.
  const NAV_ITEMS = [
    { id: 'home', href: 'landpage.html', label: 'Home' },
    { id: 'current', href: 'current-prices.html', label: 'Price Forecast' },
    { id: 'catalog', href: 'rice-catalog.html', label: 'Rice Catalog' },
    { id: 'historical', href: 'historical.html', label: 'Price History' },
    { id: 'statistics', href: 'statistics.html', label: 'Charts & Stats' },
  ];

  const CONTACT_EMAIL = 'agripriceph@gmail.com';

  // Where every number on the site comes from (same order as Admin → Data Sources). DA is the price source.
  const SOURCES = [
    { logo: 'da.png', name: 'Department of Agriculture', what: 'Daily retail rice prices (DA-AMAS bulletin)',
      href: 'https://www.da.gov.ph/price-monitoring/', primary: true },
    { logo: 'doe.png', name: 'Department of Energy', what: 'Weekly NCR fuel prices',
      href: 'https://doe.gov.ph/retail-pump-prices-metro-manila' },
    { logo: 'psa.png', name: 'Philippine Statistics Authority', what: 'Rice stocks, farmgate price, core inflation',
      href: 'https://openstat.psa.gov.ph' },
    { logo: 'worldbank.png', name: 'World Bank', what: 'World rice price (Pink Sheet)',
      href: 'https://www.worldbank.org/en/research/commodity-markets' },
    { icon: true, name: 'ExchangeRate-API', what: 'Daily USD/PHP exchange rate',
      href: 'https://www.exchangerate-api.com' },
  ];

  const FX_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/></svg>`;

  function assetBase() {
    return isAdminPath() ? '../public/' : '';
  }

  /** The one public footer: links, contact and "last updated". The data sources sit just above it (buildSources). */
  function buildFooter() {
    const pub = assetBase();
    return `
      <footer class="site-footer" id="public-site-footer">
        <div class="footer-inner">
          <div class="footer-brand-col">
            <a href="${pub}landpage.html" class="footer-logo" aria-label="AgriPricePH home">
              <span class="footer-logo-icon">${BRAND_LOGO_SVG}</span>
              <span class="footer-name">AgriPricePH</span>
            </a>
            <p class="footer-tagline">Retail rice prices in Metro Manila from official sources, with a 3-day forecast, for Filipino vendors and households.</p>
            <div class="footer-updated" id="footer-updated" aria-live="polite">
              <span class="dot" aria-hidden="true"></span><span>Checking the latest DA data…</span>
            </div>
          </div>
          <nav class="footer-col" aria-label="Explore">
            <h3>Explore</h3>
            <ul>
              ${NAV_ITEMS.filter((i) => i.id !== 'home').map((i) => `<li><a href="${pub}${i.href}">${i.label}</a></li>`).join('')}
            </ul>
          </nav>
          <nav class="footer-col" aria-label="Help">
            <h3>Help</h3>
            <ul>
              <li><a href="${pub}landpage.html#faq">FAQs</a></li>
              <li><a href="${pub}landpage.html#contact">Contact</a></li>
              <li><a href="${pub}login.html">Log in</a></li>
              <li><a href="${pub}signup.html">Sign up free</a></li>
            </ul>
          </nav>
          <div class="footer-col">
            <h3>Contact</h3>
            <p class="footer-source-copy">
              <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a><br />
              <a href="https://www.da.gov.ph/contact-us/" target="_blank" rel="noopener noreferrer">DA Contact Us</a><br />
              Philippines · Filipino or English
            </p>
          </div>
        </div>
        <div class="footer-bottom">
          <p>© ${new Date().getFullYear()} AgriPricePH · Retail price = the prevailing price per kilo consumers pay in Metro Manila markets, as monitored by DA.</p>
          <p>A student capstone project. Logos belong to their agencies; AgriPricePH is not affiliated with or endorsed by them.</p>
        </div>
      </footer>`;
  }

  /** "Where the data comes from": its own section just above the footer, on every public page. */
  function buildSources() {
    const pub = assetBase();
    const chips = SOURCES.map((src) => {
      const logo = src.icon
        ? `<span class="source-logo source-logo--icon">${FX_ICON}</span>`
        : `<img class="source-logo" src="${pub}assets/img/sources/${src.logo}" alt="" width="46" height="46" loading="lazy">`;
      return `<a class="source-chip${src.primary ? ' is-primary' : ''}" href="${src.href}" target="_blank" rel="noopener noreferrer"
          title="${src.name}: ${src.what}">
          ${logo}
          <span class="source-text"><b>${src.name}</b><span>${src.what}</span></span>
        </a>`;
    }).join('');

    return `
      <section class="site-sources" id="public-site-sources" aria-labelledby="site-sources-title">
        <div class="site-sources-inner">
          <div class="site-sources-head">
            <h2 id="site-sources-title">Where the data comes from</h2>
            <p>Collected automatically from these official sources every day.</p>
          </div>
          <div class="footer-price-source">
            <p><b>Rice prices:</b> DA-AMAS Daily Price Index, National Capital Region: the prevailing retail price,
              averaged across the <span id="footer-market-count">covered NCR wet markets</span>
              <span id="footer-market-date"></span>.
              Earlier history: PSA OpenSTAT NCR monthly average (Jan 2015 – Sep 2018) and DA price bulletins
              (Oct 2018 – Feb 2025).</p>
            <details class="footer-markets" id="footer-markets" hidden>
              <summary>See the markets</summary>
              <ol id="footer-market-list"></ol>
            </details>
          </div>
          <div class="source-grid">${chips}</div>
                </div>
      </section>`;
  }

  function longDate(iso) {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  /** DA's covered markets, as printed at the end of the newest Daily Price Index (tools/da_markets.py). */
  function renderMarkets(markets, bulletinDate) {
    if (!Array.isArray(markets) || !markets.length) return;
    const count = document.getElementById('footer-market-count');
    const when = document.getElementById('footer-market-date');
    const list = document.getElementById('footer-market-list');
    const box = document.getElementById('footer-markets');
    if (count) count.textContent = `${markets.length} covered NCR wet markets`;
    if (when && bulletinDate) when.textContent = `(list from the bulletin of ${longDate(bulletinDate)})`;
    if (list) {
      list.innerHTML = '';
      markets.forEach((name) => {
        const li = document.createElement('li');
        li.textContent = name;
        list.appendChild(li);
      });
    }
    if (box) box.hidden = false;
  }

  // One /api/site-status call per page, shared by the footer and the "DA prices as of" stamps.
  let _statusPromise = null;
  function siteStatus() {
    if (!_statusPromise) {
      _statusPromise = Promise.resolve(AgriPricePH.API?.siteStatus?.()).catch(() => null);
    }
    return _statusPromise;
  }

  function shortDay(iso) {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /** Fill every [data-da-stamp] with the newest DA bulletin day the page's prices come from (DA-AMAS
   *  feedback: show when the rice price was last updated from the DA, next to the prices). */
  async function renderDaStamps(root) {
    const els = (root || document).querySelectorAll('[data-da-stamp]');
    if (!els.length) return;
    const st = await siteStatus();
    const checked = st && st.last_checked ? new Date(st.last_checked) : null;
    const checkedTxt = checked && !isNaN(checked)
      ? `${checked.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${checked.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
      : '';
    els.forEach((el) => {
      el.classList.add('da-stamp');
      if (!st || !st.da_date) {
        el.classList.add('is-offline');
        el.innerHTML = '<span class="da-stamp-dot" aria-hidden="true"></span><span>DA price date unavailable (server offline)</span>';
        return;
      }
      el.classList.remove('is-offline');
      el.title = 'The newest Department of Agriculture (DA-AMAS) daily price bulletin in AgriPricePH. '
        + 'The system checks DA for a new bulletin every few hours during the day.'
        + (checkedTxt ? ` Last check: ${checkedTxt}.` : '');
      el.innerHTML = `<span class="da-stamp-dot" aria-hidden="true"></span>`
        + `<span>DA prices updated: <b>${shortDay(st.da_date)}</b>${checkedTxt ? `<span class="da-stamp-sep"> · </span>checked ${checkedTxt}` : ''}</span>`;
    });
  }

  async function loadFooterStatus() {
    renderDaStamps();
    const box = document.getElementById('footer-updated');
    if (!box) return;
    try {
      const st = await siteStatus();
      if (!st || !st.da_date) throw new Error('no date');
      const checked = st.last_checked ? new Date(st.last_checked) : null;
      const when = checked && !isNaN(checked)
        ? ` · sources checked ${checked.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${checked.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
        : '';
      renderMarkets(st.markets, st.markets_bulletin_date);
      box.classList.remove('is-offline');
      box.innerHTML = `<span class="dot" aria-hidden="true"></span><span>Last updated: DA prices of <b>${longDate(st.da_date)}</b>${when}</span>`;
    } catch {
      box.classList.add('is-offline');
      box.innerHTML = '<span class="dot" aria-hidden="true"></span><span>Last updated: unavailable (server offline)</span>';
    }
  }

  function injectFooter() {
    if (document.getElementById('public-site-footer')) return;
    document.querySelectorAll('footer.site-footer').forEach((el) => el.remove());   // old static copies
    const wrap = document.createElement('div');
    // "Where the data comes from" (sources, markets) sits above the footer on the home page only.
    const parts = (getActivePage() === 'home' ? buildSources() : '') + buildFooter();
    wrap.innerHTML = parts.trim();
    const nodes = [...wrap.children];
    const app = document.getElementById('public-app');
    if (app) app.after(...nodes);
    else document.body.append(...nodes);
    loadFooterStatus();
  }

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
              <a href="profile.html" class="lp-nav-profile" id="public-btn-profile" title="Profile" aria-label="Profile"
                 style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;border:1px solid var(--lp-border-md,#cfe0d4);background:var(--lp-green-50,#e8f3ec);color:var(--lp-green-600,#2d6a4f);text-decoration:none;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>
              </a>
              <a href="settings.html" class="lp-nav-burger" id="public-btn-settings" title="Settings" aria-label="Settings"
                 style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;border:1px solid var(--lp-border-md,#cfe0d4);background:var(--lp-bg,#fff);color:var(--lp-text-primary,#1f3d2c);text-decoration:none;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </a>
            </div>
            <button type="button" class="lp-nav-btn lp-nav-btn--ghost" id="public-btn-login">Log in</button>
            <button type="button" class="lp-nav-btn lp-nav-btn--primary" id="public-btn-signup">Sign up free →</button>
            <button type="button" class="lp-nav-mobile-toggle" id="public-btn-mobile" aria-label="Open menu" aria-expanded="false" aria-controls="public-mobile-menu">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="lp-nav-mobile-panel" id="public-mobile-menu" hidden>
          <ul class="lp-nav-mobile-links">
            ${NAV_ITEMS.map((item) => `<li><a href="${item.href}" class="${item.id === active ? 'active' : ''}">${item.label}</a></li>`).join('')}
          </ul>
          <div class="lp-nav-mobile-auth" id="public-mobile-auth"></div>
        </div>
      </nav>
    `;
  }

  /* Phones (≤640px) hide the inline links and the Log in / Sign up buttons for space, which left
     guests with no way to change page or sign in. This menu is the phone replacement: every page
     link, plus Log in / Sign up for guests or Settings for a signed-in retailer. */
  function bindMobileMenu() {
    const btn = document.getElementById('public-btn-mobile');
    const panel = document.getElementById('public-mobile-menu');
    if (!btn || !panel || btn.dataset.bound) return;
    btn.dataset.bound = '1';

    const renderAuth = () => {
      const box = document.getElementById('public-mobile-auth');
      if (!box) return;
      const auth = AgriPricePH.PublicAuth;
      if (auth?.isLoggedIn?.()) {
        const name = auth.getSession?.()?.name || 'My account';
        box.innerHTML = `
          <div class="lp-nav-mobile-user">Signed in as <b></b></div>
          <a href="profile.html" class="lp-nav-mobile-btn">Profile</a>
          <a href="settings.html" class="lp-nav-mobile-btn">Settings</a>`;
        box.querySelector('b').textContent = name;
      } else {
        box.innerHTML = `
          <a href="login.html" class="lp-nav-mobile-btn">Log in</a>
          <a href="signup.html" class="lp-nav-mobile-btn primary">Sign up free</a>`;
      }
    };
    const close = () => {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Open menu');
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.hidden) {
        renderAuth();
        panel.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        btn.setAttribute('aria-label', 'Close menu');
      } else {
        close();
      }
    });
    panel.addEventListener('click', (e) => { if (!e.target.closest('a')) e.stopPropagation(); });
    document.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    window.addEventListener('resize', () => { if (window.innerWidth > 640) close(); });
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
    bindMobileMenu();
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
      injectFooter();
      return;
    }

    if (getActivePage() === 'home' || document.body.dataset.publicNav === 'true') {
      injectNavbar('home');
      injectFooter();
    }
  }

  return {
    init,
    injectNavbar,
    buildNavbar,
    buildFooter,
    buildSources,
    injectFooter,
    renderDaStamps,
    homeHref,
    NAV_ITEMS,
  };
})();

document.addEventListener('DOMContentLoaded', () => {
  AgriPricePH.PublicShell.init();
});
