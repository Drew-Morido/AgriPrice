/* AgriPricePH — public User Profile page (public/profile.html).
   Logged-in only. Visual pattern mirrors the admin Account Profile module (admin/js/account.js) —
   a header card + plain hidden-attribute modal dialogs — but the data is only what a public
   account actually has: name, email, password. No avatar upload/bio/phone/activity log, since
   none of that exists for public users (model/user_store.py has no such columns). */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.PublicProfile = (function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function initials(name) {
    return (name || 'U').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  }

  function renderHeader() {
    const session = AgriPricePH.PublicAuth?.getSession?.();
    if (!session) return;
    const avatar = document.getElementById('profile-avatar');
    if (avatar) avatar.textContent = esc(initials(session.name));
    const nameEl = document.getElementById('profile-name');
    if (nameEl) nameEl.textContent = session.name || 'Account';
    const emailEl = document.getElementById('profile-email');
    if (emailEl) emailEl.textContent = session.email || '';
  }

  /* ================= Edit Profile modal ================= */
  function openEditModal() {
    const session = AgriPricePH.PublicAuth?.getSession?.() || {};
    const nameEl = document.getElementById('profile-edit-name');
    const emailEl = document.getElementById('profile-edit-email');
    if (nameEl) nameEl.value = session.name || '';
    if (emailEl) emailEl.value = session.email || '';
    const overlay = document.getElementById('profile-edit-overlay');
    if (overlay) overlay.hidden = false;
  }

  function closeEditModal() {
    const overlay = document.getElementById('profile-edit-overlay');
    if (overlay) overlay.hidden = true;
  }

  async function saveProfile() {
    const name = document.getElementById('profile-edit-name')?.value;
    const email = document.getElementById('profile-edit-email')?.value;
    const res = await AgriPricePH.PublicAuth?.updateProfile?.({ name, email });
    if (res?.ok) {
      closeEditModal();
      renderHeader();
      AgriPricePH.PublicAuth?.updateTopbarUser?.();
      AgriPricePH.PublicAlert?.success?.('Profile updated.');
    } else {
      AgriPricePH.PublicAlert?.invalid?.(res?.message || 'Could not update profile.');
    }
  }

  /* ================= Change Password modal ================= */
  function openPasswordModal() {
    ['profile-pw-current', 'profile-pw-new', 'profile-pw-confirm'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const overlay = document.getElementById('profile-password-overlay');
    if (overlay) overlay.hidden = false;
  }

  function closePasswordModal() {
    const overlay = document.getElementById('profile-password-overlay');
    if (overlay) overlay.hidden = true;
  }

  async function savePassword() {
    const current = document.getElementById('profile-pw-current')?.value || '';
    const next = document.getElementById('profile-pw-new')?.value || '';
    const confirm = document.getElementById('profile-pw-confirm')?.value || '';
    if (next !== confirm) { AgriPricePH.PublicAlert?.invalid?.('New passwords do not match.'); return; }
    const res = await AgriPricePH.PublicAuth?.changeUserPassword?.({ current, next });
    if (res?.ok) {
      closePasswordModal();
      AgriPricePH.PublicAlert?.success?.('Password updated.');
    } else {
      AgriPricePH.PublicAlert?.invalid?.(res?.message || 'Could not change password.');
    }
  }

  function bindEvents() {
    document.getElementById('profile-edit-btn')?.addEventListener('click', openEditModal);
    document.getElementById('profile-edit-close')?.addEventListener('click', closeEditModal);
    document.getElementById('profile-edit-cancel')?.addEventListener('click', closeEditModal);
    document.getElementById('profile-edit-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'profile-edit-overlay') closeEditModal();
    });
    document.getElementById('profile-edit-save')?.addEventListener('click', saveProfile);

    document.getElementById('profile-password-btn')?.addEventListener('click', openPasswordModal);
    document.getElementById('profile-password-close')?.addEventListener('click', closePasswordModal);
    document.getElementById('profile-password-cancel')?.addEventListener('click', closePasswordModal);
    document.getElementById('profile-password-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'profile-password-overlay') closePasswordModal();
    });
    document.getElementById('profile-password-save')?.addEventListener('click', savePassword);

    document.getElementById('profile-logout-btn')?.addEventListener('click', () => {
      AgriPricePH.PublicAuth?.logout?.();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const editOverlay = document.getElementById('profile-edit-overlay');
      const pwOverlay = document.getElementById('profile-password-overlay');
      if (editOverlay && !editOverlay.hidden) closeEditModal();
      else if (pwOverlay && !pwOverlay.hidden) closePasswordModal();
    });
  }

  function initProfilePage() {
    // Logged-in users only. Guests (incl. direct-URL access) are redirected.
    if (!AgriPricePH.PublicAuth?.isLoggedIn?.()) {
      window.location.replace('landpage.html');
      return;
    }
    renderHeader();
    bindEvents();
    AgriPricePH.PublicAuth?.updateTopbarUser?.();
  }

  return { initProfilePage };
})();
