"""
"Continue with Google" (model/google_signin.py + POST /api/auth/google).

Google's real token check is replaced by a fake verifier, so these run offline against a throwaway
users database. What is pinned: only verified, correctly-addressed tokens are accepted; a Google
account signs in to the same AgriPricePH account every time; an existing account with the same email
is linked, never duplicated; a deactivated account stays locked out; no client secret is involved.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))
sys.path.insert(0, os.path.join(ROOT, "api"))

import google_signin as G  # noqa: E402
import user_store as S  # noqa: E402

CID = "1234-test.apps.googleusercontent.com"
PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U"


def claims(**over):
    c = {"iss": "https://accounts.google.com", "aud": CID, "sub": "g-111", "email": "maria@gmail.com",
         "email_verified": True, "name": "Maria Santos", "picture": "https://lh3.googleusercontent.com/a/x=s96-c"}
    c.update(over)
    return c


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "USERS_DB_PATH", str(tmp_path / "users.db"))
    monkeypatch.setenv("AGRIPRICE_GOOGLE_CLIENT_ID", CID)


def fake(c):
    return lambda credential, audience: c


def test_not_configured_is_refused(tmp_path, monkeypatch):
    monkeypatch.delenv("AGRIPRICE_GOOGLE_CLIENT_ID", raising=False)
    ok, msg, _ = G.verify_credential("tok", fake(claims()))
    assert not ok and "not set up" in msg


@pytest.mark.parametrize("over,needle", [
    ({"aud": "someone-else.apps.googleusercontent.com"}, "could not be verified"),
    ({"iss": "https://evil.example.com"}, "could not be verified"),
    ({"email_verified": False}, "verify your Google email"),
    ({"email": ""}, "did not share an email"),
])
def test_bad_tokens_are_refused(db, over, needle):
    ok, msg, _ = G.verify_credential("tok", fake(claims(**over)))
    assert not ok and needle in msg


def test_a_token_google_rejects_is_refused(db):
    def boom(credential, audience):
        raise ValueError("Token expired")
    ok, msg, _ = G.verify_credential("tok", boom)
    assert not ok and "could not be verified" in msg


def test_new_google_user_gets_an_account_with_photo(db):
    ok, _, c = G.verify_credential("tok", fake(claims()))
    assert ok
    ok, msg, user, info = G.sign_in(c, fetch_picture=lambda url: PHOTO)
    assert ok, msg
    assert info == {"created": True, "linked": False}
    assert user["email"] == "maria@gmail.com" and user["name"] == "Maria Santos"
    assert user["avatar"] == PHOTO and user["google_linked"] and user["welcome_seen_at"] is None
    assert user["last_login_at"]


def test_same_google_account_signs_into_the_same_account(db):
    _, _, first, _ = G.sign_in(claims(), fetch_picture=lambda url: "")
    # Even after the Google email changes, the Google id (sub) finds the same account.
    _, _, again, info = G.sign_in(claims(email="maria.new@gmail.com"), fetch_picture=lambda url: "")
    assert again["id"] == first["id"] and info == {"created": False, "linked": False}
    assert len(S.list_users()) == 1


def test_existing_email_account_is_linked_not_duplicated(db):
    existing = S.create_user("Maria S.", "maria@gmail.com", "hash")
    ok, _, user, info = G.sign_in(claims(), fetch_picture=lambda url: "")
    assert ok and user["id"] == existing["id"] and info["linked"]
    assert user["name"] == "Maria S."  # their own name is kept
    assert len(S.list_users()) == 1


def test_deactivated_account_stays_locked(db):
    existing = S.create_user("Maria S.", "maria@gmail.com", "hash")
    S.set_user_status(existing["id"], "deactivated")
    ok, msg, user, _ = G.sign_in(claims(), fetch_picture=lambda url: "")
    assert not ok and user is None and "deactivated" in msg


def test_google_account_has_no_known_password(db):
    _, _, user, _ = G.sign_in(claims(), fetch_picture=lambda url: "")
    import user_auth
    ok, _, _ = user_auth.login_user("maria@gmail.com", "")
    assert not ok


def test_endpoint_signs_in_and_never_exposes_a_secret(db, monkeypatch):
    import app as A
    if not (A._USER_AUTH_AVAILABLE and A._GOOGLE_AVAILABLE):
        pytest.skip("user auth unavailable")
    monkeypatch.setattr(G, "_google_verify", lambda credential, audience: claims())
    monkeypatch.setattr(G, "_picture_data_url", lambda url: "")
    c = A.app.test_client()
    cfg = c.get("/api/auth/config").get_json()
    assert cfg["google_client_id"] == CID and "secret" not in str(cfg).lower()
    r = c.post("/api/auth/google", json={"credential": "tok"})
    body = r.get_json()
    assert r.status_code == 200 and body["token"] and body["created"] is True
    assert body["user"]["email"] == "maria@gmail.com" and body["user"]["show_welcome"] is True
    r2 = c.post("/api/auth/google", json={"credential": "tok"})
    assert r2.get_json()["created"] is False
