/* AgriPricePH — public User Profile page (public/profile.html).
   Logged-in only. Behaves like the admin Account Profile (admin/js/account.js), not just looks
   like it: profile photo upload (resized in the browser, saved to the account), editable display
   name / role-title / email / phone / bio, About and Contact cards, Recent Activity (this
   account's own sign-in and account events), and Additional Information rows you can add, edit
   and delete — with the same limits, messages and the admin's own loading / alert / confirm
   dialogs (admin/js/ui-modals.js). Data lives server-side on the account (model/user_store.py,
   GET/PUT /api/auth/profile, GET /api/auth/activity).
   Retailer-only differences, forced by the account model: the email is the login (so it is
   required and must be unique), and the password change and log out live here because a
   retailer has no admin Settings page or admin top bar. */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.PublicProfile = (function () {
  const Auth = () => AgriPricePH.PublicAuth;
  const Modals = () => AgriPricePH.Modals;

  let _profile = null;          // the account's profile, as last returned by the server
  let _editingInfoId = null;    // null = adding, otherwise editing that extra-info row

  function initProfilePage() {
    // Logged-in users only. Guests (incl. direct-URL access) are redirected.
    if (!Auth()?.isLoggedIn?.()) {
      window.location.replace('landpage.html');
      return;
    }
    // Paint what the browser already knows at once, then load the full profile.
    const s = Auth().getSession() || {};
    _profile = { name: s.name, email: s.email, title: s.title, avatar: s.avatar, extra_info: [] };
    render();
    bindEvents();
    loadProfile();
    loadActivity();
  }

  function bindEvents() {
    document.getElementById('profile-avatar-edit-btn')?.addEventListener('click', () => {
      document.getElementById('profile-avatar-input')?.click();
    });
    document.getElementById('profile-avatar-input')?.addEventListener('change', onAvatarSelected);

    document.getElementById('profile-edit-btn')?.addEventListener('click', openEditModal);
    document.getElementById('profile-edit-close')?.addEventListener('click', closeEditModal);
    document.getElementById('profile-edit-cancel')?.addEventListener('click', closeEditModal);
    document.getElementById('profile-edit-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'profile-edit-overlay') closeEditModal();
    });
    document.getElementById('profile-edit-save')?.addEventListener('click', saveProfile);

    document.getElementById('profile-add-info-btn')?.addEventListener('click', () => openInfoModal(null));
    document.getElementById('profile-info-close')?.addEventListener('click', closeInfoModal);
    document.getElementById('profile-info-cancel')?.addEventListener('click', closeInfoModal);
    document.getElementById('profile-info-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'profile-info-overlay') closeInfoModal();
    });
    document.getElementById('profile-info-save')?.addEventListener('click', saveInfoRow);

    document.getElementById('profile-extra-list')?.addEventListener('click', (e) => {
      const editBtn = e.target.closest('[data-edit-info]');
      const delBtn = e.target.closest('[data-delete-info]');
      if (editBtn) openInfoModal(editBtn.dataset.editInfo);
      if (delBtn) deleteInfoRow(delBtn.dataset.deleteInfo);
    });

    document.getElementById('profile-password-btn')?.addEventListener('click', openPasswordModal);
    document.getElementById('profile-password-close')?.addEventListener('click', closePasswordModal);
    document.getElementById('profile-password-cancel')?.addEventListener('click', closePasswordModal);
    document.getElementById('profile-password-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'profile-password-overlay') closePasswordModal();
    });
    document.getElementById('profile-password-save')?.addEventListener('click', savePassword);
    document.getElementById('profile-logout-btn')?.addEventListener('click', () => Auth()?.logout?.());

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (document.getElementById('ui-modal-overlay')?.hidden === false) return;   // a dialog is on top
      ['profile-edit-overlay', 'profile-info-overlay', 'profile-password-overlay'].forEach((id) => {
        const el = document.getElementById(id);
        if (el && !el.hidden) { el.hidden = true; if (id === 'profile-info-overlay') _editingInfoId = null; }
      });
    });
  }

  /* The server no longer recognises this login (expired, signed out elsewhere, or deactivated). */
  async function sessionExpired(message) {
    ['profile-edit-overlay', 'profile-info-overlay', 'profile-password-overlay'].forEach(hide);
    Modals().hideLoading();
    Auth()?.updateTopbarUser?.();
    await Modals().alert({ title: 'Please log in again', text: message || 'Your session has expired.', type: 'warning' });
    window.location.href = 'login.html?next=profile.html';
  }

  async function loadProfile() {
    const res = await Auth().getProfile();
    if (res.expired) { sessionExpired(res.message); return; }
    if (!res.ok) {
      console.warn('Profile: could not load the account profile:', res.message);
      return;
    }
    _profile = res.user;
    render();
  }

  const ACTIVITY_ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    danger:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  function activityTone(level) {
    const lv = (level || '').toUpperCase();
    if (lv === 'ERROR') return 'danger';
    if (lv === 'WARN' || lv === 'WARNING') return 'warning';
    if (lv === 'INFO') return 'success';
    return 'info';
  }

  /* This account's own sign-ins, failed sign-ins, lockouts, sign-outs, password changes and
     login-email changes — the same kind of security events the admin profile lists (recorded
     server-side on the account — never another user's, and no IP address). */
  async function loadActivity() {
    const res = await Auth().getActivity(6);
    if (!res.ok) console.warn('Profile: activity unavailable');
    renderActivity(res.logs || []);
  }

  function renderActivity(rows) {
    const list = document.getElementById('profile-activity-list');
    const empty = document.getElementById('profile-activity-empty');
    if (!list) return;

    if (!rows.length) {
      list.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    list.innerHTML = rows.map((row) => {
      const tone = activityTone(row.level);
      return `
        <div class="account-activity-row">
          <span class="account-activity-icon ${tone}">${ACTIVITY_ICONS[tone]}</span>
          <div class="account-activity-main">
            <div class="account-activity-msg">${_esc(row.msg)}</div>
            <div class="account-activity-time">${_esc(row.time)}</div>
          </div>
        </div>`;
    }).join('');
  }

  function render() {
    const p = _profile || {};
    const name = p.name || 'Account';

    setText('profile-name', name);
    setText('profile-role', p.title?.trim() || 'Retailer');
    setText('profile-email', p.email || '');
    setText('profile-bio', p.bio?.trim() || 'No bio yet — click "Edit Profile" to add one.');
    setText('profile-contact-email', p.email?.trim() || 'Not set');
    setText('profile-phone', p.phone?.trim() || 'Not set');

    renderAvatar(name, p.avatar);
    renderExtraInfo(Array.isArray(p.extra_info) ? p.extra_info : []);

    // Keep the nav's name and photo in sync without a full page reload.
    Auth()?.updateTopbarUser?.();
  }

  function renderAvatar(name, avatarDataUrl) {
    const el = document.getElementById('profile-avatar');
    if (!el) return;
    el.innerHTML = avatarDataUrl
      ? `<img src="${_esc(avatarDataUrl)}" alt="${_esc(name)}" />`
      : _esc(initials(name));
  }

  function renderExtraInfo(rows) {
    const list = document.getElementById('profile-extra-list');
    const empty = document.getElementById('profile-extra-empty');
    if (!list) return;

    if (!rows.length) {
      list.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    list.innerHTML = rows.map((row) => `
      <div class="account-extra-row">
        <div class="account-extra-main">
          <div class="account-extra-label">${_esc(row.label)}</div>
          <div class="account-extra-value">${_esc(row.value)}</div>
        </div>
        <div class="account-extra-actions">
          <button type="button" class="icon-btn-sm" data-edit-info="${_esc(row.id)}" title="Edit" aria-label="Edit ${_esc(row.label)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button type="button" class="icon-btn-sm danger" data-delete-info="${_esc(row.id)}" title="Delete" aria-label="Delete ${_esc(row.label)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>
        </div>
      </div>`).join('');
  }

  /* One save path for every partial update (details, photo, additional info): loading dialog,
     then the server's saved profile replaces the local copy — as in the admin profile. */
  async function persist(patch, loadingText, failTitle, failText) {
    Modals().loading(loadingText);
    const res = await Auth().updateProfile(patch);
    Modals().hideLoading();
    if (res.expired) { await sessionExpired(res.message); return false; }
    if (!res.ok) {
      await Modals().alert({ title: failTitle, text: res.message || failText, type: 'danger' });
      return false;
    }
    _profile = res.user || { ..._profile, ...patch };
    render();
    loadActivity();
    return true;
  }

  // ── Edit Profile modal ──────────────────────────────────────────────────

  function openEditModal() {
    const p = _profile || {};
    setVal('profile-edit-name', p.name || '');
    setVal('profile-edit-role', p.title || '');
    setVal('profile-edit-email', p.email || '');
    setVal('profile-edit-phone', p.phone || '');
    setVal('profile-edit-bio', p.bio || '');
    show('profile-edit-overlay');
  }

  function closeEditModal() {
    hide('profile-edit-overlay');
  }

  async function saveProfile() {
    const name = getVal('profile-edit-name').trim();
    if (!name) {
      await Modals().alert({ title: 'Display name required', text: 'Please enter a display name before saving.', type: 'warning' });
      return;
    }
    const email = getVal('profile-edit-email').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await Modals().alert({ title: 'Email required', text: 'Your email is how you log in — please enter a valid email address.', type: 'warning' });
      return;
    }

    const patch = {
      name,
      title: getVal('profile-edit-role').trim(),
      email,
      phone: getVal('profile-edit-phone').trim(),
      bio: getVal('profile-edit-bio').trim(),
    };

    const loginChanged = email.toLowerCase() !== String(_profile?.email || '').toLowerCase();
    const saved = await persist(patch, 'Saving profile…', 'Save failed', 'Could not save your profile.');
    if (!saved) return;
    closeEditModal();
    await Modals().alert({
      title: 'Profile updated',
      text: loginChanged
        ? `Your changes have been saved. Use ${email.toLowerCase()} to log in from now on.`
        : 'Your changes have been saved.',
      type: 'success',
    });
  }

  // ── Additional Info modal (add / edit) ──────────────────────────────────

  function openInfoModal(id) {
    _editingInfoId = id || null;
    const title = document.getElementById('profile-info-modal-title');
    if (title) title.textContent = id ? 'Edit Info' : 'Add Info';

    const rows = Array.isArray(_profile?.extra_info) ? _profile.extra_info : [];
    const row = id ? rows.find((r) => r.id === id) : null;
    setVal('profile-info-label', row?.label || '');
    setVal('profile-info-value', row?.value || '');
    show('profile-info-overlay');
  }

  function closeInfoModal() {
    hide('profile-info-overlay');
    _editingInfoId = null;
  }

  async function saveInfoRow() {
    const label = getVal('profile-info-label').trim();
    const value = getVal('profile-info-value').trim();
    if (!label || !value) {
      await Modals().alert({ title: 'Missing fields', text: 'Both a label and a value are required.', type: 'warning' });
      return;
    }

    const rows = Array.isArray(_profile?.extra_info) ? [..._profile.extra_info] : [];
    if (_editingInfoId) {
      const idx = rows.findIndex((r) => r.id === _editingInfoId);
      if (idx >= 0) rows[idx] = { ...rows[idx], label, value };
    } else {
      rows.push({ id: `info_${Date.now().toString(36)}`, label, value });
    }

    await persistExtraInfo(rows, () => closeInfoModal());
  }

  async function deleteInfoRow(id) {
    const rows = Array.isArray(_profile?.extra_info) ? _profile.extra_info : [];
    const row = rows.find((r) => r.id === id);
    if (!row) return;

    const confirmed = await Modals().confirm({
      title: 'Remove this info?',
      text: `Delete "${row.label}"? This cannot be undone.`,
      type: 'warning',
      okText: 'Delete',
      danger: true,
    });
    if (!confirmed) return;

    await persistExtraInfo(rows.filter((r) => r.id !== id));
  }

  async function persistExtraInfo(rows, onSaved) {
    const saved = await persist({ extra_info: rows }, 'Saving…', 'Save failed', 'Could not save additional info.');
    if (saved && onSaved) onSaved();
  }

  // ── Avatar upload ────────────────────────────────────────────────────────

  async function onAvatarSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      await Modals().alert({ title: 'Unsupported file', text: 'Please choose an image file (PNG, JPG, or WEBP).', type: 'warning' });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      await Modals().alert({ title: 'File too large', text: 'Please choose an image smaller than 8 MB.', type: 'warning' });
      return;
    }

    let dataUrl;
    try {
      dataUrl = await resizeImageFile(file);
    } catch (err) {
      await Modals().alert({ title: 'Upload failed', text: err.message || 'Could not update your profile picture.', type: 'danger' });
      return;
    }
    await persist({ avatar: dataUrl }, 'Uploading photo…', 'Upload failed', 'Could not update your profile picture.');
  }

  function resizeImageFile(file, maxDim = 240, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the selected file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file is not a valid image.'));
        img.onload = () => {
          let { width, height } = img;
          if (width >= height && width > maxDim) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else if (height > maxDim) {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ── Change Password (retailer-only; see the header comment) ─────────────

  function openPasswordModal() {
    ['profile-pw-current', 'profile-pw-new', 'profile-pw-confirm'].forEach((id) => setVal(id, ''));
    show('profile-password-overlay');
  }

  function closePasswordModal() {
    hide('profile-password-overlay');
  }

  async function savePassword() {
    const current = getVal('profile-pw-current');
    const next = getVal('profile-pw-new');
    const confirm = getVal('profile-pw-confirm');
    if (next !== confirm) {
      await Modals().alert({ title: 'Passwords do not match', text: 'Type the same new password in both boxes.', type: 'warning' });
      return;
    }
    Modals().loading('Updating password…');
    const res = await Auth().changeUserPassword({ current, next });
    Modals().hideLoading();
    if (res.expired) { await sessionExpired(res.message); return; }
    if (!res.ok) {
      await Modals().alert({ title: 'Password not changed', text: res.message || 'Could not change your password.', type: 'danger' });
      loadActivity();
      return;
    }
    closePasswordModal();
    loadActivity();
    await Modals().alert({ title: 'Password updated', text: 'Your new password is saved. Any other device signed in to this account has been signed out.', type: 'success' });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function initials(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'U';
    return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
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
  function show(id) {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  }
  function hide(id) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { initProfilePage };
})();
