/* AgriPricePH — User Management page (admin/pages/users.html). Super Admin only.
   Create / read / update / deactivate public user and admin accounts via /api/admin/accounts*.
   "Delete" is a soft deactivation (reversible) — see model/user_management.py.
   Add Admin is a 3-step wizard (basic info → role → password + PIN) with a review step; every field
   is checked live as it is typed. The server (model/user_management.py) re-checks everything. */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.UserManagement = (function () {

  let _data = { users: [], admins: [], stats: {}, me: {} };
  let _tab = 'users';
  let _query = '';
  let _status = 'all';
  let _editing = null; // null = creating, otherwise the account object being edited
  let _formKind = 'users';
  let _formTouched = new Set();

  // Add Admin wizard state
  let _wizStep = 1;
  let _wizMax = 1;
  let _wizTouched = new Set();
  let _wizBusy = false;
  let _pin = null;
  let _cpin = null;       // PIN boxes in the "confirm changes" dialog
  let _pending = null;    // { acct, body } waiting for that confirmation

  const ICON = {
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    deactivate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
    reactivate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  };

  const ROLE_TEXT = {
    admin: { label: 'Admin', desc: 'Day-to-day operator — no User Management, Settings or Training changes' },
    super_admin: { label: 'Super Admin', desc: 'Full access, including User Management and Settings' },
  };

  // ── lifecycle ────────────────────────────────────────────────────────────

  function init() {
    _tab = 'users'; _query = ''; _status = 'all'; _editing = null;
    mountOverlays();
    _pin = buildPin('uw-pin', onPinInput);
    _cpin = buildPin('uc-pin', onConfirmPinInput);
    bindEvents();
    load();
  }

  function destroy() {
    document.querySelectorAll('body > .um-modal-overlay').forEach((el) => el.remove());
    document.removeEventListener('keydown', onKeydown);
  }

  // Same reason as account.js: the page fragment lives in a clipped container below the sidebar,
  // so the dialogs are re-parented to <body> to cover the whole viewport.
  function mountOverlays() {
    document.querySelectorAll('body > .um-modal-overlay').forEach((el) => el.remove());
    ['um-form-overlay', 'um-wiz-overlay', 'um-profile-overlay', 'um-confirm-overlay'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.add('um-modal-overlay');
      document.body.appendChild(el);
    });
  }

  function bindEvents() {
    document.querySelectorAll('#page-outlet .um-tab').forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });
    const search = document.getElementById('um-search');
    search?.addEventListener('input', (e) => { _query = e.target.value || ''; renderTable(); });
    search?.addEventListener('focus', () => search.removeAttribute('readonly'));
    document.getElementById('um-status-filter')?.addEventListener('change', (e) => { _status = e.target.value; renderTable(); });
    document.getElementById('um-add-btn')?.addEventListener('click', () => (_tab === 'admins' ? openWizard() : openForm('users', null)));

    // A row opens the profile summary; its Edit / Deactivate buttons act directly.
    const findAcct = (kind, id) => (kind === 'admins' ? _data.admins : _data.users).find((a) => String(a.id) === String(id));
    const tbody = document.getElementById('um-tbody');
    tbody?.addEventListener('click', (e) => {
      if (e.target.closest('[data-clear-filters]')) { clearFilters(); return; }
      const btn = e.target.closest('[data-act]');
      if (btn) {
        const acct = findAcct(btn.dataset.kind, btn.dataset.id);
        if (!acct) return;
        if (btn.dataset.act === 'edit') openForm(btn.dataset.kind, acct);
        if (btn.dataset.act === 'toggle') toggleStatus(btn.dataset.kind, acct);
        return;
      }
      const row = e.target.closest('tr[data-id]');
      const acct = row && findAcct(row.dataset.kind, row.dataset.id);
      if (acct) openProfile(row.dataset.kind, acct);
    });
    tbody?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('tr[data-id]');
      if (!row || e.target !== row) return;
      e.preventDefault();
      const acct = findAcct(row.dataset.kind, row.dataset.id);
      if (acct) openProfile(row.dataset.kind, acct);
    });

    // Password show/hide buttons (each toggles its field and that field's confirm box).
    document.querySelectorAll('.um-modal-overlay .um-pass-toggle[data-toggle]').forEach((btn) => {
      btn.innerHTML = ICON.eye;
      btn.addEventListener('click', () => togglePasswordVisibility(btn));
    });
    // Caps Lock reminder on every password-type box.
    document.querySelectorAll('.um-modal-overlay input[type="password"]').forEach((inp) => {
      const onKey = (e) => setCapsLock(inp, e.getModifierState && e.getModifierState('CapsLock'));
      inp.addEventListener('keyup', onKey);
      inp.addEventListener('keydown', onKey);
      inp.addEventListener('blur', () => setCapsLock(inp, false));
    });

    bindPhotoPickers();
    bindWizard();
    bindForm();
    bindProfile();
    bindConfirm();
    document.addEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('um-confirm-overlay')?.hidden) closeConfirm();
    else if (!document.getElementById('um-profile-overlay')?.hidden) closeProfile();
    else if (!document.getElementById('um-wiz-overlay')?.hidden) closeWizard();
    else if (!document.getElementById('um-form-overlay')?.hidden) closeForm();
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
        : e.status === 403
          ? 'User Management is available to Super Admin accounts only.'
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
    setText('um-add-label', _tab === 'admins' ? 'Add Admin' : 'Add Public User');
    if (addBtn) addBtn.hidden = _tab === 'admins' && !canManageAdmins();

    const notice = document.getElementById('um-notice');
    if (notice) {
      const readOnly = _tab === 'admins' && !canManageAdmins();
      notice.hidden = !readOnly;
      notice.innerHTML = readOnly
        ? `${ICON.info}<span>Only a <b>Super Admin</b> can add, edit, or deactivate administrator accounts.</span>`
        : '';
    }

    const search = document.getElementById('um-search');
    if (search) search.placeholder = _tab === 'admins' ? 'Search name, username, or email…' : 'Search name or email…';
    renderTable();
  }

  /** Read the search box and status filter as they are on screen. A browser can fill or restore
   *  them without an input event (autofill, back/forward), which used to leave the table filtering
   *  by something the person could not see. */
  function syncFilters() {
    _query = document.getElementById('um-search')?.value || '';
    _status = document.getElementById('um-status-filter')?.value || 'all';
  }

  function clearFilters() {
    const search = document.getElementById('um-search');
    const status = document.getElementById('um-status-filter');
    if (search) search.value = '';
    if (status) status.value = 'all';
    syncFilters();
    renderTable();
  }

  function filtered() {
    syncFilters();
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
      if (total) {
        const parts = [];
        if (_query.trim()) parts.push(`search “${_query.trim()}”`);
        if (_status !== 'all') parts.push(`status “${_status === 'active' ? 'Active' : 'Deactivated'}”`);
        tbody.innerHTML = `<tr><td colspan="6" class="um-empty">
          No accounts match the ${esc(parts.join(' and ') || 'current filter')}.
          <button type="button" class="btn btn-outline btn-sm um-clear-filters" data-clear-filters>Clear search &amp; filter</button>
        </td></tr>`;
        return;
      }
      const msg = isAdmins ? 'No administrator accounts yet.' : 'No public user accounts yet. Public users appear here when they sign up on the public site, or you can add one.';
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
        : `<span class="pill pill-green">${esc(a.role_label || 'Public User')}</span>`;

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
      <tr class="um-row${inactive ? ' um-row-inactive' : ''}" data-kind="${_tab}" data-id="${esc(a.id)}" tabindex="0" title="View profile">
        <td>
          <div class="um-account">
            ${avatarHtml(a, isAdmins ? 'admin' : '')}
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

  // ── live validation (shared by the wizard and the edit form) ─────────────
  // Each checker returns { state: 'ok' | 'warn' | 'error' | 'idle', msg, soft?, suggest? }.
  // `soft` errors are "not finished yet" (too short, missing ".com", 3 more digits): shown in grey
  // while the person is still typing and in red only once they leave the field or press Next.

  const NAME_CHARS = /^[A-Za-zÀ-ÖØ-öø-ÿ .'-]+$/;
  const EMAIL_STRICT = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
  const KNOWN_DOMAINS = ['gmail.com', 'yahoo.com', 'yahoo.com.ph', 'outlook.com', 'hotmail.com', 'live.com',
    'icloud.com', 'ymail.com', 'protonmail.com', 'proton.me', 'msn.com', 'aol.com', 'da.gov.ph', 'gov.ph',
    'deped.gov.ph', 'up.edu.ph', 'edu.ph'];
  const TLD_FIX = { con: 'com', cmo: 'com', cm: 'com', om: 'com', comm: 'com', vom: 'com', xom: 'com', coom: 'com', ocm: 'com', ph1: 'ph' };

  function adminUsernames() {
    return (_data.admins || []).map((a) => String(a.username || '').toLowerCase());
  }

  function emailsInUse(kind, exceptId) {
    const list = kind === 'admins' ? (_data.admins || []) : (_data.users || []);
    return list.filter((a) => a.email && String(a.id) !== String(exceptId)).map((a) => a.email.toLowerCase());
  }

  function checkUsername(v) {
    if (!v) return { state: 'error', msg: 'Enter a username.' };
    if (/\s/.test(v)) return { state: 'error', msg: 'No spaces — use a dot or underscore instead (e.g. juan.delacruz).' };
    const bad = v.match(/[^A-Za-z0-9._-]/);
    if (bad) return { state: 'error', msg: `"${bad[0]}" isn't allowed. Use letters, numbers, dot, dash or underscore.` };
    if (v.length < 3) return { state: 'error', soft: true, msg: `At least 3 characters (${3 - v.length} more).` };
    if (adminUsernames().includes(v.toLowerCase())) return { state: 'error', msg: `@${v} is already taken. Try another one.` };
    return { state: 'ok', msg: `@${v} is available.` };
  }

  function checkName(raw) {
    const v = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!v) return { state: 'error', msg: 'Enter the full name.' };
    if (/\d/.test(v)) return { state: 'error', msg: 'Names can’t contain numbers.' };
    if (!NAME_CHARS.test(v)) return { state: 'error', msg: 'Use letters, spaces, dot, apostrophe or dash only.' };
    if (v.length < 2) return { state: 'error', soft: true, msg: 'Too short.' };
    if (!v.includes(' ')) return { state: 'warn', msg: 'Add the last name too, so admins can be told apart.' };
    return { state: 'ok', msg: 'Looks good.' };
  }

  function lev(a, b) {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[m][n];
  }

  function suggestDomain(domain) {
    if (KNOWN_DOMAINS.includes(domain)) return '';
    let best = '', bestD = 3;
    if (domain.length >= 5) {
      KNOWN_DOMAINS.forEach((k) => { const dd = lev(domain, k); if (dd > 0 && dd < bestD) { bestD = dd; best = k; } });
    }
    if (best) return best;
    const parts = domain.split('.');
    const tld = parts[parts.length - 1];
    if (TLD_FIX[tld]) return [...parts.slice(0, -1), TLD_FIX[tld]].join('.');
    return '';
  }

  function checkEmail(raw, { required = true, taken = [] } = {}) {
    const v = String(raw || '').trim();
    if (!v) return required ? { state: 'error', msg: 'Enter an email address.' } : { state: 'idle', msg: 'Optional.' };
    if (/\s/.test(v)) return { state: 'error', msg: 'Remove the spaces.' };
    const at = (v.match(/@/g) || []).length;
    if (at === 0) return { state: 'error', soft: true, msg: 'Missing "@" — e.g. name@example.com.' };
    if (at > 1) return { state: 'error', msg: 'Only one "@" is allowed.' };
    const [local, domain] = v.split('@');
    if (!local) return { state: 'error', msg: 'Add the part before "@".' };
    if (!domain) return { state: 'error', soft: true, msg: 'Add the domain after "@", e.g. gmail.com.' };
    if (!domain.includes('.')) return { state: 'error', soft: true, msg: 'Add the ending, e.g. ".com" or ".ph".' };
    if (/\.\./.test(v) || /^\.|\.$/.test(local) || !EMAIL_STRICT.test(v)) return { state: 'error', msg: 'That email address isn’t valid.' };
    if (taken.includes(v.toLowerCase())) return { state: 'error', msg: 'Already used by another account.' };
    const sugg = suggestDomain(domain.toLowerCase());
    if (sugg) return { state: 'warn', msg: `Did you mean ${local}@${sugg}?`, suggest: `${local}@${sugg}` };
    return { state: 'ok', msg: 'Looks good.' };
  }

  function passwordRules(pw, username) {
    pw = pw || '';
    const u = String(username || '').toLowerCase();
    return {
      len: pw.length >= 8,
      upper: /[A-Z]/.test(pw),
      lower: /[a-z]/.test(pw),
      digit: /\d/.test(pw),
      user: !(u.length >= 3 && pw.toLowerCase().includes(u)),
    };
  }

  /** 0 = empty, 1 Weak, 2 Fair, 3 Good, 4 Strong. */
  function passwordLevel(pw, username) {
    if (!pw) return 0;
    const r = passwordRules(pw, username);
    const passed = [r.len, r.upper, r.lower, r.digit, r.user].filter(Boolean).length;
    if (passed < 5) return passed <= 3 ? 1 : 2;
    return pw.length >= 12 || /[^A-Za-z0-9]/.test(pw) ? 4 : 3;
  }

  function checkPassword(pw, { username = '', required = true } = {}) {
    if (!pw) return required ? { state: 'error', msg: 'Enter a password.' } : { state: 'idle', msg: '' };
    const r = passwordRules(pw, username);
    if (!r.user) return { state: 'error', msg: 'Don’t use the username inside the password.' };
    if (!(r.len && r.upper && r.lower && r.digit)) return { state: 'error', soft: true, msg: 'Meet every requirement above.' };
    const lvl = passwordLevel(pw, username);
    return lvl >= 4
      ? { state: 'ok', msg: 'Strong password.' }
      : { state: 'ok', msg: 'Good. Add a symbol or make it 12+ characters to make it stronger.' };
  }

  function checkConfirm(v, original, what = 'password') {
    if (!original) return { state: 'idle', msg: '' };
    if (!v) return { state: 'error', soft: true, msg: `Type the ${what} again.` };
    if (v === original) return { state: 'ok', msg: what === 'PIN' ? 'PINs match.' : 'Passwords match.' };
    if (original.startsWith(v)) return { state: 'error', soft: true, msg: 'Keep typing…' };
    return { state: 'error', msg: `Doesn’t match the ${what} above.` };
  }

  function easyPin(p) {
    if (/^(\d)\1{5}$/.test(p)) return true;
    const asc = '01234567890', desc = '09876543210';
    if (asc.includes(p) || desc.includes(p)) return true;
    if (p.slice(0, 3) === p.slice(3)) return true; // 123123
    if (/^(\d\d)\1\1$/.test(p)) return true;         // 121212
    return false;
  }

  function checkPin(p, { required = true } = {}) {
    if (!p) return required ? { state: 'error', msg: 'Enter a 6-digit PIN.' } : { state: 'idle', msg: '' };
    if (/\D/.test(p)) return { state: 'error', msg: 'Numbers only.' };
    if (p.length < 6) return { state: 'error', soft: true, msg: `${6 - p.length} more digit${6 - p.length === 1 ? '' : 's'}.` };
    if (easyPin(p)) return { state: 'warn', msg: 'Easy to guess. A less obvious PIN is safer.' };
    return { state: 'ok', msg: 'Good PIN.' };
  }

  /** Paint one field. `show` false = untouched, so only its hint is shown. */
  function paint(key, res, show, typing) {
    const field = document.querySelector(`.um-modal-overlay [data-field="${key}"]`);
    if (!field) return;
    const msg = field.querySelector('.um-msg');
    const stateEl = field.querySelector('.um-state');
    const input = document.getElementById(key);
    field.classList.remove('is-ok', 'is-error', 'is-warn', 'is-pending');

    let state = show && res ? res.state : 'idle';
    if (state === 'error' && res.soft && typing) state = 'pending';
    if (state !== 'idle') field.classList.add(`is-${state}`);
    if (input) input.setAttribute('aria-invalid', state === 'error' ? 'true' : 'false');
    if (stateEl) stateEl.innerHTML = state === 'ok' ? ICON.ok : state === 'error' ? ICON.error : state === 'warn' ? ICON.warn : '';
    if (!msg) return;

    const text = state === 'idle' ? (res && show && res.msg ? res.msg : (msg.dataset.hint || '')) : res.msg;
    if (!text) { msg.innerHTML = ''; return; }
    const icon = state === 'ok' ? ICON.ok : state === 'error' ? ICON.error : state === 'warn' ? ICON.warn : '';
    msg.innerHTML = (icon && text ? `<span class="um-msg-icon">${icon}</span>` : '') + `<span>${esc(text)}</span>`
      + (state === 'warn' && res.suggest
        ? ` <button type="button" class="um-suggest" data-suggest-for="${esc(key)}" data-value="${esc(res.suggest)}">Use it</button>`
        : '');
  }

  function renderMeter(meterId, rulesId, pw, username) {
    const meter = document.getElementById(meterId);
    if (meter) {
      const lvl = passwordLevel(pw, username);
      meter.dataset.level = String(lvl);
      const label = meter.querySelector('em');
      if (label) label.textContent = ['', 'Weak', 'Fair', 'Good', 'Strong'][lvl];
    }
    const rules = document.getElementById(rulesId);
    if (rules) {
      const r = passwordRules(pw, username);
      rules.querySelectorAll('li[data-rule]').forEach((li) => {
        li.classList.toggle('met', !!pw && r[li.dataset.rule]);
      });
    }
  }

  function setCapsLock(input, on) {
    const wrap = input.closest('.um-field');
    if (!wrap) return;
    let note = wrap.querySelector('.um-caps');
    if (!note) {
      note = document.createElement('small');
      note.className = 'um-caps';
      note.innerHTML = `${ICON.warn}<span>Caps Lock is on</span>`;
      (input.closest('.um-input-wrap') || input).insertAdjacentElement('afterend', note);
    }
    note.hidden = !on;
  }

  // ── 6-box PIN input ──────────────────────────────────────────────────────

  function buildPin(id, onChange) {
    const host = document.getElementById(id);
    if (!host) return null;
    host.innerHTML = '';
    const boxes = [];
    for (let i = 0; i < 6; i++) {
      const b = document.createElement('input');
      b.type = 'password';
      b.inputMode = 'numeric';
      // Not maxLength 1: a whole PIN typed fast, pasted or autofilled into one box arrives as one
      // insert and would be cut to its first digit. The input handler spreads it across the boxes.
      b.maxLength = 6;
      b.autocomplete = 'off';
      b.className = 'form-input um-pin-box';
      b.setAttribute('aria-label', `Digit ${i + 1} of 6`);
      host.appendChild(b);
      boxes.push(b);
    }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'um-pass-toggle um-pin-toggle';
    toggle.setAttribute('aria-label', 'Show PIN');
    toggle.title = 'Show PIN';
    toggle.innerHTML = ICON.eye;
    host.appendChild(toggle);

    const value = () => boxes.map((b) => b.value).join('');
    const sync = () => boxes.forEach((b) => b.classList.toggle('filled', !!b.value));
    const fillFrom = (start, digits) => {
      let i = start;
      for (const d of digits) { if (i > 5) break; boxes[i++].value = d; }
      boxes[Math.min(i, 5)].focus();
      sync(); onChange();
    };

    boxes.forEach((b, i) => {
      b.addEventListener('focus', () => b.select());
      b.addEventListener('input', () => {
        const digits = b.value.replace(/\D/g, '');
        if (digits.length > 1) { b.value = ''; fillFrom(i, digits); return; }
        b.value = digits;
        if (digits && i < 5) boxes[i + 1].focus();
        sync(); onChange();
      });
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !b.value && i > 0) { boxes[i - 1].value = ''; boxes[i - 1].focus(); sync(); onChange(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft' && i > 0) { boxes[i - 1].focus(); e.preventDefault(); }
        else if (e.key === 'ArrowRight' && i < 5) { boxes[i + 1].focus(); e.preventDefault(); }
      });
      b.addEventListener('paste', (e) => {
        const digits = (e.clipboardData?.getData('text') || '').replace(/\D/g, '');
        if (!digits) return;
        e.preventDefault();
        fillFrom(i, digits);
      });
    });
    toggle.addEventListener('click', () => {
      const show = boxes[0].type === 'password';
      boxes.forEach((b) => { b.type = show ? 'text' : 'password'; });
      toggle.innerHTML = show ? ICON.eyeOff : ICON.eye;
      toggle.classList.toggle('on', show);
      toggle.setAttribute('aria-label', show ? 'Hide PIN' : 'Show PIN');
      toggle.title = show ? 'Hide PIN' : 'Show PIN';
    });

    return {
      host,
      value,
      clear() { boxes.forEach((b) => { b.value = ''; b.type = 'password'; }); toggle.innerHTML = ICON.eye; toggle.classList.remove('on'); sync(); },
      clearValues() { boxes.forEach((b) => { b.value = ''; }); sync(); },
      setDisabled(on) { boxes.forEach((b) => { b.disabled = !!on; }); },
      focus() { (boxes.find((b) => !b.value) || boxes[5]).focus(); },
    };
  }

  // ── Add Admin wizard ─────────────────────────────────────────────────────
  // Basic info (+ optional photo) → role → password → PIN → review. The password is typed twice on
  // one screen (the usual way); the PIN is entered, then re-entered on its own screen, like setting
  // a phone PIN — a mismatch starts the PIN over. Review lists everything; "Create account" saves.

  const WIZ_FIELDS = { 1: ['uw-username', 'uw-name', 'uw-email'], 2: [], 3: ['uw-password', 'uw-password2'], 4: [], 5: [] };
  const WIZ_SUB = {
    1: 'Step 1 of 5 · Who is this admin?',
    2: 'Step 2 of 5 · What can they access?',
    3: 'Step 3 of 5 · Set their password',
    4: 'Step 4 of 5 · Set their 6-digit PIN',
    5: 'Step 5 of 5 · Check the details, then create the account',
  };
  const WIZ_NEXT = { 1: 'Next: Role', 2: 'Next: Password', 3: 'Next: PIN', 4: 'Review', 5: 'Create account' };

  let _pinPhase = 'create'; // create → confirm → done
  let _pinFirst = '';
  const _photo = { uw: '', uf: null }; // wizard photo ('' = none); edit form photo (null = unchanged)

  function wizRole() {
    return document.querySelector('input[name="uw-role"]:checked')?.value || 'admin';
  }

  function wizValues() {
    return {
      username: getVal('uw-username').trim(),
      name: getVal('uw-name').replace(/\s+/g, ' ').trim(),
      email: getVal('uw-email').trim().toLowerCase(),
      role: wizRole(),
      password: getVal('uw-password'),
      password2: getVal('uw-password2'),
      pin: _pinPhase === 'done' ? _pinFirst : '',
      avatar: _photo.uw,
    };
  }

  function wizCheck(key) {
    const v = wizValues();
    switch (key) {
      case 'uw-username': return checkUsername(v.username);
      case 'uw-name': return checkName(getVal('uw-name'));
      case 'uw-email': return checkEmail(v.email, { taken: emailsInUse('admins') });
      case 'uw-password': return checkPassword(v.password, { username: v.username });
      case 'uw-password2': return v.password ? checkConfirm(v.password2, v.password) : { state: 'error', soft: true, msg: 'Set the password first.' };
      default: return { state: 'idle', msg: '' };
    }
  }

  function onWizInput(key, typing = true) {
    const v = wizValues();
    if (getVal(key)) _wizTouched.add(key);
    paint(key, wizCheck(key), _wizTouched.has(key), typing);
    // Dependent fields re-check as the field they depend on changes.
    if (key === 'uw-username' && _wizTouched.has('uw-password')) paint('uw-password', wizCheck('uw-password'), true, true);
    if (key === 'uw-password' && _wizTouched.has('uw-password2')) paint('uw-password2', wizCheck('uw-password2'), true, true);
    if (key === 'uw-password' || key === 'uw-username') renderMeter('uw-meter', 'uw-pw-rules', v.password, v.username);
    if (key === 'uw-name') renderPhoto('uw');
    showWizError('');
  }

  // ── PIN step: enter, then re-enter ──

  const PIN_TEXT = {
    create: ['Create a 6-digit PIN', 'Asked after the password at every sign-in. Numbers only.'],
    confirm: ['Re-enter the PIN', 'Type the same 6 digits again to confirm.'],
    done: ['PIN confirmed', 'Both entries match. Continue to review the account.'],
  };

  function setPinPhase(phase, msg) {
    _pinPhase = phase;
    const box = document.getElementById('uw-pinset');
    if (box) {
      box.dataset.phase = phase;
      box.classList.remove('um-pinset-swap'); void box.offsetWidth; box.classList.add('um-pinset-swap');
    }
    setText('uw-pin-title', PIN_TEXT[phase][0]);
    setText('uw-pin-sub', PIN_TEXT[phase][1]);
    const actions = document.getElementById('uw-pin-actions');
    if (actions) {
      actions.innerHTML = phase === 'confirm'
        ? '<button type="button" class="um-link" data-pin-act="restart">Start over with a different PIN</button>'
        : phase === 'done' ? '<button type="button" class="um-link" data-pin-act="restart">Change PIN</button>' : '';
    }
    if (phase !== 'done') _pin?.clearValues();
    _pin?.setDisabled(phase === 'done');
    _pin?.host.classList.toggle('is-match', phase === 'done');
    paint('uw-pin', msg || null, !!msg, false);
    syncNextButton();
    if (phase !== 'done' && _wizStep === 4) setTimeout(() => _pin?.focus(), 60);
  }

  function acceptFirstPin(v) {
    _pinFirst = v;
    setTimeout(() => setPinPhase('confirm'), 240);
  }

  function onPinInput() {
    if (!_pin) return;
    const v = _pin.value();
    showWizError('');
    if (_pinPhase === 'create') {
      const actions = document.getElementById('uw-pin-actions');
      if (actions) actions.innerHTML = '';
      const res = checkPin(v);
      if (v.length < 6) { paint('uw-pin', v ? res : null, !!v, true); return; }
      if (res.state === 'warn') {
        // An easy PIN is allowed, but only on purpose.
        paint('uw-pin', { state: 'warn', msg: 'Easy to guess, like 123456 or 111111.' }, true, false);
        if (actions) {
          actions.innerHTML = '<button type="button" class="btn btn-outline btn-sm" data-pin-act="clear">Choose another</button>'
            + '<button type="button" class="btn btn-primary btn-sm" data-pin-act="use">Use it anyway</button>';
        }
        return;
      }
      paint('uw-pin', { state: 'ok', msg: 'Got it.' }, true, false);
      acceptFirstPin(v);
    } else if (_pinPhase === 'confirm') {
      if (v.length < 6) {
        paint('uw-pin', v ? { state: 'error', soft: true, msg: `${6 - v.length} more digit${6 - v.length === 1 ? '' : 's'}.` } : null, !!v, true);
        return;
      }
      if (v === _pinFirst) {
        setPinPhase('done', { state: 'ok', msg: 'PIN confirmed.' });
      } else {
        _pinFirst = '';
        const box = document.getElementById('uw-pinset');
        box?.classList.remove('um-shake'); void box?.offsetWidth; box?.classList.add('um-shake');
        setPinPhase('create', { state: 'error', msg: 'The PINs didn’t match. Enter a new PIN.' });
      }
    }
  }

  function onPinAction(act) {
    if (act === 'use') { acceptFirstPin(_pin.value()); return; }
    _pinFirst = '';
    setPinPhase('create');
  }

  // ── photo (wizard + edit form) ──

  function photoNameFor(prefix) {
    return prefix === 'uw' ? getVal('uw-name') : getVal('um-f-name');
  }

  function currentPhoto(prefix) {
    if (prefix === 'uw') return _photo.uw;
    return _photo.uf !== null ? _photo.uf : (_editing?.avatar || '');
  }

  function renderPhoto(prefix) {
    const prev = document.getElementById(`${prefix}-photo-preview`);
    const photo = currentPhoto(prefix);
    if (prev) prev.innerHTML = photo ? `<img src="${esc(photo)}" alt="" />` : esc(initials(photoNameFor(prefix)));
    prev?.classList.toggle('has-photo', !!photo);
    const remove = document.querySelector(`[data-photo-remove="${prefix}"]`);
    if (remove) remove.hidden = !photo;
    const pick = document.querySelector(`[data-photo-pick="${prefix}"]`);
    if (pick) pick.textContent = photo ? 'Change photo' : 'Upload photo';
  }

  async function onPhotoFile(prefix, file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      await AgriPricePH.Modals.alert({ title: 'Unsupported file', text: 'Please choose a PNG, JPG, or WEBP image.', type: 'warning' });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      await AgriPricePH.Modals.alert({ title: 'File too large', text: 'Please choose an image smaller than 8 MB.', type: 'warning' });
      return;
    }
    try {
      const dataUrl = await resizeImageFile(file);
      if (prefix === 'uw') _photo.uw = dataUrl; else _photo.uf = dataUrl;
      renderPhoto(prefix);
    } catch (e) {
      await AgriPricePH.Modals.alert({ title: 'Photo not loaded', text: e.message || 'That image could not be read.', type: 'danger' });
    }
  }

  /** Square-crop to the centre and shrink to 240px: a small JPEG the server accepts. */
  function resizeImageFile(file, size = 240, quality = 0.86) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the selected file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file is not a valid image.'));
        img.onload = () => {
          const side = Math.min(img.width, img.height);
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function bindPhotoPickers() {
    document.querySelectorAll('.um-modal-overlay [data-photo-pick]').forEach((btn) => {
      btn.addEventListener('click', () => document.querySelector(`[data-photo-input="${btn.dataset.photoPick}"]`)?.click());
    });
    document.querySelectorAll('.um-modal-overlay [data-photo-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.photoRemove === 'uw') _photo.uw = ''; else _photo.uf = '';
        renderPhoto(btn.dataset.photoRemove);
      });
    });
    document.querySelectorAll('.um-modal-overlay [data-photo-input]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const file = inp.files?.[0];
        inp.value = '';
        onPhotoFile(inp.dataset.photoInput, file);
      });
    });
  }

  function bindWizard() {
    ['uw-username', 'uw-name', 'uw-email', 'uw-password', 'uw-password2'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        if (id === 'uw-username') {
          const pos = el.selectionStart;
          el.value = el.value.toLowerCase();
          try { el.setSelectionRange(pos, pos); } catch { /* ignore */ }
        }
        onWizInput(id, true);
      });
      el.addEventListener('blur', () => { if (getVal(id)) _wizTouched.add(id); onWizInput(id, false); });
    });

    document.getElementById('uw-generate')?.addEventListener('click', () => {
      const pw = generatePassword();
      setVal('uw-password', pw);
      setVal('uw-password2', pw);
      ['uw-password', 'uw-password2'].forEach((id) => { const el = document.getElementById(id); if (el) el.type = 'text'; });
      const toggle = document.querySelector('#um-wiz-overlay .um-pass-toggle[data-toggle]');
      if (toggle) { toggle.innerHTML = ICON.eyeOff; toggle.classList.add('on'); }
      _wizTouched.add('uw-password'); _wizTouched.add('uw-password2');
      onWizInput('uw-password', false);
      onWizInput('uw-password2', false);
    });

    document.getElementById('um-wiz-overlay')?.addEventListener('click', (e) => {
      const sugg = e.target.closest('.um-suggest');
      if (sugg) {
        setVal(sugg.dataset.suggestFor, sugg.dataset.value);
        onWizInput(sugg.dataset.suggestFor, false);
        return;
      }
      const pinAct = e.target.closest('[data-pin-act]');
      if (pinAct) { onPinAction(pinAct.dataset.pinAct); return; }
      const go = e.target.closest('[data-goto]');
      if (go) { gotoStep(Number(go.dataset.goto)); return; }
      const dot = e.target.closest('.um-step.is-reachable');
      if (dot) gotoStep(Number(dot.dataset.step));
    });
    document.getElementById('um-wiz-overlay')?.addEventListener('mousedown', (e) => {
      if (e.target.id === 'um-wiz-overlay') closeWizard();
    });
    document.querySelectorAll('input[name="uw-role"]').forEach((r) => r.addEventListener('change', syncRoleCards));
    document.getElementById('um-wiz-close')?.addEventListener('click', closeWizard);
    document.getElementById('um-wiz-cancel')?.addEventListener('click', closeWizard);
    document.getElementById('um-wiz-back')?.addEventListener('click', () => gotoStep(_wizStep - 1));
    document.getElementById('um-wiz-form')?.addEventListener('submit', (e) => { e.preventDefault(); wizNext(); });
  }

  /** 14 characters from every class, no look-alikes (0/O, 1/l/I), shuffled with crypto randomness. */
  function generatePassword() {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*?'];
    const all = sets.join('');
    const rnd = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
    const chars = sets.map((s) => s[rnd(s.length)]);
    while (chars.length < 14) chars.push(all[rnd(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
    const pw = chars.join('');
    const u = getVal('uw-username').toLowerCase();
    return u.length >= 3 && pw.toLowerCase().includes(u) ? generatePassword() : pw;
  }

  function syncRoleCards() {
    document.querySelectorAll('.um-role-card').forEach((card) => {
      card.classList.toggle('is-selected', !!card.querySelector('input')?.checked);
    });
  }

  function openWizard() {
    ['uw-username', 'uw-name', 'uw-email', 'uw-password', 'uw-password2'].forEach((id) => {
      setVal(id, '');
      const el = document.getElementById(id);
      if (el && id.startsWith('uw-password')) el.type = 'password';
      if (el) setCapsLock(el, false);
    });
    document.querySelectorAll('#um-wiz-overlay .um-pass-toggle[data-toggle]').forEach((b) => { b.innerHTML = ICON.eye; b.classList.remove('on'); });
    _photo.uw = '';
    renderPhoto('uw');
    _pin?.clear();
    _pinFirst = '';
    const adminRadio = document.querySelector('input[name="uw-role"][value="admin"]');
    if (adminRadio) adminRadio.checked = true;
    syncRoleCards();
    _wizTouched = new Set();
    _wizMax = 1;
    _wizBusy = false;
    Object.values(WIZ_FIELDS).flat().forEach((k) => paint(k, null, false));
    renderMeter('uw-meter', 'uw-pw-rules', '', '');
    showWizError('');
    const overlay = document.getElementById('um-wiz-overlay');
    if (overlay) overlay.hidden = false;
    setPinPhase('create');
    gotoStep(1);
  }

  function wizDirty() {
    const v = wizValues();
    return !!(v.username || v.name || v.email || v.password || _pinFirst || _photo.uw || _pin?.value());
  }

  async function closeWizard() {
    const overlay = document.getElementById('um-wiz-overlay');
    if (!overlay || overlay.hidden || _wizBusy) return;
    if (wizDirty()) {
      const ok = await AgriPricePH.Modals.confirm({
        title: 'Discard this new admin?',
        text: 'The details you typed will be cleared and no account will be created.',
        type: 'warning', okText: 'Discard', cancelText: 'Keep editing', danger: true,
      });
      if (!ok) return;
    }
    overlay.hidden = true;
  }

  /** Validate one step. force = mark every field touched so its error shows. Returns the first bad field key. */
  function stepInvalid(n, force) {
    if (n === 4) {
      if (_pinPhase === 'done') return '';
      if (force) {
        paint('uw-pin', { state: 'error', msg: _pinPhase === 'confirm' ? 'Re-enter the PIN to confirm it.' : 'Enter a 6-digit PIN.' }, true, false);
      }
      return 'uw-pin';
    }
    let first = '';
    (WIZ_FIELDS[n] || []).forEach((key) => {
      if (force) _wizTouched.add(key);
      const res = wizCheck(key);
      paint(key, res, _wizTouched.has(key), false);
      if (res.state === 'error' && !first) first = key;
    });
    return first;
  }

  function focusField(key) {
    if (key === 'uw-pin') { _pin?.focus(); return; }
    document.getElementById(key)?.focus();
  }

  function gotoStep(n) {
    n = Math.max(1, Math.min(5, n));
    // Never jump past a step that still has errors.
    for (let s = 1; s < n; s++) {
      if (stepInvalid(s, true)) { n = s; break; }
    }
    _wizStep = n;
    _wizMax = Math.max(_wizMax, n);

    document.querySelectorAll('#um-wiz-form .um-wiz-panel').forEach((p) => { p.hidden = Number(p.dataset.panel) !== n; });
    document.querySelectorAll('#um-wiz-steps .um-step').forEach((li) => {
      const s = Number(li.dataset.step);
      li.classList.toggle('is-current', s === n);
      li.classList.toggle('is-done', s < n);
      li.classList.toggle('is-reachable', s !== n && s <= _wizMax);
      if (s === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    document.getElementById('um-wiz-steps')?.style.setProperty('--um-progress-n', String((n - 1) / 4));

    setText('um-wiz-sub', WIZ_SUB[n]);
    const back = document.getElementById('um-wiz-back');
    if (back) back.hidden = n === 1;
    if (n === 5) fillReview();
    syncNextButton();
    showWizError('');

    const panel = document.querySelector(`#um-wiz-form .um-wiz-panel[data-panel="${n}"]`);
    panel?.classList.remove('um-anim-in'); void panel?.offsetWidth; panel?.classList.add('um-anim-in');
    setTimeout(() => {
      if (n === 1) focusField('uw-username');
      else if (n === 2) document.querySelector('input[name="uw-role"]:checked')?.focus();
      else if (n === 3) focusField('uw-password');
      else if (n === 4) { if (_pinPhase !== 'done') _pin?.focus(); else document.getElementById('um-wiz-next')?.focus(); }
      else document.getElementById('um-wiz-next')?.focus();
    }, 40);
  }

  function syncNextButton() {
    const next = document.getElementById('um-wiz-next');
    if (!next) return;
    next.innerHTML = _wizStep < 5
      ? `${WIZ_NEXT[_wizStep]} <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`
      : `${ICON.user.replace('<svg ', '<svg width="15" height="15" ')} ${WIZ_NEXT[5]}`;
    next.disabled = _wizBusy || (_wizStep === 4 && _pinPhase !== 'done');
  }

  function fillReview() {
    const v = wizValues();
    const role = ROLE_TEXT[v.role] || ROLE_TEXT.admin;
    const av = document.getElementById('uw-r-avatar');
    if (av) av.innerHTML = v.avatar ? `<img src="${esc(v.avatar)}" alt="" />` : esc(initials(v.name));
    setText('uw-r-name', v.name);
    setText('uw-r-sub', `@${v.username} · ${v.email}`);
    const pill = document.getElementById('uw-r-pill');
    if (pill) pill.innerHTML = `<span class="pill ${v.role === 'super_admin' ? 'um-pill-super' : 'pill-admin'}">${esc(role.label)}</span>`;
    setText('uw-r-username', `@${v.username}`);
    setText('uw-r-fullname', v.name);
    setText('uw-r-email', v.email);
    const photo = document.getElementById('uw-r-photo');
    if (photo) photo.innerHTML = v.avatar ? 'Added <span class="um-ok-text">✓</span>' : '<span class="um-muted">None, initials are shown</span>';
    const roleEl = document.getElementById('uw-r-role');
    if (roleEl) roleEl.innerHTML = `<b>${esc(role.label)}</b> <span class="um-muted">— ${esc(role.desc)}</span>`;
    const pwEl = document.getElementById('uw-r-password');
    if (pwEl) {
      const lvl = passwordLevel(v.password, v.username);
      pwEl.innerHTML = `${'•'.repeat(Math.min(v.password.length, 12))} <span class="um-ok-text">${['', 'weak', 'fair', 'good', 'strong'][lvl]} · confirmed</span>`;
    }
    setText('uw-r-handle', `@${v.username}`);
  }

  async function wizNext() {
    if (_wizBusy) return;
    if (_wizStep < 5) {
      const bad = stepInvalid(_wizStep, true);
      if (bad) {
        focusField(bad);
        const panel = document.querySelector(`#um-wiz-form .um-wiz-panel[data-panel="${_wizStep}"]`);
        panel?.classList.remove('um-shake'); void panel?.offsetWidth; panel?.classList.add('um-shake');
        return;
      }
      gotoStep(_wizStep + 1);
      return;
    }
    await submitWizard();
  }

  async function submitWizard() {
    const v = wizValues();
    const body = { username: v.username, name: v.name, email: v.email, role: v.role, password: v.password, access_code: v.pin, avatar: v.avatar };
    _wizBusy = true;
    syncNextButton();
    AgriPricePH.Modals.loading('Creating admin account…');
    try {
      const res = await AgriPricePH.API.post('/api/admin/accounts/admins', body);
      AgriPricePH.Modals.hideLoading();
      if (!res.ok || !res.data?.success) {
        const err = res.data?.error || 'Could not create this account.';
        _wizBusy = false;
        // Send the person straight to the field the server rejected.
        const field = /username/i.test(err) ? 'uw-username' : /email/i.test(err) ? 'uw-email'
          : /photo/i.test(err) ? '' : /name/i.test(err) ? 'uw-name' : /password/i.test(err) ? 'uw-password' : /code|pin/i.test(err) ? 'uw-pin' : '';
        if (field === 'uw-pin') {
          gotoStep(4);
          _pinFirst = '';
          setPinPhase('create', { state: 'error', msg: err });
        } else if (field) {
          gotoStep(field === 'uw-password' ? 3 : 1);
          _wizTouched.add(field);
          paint(field, { state: 'error', msg: err }, true, false);
          focusField(field);
        } else {
          showWizError(err);
          syncNextButton();
        }
        return;
      }
      const overlay = document.getElementById('um-wiz-overlay');
      if (overlay) overlay.hidden = true;
      _wizBusy = false;
      setTab('admins');
      await load();
      await AgriPricePH.Modals.alert({
        title: 'Admin account created',
        text: `@${v.username} can now sign in as ${(ROLE_TEXT[v.role] || ROLE_TEXT.admin).label}. Share the password and PIN with them privately.`,
        type: 'success',
      });
    } catch {
      AgriPricePH.Modals.hideLoading();
      _wizBusy = false;
      showWizError('Backend unreachable — please try again.');
      syncNextButton();
    }
  }

  function showWizError(msg) {
    const el = document.getElementById('um-wiz-error');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  // ── profile summary (click a table row) ──────────────────────────────────

  let _profileOf = null; // { kind, acct }

  function avatarHtml(a, extraClass = '') {
    const inner = a.avatar ? `<img src="${esc(a.avatar)}" alt="" />` : esc(initials(a.name));
    return `<span class="um-avatar ${extraClass}${a.avatar ? ' has-photo' : ''}" aria-hidden="true">${inner}</span>`;
  }

  function isSelfAccount(kind, a) {
    const me = _data.me || {};
    return kind === 'admins' && (a.is_primary ? me.kind === 'primary' : (me.kind === 'account' && me.id === a.id));
  }

  async function openProfile(kind, acct) {
    _profileOf = { kind, acct };
    renderProfile(kind, acct, null);
    const overlay = document.getElementById('um-profile-overlay');
    if (overlay) overlay.hidden = false;
    setTimeout(() => document.getElementById('um-profile-close')?.focus(), 30);
    if (kind === 'users') {
      try {
        const res = await AgriPricePH.API.get(`/api/admin/accounts/users/${encodeURIComponent(acct.id)}`, { noCache: true });
        if (res.success && _profileOf?.acct === acct) renderProfile(kind, { ...acct, ...res.account }, res.account.activity || []);
      } catch { /* the summary from the table is still shown */ }
    }
  }

  function closeProfile() {
    const overlay = document.getElementById('um-profile-overlay');
    if (overlay) overlay.hidden = true;
    _profileOf = null;
  }

  function renderProfile(kind, a, activity) {
    const isAdmins = kind === 'admins';
    const inactive = a.status !== 'active';
    const av = document.getElementById('um-p-avatar');
    if (av) {
      av.className = `um-avatar um-profile-avatar${isAdmins ? ' admin' : ''}${a.avatar ? ' has-photo' : ''}`;
      av.innerHTML = a.avatar ? `<img src="${esc(a.avatar)}" alt="" />` : esc(initials(a.name));
    }
    const nameEl = document.getElementById('um-p-name');
    if (nameEl) nameEl.innerHTML = `${esc(a.name)}${isSelfAccount(kind, a) ? ' <span class="um-you">You</span>' : ''}`;
    setText('um-p-handle', isAdmins ? `@${a.username}` : (a.email || ''));
    const pills = document.getElementById('um-p-pills');
    if (pills) {
      const role = a.role === 'super_admin' ? `<span class="pill um-pill-super">${esc(a.role_label)}</span>`
        : a.role === 'admin' ? `<span class="pill pill-admin">${esc(a.role_label)}</span>`
          : `<span class="pill pill-green">${esc(a.role_label || 'Public User')}</span>`;
      const status = inactive ? '<span class="pill pill-neutral um-status"><i></i>Deactivated</span>'
        : '<span class="pill pill-success um-status"><i></i>Active</span>';
      pills.innerHTML = role + status + (a.is_primary ? '<span class="pill pill-neutral">Built-in</span>' : '');
    }
    const bio = document.getElementById('um-p-bio');
    if (bio) { bio.textContent = a.bio || ''; bio.hidden = !a.bio; }

    const rows = [];
    const add = (label, value, title) => { if (value) rows.push(`<div><dt>${esc(label)}</dt><dd${title ? ` title="${esc(title)}"` : ''}>${value}</dd></div>`); };
    if (isAdmins) {
      add('Username', `@${esc(a.username)}`);
      add('Email', a.email ? esc(a.email) : '<span class="um-muted">Not set</span>');
      add('Access', esc((ROLE_TEXT[a.role] || ROLE_TEXT.admin).desc));
      add('Created by', a.is_primary ? 'Built-in account' : (a.created_by ? `@${esc(a.created_by)}` : '—'));
      if (!a.is_primary) add('Created', esc(fmtDateTime(a.created_at) || '—'));
    } else {
      add('Email', esc(a.email));
      add('Title', a.title ? esc(a.title) : '');
      add('Phone', a.phone ? esc(a.phone) : '');
      add('Joined', esc(fmtDateTime(a.created_at) || '—'));
    }
    add('Last sign-in', esc(fmtRelative(a.last_login_at)), fmtDateTime(a.last_login_at));
    if (inactive && a.deactivated_at) add('Deactivated', esc(fmtDateTime(a.deactivated_at)));
    if (a.updated_at && !a.is_primary) add('Last updated', esc(fmtDateTime(a.updated_at)));
    const grid = document.getElementById('um-p-grid');
    if (grid) grid.innerHTML = rows.join('');

    const actWrap = document.getElementById('um-p-activity');
    const actList = document.getElementById('um-p-activity-list');
    if (actWrap && actList) {
      const list = activity || [];
      actWrap.hidden = isAdmins || !activity;
      actList.innerHTML = list.length
        ? list.map((r) => `<li class="lv-${esc(String(r.level || '').toLowerCase())}"><span>${esc(r.msg)}</span><time>${esc(fmtRelative(String(r.time).replace(' ', 'T')))}</time></li>`).join('')
        : '<li class="um-muted">No account activity yet.</li>';
    }

    const actions = document.getElementById('um-p-actions');
    if (actions) {
      if (isAdmins && a.is_primary) {
        actions.innerHTML = `<span class="um-locked">${ICON.lock}<span>Protected. The built-in Super Admin is edited from Account Profile.</span></span>
          <span class="um-wiz-spacer"></span>
          ${(_data.me || {}).kind === 'primary' ? '<button type="button" class="btn btn-primary btn-sm" data-p-act="account">Open Account Profile</button>' : ''}`;
      } else {
        const self = isSelfAccount(kind, a);
        actions.innerHTML = `
          <button type="button" class="btn btn-sm ${inactive ? 'btn-outline um-btn-success' : 'btn-outline um-btn-danger'}" data-p-act="toggle" ${self && !inactive ? 'disabled title="You can’t deactivate your own account"' : ''}>
            ${inactive ? ICON.reactivate : ICON.deactivate} ${inactive ? 'Reactivate' : 'Deactivate'}
          </button>
          <span class="um-wiz-spacer"></span>
          <button type="button" class="btn btn-outline btn-sm" data-p-act="close">Close</button>
          <button type="button" class="btn btn-primary btn-sm" data-p-act="edit">${ICON.edit} Edit</button>`;
      }
    }
  }

  function bindProfile() {
    document.getElementById('um-profile-close')?.addEventListener('click', closeProfile);
    document.getElementById('um-profile-overlay')?.addEventListener('mousedown', (e) => {
      if (e.target.id === 'um-profile-overlay') closeProfile();
    });
    document.getElementById('um-p-actions')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-p-act]');
      if (!btn || !_profileOf) return;
      const { kind, acct } = _profileOf;
      if (btn.dataset.pAct === 'close') closeProfile();
      if (btn.dataset.pAct === 'edit') { closeProfile(); openForm(kind, acct); }
      if (btn.dataset.pAct === 'toggle') { closeProfile(); toggleStatus(kind, acct); }
      if (btn.dataset.pAct === 'account') { closeProfile(); AgriPricePH.Router?.navigate?.('account'); }
    });
  }

  // ── add / edit public user, edit admin (single form) ─────────────────────

  const FORM_FIELDS = ['um-f-name', 'um-f-email', 'um-f-title', 'um-f-phone', 'um-f-bio',
    'um-f-password', 'um-f-password2', 'um-f-code', 'um-f-code2'];
  const USER_ONLY = ['um-f-title', 'um-f-phone', 'um-f-bio'];
  const ADMIN_ONLY = ['um-f-code', 'um-f-code2'];

  function formCheck(key) {
    const isAdmin = _formKind === 'admins';
    const creating = !_editing;
    const pw = getVal('um-f-password');
    const code = getVal('um-f-code');
    switch (key) {
      case 'um-f-name': renderPhoto('uf'); return checkName(getVal('um-f-name'));
      case 'um-f-title': {
        const v = getVal('um-f-title').trim();
        if (!v) return { state: 'idle', msg: '' };
        return v.length > 60 ? { state: 'error', msg: 'Up to 60 characters.' } : { state: 'ok', msg: '' };
      }
      case 'um-f-phone': {
        const v = getVal('um-f-phone').trim();
        if (!v) return { state: 'idle', msg: '' };
        if (/[^0-9+()\-.\s]/.test(v)) return { state: 'error', msg: 'Only digits, spaces, +, -, ( and ).' };
        if (v.replace(/\D/g, '').length < 7) return { state: 'error', soft: true, msg: 'At least 7 digits.' };
        return { state: 'ok', msg: '' };
      }
      case 'um-f-bio': {
        const n = getVal('um-f-bio').trim().length;
        setText('um-f-bio-count', `${n} / 280`);
        return n > 280 ? { state: 'error', msg: 'Up to 280 characters.' } : { state: 'idle', msg: '' };
      }
      case 'um-f-email':
        return checkEmail(getVal('um-f-email').trim().toLowerCase(), {
          required: !isAdmin || !!_editing?.email,
          taken: emailsInUse(_formKind, _editing?.id),
        });
      case 'um-f-password': return checkPassword(pw, { username: isAdmin ? _editing?.username : '', required: creating });
      case 'um-f-password2': return pw ? checkConfirm(getVal('um-f-password2'), pw) : { state: 'idle', msg: '' };
      case 'um-f-code': return checkPin(code, { required: false });
      case 'um-f-code2': return code ? checkConfirm(getVal('um-f-code2'), code, 'PIN') : { state: 'idle', msg: '' };
      default: return { state: 'idle', msg: '' };
    }
  }

  function onFormInput(key, typing) {
    if (getVal(key)) _formTouched.add(key);
    paint(key, formCheck(key), _formTouched.has(key), typing);
    if (key === 'um-f-password') {
      renderMeter('um-f-meter', 'um-f-pw-rules', getVal('um-f-password'), _formKind === 'admins' ? _editing?.username : '');
      const show = !!getVal('um-f-password');
      document.querySelector('[data-field="um-f-password"] .um-meter').hidden = !show;
      document.getElementById('um-f-pw-rules').hidden = !show;
      if (_formTouched.has('um-f-password2') || !show) paint('um-f-password2', formCheck('um-f-password2'), _formTouched.has('um-f-password2'), true);
    }
    if (key === 'um-f-code' && (_formTouched.has('um-f-code2') || !getVal('um-f-code'))) paint('um-f-code2', formCheck('um-f-code2'), _formTouched.has('um-f-code2'), true);
    if (key === 'um-f-bio') formCheck('um-f-bio');
    showError('');
  }

  function bindForm() {
    FORM_FIELDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        if (id === 'um-f-code' || id === 'um-f-code2') el.value = el.value.replace(/\D/g, '').slice(0, 6);
        onFormInput(id, true);
      });
      el.addEventListener('blur', () => { if (getVal(id)) _formTouched.add(id); onFormInput(id, false); });
    });
    document.getElementById('um-form-overlay')?.addEventListener('click', (e) => {
      const sugg = e.target.closest('.um-suggest');
      if (!sugg) return;
      setVal(sugg.dataset.suggestFor, sugg.dataset.value);
      onFormInput(sugg.dataset.suggestFor, false);
    });
    document.getElementById('um-form-close')?.addEventListener('click', closeForm);
    document.getElementById('um-form-cancel')?.addEventListener('click', closeForm);
    document.getElementById('um-form-overlay')?.addEventListener('mousedown', (e) => {
      if (e.target.id === 'um-form-overlay') closeForm();
    });
    document.getElementById('um-form')?.addEventListener('submit', (e) => { e.preventDefault(); submitForm(); });
  }

  function openForm(kind, acct) {
    if (kind === 'admins' && !acct) { openWizard(); return; }
    _formKind = kind === 'admins' ? 'admins' : 'users';
    _editing = acct || null;
    _formTouched = new Set();
    const isAdmin = _formKind === 'admins';
    const creating = !acct;

    document.querySelectorAll('#um-form [data-for="admin"]').forEach((el) => { el.hidden = !isAdmin; });
    document.querySelectorAll('#um-form [data-for="user"]').forEach((el) => { el.hidden = isAdmin; });

    setText('um-form-title', `${creating ? 'Add' : 'Edit'} ${isAdmin ? 'Admin' : 'Public User'}`);
    setText('um-form-sub', creating
      ? 'Creates a public-site account that can sign in right away.'
      : `Updating ${acct.name}${isAdmin ? ` (@${acct.username})` : ''}.`);
    const icon = document.getElementById('um-form-icon');
    if (icon) icon.innerHTML = isAdmin ? ICON.shield : ICON.user;
    setText('um-form-save', creating ? 'Create Account' : 'Save Changes');

    _photo.uf = null;
    setVal('um-f-username', acct?.username || '');
    setVal('um-f-name', acct?.name || '');
    setVal('um-f-email', acct?.email || '');
    setVal('um-f-title', acct?.title || '');
    setVal('um-f-phone', acct?.phone || '');
    setVal('um-f-bio', acct?.bio || '');
    setText('um-f-bio-count', `${(acct?.bio || '').length} / 280`);
    setText('uf-photo-sub', creating ? 'PNG, JPG or WEBP. They can change it later themselves.' : 'PNG, JPG or WEBP. Saved with the other changes.');
    setVal('um-f-role', acct?.role === 'super_admin' ? 'super_admin' : 'admin');
    ['um-f-password', 'um-f-password2', 'um-f-code', 'um-f-code2'].forEach((id) => {
      setVal(id, '');
      const el = document.getElementById(id);
      if (el) { el.type = 'password'; setCapsLock(el, false); }
    });
    document.querySelectorAll('#um-form .um-pass-toggle[data-toggle]').forEach((b) => { b.innerHTML = ICON.eye; b.classList.remove('on'); });

    const emailReq = document.getElementById('um-f-email-req');
    if (emailReq) emailReq.textContent = isAdmin && !acct?.email ? '(optional)' : '*';
    emailReq?.classList.toggle('um-optional', isAdmin && !acct?.email);

    setText('um-f-pw-title', creating ? 'Password' : 'Change password');
    setText('um-f-password-label', creating ? 'Password' : 'New password');
    document.getElementById('um-f-password-opt').hidden = creating;
    const meter = document.querySelector('[data-field="um-f-password"] .um-meter');
    if (meter) meter.hidden = !creating;
    const rules = document.getElementById('um-f-pw-rules');
    if (rules) rules.hidden = !creating;
    renderMeter('um-f-meter', 'um-f-pw-rules', '', isAdmin ? acct?.username : '');

    const roleSel = document.getElementById('um-f-role');
    const me = _data.me || {};
    const isSelf = !!(acct && me.kind === 'account' && me.id === acct.id);
    if (roleSel) roleSel.disabled = isSelf;
    const roleMsg = document.querySelector('[data-field="um-f-role"] .um-msg');
    if (roleMsg) roleMsg.textContent = isSelf ? 'You can’t change your own role. Ask another Super Admin.' : '';

    FORM_FIELDS.forEach((k) => paint(k, null, false));
    renderPhoto('uf');
    showError('');
    const overlay = document.getElementById('um-form-overlay');
    if (overlay) overlay.hidden = false;
    setTimeout(() => document.getElementById('um-f-name')?.focus(), 30);
  }

  function closeForm() {
    const overlay = document.getElementById('um-form-overlay');
    if (overlay) overlay.hidden = true;
    _editing = null;
  }

  function collectForm() {
    const isAdmin = _formKind === 'admins';
    const body = {
      name: getVal('um-f-name').replace(/\s+/g, ' ').trim(),
      email: getVal('um-f-email').trim().toLowerCase(),
      password: getVal('um-f-password'),
    };
    if (isAdmin) {
      body.role = getVal('um-f-role');
      body.access_code = getVal('um-f-code').trim();
    } else {
      body.title = getVal('um-f-title').replace(/\s+/g, ' ').trim();
      body.phone = getVal('um-f-phone').replace(/\s+/g, ' ').trim();
      body.bio = getVal('um-f-bio').trim();
    }
    if (_photo.uf !== null && _photo.uf !== (_editing?.avatar || '')) body.avatar = _photo.uf;
    return body;
  }

  async function submitForm() {
    const isAdmin = _formKind === 'admins';
    let firstBad = '';
    FORM_FIELDS.forEach((key) => {
      if (!isAdmin && ADMIN_ONLY.includes(key)) return;
      if (isAdmin && USER_ONLY.includes(key)) return;
      _formTouched.add(key);
      const res = formCheck(key);
      paint(key, res, true, false);
      if (res.state === 'error' && !firstBad) firstBad = key;
    });
    if (firstBad) { document.getElementById(firstBad)?.focus(); return; }
    showError('');

    const body = collectForm();
    if (_editing) {
      // Editing an account is confirmed in a second step with the admin's own PIN.
      const acct = _editing;
      const kind = _formKind;
      const changes = kind === 'admins' ? adminChanges(acct, body) : userChanges(acct, body);
      if (!changes.length) {
        await AgriPricePH.Modals.alert({ title: 'Nothing to save', text: 'You have not changed anything yet.', type: 'info' });
        return;
      }
      openConfirm({
        title: 'Confirm changes',
        sub: `Saving changes to ${acct.name}'s account (${kind === 'admins' ? '@' + acct.username : acct.email}).`,
        intro: 'You are about to change:',
        changes,
        okText: 'Confirm & save',
        submit: (pin) => AgriPricePH.API.put(`/api/admin/accounts/${kind}/${encodeURIComponent(acct.id)}`, { ...body, confirm_pin: pin }),
        onFieldError: (msg) => showError(msg),
        done: async (res) => {
          closeForm();
          await load();
          await AgriPricePH.Modals.alert({ title: 'Account updated', text: res.data.message, type: 'success' });
        },
      });
      return;
    }
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

  // ── confirm an edit with the admin's own PIN ─────────────────────────────

  function userChanges(acct, body) {
    const rows = [];
    const was = (k) => String(acct[k] || '');
    const add = (label, from, to, note) => rows.push({ label, from, to, note });
    if (body.name !== was('name')) add('Full name', was('name'), body.name);
    if (body.email !== was('email')) add('Email', was('email'), body.email, 'They will sign in with the new email.');
    if (body.title !== was('title')) add('Title', was('title'), body.title);
    if (body.phone !== was('phone')) add('Phone', was('phone'), body.phone);
    if (body.bio !== was('bio')) add('Bio', was('bio'), body.bio);
    if ('avatar' in body) add('Photo', acct.avatar ? { img: acct.avatar } : '', body.avatar ? { img: body.avatar } : '');
    if (body.password) add('Password', '', 'A new password', 'They will be signed out on every device.');
    return rows;
  }

  function changeCell(v, cls) {
    if (v && typeof v === 'object' && v.img) return `<span class="${cls}"><img class="um-ch-img" src="${esc(v.img)}" alt=""></span>`;
    const t = String(v || '');
    if (!t) return `<span class="${cls} um-ch-empty">none</span>`;
    return `<span class="${cls}" title="${esc(t)}">${esc(t.length > 60 ? t.slice(0, 57) + '…' : t)}</span>`;
  }

  function adminChanges(acct, body) {
    const rows = [];
    const was = (k) => String(acct[k] || '');
    const add = (label, from, to, note) => rows.push({ label, from, to, note });
    const roleName = (r) => (ROLE_TEXT[r] || ROLE_TEXT.admin).label;
    if (body.name !== was('name')) add('Full name', was('name'), body.name);
    if (body.email !== was('email')) add('Email', was('email'), body.email);
    if (body.role && body.role !== acct.role) {
      add('Role', roleName(acct.role), roleName(body.role),
        body.role === 'super_admin' ? 'They will get full access, including User Management and Settings.' : 'They will lose User Management, Settings and Training changes.');
    }
    if ('avatar' in body) add('Photo', acct.avatar ? { img: acct.avatar } : '', body.avatar ? { img: body.avatar } : '');
    if (body.password) add('Password', '', 'A new password', 'They will need it at their next sign-in.');
    if (body.access_code) add('PIN', '', 'A new 6-digit PIN', 'They will need it at their next sign-in.');
    return rows;
  }

  /**
   * One confirmation step for every account change: lists what will change, asks for the acting
   * admin's own 6-digit PIN, then runs `submit(pin)`. The server checks the PIN (with a lockout).
   */
  function openConfirm({ title, sub, intro, changes, okText, danger = false, submit, done, onFieldError }) {
    _pending = { submit, done, onFieldError };
    setText('um-c-title', title);
    setText('um-c-sub', sub);
    const introEl = document.querySelector('#um-confirm-overlay .um-confirm-section');
    if (introEl) introEl.textContent = intro || 'You are about to change:';
    const list = document.getElementById('um-c-changes');
    if (list) {
      list.innerHTML = (changes || []).map((c) => `
        <li>
          <span class="um-ch-label">${esc(c.label)}</span>
          <span class="um-ch-values">${changeCell(c.from, 'um-ch-from')}<span class="um-ch-arrow" aria-label="to">→</span>${changeCell(c.to, 'um-ch-to')}</span>
          ${c.note ? `<span class="um-ch-note">${esc(c.note)}</span>` : ''}
        </li>`).join('');
    }
    const ok = document.getElementById('um-c-ok');
    if (ok) {
      ok.textContent = okText || 'Confirm & save';
      ok.classList.toggle('btn-danger', !!danger);
      ok.classList.toggle('btn-primary', !danger);
      ok.disabled = true;
    }
    document.querySelector('#um-confirm-overlay .um-confirm-icon')?.classList.toggle('is-danger', !!danger);
    _cpin?.clear();
    paint('uc-pin', null, false);
    const overlay = document.getElementById('um-confirm-overlay');
    if (overlay) overlay.hidden = false;
    setTimeout(() => _cpin?.focus(), 60);
  }

  function closeConfirm() {
    const overlay = document.getElementById('um-confirm-overlay');
    if (overlay) overlay.hidden = true;
    _pending = null;
  }

  function onConfirmPinInput() {
    const v = _cpin ? _cpin.value() : '';
    const ok = document.getElementById('um-c-ok');
    if (ok) ok.disabled = v.length !== 6;
    paint('uc-pin', null, false);
    if (v.length === 6) setTimeout(() => document.getElementById('um-c-ok')?.focus(), 0);
  }

  async function submitConfirmed() {
    if (!_pending || !_cpin) return;
    const pin = _cpin.value();
    if (pin.length !== 6) return;
    const job = _pending;
    const ok = document.getElementById('um-c-ok');
    if (ok) ok.disabled = true;
    AgriPricePH.Modals.loading('Saving…');
    try {
      const res = await job.submit(pin);
      AgriPricePH.Modals.hideLoading();
      if (!res.ok || !res.data?.success) {
        const code = res.data?.code;
        const msg = res.data?.error || 'Could not save this change.';
        if (code === 'pin_invalid' || code === 'locked') {
          paint('uc-pin', { state: 'error', msg: code === 'locked' ? msg : 'That PIN is incorrect. Try again.' }, true, false);
          _cpin.clear();
          const box = document.querySelector('#um-confirm-overlay .um-modal');
          box?.classList.remove('um-shake'); void box?.offsetWidth; box?.classList.add('um-shake');
          if (code !== 'locked') setTimeout(() => _cpin.focus(), 60);
          return;
        }
        closeConfirm();
        if (job.onFieldError) job.onFieldError(msg);
        else await AgriPricePH.Modals.alert({ title: 'Action failed', text: msg, type: 'danger' });
        return;
      }
      closeConfirm();
      await job.done?.(res);
    } catch {
      AgriPricePH.Modals.hideLoading();
      paint('uc-pin', { state: 'error', msg: 'Backend unreachable. Please try again.' }, true, false);
      if (ok) ok.disabled = false;
    }
  }

  function bindConfirm() {
    document.getElementById('um-c-close')?.addEventListener('click', closeConfirm);
    document.getElementById('um-c-cancel')?.addEventListener('click', closeConfirm);
    document.getElementById('um-c-ok')?.addEventListener('click', submitConfirmed);
    document.getElementById('um-confirm-overlay')?.addEventListener('mousedown', (e) => {
      if (e.target.id === 'um-confirm-overlay') closeConfirm();
    });
    document.getElementById('uc-pin')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitConfirmed(); }
    });
  }

  // ── deactivate / reactivate ──────────────────────────────────────────────

  async function toggleStatus(kind, acct) {
    const activating = acct.status !== 'active';
    const isAdmin = kind === 'admins';
    const who = isAdmin ? `${acct.name} (@${acct.username})` : `${acct.name} (${acct.email})`;
    openConfirm({
      title: activating ? 'Reactivate this account?' : 'Deactivate this account?',
      sub: who,
      intro: 'This will change:',
      changes: [{
        label: 'Status',
        from: activating ? 'Deactivated' : 'Active',
        to: activating ? 'Active' : 'Deactivated',
        note: activating
          ? 'They will be able to sign in again.'
          : `They will no longer be able to sign in${isAdmin ? ' and are signed out now' : ''}. The account and its history are kept; you can reactivate it any time.`,
      }],
      okText: activating ? 'Reactivate' : 'Deactivate',
      danger: !activating,
      submit: (pin) => AgriPricePH.API.post(`/api/admin/accounts/${kind}/${encodeURIComponent(acct.id)}/status`, { active: activating, confirm_pin: pin }),
      done: async (res) => {
        await load();
        await AgriPricePH.Modals.alert({
          title: activating ? 'Account reactivated' : 'Account deactivated',
          text: res.data.message,
          type: activating ? 'success' : 'info',
        });
      },
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  function togglePasswordVisibility(btn) {
    const ids = (btn.dataset.toggle || '').split(',');
    const first = document.getElementById(ids[0]);
    if (!first) return;
    const show = first.type === 'password';
    ids.forEach((id) => { const el = document.getElementById(id); if (el) el.type = show ? 'text' : 'password'; });
    btn.innerHTML = show ? ICON.eyeOff : ICON.eye;
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
