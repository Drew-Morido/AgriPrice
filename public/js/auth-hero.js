/* AgriPricePH — Login / Sign up hero page behavior: password toggles, the
   sign-up strength meter, the background photo slideshow, the live stat
   row, and the real submit handlers for #form-login / #form-signup
   (including the admin username -> 6-digit PIN step, same as the shared
   auth modal, and the "Forgot password?" -> email code -> reset flow). */
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

  /* ---------------- login form (email/password, or admin username -> PIN) ---------------- */
  let pendingAdmin = null;

  const AH_PANEL_IDS = ['ah-login-panel', 'ah-pin-panel', 'ah-forgot-panel', 'ah-code-panel', 'ah-reset-panel'];

  /* Fast, smooth step-to-step transition: fade+slide the current panel out,
     swap `hidden`, fade+slide the new one in. Sequential (not a simultaneous
     crossfade) since only one panel is ever visible at a time — that keeps it
     simple with no absolute-positioning/layout-jump risk. ~130ms each way
     reads as snappy, not sluggish, per "smooth fast transitioning". */
  function showPanel(id) {
    const panels = AH_PANEL_IDS.map((pid) => document.getElementById(pid)).filter(Boolean);
    const current = panels.find((el) => !el.hidden);
    const next = panels.find((el) => el.id === id);
    if (!next || next === current) return;

    if (!current) {
      panels.forEach((el) => { el.hidden = el !== next; });
      return;
    }

    current.classList.add('ah-panel-out');
    window.setTimeout(() => {
      panels.forEach((el) => { el.hidden = el !== next; });
      current.classList.remove('ah-panel-out');
      next.classList.add('ah-panel-in');
      // Force the "entering" state to actually paint before removing it, so
      // the browser has something to transition FROM.
      requestAnimationFrame(() => requestAnimationFrame(() => next.classList.remove('ah-panel-in')));
    }, 130);
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
        const userResult = await Auth().login({ email: id, password });
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
        document.querySelector('.ah-pin-box')?.focus();
        return;
      }

      if (id.includes('@')) {
        Alert()?.authFailure?.('Email or password is incorrect.');
      } else {
        Alert()?.authFailure?.(adminResult.message || 'Username or password is incorrect.');
      }
    });
  }

  /* Six single-digit boxes acting as one PIN field: typing a digit advances
     to the next box, Backspace on an empty box steps back, arrow keys move
     between boxes, and pasting a full code (e.g. from a password manager or
     an SMS prompt) fans it out across the remaining boxes. Scoped to a
     container since the page can have more than one 6-box group (admin PIN,
     password-reset code) — querying `.ah-pin-box` globally would merge them
     into one array and break both. */
  function wirePinBoxes(container) {
    const boxes = $all('.ah-pin-box', container);
    if (!boxes.length) return null;

    function value() { return boxes.map((b) => b.value).join(''); }
    function clear() { boxes.forEach((b) => { b.value = ''; }); }
    function focusBox(i) { boxes[Math.max(0, Math.min(boxes.length - 1, i))]?.focus(); }
    function firstEmptyIndex() {
      const i = boxes.findIndex((b) => !b.value);
      return i === -1 ? boxes.length - 1 : i;
    }

    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        box.value = box.value.replace(/\D/g, '').slice(-1);
        if (box.value && i < boxes.length - 1) focusBox(i + 1);
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !box.value && i > 0) {
          focusBox(i - 1);
        } else if (e.key === 'ArrowLeft' && i > 0) {
          focusBox(i - 1);
        } else if (e.key === 'ArrowRight' && i < boxes.length - 1) {
          focusBox(i + 1);
        }
      });
      box.addEventListener('paste', (e) => {
        const digits = (e.clipboardData?.getData('text') || '').replace(/\D/g, '');
        if (!digits) return;
        e.preventDefault();
        digits.slice(0, boxes.length - i).split('').forEach((d, offset) => {
          if (boxes[i + offset]) boxes[i + offset].value = d;
        });
        focusBox(Math.min(i + digits.length, boxes.length - 1));
      });
      box.addEventListener('focus', () => box.select());
    });

    return { value, clear, focusFirstEmpty: () => focusBox(firstEmptyIndex()) };
  }

  function wireAdminPinForm() {
    const form = document.getElementById('form-admin-pin');
    if (!form) return;

    const pin = wirePinBoxes(document.getElementById('ah-pin-panel'));

    document.getElementById('ah-pin-back')?.addEventListener('click', () => {
      pendingAdmin = null;
      pin?.clear();
      showPanel('ah-login-panel');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pendingAdmin) {
        Alert()?.invalid?.('Session expired. Please log in again.');
        showPanel('ah-login-panel');
        return;
      }
      const accessCode = pin?.value() || '';
      if (accessCode.length < 6) {
        Alert()?.invalid?.('Enter all 6 digits of your access code.');
        pin?.focusFirstEmpty();
        return;
      }
      const result = await Auth().adminLogin({
        username: pendingAdmin.username,
        password: pendingAdmin.password,
        accessCode,
      });
      if (!result.ok) {
        Alert()?.authFailure?.(result.message);
        pin?.clear();
        pin?.focusFirstEmpty();
        return;
      }
      Alert()?.success?.('Admin sign-in successful.', {
        onConfirm: () => { window.location.href = '../admin/index.html'; },
      });
    });
  }

  /* ---------------- "Forgot password?" -> email a 6-digit code -> verify -> reset ----------------
     Three card-swap steps, same showPanel()/wirePinBoxes() machinery as the admin PIN step
     above, each step confirmed with a popup before moving to the next:
       1. ah-forgot-panel — email -> "code sent" popup -> Continue
       2. ah-code-panel   — 6-digit code only -> "code verified" popup -> Continue
       3. ah-reset-panel  — new password + confirm -> "password reset" popup -> back to log in
     Real now that accounts live server-side (model/user_auth.py + mailer.py). The code itself
     is only checked once, in step 2; step 3 is gated on the one-time "ticket" step 2 hands back
     (see verifyResetCode/submitPasswordReset in public-auth.js), not the code again. */
  let pendingResetEmail = null;
  let pendingResetTicket = null;

  function wireForgotPasswordForm() {
    document.getElementById('ah-forgot-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      showPanel('ah-forgot-panel');
      document.getElementById('forgot-email')?.focus();
    });
    document.getElementById('ah-forgot-back')?.addEventListener('click', () => {
      showPanel('ah-login-panel');
    });

    const form = document.getElementById('form-forgot-password');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('forgot-email')?.value?.trim();
      if (!email) {
        Alert()?.invalid?.('Enter your email address.');
        return;
      }
      const result = await Auth().requestPasswordReset({ email });
      if (!result.ok) {
        Alert()?.authFailure?.(result.message);
        return;
      }
      pendingResetEmail = email;
      const targetEl = document.getElementById('ah-code-target-email');
      if (targetEl) targetEl.textContent = email;
      // "a pop up ... that the code was sent, then a button to click continue" —
      // the alert's own OK button IS that "Continue" step; the panel only swaps
      // once the visitor has acknowledged it.
      Alert()?.success?.(result.message || 'A 6-digit code was sent to your email.', {
        onConfirm: () => {
          showPanel('ah-code-panel');
          document.querySelector('#ah-code-panel .ah-pin-box')?.focus();
        },
      });
    });
  }

  function wireCodeVerifyForm() {
    const form = document.getElementById('form-verify-code');
    if (!form) return;

    const code = wirePinBoxes(document.getElementById('ah-code-panel'));

    document.getElementById('ah-code-back')?.addEventListener('click', () => {
      pendingResetEmail = null;
      pendingResetTicket = null;
      code?.clear();
      showPanel('ah-login-panel');
    });

    document.getElementById('ah-code-resend')?.addEventListener('click', async () => {
      if (!pendingResetEmail) return;
      const result = await Auth().requestPasswordReset({ email: pendingResetEmail });
      if (result.ok) {
        Alert()?.success?.(result.message || 'A new code was sent.');
      } else {
        Alert()?.authFailure?.(result.message);
      }
      code?.clear();
      code?.focusFirstEmpty();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pendingResetEmail) {
        Alert()?.invalid?.('Session expired. Start over from "Forgot password?".');
        showPanel('ah-login-panel');
        return;
      }
      const codeValue = code?.value() || '';
      if (codeValue.length < 6) {
        Alert()?.invalid?.('Enter all 6 digits of your reset code.');
        code?.focusFirstEmpty();
        return;
      }

      const result = await Auth().verifyResetCode({ email: pendingResetEmail, code: codeValue });
      if (!result.ok) {
        Alert()?.authFailure?.(result.message);
        code?.clear();
        code?.focusFirstEmpty();
        return;
      }
      pendingResetTicket = result.ticket;
      // "if match then pop up as verified then can create new password" —
      // same popup-then-Continue pattern as step 1.
      Alert()?.success?.('Code verified.', {
        onConfirm: () => {
          showPanel('ah-reset-panel');
          document.getElementById('reset-new-password')?.focus();
        },
      });
    });
  }

  function wireResetPasswordForm() {
    const form = document.getElementById('form-reset-password');
    if (!form) return;

    document.getElementById('ah-reset-back')?.addEventListener('click', () => {
      pendingResetEmail = null;
      pendingResetTicket = null;
      showPanel('ah-login-panel');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pendingResetEmail || !pendingResetTicket) {
        Alert()?.invalid?.('Session expired. Start over from "Forgot password?".');
        showPanel('ah-login-panel');
        return;
      }
      const newPassword = document.getElementById('reset-new-password')?.value || '';
      const confirm = document.getElementById('reset-confirm-password')?.value || '';

      if (!Auth().passwordStrength(newPassword).valid) {
        Alert()?.invalid?.('New password must be at least 8 characters with uppercase, lowercase, and a number.');
        return;
      }
      if (newPassword !== confirm) {
        Alert()?.invalid?.('Passwords do not match.');
        return;
      }

      const result = await Auth().submitPasswordReset({ email: pendingResetEmail, ticket: pendingResetTicket, newPassword });
      if (!result.ok) {
        Alert()?.authFailure?.(result.message);
        return;
      }
      pendingResetEmail = null;
      pendingResetTicket = null;
      // "if done correctly it will pop up as successful then button to go back to login"
      Alert()?.success?.('Your password has been reset. You can log in now.', {
        onConfirm: () => showPanel('ah-login-panel'),
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

    form.addEventListener('submit', async (e) => {
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
      const result = await Auth().signup({ name, email, password });
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
  // A slide's data-credit is a full line like "Photo: Patrickroque01 — Wikimedia
  // Commons (CC BY-SA 4.0)". The trigger pill only shows the photographer's name;
  // the full line (linked) shows up in the popover on hover/focus/tap.
  function creditName(credit) {
    return credit.replace(/^Photo:\s*/i, '').split(/\s+—\s+/)[0].trim() || 'Photo credit';
  }

  function wireSlideshow() {
    const slides = $all('.ah-slide');
    const dots = $all('.ah-slide-dot');
    const creditWrap = document.getElementById('ah-slide-credit');
    const creditTrigger = document.getElementById('ah-credit-trigger');
    const creditNameEl = document.getElementById('ah-credit-name');
    const creditPopover = document.getElementById('ah-credit-popover');
    if (!slides.length) return;

    let index = Math.max(0, slides.findIndex((s) => s.classList.contains('is-active')));
    let timer = null;

    function render() {
      slides.forEach((s, i) => s.classList.toggle('is-active', i === index));
      dots.forEach((d, i) => {
        d.classList.toggle('is-active', i === index);
        d.setAttribute('aria-selected', i === index ? 'true' : 'false');
      });
      const credit = slides[index].getAttribute('data-credit') || '';
      const href = slides[index].getAttribute('data-credit-href');
      if (creditNameEl) creditNameEl.textContent = creditName(credit);
      if (creditPopover) {
        creditPopover.innerHTML = href
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

    // Hover already reveals the popover via CSS (:hover / :focus-within); the
    // click here just makes it work on touch, where there is no hover.
    if (creditWrap && creditTrigger) {
      creditTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = creditWrap.classList.toggle('is-open');
        creditTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.addEventListener('click', (e) => {
        if (!creditWrap.contains(e.target)) {
          creditWrap.classList.remove('is-open');
          creditTrigger.setAttribute('aria-expanded', 'false');
        }
      });
    }

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
    wireLoginForm();
    wireAdminPinForm();
    wireForgotPasswordForm();
    wireCodeVerifyForm();
    wireResetPasswordForm();
    wireSignupForm();
    wireTermsModal();
    wireSlideshow();
    loadStatRow();
  });
})();
