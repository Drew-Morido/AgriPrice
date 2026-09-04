/* AgriPricePH — Login / Sign up hero page behavior: password toggles, the
   sign-up strength meter, the background photo slideshow, the live stat
   row, and the real submit handlers for #form-login / #form-signup
   (including the admin username -> 6-digit PIN step, same as the shared
   auth modal). */
window.AgriPricePH = window.AgriPricePH || {};

(function () {
  function Auth() { return AgriPricePH.PublicAuth; }
  function Alert() { return AgriPricePH.PublicAlert; }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  /* ---------------- show / hide password ---------------- */
  function wirePasswordToggles() {
    $all('[data-pw-toggle]').forEach((btn) => {
      const input = document.getElementById(btn.getAttribute('data-pw-toggle'));
      if (!input) return;
      btn.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      });
    });
  }

  /* ---------------- live password-strength hint (sign-up only) ---------------- */
  function wirePasswordStrength() {
    const input = document.getElementById('signup-password');
    const bar = document.getElementById('signup-pw-bar');
    const hint = document.getElementById('signup-pw-hint');
    if (!input || !bar || !hint) return;
    const defaultHint = 'Use at least 8 characters with uppercase, lowercase, and a number.';
    input.addEventListener('input', (e) => {
      const v = e.target.value;
      if (!v) {
        bar.style.width = '0%';
        hint.textContent = defaultHint;
        return;
      }
      const s = Auth().passwordStrength(v);
      bar.style.width = `${s.score * 25}%`;
      bar.style.background = s.color;
      hint.textContent = s.label;
    });
  }

  /* ---------------- "Forgot password?" — honest demo notice, no backend flow ---------------- */
  function wireForgotPassword() {
    const link = document.getElementById('ah-forgot-link');
    if (!link) return;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      Alert()?.warning?.(
        "Password reset isn't available in this demo — accounts are stored only in this browser. " +
        'Try logging in with the password you set when you created the account.'
      );
    });
  }

  /* ---------------- login form (email/password, or admin username -> PIN) ---------------- */
  let pendingAdmin = null;

  function showPanel(id) {
    ['ah-login-panel', 'ah-pin-panel'].forEach((pid) => {
      const el = document.getElementById(pid);
      if (el) el.hidden = pid !== id;
    });
  }

  function wireLoginForm() {
    const form = document.getElementById('form-login');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('login-email')?.value?.trim();
      const password = document.getElementById('login-password')?.value;
      if (!id || !password) {
        Alert()?.invalid?.('Please enter your email or username and password.');
        return;
      }

      if (id.includes('@')) {
        const userResult = Auth().login({ email: id, password });
        if (userResult.ok) {
          Alert()?.success?.('Welcome back! You are now logged in.', {
            onConfirm: () => {
              const next = new URLSearchParams(window.location.search).get('next');
              window.location.href = next || Auth().defaultLandingPage();
            },
          });
          return;
        }
      }

      // Not a matching user account — try it as an admin username.
      const adminResult = await Auth().verifyAdminPassword({ username: id, password });
      if (adminResult.ok) {
        pendingAdmin = { username: id, password };
        showPanel('ah-pin-panel');
        document.getElementById('admin-pin')?.focus();
        return;
      }

      if (id.includes('@')) {
        Alert()?.authFailure?.('Email or password is incorrect.');
      } else {
        Alert()?.authFailure?.(adminResult.message || 'Username or password is incorrect.');
      }
    });
  }

  function wireAdminPinForm() {
    const form = document.getElementById('form-admin-pin');
    if (!form) return;

    const pinInput = document.getElementById('admin-pin');
    pinInput?.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    });

    document.getElementById('ah-pin-back')?.addEventListener('click', () => {
      pendingAdmin = null;
      if (pinInput) pinInput.value = '';
      showPanel('ah-login-panel');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pendingAdmin) {
        Alert()?.invalid?.('Session expired. Please log in again.');
        showPanel('ah-login-panel');
        return;
      }
      const accessCode = pinInput?.value;
      const result = await Auth().adminLogin({
        username: pendingAdmin.username,
        password: pendingAdmin.password,
        accessCode,
      });
      if (!result.ok) {
        Alert()?.authFailure?.(result.message);
        return;
      }
      Alert()?.success?.('Admin sign-in successful.', {
        onConfirm: () => { window.location.href = '../admin/index.html'; },
      });
    });
  }

  /* ---------------- sign-up form: inline, per-field error handling ---------------- */
  function setFieldError(fieldId, message) {
    const input = document.getElementById(fieldId);
    const errorEl = document.getElementById(`${fieldId}-error`);
    if (input) input.classList.toggle('has-error', !!message);
    if (errorEl) {
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
    }
  }

  function wireSignupForm() {
    const form = document.getElementById('form-signup');
    if (!form) return;

    // Clear a field's error the moment the visitor starts fixing it.
    ['signup-firstname', 'signup-lastname', 'signup-email', 'signup-password', 'signup-confirm'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', () => setFieldError(id, ''));
    });
    document.getElementById('signup-terms')?.addEventListener('change', () => setFieldError('signup-terms', ''));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const firstName = document.getElementById('signup-firstname')?.value?.trim();
      const lastName = document.getElementById('signup-lastname')?.value?.trim();
      const email = document.getElementById('signup-email')?.value?.trim();
      const password = document.getElementById('signup-password')?.value || '';
      const confirm = document.getElementById('signup-confirm')?.value || '';
      const terms = document.getElementById('signup-terms')?.checked;

      // Reset, then re-validate every field so all problems show at once.
      ['signup-firstname', 'signup-lastname', 'signup-email', 'signup-password', 'signup-confirm', 'signup-terms']
        .forEach((id) => setFieldError(id, ''));

      let firstInvalid = null;
      const invalid = (id, message) => { setFieldError(id, message); if (!firstInvalid) firstInvalid = id; };

      if (!firstName) invalid('signup-firstname', 'Enter your first name.');
      if (!lastName) invalid('signup-lastname', 'Enter your last name.');
      if (!email) {
        invalid('signup-email', 'Enter your email.');
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        invalid('signup-email', 'Enter a valid email address.');
      }
      if (!Auth().passwordStrength(password).valid) {
        invalid('signup-password', 'At least 8 characters, with uppercase, lowercase, and a number.');
      }
      if (!confirm) {
        invalid('signup-confirm', 'Re-enter your password.');
      } else if (password !== confirm) {
        invalid('signup-confirm', 'Passwords do not match.');
      }
      if (!terms) invalid('signup-terms', 'Please accept the Terms & Conditions to continue.');

      if (firstInvalid) {
        document.getElementById(firstInvalid)?.focus();
        return;
      }

      const name = `${firstName} ${lastName}`.trim();
      const result = Auth().signup({ name, email, password });
      if (!result.ok) {
        // Server/account-level failure (e.g. email already registered) — this
        // isn't one field's fault, so it stays a popup rather than an inline error.
        Alert()?.authFailure?.(result.message);
        return;
      }
      Alert()?.success?.('Your account was created successfully.', {
        onConfirm: () => { window.location.href = Auth().defaultLandingPage(); },
      });
    });
  }

  /* ---------------- Terms & Conditions modal ---------------- */
  function wireTermsModal() {
    const modal = document.getElementById('ah-terms-modal');
    const openBtn = document.getElementById('ah-terms-link');
    if (!modal || !openBtn) return;
    const closeBtn = document.getElementById('ah-terms-close');
    const okBtn = document.getElementById('ah-terms-ok');

    function open() { modal.classList.add('is-open'); }
    function close() { modal.classList.remove('is-open'); }

    openBtn.addEventListener('click', (e) => {
      // The button lives inside the terms <label> — stop the click from also
      // toggling the checkbox underneath it.
      e.preventDefault();
      e.stopPropagation();
      open();
    });
    closeBtn?.addEventListener('click', close);
    okBtn?.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-open')) close();
    });
  }

  /* ---------------- background photo slideshow ---------------- */
  function wireSlideshow() {
    const slides = $all('.ah-slide');
    const dots = $all('.ah-slide-dot');
    const creditEl = document.getElementById('ah-slide-credit');
    if (!slides.length) return;

    let index = Math.max(0, slides.findIndex((s) => s.classList.contains('is-active')));
    let timer = null;

    function render() {
      slides.forEach((s, i) => s.classList.toggle('is-active', i === index));
      dots.forEach((d, i) => {
        d.classList.toggle('is-active', i === index);
        d.setAttribute('aria-selected', i === index ? 'true' : 'false');
      });
      if (creditEl) {
        const credit = slides[index].getAttribute('data-credit') || '';
        const href = slides[index].getAttribute('data-credit-href');
        creditEl.innerHTML = href
          ? `<a href="${href}" target="_blank" rel="noopener">${credit}</a>`
          : credit;
      }
    }

    function goTo(i) {
      index = (i + slides.length) % slides.length;
      render();
    }

    function restart() {
      if (timer) clearInterval(timer);
      timer = setInterval(() => goTo(index + 1), 6500);
    }

    dots.forEach((d) => {
      d.addEventListener('click', () => {
        goTo(Number(d.getAttribute('data-slide-index')) || 0);
        restart();
      });
    });

    render();
    restart();
  }

  /* ---------------- live stat row: local rice, imported rice, fuel, USD/PHP ----------------
     Same source and last-vs-previous-day calc as public-data.js's loadCurrentPrices(),
     with the same mock-data fallback when the backend API is unreachable. */
  function pctChange(arr) {
    if (!arr || arr.length < 1) return null;
    const last = Number(arr[arr.length - 1]);
    const prev = arr.length > 1 ? Number(arr[arr.length - 2]) : last;
    if (!Number.isFinite(last)) return null;
    const change = last - prev;
    const pct = prev ? (change / prev) * 100 : 0;
    return { last, pct };
  }

  function renderStat(elId, entry, unit) {
    const valueEl = document.getElementById(`${elId}-value`);
    const changeEl = document.getElementById(`${elId}-change`);
    if (!valueEl || !changeEl) return;
    if (!entry) {
      valueEl.textContent = '—';
      changeEl.textContent = '';
      return;
    }
    valueEl.innerHTML = `₱${entry.last.toFixed(2)}${unit ? `<span class="unit">${unit}</span>` : ''}`;
    const pct = entry.pct;
    if (pct > 0.05) {
      changeEl.textContent = `▲ ${Math.abs(pct).toFixed(1)}%`;
      changeEl.className = 'ah-stat-change up';
    } else if (pct < -0.05) {
      changeEl.textContent = `▼ ${Math.abs(pct).toFixed(1)}%`;
      changeEl.className = 'ah-stat-change down';
    } else {
      changeEl.textContent = '— 0.0%';
      changeEl.className = 'ah-stat-change flat';
    }
  }

  async function loadStatRow() {
    if (!document.getElementById('ah-stat-locWellMilled-value')) return;
    let hist = null;
    try {
      const res = await AgriPricePH.API?.historical?.();
      if (res?.historical?.locWellMilled?.length) hist = res.historical;
    } catch { /* fall through to mock */ }
    if (!hist) hist = AgriPricePH.Data?.historical || {};

    renderStat('ah-stat-locWellMilled', pctChange(hist.locWellMilled), '/kg');
    renderStat('ah-stat-impPremium', pctChange(hist.impPremium), '/kg');
    renderStat('ah-stat-fuel', pctChange(hist.fuel), '/L');
    renderStat('ah-stat-exchange', pctChange(hist.exchange), null);
  }

  document.addEventListener('DOMContentLoaded', () => {
    wirePasswordToggles();
    wirePasswordStrength();
    wireForgotPassword();
    wireLoginForm();
    wireAdminPinForm();
    wireSignupForm();
    wireTermsModal();
    wireSlideshow();
    loadStatRow();
  });
})();
