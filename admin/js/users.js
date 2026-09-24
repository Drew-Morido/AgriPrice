/* AgriPricePH — User Management page (admin/pages/users.html).
   Create / read / update / deactivate retailer and admin accounts via /api/admin/accounts*.
   "Delete" is a soft deactivation (reversible) — see model/user_management.py. */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.UserManagement = (function () {

  let _data = { users: [], admins: [], stats: {}, me: {} };
  let _tab = 'users';
  let _query = '';
  let _status = 'all';
  let _editing = null; // null = creating, otherwise the account object being edited
  let _formKind = 'users';

  const ICON = {
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    deactivate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
    reactivate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  // ── lifecycle ────────────────────────────────────────────────────────────

  function init() {
    _tab = 'users'; _query = ''; _status = 'all'; _editing = null;
    mountOverlay();
    bindEvents();
    load();
  }

  function destroy() {
    document.querySelectorAll('body > .um-modal-overlay').forEach((el) => el.remove());
    document.removeEventListener('keydown', onKeydown);
  }

  // Same reason as account.js: the page fragment lives in a clipped container below the sidebar,
  // so the dialog is re-parented to <body> to cover the whole viewport.
  function mountOverlay() {
    document.querySelectorAll('body > .um-modal-overlay').forEach((el) => el.remove());
    const el = document.getElementById('um-form-overlay');
    if (!el) return;
    el.classList.add('um-modal-overlay');
    document.body.appendChild(el);
  }

  function bindEvents() {
    document.querySelectorAll('#page-outlet .um-tab').forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });
    document.getElementById('um-search')?.addEventListener('input', (e) => { _query = e.target.value || ''; renderTable(); });
    document.getElementById('um-status-filter')?.addEventListener('change', (e) => { _status = e.target.value; renderTable(); });
    document.getElementById('um-add-btn')?.addEventListener('click', () => openForm(_tab, null));

    document.getElementById('um-tbody')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const list = btn.dataset.kind === 'admins' ? _data.admins : _data.users;
      const acct = list.find((a) => String(a.id) === btn.dataset.id);
      if (!acct) return;
      if (btn.dataset.act === 'edit') openForm(btn.dataset.kind, acct);
      if (btn.dataset.act === 'toggle') toggleStatus(btn.dataset.kind, acct);
    });

    document.getElementById('um-form-close')?.addEventListener('click', closeForm);
    document.getElementById('um-form-cancel')?.addEventListener('click', closeForm);
    document.getElementById('um-form-overlay')?.addEventListener('mousedown', (e) => {
      if (e.target.id === 'um-form-overlay') closeForm();
    });
    document.getElementById('um-form')?.addEventListener('submit', (e) => { e.preventDefault(); submitForm(); });
    document.getElementById('um-f-password')?.addEventListener('input', (e) => renderStrength(e.target.value));
    document.getElementById('um-f-code')?.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    });
    document.getElementById('um-f-password-toggle')?.addEventListener('click', togglePasswordVisibility);
    document.addEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    const overlay = document.getElementById('um-form-overlay');
    if (e.key === 'Escape' && overlay && !overlay.hidden) closeForm();
  }

  // ── data ─────────────────────────────────────────────────────────────────

  async function load() {
    try {
      const res = await AgriPricePH.API.get('/api/admin/accounts', { noCache: true });
      if (!res.success) throw new Error(res.error || 'Could not load accounts.');
      _data = res;
      renderAll();
    } catch (e) {
      const msg = e.status === 401
        ? 'Your admin session has expired. Please sign in again.'
        : 'Couldn’t load accounts — the backend is unreachable.';
      const tbody = document.getElementById('um-tbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="um-empty">${esc(msg)}</td></tr>`;
    }
  }

  function canManageAdmins() {
    return !!_data.me?.can_manage_admins;
  }

  // ── render ───────────────────────────────────────────────────────────────

  function renderAll() {
    const s = _data.stats || {};
    setText('um-stat-total', s.total ?? '—');
    setText('um-stat-users', s.users_total != null ? `${s.users_active}` : '—');
    setText('um-stat-admins', s.admins_total != null ? `${s.admins_active}` : '—');
    setText('um-stat-deactivated', s.deactivated ?? '—');
    setText('um-count-users', (_data.users || []).length);
    setText('um-count-admins', (_data.admins || []).length);

    const me = _data.me || {};
    const meEl = document.getElementById('um-me');
    if (meEl) {
      meEl.innerHTML = me.username
        ? `Signed in as <b>@${esc(me.username)}</b> <span class="pill ${me.role === 'super_admin' ? 'um-pill-super' : 'pill-admin'}">${esc(me.role_label)}</span>`
        : '';
    }
    setTab(_tab);
  }

  function setTab(tab) {
    _tab = tab === 'admins' ? 'admins' : 'users';
    document.querySelectorAll('#page-outlet .um-tab').forEach((b) => {
      const on = b.dataset.tab === _tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    const addBtn = document.getElementById('um-add-btn');
    setText('um-add-label', _tab === 'admins' ? 'Add Admin' : 'Add Retailer');
    if (addBtn) addBtn.hidden = _tab === 'admins' && !canManageAdmins();

    const notice = document.getElementById('um-notice');
    if (notice) {
      const readOnly = _tab === 'admins' && !canManageAdmins();
      notice.hidden = !readOnly;
      notice.innerHTML = readOnly
        ? `${ICON.info}<span>You can view administrator accounts, but only a <b>Super Admin</b> can add, edit, or deactivate them.</span>`
        : '';
    }

    const search = document.getElementById('um-search');
    if (search) search.placeholder = _tab === 'admins' ? 'Search name, username, or email…' : 'Search name or email…';
    renderTable();
  }

  function filtered() {
    const list = _tab === 'admins' ? (_data.admins || []) : (_data.users || []);
    const q = _query.trim().toLowerCase();
    return list.filter((a) => {
      if (_status !== 'all' && a.status !== _status) return false;
      if (!q) return true;
      return `${a.name} ${a.email || ''} ${a.username || ''}`.toLowerCase().includes(q);
    });
  }

  function renderTable() {
    const thead = document.getElementById('um-thead');
    const tbody = document.getElementById('um-tbody');
    if (!thead || !tbody) return;

    const isAdmins = _tab === 'admins';
    thead.innerHTML = `<tr>
      <th>Account</th>
      <th>Role</th>
      <th>Status</th>
      <th>${isAdmins ? 'Created by' : 'Date joined'}</th>
      <th>Last sign-in</th>
      <th class="um-col-actions">Actions</th>
    </tr>`;

    const rows = filtered();
    const total = (isAdmins ? _data.admins : _data.users)?.length || 0;
    setText('um-result-count', rows.length === total ? `${total} account${total === 1 ? '' : 's'}` : `${rows.length} of ${total}`);

    if (!rows.length) {
      const msg = total
        ? 'No accounts match your search or filter.'
        : (isAdmins ? 'No administrator accounts yet.' : 'No retailer accounts yet. Retailers appear here when they sign up on the public site, or you can add one.');
      tbody.innerHTML = `<tr><td colspan="6" class="um-empty">${esc(msg)}</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((a) => rowHtml(a, isAdmins)).join('');
  }

  function rowHtml(a, isAdmins) {
    const inactive = a.status !== 'active';
    const me = _data.me || {};
    const isSelf = isAdmins && (a.is_primary ? me.kind === 'primary' : (me.kind === 'account' && me.id === a.id));
    const sub = isAdmins
      ? `@${esc(a.username)}${a.email ? ` · ${esc(a.email)}` : ''}`
      : esc(a.email);

    const rolePill = a.role === 'super_admin'
      ? `<span class="pill um-pill-super">${esc(a.role_label)}</span>`
      : a.role === 'admin'
        ? `<span class="pill pill-admin">${esc(a.role_label)}</span>`
        : `<span class="pill pill-green">${esc(a.role_label || 'Retailer')}</span>`;

    const statusPill = inactive
      ? `<span class="pill pill-neutral um-status"><i></i>Deactivated</span>`
      : `<span class="pill pill-success um-status"><i></i>Active</span>`;

    const fourth = isAdmins
      ? (a.is_primary ? '<span class="um-muted">Built-in account</span>' : (a.created_by ? `@${esc(a.created_by)}` : '<span class="um-muted">—</span>'))
      : `<span title="${esc(fmtDateTime(a.created_at))}">${esc(fmtDate(a.created_at))}</span>`;

    let actions;
    if (isAdmins && a.is_primary) {
      actions = `<span class="um-locked" title="The built-in Super Admin is edited from Account Profile and can't be deactivated.">${ICON.lock}<span>Protected</span></span>`;
    } else if (isAdmins && !canManageAdmins()) {
      actions = '<span class="um-muted">View only</span>';
    } else {
      const toggleLabel = inactive ? 'Reactivate' : 'Deactivate';
      const disableToggle = isSelf && !inactive;
      actions = `
        <button type="button" class="um-icon-btn" data-act="edit" data-kind="${_tab}" data-id="${esc(a.id)}" title="Edit account" aria-label="Edit ${esc(a.name)}">${ICON.edit}</button>
        <button type="button" class="um-icon-btn ${inactive ? 'success' : 'danger'}" data-act="toggle" data-kind="${_tab}" data-id="${esc(a.id)}"
          title="${disableToggle ? 'You can’t deactivate your own account' : toggleLabel + ' account'}" aria-label="${toggleLabel} ${esc(a.name)}" ${disableToggle ? 'disabled' : ''}>
          ${inactive ? ICON.reactivate : ICON.deactivate}
        </button>`;
    }

    return `
      <tr class="${inactive ? 'um-row-inactive' : ''}">
        <td>
          <div class="um-account">
            <span class="um-avatar ${isAdmins ? 'admin' : ''}" aria-hidden="true">${esc(initials(a.name))}</span>
            <div class="um-account-text">
              <div class="um-account-name">${esc(a.name)}${isSelf ? ' <span class="um-you">You</span>' : ''}</div>
              <div class="um-account-sub">${sub}</div>
            </div>
          </div>
        </td>
        <td>${rolePill}</td>
        <td>${statusPill}${inactive && a.deactivated_at ? `<div class="um-account-sub">since ${esc(fmtDate(a.deactivated_at))}</div>` : ''}</td>
        <td>${fourth}</td>
        <td><span title="${esc(fmtDateTime(a.last_login_at))}">${esc(fmtRelative(a.last_login_at))}</span></td>
        <td class="um-col-actions"><div class="um-row-actions">${actions}</div></td>
      </tr>`;
  }

  // ── create / edit dialog ─────────────────────────────────────────────────

  function openForm(kind, acct) {
    _formKind = kind === 'admins' ? 'admins' : 'users';
    _editing = acct || null;
    const isAdmin = _formKind === 'admins';
    const creating = !acct;

    document.querySelectorAll('#um-form [data-for="admin"]').forEach((el) => { el.hidden = !isAdmin; });

    setText('um-form-title', `${creating ? 'Add' : 'Edit'} ${isAdmin ? 'Admin' : 'Retailer'}`);
    setText('um-form-sub', creating
      ? (isAdmin ? 'Creates an administrator who signs in with a username, password, and 6-digit code.'
                 : 'Creates a public-site account that can sign in right away.')
      : `Updating ${acct.name}${isAdmin ? ` (@${acct.username})` : ''}.`);
    const icon = document.getElementById('um-form-icon');
    if (icon) icon.innerHTML = isAdmin ? ICON.shield : ICON.user;
    setText('um-form-save', creating ? 'Create Account' : 'Save Changes');

    const username = document.getElementById('um-f-username');
    if (username) {
      username.value = acct?.username || '';
      username.readOnly = !creating;
    }
    const uHint = document.getElementById('um-f-username-hint');
    if (uHint) uHint.hidden = !creating;
    setVal('um-f-name', acct?.name || '');
    setVal('um-f-email', acct?.email || '');
    setVal('um-f-role', acct?.role === 'super_admin' ? 'super_admin' : 'admin');
    setVal('um-f-password', '');
    setVal('um-f-code', '');
    const pw = document.getElementById('um-f-password');
    if (pw) pw.type = 'password';
    renderStrength('');
    document.getElementById('um-f-password-opt').hidden = creating;
    document.getElementById('um-f-code-opt').hidden = creating;

    const roleSel = document.getElementById('um-f-role');
    const me = _data.me || {};
    if (roleSel) roleSel.disabled = !!(acct && me.kind === 'account' && me.id === acct.id);

    showError('');
    const overlay = document.getElementById('um-form-overlay');
    if (overlay) overlay.hidden = false;
    setTimeout(() => document.getElementById(creating && isAdmin ? 'um-f-username' : 'um-f-name')?.focus(), 30);
  }

  function closeForm() {
    const overlay = document.getElementById('um-form-overlay');
    if (overlay) overlay.hidden = true;
    _editing = null;
  }

  function collectForm() {
    const isAdmin = _formKind === 'admins';
    const body = {
      name: getVal('um-f-name').trim(),
      email: getVal('um-f-email').trim(),
      password: getVal('um-f-password'),
    };
    if (isAdmin) {
      body.role = getVal('um-f-role');
      body.access_code = getVal('um-f-code').trim();
      if (!_editing) body.username = getVal('um-f-username').trim();
    }
    return body;
  }

  // Client-side checks mirror the server's (model/user_management.py), which stays authoritative.
  function validate(body) {
    const isAdmin = _formKind === 'admins';
    const creating = !_editing;
    if (isAdmin && creating && !/^[A-Za-z0-9._-]{3,32}$/.test(body.username)) {
      return 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.';
    }
    if (body.name.length < 2) return 'Please enter the full name (at least 2 characters).';
    if ((!isAdmin || body.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return isAdmin ? 'That email address doesn’t look valid.' : 'Please enter a valid email address.';
    }
    if (creating || body.password) {
      if (strengthScore(body.password) < 4) {
        return 'Password must be at least 8 characters with an uppercase letter, a lowercase letter, and a number.';
      }
    }
    if (isAdmin && (creating || body.access_code) && !/^\d{6}$/.test(body.access_code)) {
      return 'Access code must be exactly 6 digits.';
    }
    return '';
  }

  async function submitForm() {
    const body = collectForm();
    const err = validate(body);
    if (err) { showError(err); return; }
    showError('');

    const base = `/api/admin/accounts/${_formKind}`;
    const saveBtn = document.getElementById('um-form-save');
    if (saveBtn) saveBtn.disabled = true;
    AgriPricePH.Modals.loading(_editing ? 'Saving changes…' : 'Creating account…');
    try {
      const res = _editing
        ? await AgriPricePH.API.put(`${base}/${encodeURIComponent(_editing.id)}`, body)
        : await AgriPricePH.API.post(base, body);
      AgriPricePH.Modals.hideLoading();
      if (!res.ok || !res.data?.success) {
        showError(res.data?.error || 'Could not save this account.');
        return;
      }
      const wasCreating = !_editing;
      closeForm();
      await load();
      await AgriPricePH.Modals.alert({
        title: wasCreating ? 'Account created' : 'Account updated',
        text: res.data.message,
        type: 'success',
      });
    } catch {
      AgriPricePH.Modals.hideLoading();
      showError('Backend unreachable — please try again.');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // ── deactivate / reactivate ──────────────────────────────────────────────

  async function toggleStatus(kind, acct) {
    const activating = acct.status !== 'active';
    const isAdmin = kind === 'admins';
    const who = isAdmin ? `${acct.name} (@${acct.username})` : `${acct.name} (${acct.email})`;
    const ok = await AgriPricePH.Modals.confirm(activating
      ? {
          title: 'Reactivate this account?',
          text: `${who} will be able to sign in again.`,
          type: 'info', okText: 'Reactivate',
        }
      : {
          title: 'Deactivate this account?',
          text: `${who} will no longer be able to sign in${isAdmin ? ' and will be signed out immediately' : ''}. `
            + 'The account and its history are kept, and you can reactivate it at any time.',
          type: 'warning', okText: 'Deactivate', danger: true,
        });
    if (!ok) return;

    AgriPricePH.Modals.loading(activating ? 'Reactivating…' : 'Deactivating…');
    try {
      const res = await AgriPricePH.API.post(`/api/admin/accounts/${kind}/${encodeURIComponent(acct.id)}/status`, { active: activating });
      AgriPricePH.Modals.hideLoading();
      if (!res.ok || !res.data?.success) {
        await AgriPricePH.Modals.alert({ title: 'Action failed', text: res.data?.error || 'Could not update this account.', type: 'danger' });
        return;
      }
      await load();
      await AgriPricePH.Modals.alert({
        title: activating ? 'Account reactivated' : 'Account deactivated',
        text: res.data.message,
        type: activating ? 'success' : 'info',
      });
    } catch {
      AgriPricePH.Modals.hideLoading();
      await AgriPricePH.Modals.alert({ title: 'Backend unreachable', text: 'Please try again.', type: 'danger' });
    }
  }

  // ── password helpers ─────────────────────────────────────────────────────

  function strengthScore(pw) {
    pw = pw || '';
    return (pw.length >= 8 ? 1 : 0) + (/[A-Z]/.test(pw) ? 1 : 0) + (/[a-z]/.test(pw) ? 1 : 0) + (/\d/.test(pw) ? 1 : 0);
  }

  function renderStrength(pw) {
    const el = document.getElementById('um-strength');
    if (!el) return;
    const score = pw ? strengthScore(pw) : 0;
    el.dataset.score = String(score);
    el.hidden = !pw;
  }

  function togglePasswordVisibility() {
    const input = document.getElementById('um-f-password');
    const btn = document.getElementById('um-f-password-toggle');
    if (!input || !btn) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    btn.title = show ? 'Hide password' : 'Show password';
    btn.classList.toggle('on', show);
  }

  function showError(msg) {
    const el = document.getElementById('um-form-error');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  // ── formatting ───────────────────────────────────────────────────────────

  function parseDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d) ? null : d;
  }

  function fmtDate(iso) {
    const d = parseDate(iso);
    return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  }

  function fmtDateTime(iso) {
    const d = parseDate(iso);
    return d ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  }

  function fmtRelative(iso) {
    const d = parseDate(iso);
    if (!d) return 'Never';
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
    const days = Math.round(hrs / 24);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
    return fmtDate(iso);
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function setVal(id, v) {
    const el = document.getElementById(id);
    if (el) el.value = v ?? '';
  }
  function getVal(id) {
    return document.getElementById(id)?.value ?? '';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { init, destroy };
})();
