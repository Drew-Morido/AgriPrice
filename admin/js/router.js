window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Router = (function () {

  const routes = {
    'dashboard':    { title: 'Dashboard Overview',       module: 'Dashboard' },
    'predictions':  { title: 'Price Forecast',           module: 'Predictions' },
    'data-sources': { title: 'Data Sources',             module: 'DataSources' },
    'historical':   { title: 'Price History',            module: 'HistoricalData' },
    'web-scraper':  { title: 'Web Scraper',              module: 'WebScraper' },
    'lstm-model':   { title: 'LSTM Model',               module: 'LSTMModel' },
    'training':     { title: 'Model Training',           module: 'Training' },
    'metrics':      { title: 'Performance Metrics',      module: 'Metrics' },
    'correlation':  { title: 'Correlation Analysis',     module: 'Correlation' },
    'reports':      { title: 'Reports & Export',         module: 'Reports' },
    'taxes':        { title: 'Taxes & Import Charges',     module: 'Taxes' },
    'alerts':       { title: 'Price Alerts',             module: 'Alerts' },
    'settings':     { title: 'System Settings',          module: 'Settings' },
    'logs':         { title: 'System Logs',              module: 'SystemLogs' },
  };

  const pageCache  = {};
  let currentRoute = null;
  const contentEl  = document.getElementById('page-outlet');

  async function loadPage(routeKey) {
    if (pageCache[routeKey]) return pageCache[routeKey];
    const res = await fetch(`./pages/${routeKey}.html`);
    if (!res.ok) throw new Error(`Failed to load page: ${routeKey}`);
    const html = await res.text();
    pageCache[routeKey] = html;
    return html;
  }

  async function navigate(routeKey) {
    const route = routes[routeKey];
    if (!route) return;

    if (currentRoute === 'training' && routeKey !== currentRoute) {
      const train = AgriPricePH.Training;
      if (train?.isActive?.()) {
        const ok = await train.confirmLeave?.();
        if (!ok) return;
        const stopped = await train.cancelTraining?.();
        if (!stopped || train.isActive?.()) return;
      }
    }

    // ── KEY FIX ──────────────────────────────────────────────────────────────
    // Kung same route na ang naka-mount, HUWAG i-destroy ang DOM.
    // Ito ang nagpapatigil ng glitch sa Web Scraper:
    //   - Activity Log ay hindi nababura
    //   - SSE connection ay hindi nasisira
    //   - Run Now button ay hindi nire-reinit
    if (routeKey === currentRoute) {
      const ctx = AgriPricePH.Navigation?.consumeContext?.(routeKey);
      if (ctx) {
        const sameMod = AgriPricePH[routes[routeKey]?.module];
        if (sameMod?.applySearchContext) {
          requestAnimationFrame(() => sameMod.applySearchContext(ctx));
        }
      }
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Notify current module na aalis na tayo (para makapag-cleanup kung kailangan)
    if (currentRoute) {
      const prevMod = AgriPricePH[routes[currentRoute]?.module];
      if (prevMod && typeof prevMod.destroy === 'function') {
        prevMod.destroy();
      }
    }

    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.route === routeKey);
    });

    const titleEl = document.querySelector('.topbar-title');
    if (titleEl) titleEl.textContent = route.title;

    contentEl.classList.add('page-transitioning');

    try {
      const html = await loadPage(routeKey);
      contentEl.innerHTML = html;
    } catch (e) {
      contentEl.innerHTML = `<div style="padding:40px;color:var(--text-muted);">Page not found: ${routeKey}</div>`;
    }

    contentEl.classList.remove('page-transitioning');
    contentEl.scrollTop = 0;

    // Update route BEFORE calling init so the guard in WebScraper.init() works
    currentRoute = routeKey;
    window.location.hash = routeKey;

    const mod = AgriPricePH[route.module];
    const navCtx = AgriPricePH.Navigation?.consumeContext?.(routeKey);
    if (mod && typeof mod.init === 'function') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          mod.init();
          if (navCtx && typeof mod.applySearchContext === 'function') {
            requestAnimationFrame(() => mod.applySearchContext(navCtx));
          }
        });
      });
    } else if (navCtx && mod?.applySearchContext) {
      mod.applySearchContext(navCtx);
    }
  }

  function init() {
    const sidebar = document.querySelector('.sidebar');
    const burger = document.getElementById('admin-burger');
    const closeSidebar = () => {
      sidebar?.classList.remove('open');
      burger?.setAttribute('aria-expanded', 'false');
    };
    if (burger && sidebar) {
      burger.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = sidebar.classList.toggle('open');
        burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.addEventListener('click', (e) => {
        if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && !burger.contains(e.target)) {
          closeSidebar();
        }
      });
    }

    document.querySelectorAll('.nav-item[data-route]').forEach(el => {
      el.addEventListener('click', () => { navigate(el.dataset.route); closeSidebar(); });
    });

    const hash    = window.location.hash.replace('#', '');
    const initial = routes[hash] ? hash : 'dashboard';
    navigate(initial);

    window.addEventListener('hashchange', () => {
      const h = window.location.hash.replace('#', '');
      // ── KEY FIX ──────────────────────────────────────────────────────────
      // Huwag mag-navigate kapag same route pa rin.
      // Ang SSE stream sa Web Scraper ay nagse-set ng hash — huwag itong
      // ibibigyang-reaksyon ng router.
      if (routes[h] && h !== currentRoute) navigate(h);
      // ─────────────────────────────────────────────────────────────────────
    });
  }

  return { init, navigate };

})();