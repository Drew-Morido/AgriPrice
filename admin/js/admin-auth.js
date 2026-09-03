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
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');
      backdrop.setAttribute('aria-label', 'Confirm logout');
      backdrop.style.cssText = [
        'position:fixed',
        'inset:0',
        'background:rgba(3,10,6,0.66)',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'z-index:9999',
        'padding:18px',
      ].join(';');

      const panel = document.createElement('div');
      panel.style.cssText = [
        'width:min(430px,96vw)',
        'background:#fff',
        'border-radius:14px',
        'padding:20px',
        'box-shadow:0 18px 48px rgba(0,0,0,0.35)',
        'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      ].join(';');
      panel.innerHTML = `
        <h3 style="margin:0 0 8px;font-size:18px;color:#143624">Log out admin session?</h3>
        <p style="margin:0 0 16px;font-size:13px;color:#365846;line-height:1.45">
          You will be signed out and redirected to the public landpage.
        </p>
        <div style="display:flex;justify-content:flex-end;gap:10px">
          <button type="button" data-action="cancel" style="border:1px solid #b9c8be;background:#fff;color:#1f3d2c;padding:8px 14px;border-radius:9px;cursor:pointer">Cancel</button>
          <button type="button" data-action="confirm" style="border:1px solid #1f6f4a;background:#2a8a5c;color:#fff;padding:8px 14px;border-radius:9px;cursor:pointer">Yes, log out</button>
        </div>
      `;
      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);

      function close(val) {
        backdrop.remove();
        resolve(val);
      }

      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(false);
      });
      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => close(false));
      panel.querySelector('[data-action="confirm"]')?.addEventListener('click', () => close(true));
      const onEsc = (e) => {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', onEsc);
          close(false);
        }
      };
      document.addEventListener('keydown', onEsc, { once: true });
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
  // unauthenticated visit here bounces out to the public site with that modal pre-opened.
  const PUBLIC_LOGIN_URL = '../public/landpage.html?auth=login';

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
