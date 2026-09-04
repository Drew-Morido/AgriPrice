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

  const NETWORK_ERROR = 'Cannot reach the server. Start the backend (run_backend.bat) and try again.';

  /* Accounts now live server-side (model/user_auth.py) so a real, email-based
     password reset is possible — see requestPasswordReset/verifyResetCode/
     submitPasswordReset below (the reset flow's 3 steps). localStorage
     ['agriprice_public_users'] is kept only as a read-only
     migration source for accounts created before this change (see login()'s
     fallback below); nothing writes to it anymore. */
  async function signup({ name, email, password }) {
    if (!name || !email || !password) {
      return { ok: false, message: 'Please fill in all fields.' };
    }
    if (!passwordStrength(password).valid) {
      return { ok: false, message: 'Password must be at least 8 characters with uppercase, lowercase, and a number.' };
    }
    try {
      const res = await AgriPricePH.API.authSignup(name, email.toLowerCase(), password);
      if (res.ok && res.data?.success) {
        setSession({ name, email: email.toLowerCase(), role: normalizeRole() });
        return { ok: true };
      }
      return { ok: false, message: res.data?.error || 'Could not create your account.' };
    } catch {
      return { ok: false, message: NETWORK_ERROR };
    }
  }

  /* Update the signed-in account's name/email (server-side). Email is the login id, so a
     changed email must not collide with another account. */
  async function updateProfile({ name, email }) {
    const session = getSession();
    if (!session || !session.email) return { ok: false, message: 'You are not logged in.' };
    name = (name || '').trim();
    email = (email || '').trim().toLowerCase();
    if (!name || !email) return { ok: false, message: 'Name and email are required.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: 'Please enter a valid email address.' };
    try {
      const res = await AgriPricePH.API.authUpdateProfile(session.email.toLowerCase(), name, email);
      if (res.ok && res.data?.success) {
        setSession({ name, email, role: normalizeRole() });
        return { ok: true };
      }
      return { ok: false, message: res.data?.error || 'Could not update your profile.' };
    } catch {
      return { ok: false, message: NETWORK_ERROR };
    }
  }

  /* Change the signed-in account's password (verify current, enforce strong new). */
  async function changeUserPassword({ current, next }) {
    const session = getSession();
    if (!session || !session.email) return { ok: false, message: 'You are not logged in.' };
    if (!passwordStrength(next).valid) {
      return { ok: false, message: 'New password must be at least 8 characters with uppercase, lowercase, and a number.' };
    }
    try {
      const res = await AgriPricePH.API.authChangePassword(session.email.toLowerCase(), current, next);
      if (res.ok && res.data?.success) return { ok: true };
      return { ok: false, message: res.data?.error || 'Could not change your password.' };
    } catch {
      return { ok: false, message: NETWORK_ERROR };
    }
  }

  /* One-time, silent migration for accounts created before accounts moved server-side: if the
     server doesn't recognize the email/password, fall back to the legacy localStorage array
     (read-only otherwise). A match there is re-registered server-side and removed from the
     legacy array so it never gets migrated twice — from then on that account is a normal
     server-side account (and can use email-based password reset). An account that only ever
     existed in a DIFFERENT browser's localStorage can't be recovered this way; it has to be
     created again. */
  async function migrateLegacyAccount(email, password) {
    const users = getUsers();
    const idx = users.findIndex((u) => u.email === email.toLowerCase() && u.password === password);
    if (idx === -1) return null;
    const legacy = users[idx];
    try {
      const res = await AgriPricePH.API.authSignup(legacy.name, legacy.email, password);
      if (!res.ok || !res.data?.success) return null;
    } catch {
      return null;
    }
    users.splice(idx, 1);
    saveUsers(users);
    return { name: legacy.name, email: legacy.email, role: normalizeRole(legacy.role) };
  }

  async function login({ email, password }) {
    email = (email || '').trim().toLowerCase();
    try {
      const res = await AgriPricePH.API.authLogin(email, password);
      if (res.ok && res.data?.success && res.data?.user) {
        setSession({ name: res.data.user.name, email: res.data.user.email, role: normalizeRole(res.data.user.role) });
        return { ok: true };
      }
      if (res.status === 429) {
        return { ok: false, message: res.data?.error || 'Too many attempts. Try again later.' };
      }
      const migrated = await migrateLegacyAccount(email, password);
      if (migrated) {
        setSession(migrated);
        return { ok: true };
      }
      return { ok: false, message: res.data?.error || 'Email or password is incorrect.' };
    } catch {
      return { ok: false, message: NETWORK_ERROR };
    }
  }

  /* ---------------- forgot / reset password (email code via model/mailer.py) ---------------- */
  /* Step 1 of 3. By design, the server tells us outright whether the email is
     registered (an explicit "email verified" vs "no account found" popup),
     and whether a still-valid code was already sent rather than silently
     emailing a second one (see model/user_auth.py's request_reset()) —
     ok:true covers both "sent" and "already_sent", ok:false covers "no
     account" and any real failure; the message text (crafted server-side)
     already says which. */
  async function requestPasswordReset({ email }) {
    email = (email || '').trim().toLowerCase();
    if (!email) return { ok: false, message: 'Enter your email address.' };
    try {
      const res = await AgriPricePH.API.forgotPassword(email);
      if (res.status === 429) {
        return { ok: false, message: res.data?.error || 'Too many attempts. Try again later.' };
      }
      if (res.ok && res.data?.success) {
        return { ok: true, message: res.data.message || 'A 6-digit code was sent to your email.' };
      }
      return { ok: false, message: res.data?.error || 'Could not send a reset code right now.' };
    } catch {
      return { ok: false, message: NETWORK_ERROR };
    }
  }

  /* Step 2 of 3: check the code on its own. On success the server hands back a
     one-time "ticket" — hold onto it and send it (not the code) in step 3. */
  async function verifyResetCode({ email, code }) {
    email = (email || '').trim().toLowerCase();
    try {
      const res = await AgriPricePH.API.verifyResetCode(email, code);
      if (res.ok && res.data?.success && res.data?.ticket) {
        return { ok: true, ticket: res.data.ticket };
      }
      if (res.status === 429) {
        return { ok: false, message: res.data?.error || 'Too many attempts. Try again later.' };
      }
      return { ok: false, message: res.data?.error || 'That code is incorrect.' };
    } catch {
      return { ok: false, message: NETWORK_ERROR };
    }
  }

  /* Step 3 of 3: set the new password — gated on the ticket from step 2. */
  async function submitPasswordReset({ email, ticket, newPassword }) {
    email = (email || '').trim().toLowerCase();
    if (!passwordStrength(newPassword).valid) {
      return { ok: false, message: 'New password must be at least 8 characters with uppercase, lowercase, and a number.' };
    }
    try {
      const res = await AgriPricePH.API.resetPassword(email, ticket, newPassword);
      if (res.ok && res.data?.success) return { ok: true };
      if (res.status === 429) {
        return { ok: false, message: res.data?.error || 'Too many attempts. Try again later.' };
      }
      return { ok: false, message: res.data?.error || 'Could not reset your password.' };
    } catch {
      return { ok: false, message: NETWORK_ERROR };
    }
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
    requestPasswordReset,
    verifyResetCode,
    submitPasswordReset,
    defaultLandingPage,
  };
})();
