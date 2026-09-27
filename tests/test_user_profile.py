"""
Retailer profile storage (model/user_store.py) — the data behind public/profile.html, which works
like the admin Account Profile: partial saves, the same field limits, a photo, additional-info
rows, and the account's own activity history. Runs against a throwaway database, never the real
model/agriprice_users.db.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sqlite3
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))

import privacy  # noqa: E402
import user_store as S  # noqa: E402

TINY_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U"


@pytest.fixture()
def user(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "USERS_DB_PATH", str(tmp_path / "users.db"))
    return S.create_user("Maria Santos", "maria@example.com", "hash")


def test_partial_save_changes_only_the_fields_sent(user):
    ok, _ = S.update_profile(user["id"], {"phone": "0917 555 0101", "bio": "Retailer since 2019."})
    assert ok
    u = S.get_user_by_id(user["id"])
    assert (u["name"], u["email"], u["phone"], u["bio"]) == ("Maria Santos", "maria@example.com", "0917 555 0101", "Retailer since 2019.")
    ok, _ = S.update_profile(user["id"], {"title": "Rice retailer"})
    u = S.get_user_by_id(user["id"])
    assert ok and u["title"] == "Rice retailer" and u["phone"] == "0917 555 0101", "an unrelated save wiped a field"


@pytest.mark.parametrize("patch,needle", [
    ({"name": "   "}, "display name"),
    ({"title": "x" * 61}, "60"),
    ({"phone": "1" * 31}, "30"),
    ({"bio": "b" * 281}, "280"),
    ({"email": "not-an-email"}, "valid email"),
    ({"avatar": "javascript:alert(1)"}, "photo"),
    ({"avatar": "data:image/svg+xml;base64,PHN2Zz4="}, "photo"),
    ({"extra_info": [{"id": "a", "label": "", "value": "v"}]}, "label and a value"),
    ({"extra_info": [{"id": "a b", "label": "L", "value": "v"}]}, "label and a value"),
    ({"extra_info": [{"id": f"r{i}", "label": "L", "value": "v"} for i in range(21)]}, "20"),
])
def test_same_limits_as_the_admin_form(user, patch, needle):
    ok, msg = S.update_profile(user["id"], patch)
    assert not ok and needle in msg


def test_email_must_stay_unique(user):
    S.create_user("Other", "other@example.com", "hash")
    ok, msg = S.update_profile(user["id"], {"email": "OTHER@example.com"})
    assert not ok and "already used" in msg


def test_photo_and_additional_info_round_trip(user):
    rows = [{"id": "info_1", "label": "Stall", "value": "Stall 14, Quiapo"}]
    assert S.update_profile(user["id"], {"avatar": TINY_JPEG, "extra_info": rows})[0]
    u = S.get_user_by_id(user["id"])
    assert u["avatar"] == TINY_JPEG and u["extra_info"] == rows


def test_activity_is_per_account_newest_first_and_trimmed(user):
    other = S.create_user("Other", "other@example.com", "hash")
    for i in range(S.ACTIVITY_KEEP + 5):
        S.add_activity(user["id"], "INFO", f"event {i}")
    S.add_activity(other["id"], "WARN", "someone else's event")
    mine = S.list_activity(user["id"], 50)
    assert mine[0]["msg"] == f"event {S.ACTIVITY_KEEP + 4}"
    assert all("someone else" not in r["msg"] for r in mine)
    with sqlite3.connect(S.USERS_DB_PATH) as c:
        kept = c.execute("SELECT COUNT(*) FROM user_activity WHERE user_id = ?", (user["id"],)).fetchone()[0]
    assert kept == S.ACTIVITY_KEEP
    assert set(mine[0]) == {"time", "level", "msg"}, "activity rows must not carry anything else (e.g. an IP)"


def test_erasure_removes_sessions_and_activity(user):
    S.create_user_session(user["id"], 3600)
    S.add_activity(user["id"], "INFO", "Signed in")
    ok, _ = privacy.erase_data_subject("maria@example.com", db_path=S.USERS_DB_PATH)
    assert ok
    with sqlite3.connect(S.USERS_DB_PATH) as c:
        for table in ("users", "user_sessions", "user_activity"):
            assert c.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0, f"{table} kept rows after erasure"
