/* AgriPricePH — Account Profile page (admin/pages/account.html) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.AccountProfile = (function () {

  let _mounted = false;
  let _profile = null; // current "security" section of /api/settings
  let _editingInfoId = null; // null = adding, otherwise editing that extra-info row
  let _managed = null; // an admin account created in User Management (its own photo only)

  function init() {
    if (_mounted) {
      loadProfile();
      loadActivity();
      return;
    }
    _mounted = true;
    mountOverlays();
    bindEvents();
    loadProfile();
    loadActivity();
  }

  function destroy() {
    _mounted = false;
    document.querySelectorAll('body > .account-modal-overlay').forEach((el) => el.remove());
  }

  // The edit/info dialogs are authored inside the page fragment, which sits in a container that
  // clips and stacks below the sidebar — so the dim layer never covered the whole screen and a
  // tall dialog could be cut off on short windows. Re-parenting them to <body> lets them cover
  // everything and centre against the real viewport.
  function mountOverlays() {
    ['account-edit-overlay', 'account-info-overlay'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.add('account-modal-overlay');
      document.body.appendChild(el);
    });
  }

  function bindEvents() {
    document.getElementById('account-avatar-edit-btn')?.addEventListener('click', () => {
      document.getElementById('account-avatar-input')?.click();
    });
    document.getElementById('account-avatar-input')?.addEventListener('change', onAvatarSelected);

    document.getElementById('account-edit-profile-btn')?.addEventListener('click', openEditModal);
    document.getElementById('account-edit-close')?.addEventListener('click', closeEditModal);
    document.getElementById('account-edit-cancel')?.addEventListener('click', closeEditModal);
    document.getElementById('account-edit-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'account-edit-overlay') closeEditModal();
    });
    document.getElementById('account-edit-save')?.addEventListener('click', saveProfile);

    document.getElementById('account-add-info-btn')?.addEventListener('click', () => openInfoModal(null));
    document.getElementById('account-info-close')?.addEventListener('click', closeInfoModal);
    document.getElementById('account-info-cancel')?.addEventListener('click', closeInfoModal);
    document.getElementById('account-info-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'account-info-overlay') closeInfoModal();
    });
    document.getElementById('account-info-save')?.addEventListener('click', saveInfoRow);

    document.getElementById('account-extra-list')?.addEventListener('click', (e) => {
      const editBtn = e.target.closest('[data-edit-info]');
      const delBtn = e.target.closest('[data-delete-info]');
      if (editBtn) openInfoModal(editBtn.dataset.editInfo);
      if (delBtn) deleteInfoRow(delBtn.dataset.deleteInfo);
    });
  }

  async function loadProfile() {
    // An additional admin (created in User Management) is not the built-in admin whose profile
    // lives in /api/settings — show their own account, read-only, instead of someone else's.
    const me = await AgriPricePH.API.get('/api/admin/me', { noCache: true }).then((r) => r.admin).catch(() => null);
    if (me && me.kind === 'account') {
      _managed = me;
      renderManagedAccount(me);
      return;
    }
    _managed = null;
    try {
      const data = await AgriPricePH.API.get('/api/settings');
      if (!data.ready) throw new Error(data.error || 'Settings unavailable');
      _profile = data.settings?.security || {};
      render();
    } catch (e) {
      console.warn('Account profile: settings API offline:', e);
      _profile = _profile || {};
      render();
    }
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

  /* Sign-ins, failed logins, lockouts, and logouts are already logged server-side under
     source="AUTH" (api/app.py) for the System Logs page — reused here instead of a new
     endpoint, filtered down to just this account's activity. */
  async function loadActivity() {
    try {
      const data = await AgriPricePH.API.get('/api/logs?limit=50');
      if (!data.ready) throw new Error(data.error || 'Logs unavailable');
      // Only this admin's own sign-in events (log lines name the account as '<username>').
      const me = AgriPricePH.AdminRole?.identity?.();
      const tag = me?.username ? `'${me.username}'` : '';
      const rows = (data.logs || [])
        .filter((l) => (l.source || '').toUpperCase() === 'AUTH')
        .filter((l) => !tag || String(l.msg || '').includes(tag))
        .slice(0, 6);
      renderActivity(rows);
    } catch (e) {
      console.warn('Account profile: activity log unavailable:', e);
      renderActivity([]);
    }
  }

  function renderActivity(rows) {
    const list = document.getElementById('account-activity-list');
    const empty = document.getElementById('account-activity-empty');
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
    const name = p.admin_display_name || 'Admin User';
    const role = p.admin_role || 'System Admin';
    const username = p.admin_username || 'admin';

    setText('account-name', name);
    setText('account-role', role);
    setText('account-username', `@${username}`);
    setText('account-bio', p.admin_bio?.trim() || 'No bio yet — click "Edit Profile" to add one.');
    setText('account-email', p.admin_email?.trim() || 'Not set');
    setText('account-phone', p.admin_phone?.trim() || 'Not set');

    renderAvatar(name, p.admin_avatar);
    renderExtraInfo(Array.isArray(p.admin_extra_info) ? p.admin_extra_info : []);

    // Keep the topbar avatar/name in sync without a full page reload.
    AgriPricePH.Topbar?.refreshUserBadge?.();
  }

  function renderManagedAccount(me) {
    setText('account-name', me.name);
    setText('account-role', me.role === 'super_admin' ? 'Super Admin' : 'Admin');
    setText('account-username', `@${me.username}`);
    setText('account-bio', 'This admin account is managed from User Management. You can change your own profile photo here; ask a Super Admin to change your name, email, role, password, or access code.');
    setText('account-email', 'Managed in User Management');
    setText('account-phone', 'Not set');
    renderAvatar(me.name, me.avatar || null);
    renderExtraInfo([]);
    ['account-edit-profile-btn', 'account-add-info-btn'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none'; // .btn sets display, which would override [hidden]
    });
  }

  function renderAvatar(name, avatarDataUrl) {
    const el = document.getElementById('account-avatar');
    if (!el) return;
    el.innerHTML = avatarDataUrl
      ? `<img src="${avatarDataUrl}" alt="${_esc(name)}" />`
      : _esc(initials(name));
  }

  function renderExtraInfo(rows) {
    const list = document.getElementById('account-extra-list');
    const empty = document.getElementById('account-extra-empty');
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

  // ── Edit Profile modal ──────────────────────────────────────────────────

  function openEditModal() {
    const p = _profile || {};
    setVal('account-edit-name', p.admin_display_name || '');
    setVal('account-edit-role', p.admin_role || '');
    setVal('account-edit-email', p.admin_email || '');
    setVal('account-edit-phone', p.admin_phone || '');
    setVal('account-edit-bio', p.admin_bio || '');
    show('account-edit-overlay');
  }

  function closeEditModal() {
    hide('account-edit-overlay');
  }

  async function saveProfile() {
    const name = getVal('account-edit-name').trim();
    if (!name) {
      await AgriPricePH.Modals.alert({ title: 'Display name required', text: 'Please enter a display name before saving.', type: 'warning' });
      return;
    }

    const patch = {
      admin_display_name: name,
      admin_role: getVal('account-edit-role').trim(),
      admin_email: getVal('account-edit-email').trim(),
      admin_phone: getVal('account-edit-phone').trim(),
      admin_bio: getVal('account-edit-bio').trim(),
    };

    AgriPricePH.Modals.loading('Saving profile…');
    try {
      const res = await AgriPricePH.API.put('/api/settings', { security: patch });
      if (!res.ok) throw new Error(res.data?.error || 'Save failed.');
      _profile = res.data?.settings?.security || { ..._profile, ...patch };
      AgriPricePH.Modals.hideLoading();
      closeEditModal();
      render();
      await AgriPricePH.Modals.alert({ title: 'Profile updated', text: 'Your changes have been saved.', type: 'success' });
    } catch (e) {
      AgriPricePH.Modals.hideLoading();
      await AgriPricePH.Modals.alert({ title: 'Save failed', text: e.message || 'Could not save your profile.', type: 'danger' });
    }
  }

  // ── Additional Info modal (add / edit) ──────────────────────────────────

  function openInfoModal(id) {
    _editingInfoId = id || null;
    const title = document.getElementById('account-info-modal-title');
    if (title) title.textContent = id ? 'Edit Info' : 'Add Info';

    const rows = Array.isArray(_profile?.admin_extra_info) ? _profile.admin_extra_info : [];
    const row = id ? rows.find((r) => r.id === id) : null;
    setVal('account-info-label', row?.label || '');
    setVal('account-info-value', row?.value || '');
    show('account-info-overlay');
  }

  function closeInfoModal() {
    hide('account-info-overlay');
    _editingInfoId = null;
  }

  async function saveInfoRow() {
    const label = getVal('account-info-label').trim();
    const value = getVal('account-info-value').trim();
    if (!label || !value) {
      await AgriPricePH.Modals.alert({ title: 'Missing fields', text: 'Both a label and a value are required.', type: 'warning' });
      return;
    }

    const rows = Array.isArray(_profile?.admin_extra_info) ? [..._profile.admin_extra_info] : [];
    if (_editingInfoId) {
      const idx = rows.findIndex((r) => r.id === _editingInfoId);
      if (idx >= 0) rows[idx] = { ...rows[idx], label, value };
    } else {
      rows.push({ id: `info_${Date.now().toString(36)}`, label, value });
    }

    await persistExtraInfo(rows, () => closeInfoModal());
  }

  async function deleteInfoRow(id) {
    const rows = Array.isArray(_profile?.admin_extra_info) ? _profile.admin_extra_info : [];
    const row = rows.find((r) => r.id === id);
    if (!row) return;

    const confirmed = await AgriPricePH.Modals.confirm({
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
    AgriPricePH.Modals.loading('Saving…');
    try {
      const res = await AgriPricePH.API.put('/api/settings', { security: { admin_extra_info: rows } });
      if (!res.ok) throw new Error(res.data?.error || 'Save failed.');
      _profile = res.data?.settings?.security || { ..._profile, admin_extra_info: rows };
      AgriPricePH.Modals.hideLoading();
      render();
      if (onSaved) onSaved();
    } catch (e) {
      AgriPricePH.Modals.hideLoading();
      await AgriPricePH.Modals.alert({ title: 'Save failed', text: e.message || 'Could not save additional info.', type: 'danger' });
    }
  }

  // ── Avatar upload ────────────────────────────────────────────────────────

  async function onAvatarSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      await AgriPricePH.Modals.alert({ title: 'Unsupported file', text: 'Please choose an image file (PNG, JPG, or WEBP).', type: 'warning' });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      await AgriPricePH.Modals.alert({ title: 'File too large', text: 'Please choose an image smaller than 8 MB.', type: 'warning' });
      return;
    }

    AgriPricePH.Modals.loading('Uploading photo…');
    try {
      const dataUrl = await resizeImageFile(file);
      if (_managed) {
        // Admin accounts made in User Management save their own photo on their own account.
        const r = await AgriPricePH.API.put('/api/admin/me/avatar', { avatar: dataUrl });
        if (!r.ok || !r.data?.success) throw new Error(r.data?.error || 'Upload failed.');
        _managed = { ..._managed, avatar: r.data.avatar };
        AgriPricePH.Modals.hideLoading();
        renderAvatar(_managed.name, _managed.avatar);
        AgriPricePH.Topbar?.refreshUserBadge?.();
        await AgriPricePH.Modals.alert({ title: 'Photo saved', text: 'Your new profile photo is saved to your account.', type: 'success' });
        return;
      }
      const res = await AgriPricePH.API.put('/api/settings', { security: { admin_avatar: dataUrl } });
      if (!res.ok) throw new Error(res.data?.error || 'Upload failed.');
      _profile = res.data?.settings?.security || { ..._profile, admin_avatar: dataUrl };
      AgriPricePH.Modals.hideLoading();
      render();
    } catch (err) {
      AgriPricePH.Modals.hideLoading();
      await AgriPricePH.Modals.alert({ title: 'Upload failed', text: err.message || 'Could not update your profile picture.', type: 'danger' });
    }
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

  // ── Helpers ──────────────────────────────────────────────────────────────

  function initials(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'AD';
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
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { init, destroy };
})();
