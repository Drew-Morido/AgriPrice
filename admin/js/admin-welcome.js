/* AgriPricePH — one-time welcome for a new admin account (created in User Management).
   Asks /api/admin/me whether this account has seen it; marks it seen on close, so it shows once
   per account (stored server-side, not in the browser). The built-in admin never sees it. */
(function () {
  const ROLE_TILES = {
    admin: [
      { icon: 'trend', title: 'Dashboard & forecasts', text: 'Today’s prices, the 3-day forecast, and how accurate it has been.' },
      { icon: 'refresh', title: 'Keep the data fresh', text: 'Run the web scraper and check Data Sources and Price History.' },
      { icon: 'bell', title: 'Alerts & reports', text: 'Set price alerts and export reports for your team.' },
    ],
    super_admin: [
      { icon: 'shield', title: 'Everything an Admin can do', text: 'Dashboards, forecasts, scraper runs, alerts and reports.' },
      { icon: 'users', title: 'User Management', text: 'Add admins and manage public user accounts.' },
      { icon: 'gear', title: 'Settings & training', text: 'Configure the system and retrain the forecasting model.' },
    ],
  };

  function token() {
    try { return JSON.parse(sessionStorage.getItem('agriprice_admin_session') || 'null')?.token || ''; } catch { return ''; }
  }

  async function maybeWelcome() {
    const role = AgriPricePH.AdminRole;
    if (!role || !AgriPricePH.WelcomeModal) return;
    const me = await role.ready();
    if (!me || me.kind !== 'account') return;
    let data;
    try {
      data = await AgriPricePH.API.get('/api/admin/me', { noCache: true });
    } catch { return; }
    if (!data?.show_welcome) return;
    const admin = data.admin || me;
    const first = String(admin.name || '').trim().split(/\s+/)[0] || admin.username;
    const isSuper = admin.role === 'super_admin';
    const markSeen = () => fetch(`${AgriPricePH.API.BASE}/api/admin/me/welcome-seen`, {
      method: 'POST', headers: { Authorization: `Bearer ${token()}` },
    }).catch(() => {});

    await AgriPricePH.WelcomeModal.show({
      name: admin.name,
      avatar: admin.avatar,
      eyebrow: isSuper ? 'Super Admin · first sign-in' : 'Admin · first sign-in',
      title: `Welcome aboard, ${first}!`,
      text: `Your ${isSuper ? 'Super Admin' : 'Admin'} account for AgriPricePH is ready. Here’s where to start.`,
      tiles: ROLE_TILES[isSuper ? 'super_admin' : 'admin'],
      secondary: admin.avatar ? null : { label: 'Add my photo', onClick: () => AgriPricePH.Router?.navigate?.('account') },
      primary: { label: 'Go to Dashboard', onClick: () => AgriPricePH.Router?.navigate?.('dashboard') },
    });
    markSeen();
  }

  document.addEventListener('DOMContentLoaded', () => { setTimeout(maybeWelcome, 600); });
})();
