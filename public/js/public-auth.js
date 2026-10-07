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

  /* A signed-in session is { name, email, role, token, expiresAt, remember }. The token is issued
     by the server at login/signup and is what the account endpoints check. Without "Remember me"
     it lives in sessionStorage (gone when the tab closes); with it, in localStorage for 30 days. */
  function readStored(store) {
    try {
      const s = JSON.parse(store.getItem(STORAGE_SESSION) || 'null');
      return s && typeof s === 'object' ? s : null;
    } catch {
      return null;
    }
  }

  function clearSession() {
    try { sessionStorage.removeItem(STORAGE_SESSION); } catch { /* ignore */ }
    try { localStorage.removeItem(STORAGE_SESSION); } catch { /* ignore */ }
  }

  function getSession() {
    let s = null;
    try { s = readStored(sessionStorage) || readStored(localStorage); } catch { s = null; }
    if (!s) return null;
    // Sessions saved before server-issued tokens existed cannot be verified: treat as signed out.
    if (!s.token || (s.expiresAt && s.expiresAt < Date.now())) {
      clearSession();
      return null;
    }
    s.role = normalizeRole(s.role);
    return s;
  }

  function writeSession(session) {
    clearSession();
    const store = session.remember ? localStorage : sessionStorage;
    store.setItem(STORAGE_SESSION, JSON.stringify(session));
  }

  /** Save the session the server returned from /api/auth/login or /api/auth/signup. */
  function startSession(data) {
    writeSession({
      name: data.user.name,
      email: data.user.email,
      avatar: data.user.avatar || '',
      title: data.user.title || '',
      role: normalizeRole(data.user.role),
      token: data.token,
      expiresAt: Date.now() + (Number(data.expires_in) || 86400) * 1000,
      remember: !!data.remember,
    });
  }

  /** Keep the token, refresh what the nav shows (after a profile edit, or an admin rename). */
  function refreshSessionUser(user) {
    const s = getSession();
    if (!s || !user) return;
    writeSession({
      ...s,
      name: user.name ?? s.name,
      email: user.email ?? s.email,
      avatar: user.avatar ?? s.avatar ?? '',
      title: user.title ?? s.title ?? '',
    });
  }

  const EXPIRED_MESSAGE = 'Your session has expired. Please log in again.';

  function logout() {
    const token = getSession()?.token;
    clearSession();
    if (token) AgriPricePH.API?.authLogout?.(token).catch(() => {});
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
    return !!(s && s.email && s.token && s.role === 'retailer');
  }

  /* Only pages of this site may be a post-login destination. A raw ?next= value used to go
     straight into location.href, so a crafted login link could send the visitor to another site
     or run script ("javascript:..."). */
  function safeNextPage(raw) {
    const v = String(raw || '').trim();
    return /^[a-z0-9-]+\.html(?:[?#][^\s]*)?$/i.test(v) ? v : null;
  }

  function nextPageFromUrl() {
    try {
      return safeNextPage(new URLSearchParams(window.location.search).get('next'));
    } catch {
      return null;
    }
  }

  // Pages that show only to signed-in retailers: if their session turns out to be invalid, reload
  // so the page's own guard (redirect or unlock prompt) takes over.
  const MEMBER_PAGES = ['profile', 'settings', 'historical', 'statistics'];

  /* Check the stored session with the server once per page load. Catches a session that expired,
     was signed out elsewhere (password change/reset), or whose account was deactivated, and picks
     up an admin rename. A network failure leaves the session alone. */
  async function verifySession() {
    const s = getSession();
    if (!s || !AgriPricePH.API?.authSession) return;
    let res;
    try {
      res = await AgriPricePH.API.authSession(s.token);
    } catch {
      return;
    }
    if (res.status === 401) {
      clearSession();
      updateTopbarUser();
      if (MEMBER_PAGES.includes(document.body?.dataset?.page)) window.location.reload();
      return;
    }
    if (res.ok && res.data?.user) {
      refreshSessionUser(res.data.user);
      updateTopbarUser();
      if (res.data.user.show_welcome) showFirstWelcome(res.data.user, s.token);
    }
  }

  /* One-time welcome for a brand-new account, on the first page after sign-up or first sign-in.
     The server remembers it per account (users.welcome_seen_at), so it never repeats — not on
     another page, another browser, or another device. Not on the login/sign-up pages themselves. */
  let _welcomeShown = false;
  function loadWelcomeModal() {
    if (AgriPricePH.WelcomeModal) return Promise.resolve(true);
    return new Promise((resolve) => {
      const tag = document.createElement('script');
      tag.src = '../js/welcome-modal.js?v=1';
      tag.onload = () => resolve(!!AgriPricePH.WelcomeModal);
      tag.onerror = () => resolve(false);
      document.head.appendChild(tag);
    });
  }

  async function showFirstWelcome(user, token) {
    const page = (window.location.pathname.split('/').pop() || '').toLowerCase();
    if (_welcomeShown || page === 'login.html' || page === 'signup.html') return;
    _welcomeShown = true;
    if (!(await loadWelcomeModal())) return;
    const first = String(user.name || '').trim().split(/\s+/)[0] || 'there';
    await AgriPricePH.WelcomeModal.show({
      name: user.name,
      avatar: user.avatar,
      eyebrow: 'Your free account is ready',
      title: `Welcome to AgriPricePH, ${first}!`,
      text: 'Follow rice prices across the Philippines and plan your rice budget with confidence.',
      tiles: [
        { icon: 'tag', title: 'Today’s rice prices', text: 'DA retail prices for 8 local and imported rice types.' },
        { icon: 'trend', title: '3-day price forecast', text: 'Where prices may go next, with a likely price range.' },
        { icon: 'history', title: 'Price history & charts', text: 'Rice prices since 2015, now unlocked for you.' },
      ],
      secondary: { label: 'Set up my profile', onClick: () => { window.location.href = 'profile.html'; } },
      primary: { label: 'Start exploring' },
    });
    AgriPricePH.API?.authWelcomeSeen?.(token).catch(() => {});
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
      if (res.ok && res.data?.success && res.data?.token) {
        startSession(res.data);
        return { ok: true, user: res.data.user };
      }
      return { ok: false, message: res.data?.error || 'Could not create your account.' };
    } catch {
      return { ok: false, message: NETWORK_ERROR };
    }
  }

  /* Update the signed-in account's name/email (server-side). Email is the login id, so a
     changed email must not collide with another account. */
  /* Save part of the signed-in account's profile: any of name, email, title, phone, bio, avatar,
     extra_info. Returns { ok, user } with the saved profile, like the admin profile's save. */
  async function updateProfile(patch = {}) {
    const session = getSession();
    if (!session || !session.email) return { ok: false, message: 'You are not logged in.' };
    patch = { ...patch };
    if ('name' in patch) {
      patch.name = String(patch.name || '').trim();
      if (!patch.name) return { ok: false, message: 'Please enter a display name.' };
    }
    if ('email' in patch) {
      patch.email = String(patch.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) return { ok: false, message: 'Please enter a valid email address.' };
    }
    try {
      const res = await AgriPricePH.API.authUpdateProfile(session.token, patch);
      if (res.ok && res.data?.success) {
        refreshSessionUser(res.data.user);
        updateTopbarUser();
        return { ok: true, user: res.data.user };
      }
      if (res.status === 401) {
        clearSession();
        return { ok: false, expired: true, message: EXPIRED_MESSAGE };
      }
      return { ok: false, message: res.data?.error || 'Could not update your profile.' };
    } catch {
      return { ok: false, message: NETWORK_ERROR };
    }
  }

  /** The signed-in account's full profile from the server. */
  async function getProfile() {
    const session = getSession();
    if (!session) return { ok: false, expired: true, message: EXPIRED_MESSAGE };
    try {
      const res = await AgriPricePH.API.authProfile(session.token);
      if (res.ok && res.data?.user) {
        refreshSessionUser(res.data.user);
        return { ok: true, user: res.data.user };
      }
      if (res.status === 401) {
        clearSession();
        return { ok: false, expired: true, message: EXPIRED_MESSAGE };
      }
      return { ok: false, message: res.data?.error || 'Could not load your profile.' };
    } catch {
      return { ok: false, message: NETWORK_ERROR };
    }
  }

  /** This account's recent sign-in and account events, newest first. */
  async function getActivity(limit = 6) {
    const session = getSession();
    if (!session) return { ok: false, expired: true, logs: [] };
    try {
      const res = await AgriPricePH.API.authActivity(session.token, limit);
      if (res.ok && Array.isArray(res.data?.logs)) return { ok: true, logs: res.data.logs };
      if (res.status === 401) return { ok: false, expired: true, logs: [] };
      return { ok: false, logs: [] };
    } catch {
      return { ok: false, logs: [] };
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
      const res = await AgriPricePH.API.authChangePassword(session.token, current, next);
      if (res.ok && res.data?.success) return { ok: true };
      if (res.status === 401) {
        clearSession();
        return { ok: false, expired: true, message: EXPIRED_MESSAGE };
      }
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
    let res;
    try {
      res = await AgriPricePH.API.authSignup(legacy.name, legacy.email, password);
      if (!res.ok || !res.data?.success || !res.data?.token) return null;
    } catch {
      return null;
    }
    users.splice(idx, 1);
    saveUsers(users);
    return res.data;
  }

  async function login({ email, password, remember }) {
    email = (email || '').trim().toLowerCase();
    try {
      const res = await AgriPricePH.API.authLogin(email, password, remember);
      if (res.ok && res.data?.success && res.data?.token) {
        startSession(res.data);
        return { ok: true, user: res.data.user };
      }
      if (res.status === 429) {
        return { ok: false, message: res.data?.error || 'Too many attempts. Try again later.' };
      }
      if (res.status === 403 && res.data?.code === 'deactivated') {
        return { ok: false, deactivated: true, message: res.data.error };
      }
      const migrated = await migrateLegacyAccount(email, password);
      if (migrated) {
        startSession(migrated);
        return { ok: true, user: migrated.user };
      }
      return { ok: false, message: res.data?.error || 'Email or password is incorrect.' };
    } catch {
      return { ok: false, message: NETWORK_ERROR };
    }
  }

  /* "Continue with Google": the server verifies Google's ID token, then signs in, links (same
     verified email) or creates the public account. Returns { ok, user, created, linked }. */
  async function googleSignIn(credential, remember) {
    try {
      const res = await AgriPricePH.API.authGoogle(credential, remember);
      if (res.ok && res.data?.success && res.data?.token) {
        startSession(res.data);
        return { ok: true, user: res.data.user, created: !!res.data.created, linked: !!res.data.linked };
      }
      if (res.status === 403 && res.data?.code === 'deactivated') {
        return { ok: false, deactivated: true, message: res.data.error };
      }
      return { ok: false, message: res.data?.error || 'Google sign-in did not work. Please try again.' };
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
        return { ok: true, admin: res.data.admin || null };
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

    const profileBtn = document.getElementById('public-btn-profile');
    if (profileBtn) {
      if (!profileBtn.dataset.icon) profileBtn.dataset.icon = profileBtn.innerHTML;
      const photo = loggedIn && session?.avatar;
      if (photo) {
        profileBtn.innerHTML = '';
        const img = document.createElement('img');
        img.src = session.avatar;
        img.alt = '';
        img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;display:block';
        profileBtn.appendChild(img);
        profileBtn.style.overflow = 'hidden';
        profileBtn.style.padding = '0';
      } else if (profileBtn.innerHTML !== profileBtn.dataset.icon) {
        profileBtn.innerHTML = profileBtn.dataset.icon;
      }
    }

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
  }

  document.addEventListener('DOMContentLoaded', () => {
    requestAnimationFrame(() => updateTopbarUser());
    verifySession();
  });

  return {
    getUsers,
    getSession,
    clearSession,
    isLoggedIn,
    safeNextPage,
    nextPageFromUrl,
    requireLogin,
    verifyAdminPassword,
    signup,
    login,
    googleSignIn,
    adminLogin,
    logout,
    updateTopbarUser,
    passwordStrength,
    updateProfile,
    getProfile,
    getActivity,
    changeUserPassword,
    requestPasswordReset,
    verifyResetCode,
    submitPasswordReset,
    defaultLandingPage,
  };
})();
