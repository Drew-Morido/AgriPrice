"""
Security fixes (2026-10-01 audit). Each test pins one hole that was open:

 1. /api/save-export (no login, unchecked path) is gone.
 2. Lockouts cannot be dodged by faking X-Forwarded-For or by switching address; the 6-digit reset
    code dies after 5 wrong tries; a correct admin password no longer resets the PIN counter.
 3. GET /api/settings shows admin details and the file path only to a signed-in admin.
 4. The built-in admin signed in with Admin@123 / 123456 can do nothing but change them; Settings ->
    Change Password really changes the sign-in password; Reset Defaults keeps the admin login;
    a PIN saved through Settings is no longer overwritten.
 5. Security headers (frame-ancestors, nosniff, CSP) are sent.
 6. The admin token is never read from the URL.
 7. Admin-only reads (alerts, live logs, scrape review) need an admin session.
 8. A brand "image" must really be an image.

Runs against throwaway settings / users files — never the real ones.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sys
import time

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))
sys.path.insert(0, os.path.join(ROOT, "api"))

import admin_auth as AA  # noqa: E402
import settings_store as SS  # noqa: E402
import user_auth as UA  # noqa: E402
import user_store as US  # noqa: E402


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(SS, "SETTINGS_PATH", str(tmp_path / "settings.json"))
    monkeypatch.setattr(US, "USERS_DB_PATH", str(tmp_path / "users.db"))
    for bucket in (AA._FAILED, AA._SESSIONS, UA.LOGIN_ATTEMPTS, UA.RESET_VERIFY_ATTEMPTS, UA._RESET_CODES):
        bucket.clear()
    import app as A
    if not (A._ADMIN_AUTH_AVAILABLE and A._USER_AUTH_AVAILABLE):
        pytest.skip("auth modules unavailable")
    yield A
    for bucket in (AA._FAILED, AA._SESSIONS, UA.LOGIN_ATTEMPTS, UA.RESET_VERIFY_ATTEMPTS, UA._RESET_CODES):
        bucket.clear()


def client(A, addr="10.0.0.1"):
    return A.app.test_client(), {"REMOTE_ADDR": addr}


def admin_login(A, password="Admin@123", code="123456", addr="10.0.0.9"):
    c, env_ = client(A, addr)
    r = c.post("/api/admin/verify", json={"username": "admin", "password": password, "access_code": code},
               environ_base=env_)
    return c, r


# ── 1 ──
def test_save_export_endpoint_is_gone(env):
    c, e = client(env)
    r = c.post("/api/save-export", json={"module": "../../api", "filename": "x.py", "csv_data": "boom"}, environ_base=e)
    assert r.status_code in (404, 405)
    assert not os.path.exists(os.path.join(ROOT, "api", "x.py"))


# ── 2 ──
def test_fake_forwarded_for_does_not_dodge_the_lockout(env):
    US.create_user("Ana", "ana@example.com", "pbkdf2:sha256:1$x$y")
    c, e = client(env)
    for i in range(5):
        c.post("/api/auth/login", json={"email": "ana@example.com", "password": "nope"},
               headers={"X-Forwarded-For": f"203.0.113.{i}"}, environ_base=e)
    r = c.post("/api/auth/login", json={"email": "ana@example.com", "password": "nope"},
               headers={"X-Forwarded-For": "198.51.100.77"}, environ_base=e)
    assert r.status_code == 429


def test_switching_address_does_not_dodge_the_account_lockout(env):
    US.create_user("Ana", "ana@example.com", "pbkdf2:sha256:1$x$y")
    for i in range(5):
        c, e = client(env, f"10.1.0.{i}")
        c.post("/api/auth/login", json={"email": "ana@example.com", "password": "nope"}, environ_base=e)
    c, e = client(env, "10.9.9.9")
    r = c.post("/api/auth/login", json={"email": "ana@example.com", "password": "nope"}, environ_base=e)
    assert r.status_code == 429


def test_reset_code_dies_after_five_wrong_tries():
    UA._RESET_CODES.clear()
    UA._RESET_CODES["ana@example.com"] = {"code_hash": UA._hash_code("482915"), "expires_at": time.time() + 600}
    for _ in range(4):
        ok, msg, _ = UA.verify_reset_code("ana@example.com", "000000")
        assert not ok and "left" in msg
    ok, msg, _ = UA.verify_reset_code("ana@example.com", "000000")
    assert not ok and "Request a new code" in msg
    ok, _, _ = UA.verify_reset_code("ana@example.com", "482915")   # even the right code is now dead
    assert not ok
    UA._RESET_CODES.clear()


def test_right_password_no_longer_resets_the_pin_counter(env):
    c, e = client(env, "10.2.2.2")
    for _ in range(4):
        c.post("/api/admin/verify", json={"username": "admin", "password": "Admin@123", "access_code": "000000"}, environ_base=e)
        assert c.post("/api/admin/verify-password", json={"username": "admin", "password": "Admin@123"},
                      environ_base=e).status_code == 200
    c.post("/api/admin/verify", json={"username": "admin", "password": "Admin@123", "access_code": "000000"}, environ_base=e)
    r = c.post("/api/admin/verify", json={"username": "admin", "password": "Admin@123", "access_code": "123456"}, environ_base=e)
    assert r.status_code == 429


# ── 3 ──
def test_settings_hide_admin_details_from_the_public(env):
    SS.update_settings({"security": {"admin_email": "boss@example.com", "admin_phone": "0917"}})
    c, e = client(env)
    body = c.get("/api/settings", environ_base=e).get_json()
    text = str(body)
    assert "boss@example.com" not in text and "admin_username" not in text and "path" not in body
    assert set(body["settings"]["general"]) == {"system_name", "currency", "date_format"}


def test_settings_full_for_a_signed_in_admin(env, monkeypatch):
    SS.update_settings({"security": {"admin_email": "boss@example.com"}})
    monkeypatch.setattr(env, "session_identity", lambda t: {"kind": "primary", "id": "primary", "role": "super_admin"})
    c, e = client(env)
    body = c.get("/api/settings", headers={"Authorization": "Bearer x"}, environ_base=e).get_json()
    assert body["settings"]["security"]["admin_email"] == "boss@example.com" and "path" not in body


# ── 4 ──
def test_default_login_can_only_change_the_defaults(env):
    c, r = admin_login(env)
    assert r.status_code == 200 and r.get_json()["admin"]["must_change_credentials"] is True
    h = {"Authorization": f"Bearer {r.get_json()['token']}"}
    blocked = c.get("/api/logs", headers=h)
    assert blocked.status_code == 403 and blocked.get_json()["code"] == "must_change_credentials"
    assert c.post("/api/admin/me/credentials", headers=h, json={"current_password": "wrong", "new_password": "Harvest2026x",
                  "new_pin": "482915"}).status_code == 400
    assert c.post("/api/admin/me/credentials", headers=h, json={"current_password": "Admin@123", "new_password": "Harvest2026x",
                  "new_pin": "111111"}).status_code == 400
    ok = c.post("/api/admin/me/credentials", headers=h, json={"current_password": "Admin@123", "new_password": "Harvest2026x",
                "new_pin": "482915"})
    assert ok.status_code == 200 and ok.get_json()["admin"]["must_change_credentials"] is False
    assert c.get("/api/logs", headers=h).status_code == 200
    _, again = admin_login(env, "Harvest2026x", "482915", addr="10.0.0.10")
    assert again.status_code == 200 and again.get_json()["admin"]["must_change_credentials"] is False
    assert admin_login(env, addr="10.0.0.11")[1].status_code == 401   # the defaults no longer work


def test_settings_change_password_changes_the_real_sign_in_password(env):
    ok, msg = SS.change_password("Admin@123", "Harvest2026x")
    assert ok, msg
    ok, _, _ = AA.authenticate_admin("admin", "Harvest2026x", "123456")
    assert ok


def test_reset_defaults_keeps_the_admin_login(env):
    assert AA.change_primary_credentials("Admin@123", "Harvest2026x", "482915")[0]
    SS.reset_to_defaults()
    assert AA.authenticate_admin("admin", "Harvest2026x", "482915")[0]
    assert not AA.authenticate_admin("admin", "Admin@123", "123456")[0]


def test_pin_saved_through_settings_is_kept(env):
    SS.update_settings({"security": {"admin_access_code": "482915", "admin_display_name": "Boss"}})
    assert AA.verify_access_code("482915")
    assert not AA.verify_access_code("123456")


def test_settings_cannot_set_credentials_or_username(env):
    SS.update_settings({"security": {"admin_password_hash": "x", "password_hash": "y", "admin_username": "root"}})
    raw = SS._load_raw()["security"]
    assert raw.get("admin_username", "admin") == "admin" and raw.get("admin_password_hash") != "x"


# ── 5 ──
def test_security_headers(env):
    c, e = client(env)
    page = c.get("/public/login.html", environ_base=e)
    assert page.headers.get("X-Frame-Options") == "SAMEORIGIN"
    assert page.headers.get("X-Content-Type-Options") == "nosniff"
    csp = page.headers.get("Content-Security-Policy", "")
    assert "frame-ancestors 'self'" in csp and "object-src 'none'" in csp and "accounts.google.com" in csp
    assert c.get("/api/auth/config", environ_base=e).headers.get("Cache-Control") == "no-store"


# ── 6 ──
def test_admin_token_is_not_read_from_the_url(env):
    c, r = admin_login(env)
    tok = r.get_json()["token"]
    assert c.get(f"/api/admin/session?token={tok}").status_code == 401
    assert c.get("/api/admin/session", headers={"Authorization": f"Bearer {tok}"}).status_code == 200


# ── 7 ──
@pytest.mark.parametrize("url", ["/api/alerts", "/api/alerts/log", "/api/alerts/summary", "/api/stream-training", "/api/stream-scrape", "/api/scrape-review"])
def test_admin_reads_need_a_session(env, url):
    c, e = client(env)
    assert c.get(url, environ_base=e).status_code == 401


# ── 8 ──
def test_brand_image_must_really_be_an_image(env):
    assert env._looks_like_image(b"\x89PNG\r\n\x1a\n0000", "png")
    assert env._looks_like_image(b"\xff\xd8\xff\xe0", "jpg")
    assert env._looks_like_image(b"RIFF\x00\x00\x00\x00WEBPVP8 ", "webp")
    assert not env._looks_like_image(b"<html><script>", "png")
