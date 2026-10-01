/* AgriPricePH — forced change of the built-in admin's default login.
   While the built-in admin is still signed in with the documented defaults (Admin@123 / 123456),
   the server refuses every admin action (api/app.py MUST_CHANGE_MSG) and this screen stays up until
   both are replaced through POST /api/admin/me/credentials. The only other way out is Log out. */
(function () {
  const PW_RULES = [
    ['len', '8+ characters', (p) => p.length >= 8],
    ['upper', 'Uppercase letter', (p) => /[A-Z]/.test(p)],
    ['lower', 'Lowercase letter', (p) => /[a-z]/.test(p)],
    ['digit', 'Number', (p) => /\d/.test(p)],
    ['notdef', 'Not the default password', (p) => !!p && p !== 'Admin@123'],
  ];

  function token() {
    try { return JSON.parse(sessionStorage.getItem('agriprice_admin_session') || 'null')?.token || ''; } catch { return ''; }
  }

  function easyPin(p) {
    return /^(\d)\1{5}$/.test(p) || '01234567890'.includes(p) || '09876543210'.includes(p)
      || p.slice(0, 3) === p.slice(3) || /^(\d\d)\1\1$/.test(p);
  }

  function field(id, label, type, extra = '') {
    return `<div class="um-field" data-field="${id}">
      <label for="${id}">${label}</label>
      <div class="um-input-wrap"><input type="${type}" class="form-input${type === 'password' && extra.includes('pin') ? ' um-code-input' : ''}" id="${id}" ${extra} /></div>
      <small class="um-msg" id="${id}-msg"></small>
    </div>`;
  }

  function setMsg(id, state, text) {
    const f = document.querySelector(`[data-field="${id}"]`);
    if (!f) return;
    f.classList.remove('is-ok', 'is-error');
    if (state) f.classList.add(`is-${state}`);
    const m = document.getElementById(`${id}-msg`);
    if (m) m.textContent = text || '';
  }

  function show(me) {
    if (document.getElementById('cred-overlay')) return;
    const root = document.createElement('div');
    root.id = 'cred-overlay';
    root.className = 'alert-modal-overlay um-modal-overlay';
    root.innerHTML = `
      <div class="alert-modal card um-modal cred-modal" role="dialog" aria-modal="true" aria-labelledby="cred-title">
        <div class="card-header">
          <div class="um-modal-heading">
            <span class="um-modal-icon cred-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></span>
            <div>
              <span class="card-title" id="cred-title">Secure your admin account</span>
              <p class="um-modal-sub">You signed in with the default password or PIN that is printed in the project documents. Set your own before using the dashboard.</p>
            </div>
          </div>
        </div>
        <div class="card-body">
          <form class="um-form" id="cred-form" novalidate autocomplete="off">
            ${field('cred-current', 'Current password', 'password', 'autocomplete="current-password"')}
            <div class="um-sec-group">
              <div class="um-sec-title">New password</div>
              ${field('cred-pw', 'New password', 'password', 'autocomplete="new-password" maxlength="128"')}
              <ul class="um-checklist" id="cred-rules">${PW_RULES.map(([k, t]) => `<li data-rule="${k}">${t}</li>`).join('')}</ul>
              ${field('cred-pw2', 'Confirm new password', 'password', 'autocomplete="new-password" maxlength="128"')}
            </div>
            <div class="um-sec-group">
              <div class="um-sec-title">New 6-digit PIN <span class="um-sec-sub">asked after the password at sign-in</span></div>
              ${field('cred-pin', 'New PIN', 'password', 'inputmode="numeric" maxlength="6" data-pin="1"')}
              ${field('cred-pin2', 'Confirm new PIN', 'password', 'inputmode="numeric" maxlength="6" data-pin="1"')}
            </div>
            <p class="um-form-error" id="cred-error" role="alert" hidden></p>
            <div class="alert-form-actions">
              <button type="button" class="btn btn-outline" id="cred-logout">Log out</button>
              <button type="submit" class="btn btn-primary" id="cred-save">Save and continue</button>
            </div>
          </form>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.hidden = false;
    setTimeout(() => document.getElementById('cred-current')?.focus(), 60);

    root.querySelectorAll('input[data-pin]').forEach((inp) => {
      inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 6); });
    });
    document.getElementById('cred-pw')?.addEventListener('input', (e) => {
      const p = e.target.value;
      root.querySelectorAll('#cred-rules li').forEach((li) => {
        const rule = PW_RULES.find((r) => r[0] === li.dataset.rule);
        li.classList.toggle('met', !!p && rule[2](p));
      });
    });
    document.getElementById('cred-logout')?.addEventListener('click', () => document.getElementById('admin-logout-btn')?.click());
    document.getElementById('cred-form')?.addEventListener('submit', (e) => { e.preventDefault(); save(root); });
  }

  function validate() {
    const v = (id) => document.getElementById(id)?.value || '';
    let bad = '';
    const fail = (id, msg) => { setMsg(id, 'error', msg); if (!bad) bad = id; };
    ['cred-current', 'cred-pw', 'cred-pw2', 'cred-pin', 'cred-pin2'].forEach((id) => setMsg(id, '', ''));
    if (!v('cred-current')) fail('cred-current', 'Enter your current password.');
    const pw = v('cred-pw');
    if (!PW_RULES.every((r) => r[2](pw))) fail('cred-pw', 'Meet every requirement above.');
    else if (pw.toLowerCase().includes('admin')) fail('cred-pw', 'Don’t use the username inside the password.');
    if (v('cred-pw2') !== pw || !pw) fail('cred-pw2', 'Doesn’t match the new password.');
    const pin = v('cred-pin');
    if (!/^\d{6}$/.test(pin)) fail('cred-pin', 'Enter exactly 6 digits.');
    else if (pin === '123456' || easyPin(pin)) fail('cred-pin', 'Too easy to guess. Avoid 123456, 111111, 121212 and the like.');
    if (v('cred-pin2') !== pin || !pin) fail('cred-pin2', 'Doesn’t match the new PIN.');
    return bad;
  }

  async function save(root) {
    const err = document.getElementById('cred-error');
    if (err) err.hidden = true;
    const bad = validate();
    if (bad) { document.getElementById(bad)?.focus(); return; }
    const btn = document.getElementById('cred-save');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`${AgriPricePH.API.BASE}/api/admin/me/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({
          current_password: document.getElementById('cred-current').value,
          new_password: document.getElementById('cred-pw').value,
          new_pin: document.getElementById('cred-pin').value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        const msg = data.error || 'Could not save. Please try again.';
        if (/current password/i.test(msg)) { setMsg('cred-current', 'error', msg); document.getElementById('cred-current')?.focus(); }
        else if (/pin/i.test(msg)) setMsg('cred-pin', 'error', msg);
        else if (/password/i.test(msg)) setMsg('cred-pw', 'error', msg);
        else if (err) { err.textContent = msg; err.hidden = false; }
        return;
      }
      root.remove();
      await AgriPricePH.Modals?.alert?.({
        title: 'Your admin account is secured',
        text: 'New password and PIN saved. Use them from your next sign-in.',
        type: 'success',
      });
      window.location.reload();
    } catch {
      if (err) { err.textContent = 'Backend unreachable. Please try again.'; err.hidden = false; }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const role = AgriPricePH.AdminRole;
    if (!role) return;
    const me = await role.ready();
    if (me?.must_change_credentials) show(me);
  });
})();
