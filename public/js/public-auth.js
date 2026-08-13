/* AgriPricePH — Public site auth (retailers) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.PublicAuth = (function () {
  const STORAGE_USERS = 'agriprice_public_users';
  const STORAGE_SESSION = 'agriprice_public_session';
  const ADMIN_SESSION_KEY = 'agriprice_admin_session';

  function getUsers() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_USERS) || '[]');
    } catch {
      return [];
    }
  }

  function saveUsers(users) {
    localStorage.setItem(STORAGE_USERS, JSON.stringify(users));
  }

  /* Single public role. Legacy accounts (vendor/household/blank) are coerced to 'retailer' at
     read time so no existing browser-local account is locked out after the role simplification. */
  function normalizeRole() {
    return 'retailer';
  }

  function getSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(STORAGE_SESSION) || 'null');
      if (s && typeof s === 'object') s.role = normalizeRole(s.role);
      return s;
    } catch {
      return null;
    }
  }

  function setSession(user) {
    sessionStorage.setItem(STORAGE_SESSION, JSON.stringify(user));
  }

  function logout() {
    sessionStorage.removeItem(STORAGE_SESSION);
    const Alert = AgriPricePH.PublicAlert;
    if (Alert?.success) {
      Alert.success('You have been logged out.', {
        onConfirm: () => {
          window.location.href = 'landpage.html';
        },
      });
      return;
    }
    window.location.href = 'landpage.html';
  }

  function isLoggedIn() {
    const s = getSession();
    return !!(s && s.email && s.role === 'retailer');
  }

  function requireLogin() {
    return isLoggedIn();
  }

  async function verifyAdminPassword({ username, password }) {
    if (!username?.trim() || !password) {
      return { ok: false, message: 'Enter your username and password.' };
    }
    try {
      const res = await AgriPricePH.API.adminVerifyPassword(username.trim(), password);
      if (res.ok && res.data?.success) {
        return { ok: true };
      }
      const status = res.status;
      const msg = res.data?.error || 'Could not verify admin credentials.';
      if (status === 429) {
        return { ok: false, message: msg };
      }
      return { ok: false, message: msg };
    } catch {
      return {
        ok: false,
        message: 'Cannot reach the server. Start the backend (run_backend.bat) and try again.',
      };
    }
  }

  function signup({ name, email, password }) {
    if (!name || !email || !password) {
      return { ok: false, message: 'Please fill in all fields.' };
    }
    if (password.length < 6) {
      return { ok: false, message: 'Use a password with at least 6 characters.' };
    }
    const users = getUsers();
    if (users.some((u) => u.email === email.toLowerCase())) {
      return { ok: false, message: 'This email is already registered. Try logging in.' };
    }
    const role = normalizeRole();
    users.push({ name, email: email.toLowerCase(), password, role });
    saveUsers(users);
    setSession({ name, email: email.toLowerCase(), role });
    return { ok: true };
  }

  function login({ email, password }) {
    const user = getUsers().find((u) => u.email === email.toLowerCase() && u.password === password);
    if (!user) {
      return { ok: false, message: 'Email or password is incorrect.' };
    }
    setSession({ name: user.name, email: user.email, role: normalizeRole(user.role) });
    return { ok: true };
  }

  function saveAdminSession(token, expiresInSec) {
    const expiresAt = Date.now() + (expiresInSec || 3600) * 1000;
    sessionStorage.setItem(
      ADMIN_SESSION_KEY,
      JSON.stringify({ token, expiresAt })
    );
  }

  async function adminLogin({ username, password, accessCode }) {
    const code = String(accessCode || '').replace(/\D/g, '');
    if (!username?.trim() || !password) {
      return { ok: false, message: 'Enter your username and password.' };
    }
    if (code.length !== 6) {
      return { ok: false, message: 'Enter the full 6-digit access code.' };
    }

    try {
      const res = await AgriPricePH.API.adminVerify(username.trim(), password, code);
      if (res.ok && res.data?.success && res.data?.token) {
        saveAdminSession(res.data.token, res.data.expires_in);
        return { ok: true };
      }
      const status = res.status;
      const msg = res.data?.error || 'Could not sign in. Check your details.';
      if (status === 429) {
        return { ok: false, message: msg };
      }
      return { ok: false, message: msg };
    } catch {
      return {
        ok: false,
        message: 'Cannot reach the server. Start the backend (run_backend.bat) and try again.',
      };
    }
  }

  function initials(name) {
    return (name || 'U').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || 'U';
  }

  function setNavControl(el, show) {
    if (!el) return;
    if (show) {
      el.removeAttribute('hidden');
      el.classList.remove('lp-nav-hidden');
      el.style.removeProperty('display');
    } else {
      el.setAttribute('hidden', '');
      el.classList.add('lp-nav-hidden');
      el.style.display = 'none';
    }
  }

  function updateTopbarUser() {
    const session = getSession();
    const loggedIn = isLoggedIn();
    const avatar = document.getElementById('public-user-avatar');
    const nameEl = document.getElementById('public-user-name');
    const roleEl = document.getElementById('public-user-role');
    const userWrap = document.getElementById('public-topbar-user');
    const loginBtn = document.getElementById('public-btn-login');
    const signupBtn = document.getElementById('public-btn-signup');
    // Logout lives only in Settings → Account (no nav logout button by design).

    if (loggedIn && session) {
      if (avatar) {
        avatar.textContent = initials(session.name);
        avatar.classList.remove('topbar-avatar-guest');
      }
      if (nameEl) nameEl.textContent = session.name || session.email || 'User';
      if (roleEl) {
        roleEl.textContent = 'Retailer';
        roleEl.className = 'pill pill-blue';
      }
      setNavControl(userWrap, true);
      setNavControl(loginBtn, false);
      setNavControl(signupBtn, false);
    } else {
      if (avatar) {
        avatar.textContent = 'G';
        avatar.classList.add('topbar-avatar-guest');
      }
      if (nameEl) nameEl.textContent = 'Guest';
      if (roleEl) {
        roleEl.textContent = 'Not signed in';
        roleEl.className = 'pill pill-guest';
      }
      setNavControl(userWrap, false);
      setNavControl(loginBtn, true);
      setNavControl(signupBtn, true);
    }

    bindBurgerMenu();
  }

  // Secondary-nav burger dropdown (holds Settings). Bound once per navbar render.
  function bindBurgerMenu() {
    const burger = document.getElementById('public-btn-burger');
    const menu = document.getElementById('public-nav-menu');
    if (!burger || !menu || burger.dataset.bound) return;
    burger.dataset.bound = '1';
    const close = () => { menu.setAttribute('hidden', ''); burger.setAttribute('aria-expanded', 'false'); };
    burger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.hasAttribute('hidden')) {
        menu.removeAttribute('hidden');
        burger.setAttribute('aria-expanded', 'true');
      } else {
        close();
      }
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  document.addEventListener('DOMContentLoaded', () => {
    requestAnimationFrame(() => updateTopbarUser());
  });

  return {
    getUsers,
    getSession,
    isLoggedIn,
    requireLogin,
    verifyAdminPassword,
    signup,
    login,
    adminLogin,
    logout,
    updateTopbarUser,
  };
})();
