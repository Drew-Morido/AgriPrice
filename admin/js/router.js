window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Router = (function () {

  const routes = {
    'dashboard':    { title: 'Dashboard Overview',       module: 'Dashboard' },
    'predictions':  { title: 'Price Forecast',           module: 'Predictions' },
    'data-sources': { title: 'Data Sources',             module: 'DataSources' },
    'historical':   { title: 'Price History',            module: 'HistoricalData' },
    'web-scraper':  { title: 'Web Scraper',              module: 'WebScraper' },
    'model-dashboard': { title: 'Model Dashboard',       module: 'ModelDashboard' },
    'forecast-compare': { title: 'Forecast vs Actual',    module: 'ForecastCompare' },
    'training':     { title: 'Model Training',           module: 'Training' },
    'correlation':  { title: 'Market Drivers',           module: 'Correlation' },
    'reports':      { title: 'Reports & Export',         module: 'Reports' },
    'taxes':        { title: 'Taxes & Import Charges',     module: 'Taxes' },
    'rice-brands':  { title: 'Rice Brands',               module: 'RiceBrands' },
    'alerts':       { title: 'Price Alerts',             module: 'Alerts' },
    'users':        { title: 'User Management',          module: 'UserManagement', superOnly: true },
    'settings':     { title: 'System Settings',          module: 'Settings' },
    'logs':         { title: 'System Logs',              module: 'SystemLogs' },
    'account':      { title: 'Account Profile',          module: 'AccountProfile' },
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

  // Super-Admin-only modules: a plain Admin is sent to the Dashboard (the server refuses the API
  // calls too — this is only so they never land on a page that can't load).
  async function allowed(routeKey) {
    if (!routes[routeKey]?.superOnly) return true;
    const role = AgriPricePH.AdminRole;
    if (!role) return true;
    await role.ready();
    return role.isSuper();
  }

  async function navigate(routeKey) {
    const route = routes[routeKey];
    if (!route) return;

    if (!(await allowed(routeKey))) {
      AgriPricePH.Modals?.alert?.({
        title: 'Super Admin only',
        text: `${route.title} is available to Super Admin accounts only.`,
        type: 'info',
      });
      if (currentRoute) { window.location.hash = currentRoute; return; }
      routeKey = 'dashboard';
      return navigate(routeKey);
    }

    // Leaving Training mid-run cancels it — only for a Super Admin, the role that can start or stop
    // training. A plain Admin is just watching, so leaving must not stop someone else's run.
    if (currentRoute === 'training' && routeKey !== currentRoute && (!AgriPricePH.AdminRole || AgriPricePH.AdminRole.isSuper())) {
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
      // Let the injected DOM settle before init (two frames), but NEVER depend on rAF alone:
      // rAF callbacks don't fire while the tab is hidden/background, which previously left the
      // page mounted but never initialised — showing only the static placeholder markup.
      // Whichever of rAF / timeout wins first runs init exactly once.
      let started = false;
      const runInit = () => {
        if (started) return;
        started = true;
        mod.init();
        if (navCtx && typeof mod.applySearchContext === 'function') {
          mod.applySearchContext(navCtx);
        }
      };
      requestAnimationFrame(() => requestAnimationFrame(runInit));
      setTimeout(runInit, 120);
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

    // Role demoted mid-session (another Super Admin changed it): leave a page this role can't use.
    // A reload re-renders every page (and the sidebar) for the new role in one step.
    document.addEventListener('agriprice:role-changed', () => {
      if (routes[currentRoute]?.superOnly && !AgriPricePH.AdminRole?.isSuper?.()) window.location.hash = 'dashboard';
      window.location.reload();
    });

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