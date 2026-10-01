"""
Admin roles (Super Admin vs Admin) and the Add Admin account rules.

* api/app.py: a plain Admin is refused (403) on every Super-Admin-only endpoint — User Management,
  Settings changes, model training, clearing logs, deleting report files — while /api/admin/me, which
  every admin needs to learn its own role, stays open. The UI hides the same things, but the server is
  the authority, so this is what is tested.
* model/user_management.py: new admins need an email, may not reuse another admin's email, and may
  not put the username inside the password. Public accounts are labelled "Public User".

Runs against a throwaway users database and patched sessions — never the real accounts.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))
sys.path.insert(0, os.path.join(ROOT, "api"))

import user_management as UM  # noqa: E402
import user_store as S  # noqa: E402

SUPER = {"kind": "account", "id": 1, "username": "boss", "name": "Boss", "role": "super_admin"}
ADMIN = {"kind": "account", "id": 2, "username": "operator", "name": "Op Erator", "role": "admin"}

SUPER_ONLY = [
    ("PUT", "/api/settings"),
    ("POST", "/api/settings/reset"),
    ("POST", "/api/settings/password"),
    ("POST", "/api/run-training"),
    ("POST", "/api/cancel-training"),
    ("POST", "/api/logs/clear"),
    ("DELETE", "/api/reports/file/example.csv"),
    ("GET", "/api/admin/accounts"),
    ("POST", "/api/admin/accounts/users"),
    ("GET", "/api/admin/accounts/users/1"),
    ("PUT", "/api/admin/accounts/users/1"),
    ("POST", "/api/admin/accounts/users/1/status"),
    ("POST", "/api/admin/accounts/admins"),
    ("PUT", "/api/admin/accounts/admins/1"),
    ("POST", "/api/admin/accounts/admins/1/status"),
]


@pytest.fixture(scope="module")
def app_module():
    import app as A  # noqa: E402  (api/app.py — importing it starts nothing; threads start in main)
    if not A._ADMIN_AUTH_AVAILABLE:
        pytest.skip("admin auth module unavailable")
    return A


def _client_as(A, monkeypatch, identity):
    monkeypatch.setattr(A, "session_identity", lambda token: identity)
    return A.app.test_client()


@pytest.mark.parametrize("method,url", SUPER_ONLY)
def test_plain_admin_is_refused_super_admin_actions(app_module, monkeypatch, method, url):
    c = _client_as(app_module, monkeypatch, ADMIN)
    r = c.open(url, method=method, json={})
    assert r.status_code == 403, f"{method} {url} let a plain Admin through ({r.status_code})"
    assert "Super Admin" in (r.get_json() or {}).get("error", "")


def test_signed_out_is_401_not_403(app_module, monkeypatch):
    c = _client_as(app_module, monkeypatch, None)
    assert c.put("/api/settings", json={}).status_code == 401


def test_every_admin_can_read_its_own_role(app_module, monkeypatch):
    c = _client_as(app_module, monkeypatch, ADMIN)
    r = c.get("/api/admin/me")
    assert r.status_code == 200 and r.get_json()["admin"]["role"] == "admin"


def test_super_admin_passes_the_guard(app_module, monkeypatch):
    c = _client_as(app_module, monkeypatch, SUPER)
    # No training is running, so a Super Admin gets the endpoint's own "nothing to cancel" answer.
    assert c.post("/api/cancel-training").status_code == 409


# ─── account rules ───

@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "USERS_DB_PATH", str(tmp_path / "users.db"))
    monkeypatch.setattr(UM, "_security", lambda: {"admin_username": "admin", "admin_email": "owner@example.com"})
    monkeypatch.setattr(UM, "primary_admin_username", lambda: "admin")


def _admin_payload(**over):
    p = {"username": "jdelacruz", "name": "Juan Dela Cruz", "email": "juan@example.com",
         "role": "admin", "password": "Harvest2026", "access_code": "482915"}
    p.update(over)
    return p


def test_new_admin_is_created(db):
    ok, msg, acct = UM.create_admin(_admin_payload(), SUPER)
    assert ok, msg
    assert acct["role"] == "admin" and acct["email"] == "juan@example.com" and acct["created_by"] == "boss"


@pytest.mark.parametrize("over,needle", [
    ({"email": ""}, "Email is required"),
    ({"email": "owner@example.com"}, "already used"),
    ({"password": "Jdelacruz2026"}, "must not contain the username"),
    ({"username": "admin"}, "already taken"),
    ({"access_code": "12345"}, "6 digits"),
])
def test_new_admin_rules(db, over, needle):
    ok, msg, _ = UM.create_admin(_admin_payload(**over), SUPER)
    assert not ok and needle in msg


def test_admin_email_is_unique_among_admins(db):
    assert UM.create_admin(_admin_payload(), SUPER)[0]
    ok, msg, _ = UM.create_admin(_admin_payload(username="maria", email="JUAN@example.com"), SUPER)
    assert not ok and "already used" in msg


def test_public_accounts_are_labelled_public_user(db):
    ok, _, user = UM.create_user({"name": "Ana Reyes", "email": "ana@example.com", "password": "Palay2026x"})
    assert ok and user["role_label"] == "Public User"


# ─── photos and the one-time welcome ───

TINY_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U"


def test_admin_photo_is_saved_at_creation_and_validated(db):
    ok, msg, acct = UM.create_admin(_admin_payload(avatar=TINY_JPEG), SUPER)
    assert ok, msg
    assert acct["avatar"] == TINY_JPEG
    ok, msg, _ = UM.create_admin(_admin_payload(username="maria", email="m@example.com",
                                                avatar="javascript:alert(1)"), SUPER)
    assert not ok and "photo" in msg


def test_admin_changes_own_photo_and_super_admin_can_change_it(db):
    _, _, acct = UM.create_admin(_admin_payload(), SUPER)
    me = {"kind": "account", "id": acct["id"], "username": acct["username"], "role": "admin"}
    ok, _, saved = UM.set_own_avatar(me, TINY_JPEG)
    assert ok and S.get_admin_account(acct["id"])["avatar"] == TINY_JPEG
    ok, msg, out = UM.update_admin(acct["id"], {"name": acct["name"], "email": acct["email"], "role": "admin", "avatar": ""}, SUPER)
    assert ok and out["avatar"] == "" and "photo removed" in msg


def test_welcome_shows_once_per_new_admin(db):
    _, _, acct = UM.create_admin(_admin_payload(), SUPER)
    me = {"kind": "account", "id": acct["id"]}
    assert UM.welcome_pending(me)
    assert S.mark_admin_welcomed(acct["id"]) is True
    assert not UM.welcome_pending(me)
    assert S.mark_admin_welcomed(acct["id"]) is False  # already seen: nothing changes
    assert not UM.welcome_pending({"kind": "primary", "id": "primary"})


def test_welcome_shows_once_per_new_public_user(db):
    ok, _, user = UM.create_user({"name": "Ana Reyes", "email": "ana@example.com", "password": "Palay2026x"})
    assert ok
    assert S.get_user_by_id(user["id"])["welcome_seen_at"] is None
    assert S.mark_user_welcomed(user["id"]) is True
    assert S.get_user_by_id(user["id"])["welcome_seen_at"]


def test_existing_accounts_are_not_welcomed_after_upgrade(tmp_path, monkeypatch):
    """Accounts made before the welcome existed must not suddenly get it."""
    import sqlite3
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, "
                 "email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, "
                 "role TEXT NOT NULL DEFAULT 'retailer', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
    conn.execute("INSERT INTO users (name, email, password_hash, created_at, updated_at) "
                 "VALUES ('Old User', 'old@example.com', 'h', '2026-01-01T00:00:00', '2026-01-01T00:00:00')")
    conn.commit()
    conn.close()
    monkeypatch.setattr(S, "USERS_DB_PATH", str(path))
    assert S.get_user_by_email("old@example.com")["welcome_seen_at"] == "2026-01-01T00:00:00"


def test_profile_detail_includes_activity(db):
    ok, _, user = UM.create_user({"name": "Ana Reyes", "email": "ana@example.com", "password": "Palay2026x"})
    S.add_activity(user["id"], "INFO", "Signed in")
    detail = UM.user_detail(user["id"])
    assert detail["email"] == "ana@example.com" and detail["activity"][0]["msg"] == "Signed in"
    assert "password_hash" not in detail


# ─── editing a public user: every profile field, confirmed with the admin's own PIN ───

PRIMARY = {"kind": "primary", "id": "primary", "username": "admin", "name": "Admin", "role": "super_admin"}


@pytest.fixture()
def edit_env(tmp_path, monkeypatch, app_module):
    import admin_auth as AA
    import settings_store as SS
    monkeypatch.setattr(SS, "SETTINGS_PATH", str(tmp_path / "settings.json"))   # default PIN 123456
    monkeypatch.setattr(S, "USERS_DB_PATH", str(tmp_path / "users.db"))
    monkeypatch.setattr(app_module, "session_identity", lambda token: PRIMARY)
    AA._FAILED.clear()
    ok, _, user = UM.create_user({"name": "Ana Reyes", "email": "ana@example.com", "password": "Palay2026x"})
    yield app_module.app.test_client(), user
    AA._FAILED.clear()


def test_public_user_edit_needs_the_admin_pin(edit_env):
    c, user = edit_env
    body = {"name": "Ana R. Reyes", "email": "ana@example.com"}
    assert c.put(f"/api/admin/accounts/users/{user['id']}", json=body).get_json()["code"] == "pin_invalid"
    r = c.put(f"/api/admin/accounts/users/{user['id']}", json={**body, "confirm_pin": "000000"})
    assert r.status_code == 403 and r.get_json()["code"] == "pin_invalid"
    assert S.get_user_by_id(user["id"])["name"] == "Ana Reyes"          # nothing saved
    ok = c.put(f"/api/admin/accounts/users/{user['id']}", json={**body, "confirm_pin": "123456"})
    assert ok.status_code == 200 and S.get_user_by_id(user["id"])["name"] == "Ana R. Reyes"


def test_wrong_pins_lock_the_edit(edit_env):
    c, user = edit_env
    body = {"name": "Ana Reyes", "email": "ana@example.com", "confirm_pin": "000000"}
    for _ in range(5):
        c.put(f"/api/admin/accounts/users/{user['id']}", json=body)
    r = c.put(f"/api/admin/accounts/users/{user['id']}", json={**body, "confirm_pin": "123456"})
    assert r.status_code == 429


def test_every_profile_field_is_saved_and_checked(edit_env):
    c, user = edit_env
    body = {"name": "Ana Reyes", "email": "ana@example.com", "title": "Rice retailer", "phone": "0917 555 0101",
            "bio": "Sells rice in Quezon City.", "avatar": TINY_JPEG, "confirm_pin": "123456"}
    assert c.put(f"/api/admin/accounts/users/{user['id']}", json=body).status_code == 200
    u = S.get_user_by_id(user["id"])
    assert (u["title"], u["phone"], u["bio"], u["avatar"]) == ("Rice retailer", "0917 555 0101", "Sells rice in Quezon City.", TINY_JPEG)
    assert any("updated your" in a["msg"] for a in S.list_activity(user["id"], 10))
    bad = c.put(f"/api/admin/accounts/users/{user['id']}", json={**body, "name": "Changed", "phone": "call me maybe"})
    assert bad.status_code == 400 and S.get_user_by_id(user["id"])["name"] == "Ana Reyes"   # all-or-nothing


def test_deactivate_and_reactivate_need_the_admin_pin(edit_env):
    c, user = edit_env
    url = f"/api/admin/accounts/users/{user['id']}/status"
    assert c.post(url, json={"active": False}).get_json()["code"] == "pin_invalid"
    assert S.get_user_by_id(user["id"])["status"] == "active"
    assert c.post(url, json={"active": False, "confirm_pin": "123456"}).status_code == 200
    assert S.get_user_by_id(user["id"])["status"] == "deactivated"
    assert c.post(url, json={"active": True, "confirm_pin": "000000"}).status_code == 403
    assert c.post(url, json={"active": True, "confirm_pin": "123456"}).status_code == 200


def test_admin_edit_and_status_need_the_admin_pin(edit_env):
    c, _ = edit_env
    _, _, acct = UM.create_admin(_admin_payload(), PRIMARY)
    body = {"name": "Juan D. Cruz", "email": "juan@example.com", "role": "admin"}
    assert c.put(f"/api/admin/accounts/admins/{acct['id']}", json=body).status_code == 403
    assert c.put(f"/api/admin/accounts/admins/{acct['id']}", json={**body, "confirm_pin": "123456"}).status_code == 200
    assert S.get_admin_account(acct["id"])["name"] == "Juan D. Cruz"
    url = f"/api/admin/accounts/admins/{acct['id']}/status"
    assert c.post(url, json={"active": False}).status_code == 403
    assert c.post(url, json={"active": False, "confirm_pin": "123456"}).status_code == 200
