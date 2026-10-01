/* AgriPricePH — Admin session guard (server-validated token) */
(function () {
  const STORAGE_KEY = 'agriprice_admin_session';
  let consecutiveSessionFailures = 0;

  function getStoredSession() {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function clearSession() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  function getToken() {
    return getStoredSession()?.token || '';
  }

  function confirmLogoutModal() {
    // Shared on-theme confirm dialog (admin/js/ui-modals.js) — matches light/dark theme
    // instead of the fixed white panel this used to hardcode.
    return AgriPricePH.Modals.confirm({
      title: 'Log out admin session?',
      text: 'You will be signed out and redirected to the public landpage.',
      type: 'warning',
      okText: 'Yes, log out',
      cancelText: 'Cancel',
    });
  }

  // ── Role (Super Admin vs Admin) ──────────────────────────────────────────
  // The server is the authority (api/app.py::_require_super_admin / _um_guard); this only shapes the
  // UI. <html data-admin-role> drives CSS: `.super-only` stays hidden until the server confirms a
  // Super Admin, so a plain Admin never sees the User Management link flash in.
  let _resolveRole;
  const _roleReady = new Promise((resolve) => { _resolveRole = resolve; });
  let _identity = null;

  function applyRole(identity) {
    _identity = identity || null;
    const role = identity?.role || '';
    if (role) document.documentElement.dataset.adminRole = role;
    else delete document.documentElement.dataset.adminRole;
  }

  window.AgriPricePH = window.AgriPricePH || {};
  AgriPricePH.AdminRole = {
    /** Resolves with the signed-in identity ({ role, username, name, ... }) or null. */
    ready: (ms = 4000) => Promise.race([_roleReady, new Promise((r) => setTimeout(() => r(_identity), ms))]),
    identity: () => _identity,
    isSuper: () => _identity?.role === 'super_admin',
    /** Standard "view only" note for pages a plain Admin can read but not change. */
    viewOnlyNotice(what) {
      return `<div class="role-viewonly" role="note">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span><b>View only.</b> ${what} Only a <b>Super Admin</b> can make changes here.</span>
      </div>`;
    },
  };

  // Paint the last known role at once (no flicker on reload); the server check below confirms it.
  applyRole(getStoredSession()?.admin || null);

  async function validateSession() {
    const sess = getStoredSession();
    if (!sess?.token) { _resolveRole(null); return false; }
    if (sess.expiresAt && Date.now() > sess.expiresAt) {
      clearSession();
      _resolveRole(null);
      return false;
    }
    try {
      const res = await fetch(`${AgriPricePH.API.BASE}/api/admin/session`, {
        headers: { Authorization: `Bearer ${sess.token}` },
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.valid) {
        consecutiveSessionFailures = 0;
        const prevRole = _identity?.role;
        applyRole(data.admin);
        try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...sess, admin: data.admin })); } catch { /* ignore */ }
        _resolveRole(data.admin);
        // A Super Admin demoted mid-session: leave the page they can no longer use.
        if (prevRole && prevRole !== data.admin?.role) document.dispatchEvent(new CustomEvent('agriprice:role-changed'));
        return true;
      }
      // Only hard-fail for explicit auth failure; do not logout on transient server issues.
      if (res.status === 401 || res.status === 403) {
        clearSession();
        _resolveRole(null);
        return false;
      }
      _resolveRole(_identity); // backend hiccup: keep the last known role
      consecutiveSessionFailures += 1;
      return consecutiveSessionFailures < 3;
    } catch {
      // Network/backend hiccup during training should not immediately force logout.
      _resolveRole(_identity);
      consecutiveSessionFailures += 1;
      return consecutiveSessionFailures < 3;
    }
  }

  async function enforceSessionOrRedirect() {
    const ok = await validateSession();
    if (ok) return true;
    clearSession();
    return false;
  }

  async function logout() {
    const confirmed = await confirmLogoutModal();
    if (!confirmed) return;
    const token = getToken();
    try {
      if (token) {
        await fetch(`${AgriPricePH.API.BASE}/api/admin/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch { /* ignore */ }
    clearSession();
    window.location.href = '../public/landpage.html';
  }

  // Admin sign-in now happens through the same unified login modal as retailer accounts
  // (public/js/public-auth-modal.js — the login form auto-detects admin credentials and, on a
  // correct username/password, follows up with the 6-digit access code prompt before redirecting
  // back into admin/index.html). The old standalone admin/login.html page has been retired, so an
  // unauthenticated visit here bounces out to the real public login page.
  const PUBLIC_LOGIN_URL = '../public/login.html';

  document.addEventListener('DOMContentLoaded', async () => {
    const ok = await enforceSessionOrRedirect();
    if (!ok) {
      window.location.replace(PUBLIC_LOGIN_URL);
      return;
    }
    document.getElementById('admin-logout-btn')?.addEventListener('click', logout);

    setInterval(async () => {
      if (!(await enforceSessionOrRedirect())) {
        window.location.replace(PUBLIC_LOGIN_URL);
      }
    }, 5 * 60 * 1000);
  });
})();
