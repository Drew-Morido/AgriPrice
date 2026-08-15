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

  /* Standard strong-password check + strength scoring (0–4) for the signup meter. Valid requires
     >=8 chars with uppercase, lowercase, and a number. */
  function passwordStrength(pw) {
    pw = pw || '';
    const len8 = pw.length >= 8;
    const upper = /[A-Z]/.test(pw);
    const lower = /[a-z]/.test(pw);
    const num = /[0-9]/.test(pw);
    const special = /[^A-Za-z0-9]/.test(pw);
    const valid = len8 && upper && lower && num;
    let score = 0;
    if (pw.length >= 6) score = 1;
    if (len8 && upper && lower) score = 2;
    if (valid) score = 3;
    if (valid && (special || pw.length >= 12)) score = 4;
    const labels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
    const colors = ['#e0645f', '#e0645f', '#e0a95f', '#4CAF6E', '#2f9e5f'];
    return { score, valid, label: labels[score], color: colors[score] };
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

  /* The page a logged-in user is sent to (post-login + when they hit the landing page). Sourced
     from the user's saved preference (public Settings → Preferences); defaults to Price Forecast. */
  function defaultLandingPage() {
    const allowed = ['current-prices.html', 'rice-catalog.html', 'historical.html', 'statistics.html'];
    try {
      const p = JSON.parse(localStorage.getItem('agriprice_public_prefs') || 'null') || {};
      return allowed.includes(p.defaultPage) ? p.defaultPage : 'current-prices.html';
    } catch {
      return 'current-prices.html';
    }
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
    if (!passwordStrength(password).valid) {
      return { ok: false, message: 'Password must be at least 8 characters with uppercase, lowercase, and a number.' };
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

  /* Update the signed-in account's name/email (localStorage account + session). Email is the
     login id, so a changed email must not collide with another account. */
  function updateProfile({ name, email }) {
    const session = getSession();
    if (!session || !session.email) return { ok: false, message: 'You are not logged in.' };
    name = (name || '').trim();
    email = (email || '').trim().toLowerCase();
    if (!name || !email) return { ok: false, message: 'Name and email are required.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: 'Please enter a valid email address.' };
    const users = getUsers();
    const idx = users.findIndex((u) => u.email === session.email.toLowerCase());
    if (idx === -1) return { ok: false, message: 'Account not found on this device.' };
    if (email !== session.email.toLowerCase() && users.some((u) => u.email === email)) {
      return { ok: false, message: 'That email is already used by another account.' };
    }
    users[idx].name = name;
    users[idx].email = email;
    saveUsers(users);
    setSession({ name, email, role: normalizeRole() });
    return { ok: true };
  }

  /* Change the signed-in account's password (verify current, enforce strong new). */
  function changeUserPassword({ current, next }) {
    const session = getSession();
    if (!session || !session.email) return { ok: false, message: 'You are not logged in.' };
    const users = getUsers();
    const idx = users.findIndex((u) => u.email === session.email.toLowerCase());
    if (idx === -1) return { ok: false, message: 'Account not found on this device.' };
    if (users[idx].password !== current) return { ok: false, message: 'Your current password is incorrect.' };
    if (!passwordStrength(next).valid) {
      return { ok: false, message: 'New password must be at least 8 characters with uppercase, lowercase, and a number.' };
    }
    users[idx].password = next;
    saveUsers(users);
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
    passwordStrength,
    updateProfile,
    changeUserPassword,
    defaultLandingPage,
  };
})();
