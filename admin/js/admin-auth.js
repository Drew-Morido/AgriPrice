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

  async function validateSession() {
    const sess = getStoredSession();
    if (!sess?.token) return false;
    if (sess.expiresAt && Date.now() > sess.expiresAt) {
      clearSession();
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
        return true;
      }
      // Only hard-fail for explicit auth failure; do not logout on transient server issues.
      if (res.status === 401 || res.status === 403) {
        clearSession();
        return false;
      }
      consecutiveSessionFailures += 1;
      return consecutiveSessionFailures < 3;
    } catch {
      // Network/backend hiccup during training should not immediately force logout.
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
