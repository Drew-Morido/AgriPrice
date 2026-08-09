/* AgriPricePH — Unlock promo + unified auth modal (Login / Sign up; user vs admin by credentials) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.PublicAuthModal = (function () {
  const ICON_HISTORY = `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="6" y="10" width="36" height="28" rx="4" stroke="currentColor" stroke-width="2"/>
    <path d="M6 18h36" stroke="currentColor" stroke-width="2"/>
    <path d="M14 28l6 6 14-14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  const ICON_STATS = `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="8" y="26" width="7" height="12" rx="2" fill="currentColor" opacity="0.35"/>
    <rect x="20" y="18" width="7" height="20" rx="2" fill="currentColor" opacity="0.55"/>
    <rect x="32" y="10" width="7" height="28" rx="2" fill="currentColor"/>
    <path d="M8 40h32" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;

  const FEATURES = {
    historical: {
      iconSvg: ICON_HISTORY,
      title: 'Unlock Price History',
      lead: 'Do you want to open this feature?',
      body: 'View daily rice prices from 2015 to today across all 8 rice types — free with a quick account.',
      badge: 'Members only',
    },
    statistics: {
      iconSvg: ICON_STATS,
      title: 'Unlock Charts & Stats',
      lead: 'Do you want to open this feature?',
      body: 'Explore trends, comparisons, and market insights over the last 90 days — free with a quick account.',
      badge: 'Members only',
    },
  };

  let unlockRoot = null;
  let authRoot = null;
  let pinRoot = null;
  let pendingAdmin = null;
  let onAuthSuccess = null;
  let authNext = 'historical.html';
  let gatedUnlockCallback = null;

  function Auth() {
    return AgriPricePH.PublicAuth;
  }

  function Alert() {
    return AgriPricePH.PublicAlert;
  }

  function lockBody(open) {
    document.body.classList.toggle('public-auth-modal-open', open);
  }

  function ensureUnlockRoot() {
    if (unlockRoot) return unlockRoot;
    unlockRoot = document.createElement('div');
    unlockRoot.id = 'public-unlock-root';
    unlockRoot.className = 'public-unlock-backdrop';
    unlockRoot.innerHTML = `
      <div class="public-unlock-card" role="dialog" aria-modal="true" aria-labelledby="public-unlock-title">
        <button type="button" class="public-unlock-close" aria-label="Close">&times;</button>
        <div class="public-unlock-badge" id="public-unlock-badge"></div>
        <div class="public-unlock-icon" id="public-unlock-icon" aria-hidden="true"></div>
        <p class="public-unlock-lead" id="public-unlock-lead"></p>
        <h2 class="public-unlock-title" id="public-unlock-title"></h2>
        <p class="public-unlock-body" id="public-unlock-body"></p>
        <div class="public-unlock-actions">
          <button type="button" class="btn btn-primary btn-lg" id="public-unlock-login">Log in</button>
          <button type="button" class="btn btn-outline btn-lg" id="public-unlock-signup">Sign up free</button>
        </div>
        <p class="public-unlock-foot">Price forecast stays free — no account needed.</p>
      </div>
    `;
    document.body.appendChild(unlockRoot);

    unlockRoot.addEventListener('click', (e) => {
      if (e.target === unlockRoot) dismissUnlockToHome();
    });
    unlockRoot.querySelector('.public-unlock-close')?.addEventListener('click', dismissUnlockToHome);
    unlockRoot.querySelector('#public-unlock-login')?.addEventListener('click', () => {
      hideUnlock();
      showAuth({ mode: 'login', next: authNext, onSuccess: onAuthSuccess });
    });
    unlockRoot.querySelector('#public-unlock-signup')?.addEventListener('click', () => {
      hideUnlock();
      showAuth({ mode: 'signup', next: authNext, onSuccess: onAuthSuccess });
    });

    return unlockRoot;
  }

  function dismissUnlockToHome() {
    hideUnlock();
    const page = document.body.dataset.page;
    if (page === 'historical' || page === 'statistics') {
      window.location.href = 'landpage.html';
    }
  }

  function ensureAuthRoot() {
    if (authRoot) return authRoot;
    authRoot = document.createElement('div');
    authRoot.id = 'public-auth-modal-root';
    authRoot.className = 'lp-modal-backdrop public-auth-backdrop';
    authRoot.innerHTML = `
      <div class="lp-modal public-auth-modal" role="dialog" aria-modal="true" aria-labelledby="public-auth-modal-title">
        <div class="lp-modal-header">
          <div>
            <h2 id="public-auth-modal-title">Welcome</h2>
            <p class="public-auth-modal-sub">Log in or create a free account for history and charts.</p>
          </div>
          <button type="button" class="lp-modal-close public-auth-close" aria-label="Close">&times;</button>
        </div>
        <div class="lp-modal-tabs public-auth-tabs" role="tablist">
          <button type="button" class="active" data-auth-tab="login" role="tab">Log in</button>
          <button type="button" data-auth-tab="signup" role="tab">Sign up</button>
        </div>
        <div class="lp-modal-body">
          <div class="public-auth-panel active" data-auth-panel="login">
            <form id="public-modal-form-login" autocomplete="on">
              <div class="lp-form-group">
                <label for="public-modal-login-id">Email or username</label>
                <input class="form-input" type="text" id="public-modal-login-id" required autocomplete="username" placeholder="you@email.com or admin username" />
              </div>
              <div class="lp-form-group">
                <label for="public-modal-login-password">Password</label>
                <input class="form-input" type="password" id="public-modal-login-password" required autocomplete="current-password" placeholder="Your password" />
              </div>
              <button type="submit" class="btn btn-primary btn-lg" style="width:100%">Log in</button>
            </form>
          </div>
          <div class="public-auth-panel" data-auth-panel="signup" hidden>
            <form id="public-modal-form-signup" autocomplete="on">
              <div class="lp-form-group">
                <label for="public-modal-signup-name">Your name</label>
                <input class="form-input" type="text" id="public-modal-signup-name" required placeholder="e.g. Maria Santos" />
              </div>
              <div class="lp-form-group">
                <label for="public-modal-signup-email">Email</label>
                <input class="form-input" type="email" id="public-modal-signup-email" required autocomplete="email" placeholder="you@email.com" />
              </div>
              <div class="lp-form-group">
                <label for="public-modal-signup-password">Password</label>
                <input class="form-input" type="password" id="public-modal-signup-password" required minlength="6" autocomplete="new-password" placeholder="At least 6 characters" />
              </div>
              <div class="lp-form-group">
                <label>I am signing up as a…</label>
                <div class="lp-role-select">
                  <label><input type="radio" name="public-modal-signup-role" value="vendor" /> Vendor</label>
                  <label><input type="radio" name="public-modal-signup-role" value="household" checked /> Household</label>
                </div>
              </div>
              <button type="submit" class="btn btn-primary btn-lg" style="width:100%">Create account</button>
            </form>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(authRoot);

    authRoot.addEventListener('click', (e) => {
      if (e.target === authRoot) hideAuth();
    });
    authRoot.querySelector('.public-auth-close')?.addEventListener('click', hideAuth);

    authRoot.querySelectorAll('[data-auth-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setAuthTab(btn.dataset.authTab));
    });

    authRoot.querySelector('#public-modal-form-login')?.addEventListener('submit', handleUnifiedLogin);
    authRoot.querySelector('#public-modal-form-signup')?.addEventListener('submit', handleUserSignup);

    return authRoot;
  }

  function ensurePinRoot() {
    if (pinRoot) return pinRoot;
    pinRoot = document.createElement('div');
    pinRoot.id = 'public-admin-pin-root';
    pinRoot.className = 'lp-modal-backdrop public-pin-backdrop';
    pinRoot.innerHTML = `
      <div class="lp-modal public-pin-modal" role="dialog" aria-modal="true" aria-labelledby="public-pin-title">
        <div class="lp-modal-header">
          <div>
            <h2 id="public-pin-title">Admin access code</h2>
            <p class="public-auth-modal-sub">Enter your 6-digit PIN to open the admin dashboard.</p>
          </div>
          <button type="button" class="lp-modal-close public-pin-close" aria-label="Close">&times;</button>
        </div>
        <div class="lp-modal-body">
          <form id="public-modal-form-pin" autocomplete="off">
            <div class="lp-form-group">
              <label for="public-modal-admin-pin">6-digit PIN</label>
              <input class="form-input public-pin-input" type="password" id="public-modal-admin-pin"
                inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"
                placeholder="••••••" required />
            </div>
            <button type="submit" class="btn btn-primary btn-lg" style="width:100%">Sign in to dashboard</button>
            <button type="button" class="btn btn-ghost btn-sm public-pin-back" style="width:100%;margin-top:10px">← Back to log in</button>
          </form>
        </div>
      </div>
    `;
    document.body.appendChild(pinRoot);

    pinRoot.addEventListener('click', (e) => {
      if (e.target === pinRoot) hidePin();
    });
    pinRoot.querySelector('.public-pin-close')?.addEventListener('click', hidePin);
    pinRoot.querySelector('.public-pin-back')?.addEventListener('click', () => {
      hidePin();
      showAuth({ mode: 'login' });
    });
    pinRoot.querySelector('#public-modal-admin-pin')?.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    });
    pinRoot.querySelector('#public-modal-form-pin')?.addEventListener('submit', handleAdminPin);

    return pinRoot;
  }

  function setAuthTab(tab) {
    ensureAuthRoot();
    const activeTab = tab === 'signup' ? 'signup' : 'login';
    authRoot.querySelectorAll('[data-auth-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.authTab === activeTab);
    });
    authRoot.querySelectorAll('[data-auth-panel]').forEach((panel) => {
      const active = panel.dataset.authPanel === activeTab;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    });
  }

  function showUnlock({ feature, next, onSuccess } = {}) {
    const cfg = FEATURES[feature] || FEATURES.historical;
    authNext = next || 'historical.html';
    onAuthSuccess = onSuccess || null;
    gatedUnlockCallback = onSuccess || null;

    const root = ensureUnlockRoot();
    root.querySelector('#public-unlock-badge').textContent = cfg.badge;
    root.querySelector('#public-unlock-icon').innerHTML = cfg.iconSvg;
    root.querySelector('#public-unlock-lead').textContent = cfg.lead;
    root.querySelector('#public-unlock-title').textContent = cfg.title;
    root.querySelector('#public-unlock-body').textContent = cfg.body;

    requestAnimationFrame(() => {
      root.classList.add('open');
      lockBody(true);
    });
  }

  function hideUnlock() {
    if (!unlockRoot) return;
    unlockRoot.classList.remove('open');
    if (!authRoot?.classList.contains('open') && !pinRoot?.classList.contains('open')) {
      lockBody(false);
    }
  }

  function showAuth({ mode = 'login', next, onSuccess } = {}) {
    ensureAuthRoot();
    authNext = next || authNext || 'historical.html';
    onAuthSuccess = onSuccess || onAuthSuccess;
    setAuthTab(mode === 'signup' ? 'signup' : 'login');

    requestAnimationFrame(() => {
      authRoot.classList.add('open');
      lockBody(true);
      const focusId = mode === 'signup' ? 'public-modal-signup-name' : 'public-modal-login-id';
      document.getElementById(focusId)?.focus();
    });
  }

  function hideAuth() {
    if (!authRoot) return;
    authRoot.classList.remove('open');
    if (!unlockRoot?.classList.contains('open') && !pinRoot?.classList.contains('open')) {
      lockBody(false);
    }
  }

  function showPinModal(credentials) {
    pendingAdmin = credentials;
    ensurePinRoot();
    hideAuth();
    pinRoot.querySelector('#public-modal-admin-pin').value = '';
    requestAnimationFrame(() => {
      pinRoot.classList.add('open');
      lockBody(true);
      document.getElementById('public-modal-admin-pin')?.focus();
    });
  }

  function hidePin() {
    if (!pinRoot) return;
    pinRoot.classList.remove('open');
    pendingAdmin = null;
    if (!unlockRoot?.classList.contains('open') && !authRoot?.classList.contains('open')) {
      lockBody(false);
    }
  }

  function unlockGatedContent() {
    const content = document.getElementById('public-page-content');
    content?.classList.remove('public-gated-locked');
    hideUnlock();
    Auth()?.updateTopbarUser?.();
    if (typeof gatedUnlockCallback === 'function') {
      const cb = gatedUnlockCallback;
      gatedUnlockCallback = null;
      cb();
    }
    if (typeof onAuthSuccess === 'function') {
      const cb = onAuthSuccess;
      onAuthSuccess = null;
      cb();
    }
  }

  async function handleUnifiedLogin(e) {
    e.preventDefault();
    const id = document.getElementById('public-modal-login-id')?.value?.trim();
    const password = document.getElementById('public-modal-login-password')?.value;

    if (!id || !password) {
      Alert()?.invalid?.('Please enter your email or username and password.');
      return;
    }

    if (id.includes('@')) {
      const userResult = Auth().login({ email: id, password });
      if (userResult.ok) {
        hideAuth();
        Alert()?.success?.('Welcome back! You are now logged in.', {
          onConfirm: () => unlockGatedContent(),
        });
        return;
      }
    }

    const adminResult = await Auth().verifyAdminPassword({ username: id, password });
    if (adminResult.ok) {
      showPinModal({ username: id, password });
      return;
    }

    if (id.includes('@')) {
      Alert()?.authFailure?.('Email or password is incorrect.');
    } else {
      Alert()?.authFailure?.(adminResult.message || 'Username or password is incorrect.');
    }
  }

  function handleUserSignup(e) {
    e.preventDefault();
    const result = Auth().signup({
      name: document.getElementById('public-modal-signup-name')?.value?.trim(),
      email: document.getElementById('public-modal-signup-email')?.value?.trim(),
      password: document.getElementById('public-modal-signup-password')?.value,
      role: document.querySelector('input[name="public-modal-signup-role"]:checked')?.value || 'household',
    });
    if (!result.ok) {
      Alert()?.authFailure?.(result.message);
      return;
    }
    hideAuth();
    Alert()?.success?.('Your account was created successfully.', {
      onConfirm: () => unlockGatedContent(),
    });
  }

  async function handleAdminPin(e) {
    e.preventDefault();
    if (!pendingAdmin) {
      Alert()?.invalid?.('Session expired. Please log in again.');
      hidePin();
      showAuth({ mode: 'login' });
      return;
    }
    const accessCode = document.getElementById('public-modal-admin-pin')?.value;
    const result = await Auth().adminLogin({
      username: pendingAdmin.username,
      password: pendingAdmin.password,
      accessCode,
    });
    if (!result.ok) {
      Alert()?.authFailure?.(result.message);
      return;
    }
    hidePin();
    Alert()?.success?.('Admin sign-in successful.', {
      onConfirm: () => {
        window.location.href = '../admin/index.html';
      },
    });
  }

  function lockGatedContent() {
    document.getElementById('public-page-content')?.classList.add('public-gated-locked');
  }

  function initGatedPage({ feature, next, onUnlock }) {
    if (Auth()?.isLoggedIn?.()) {
      onUnlock?.();
      return;
    }
    lockGatedContent();
    authNext = next || authNext;
    gatedUnlockCallback = onUnlock;

    const authParam = new URLSearchParams(window.location.search).get('auth');
    if (authParam) return;

    requestAnimationFrame(() => {
      showUnlock({ feature, next, onSuccess: onUnlock });
    });
  }

  function bindGlobalTriggers() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('#public-btn-login')) {
        e.preventDefault();
        showAuth({ mode: 'login' });
        return;
      }
      if (e.target.closest('#public-btn-signup')) {
        e.preventDefault();
        showAuth({ mode: 'signup' });
        return;
      }
      const trigger = e.target.closest('[data-auth-open]');
      if (trigger) {
        e.preventDefault();
        const mode = trigger.dataset.authOpen === 'signup' ? 'signup' : 'login';
        showAuth({
          mode,
          next: trigger.dataset.authNext || undefined,
        });
      }
    });
  }

  function handleAuthQueryParam() {
    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    if (!auth) return;
    const next = params.get('next') || window.location.pathname.split('/').pop() || 'historical.html';
    authNext = next;
    const clean = window.location.pathname.split('/').pop() || window.location.pathname;
    window.history.replaceState(null, '', clean);

    requestAnimationFrame(() => {
      if (auth === 'signup') showAuth({ mode: 'signup', next });
      else showAuth({ mode: 'login', next });
    });
  }

  function init() {
    ensureUnlockRoot();
    ensureAuthRoot();
    ensurePinRoot();
    bindGlobalTriggers();
    handleAuthQueryParam();

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (pinRoot?.classList.contains('open')) hidePin();
      else if (authRoot?.classList.contains('open')) hideAuth();
      else if (unlockRoot?.classList.contains('open')) dismissUnlockToHome();
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    showUnlock,
    hideUnlock,
    showAuth,
    hideAuth,
    showPinModal,
    hidePin,
    initGatedPage,
    lockGatedContent,
    unlockGatedContent,
    dismissUnlockToHome,
  };
})();
