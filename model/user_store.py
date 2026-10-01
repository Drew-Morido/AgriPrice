"""
AgriPricePH — server-side public/vendor user accounts (SQLite).

Public/vendor accounts used to live only in the visitor's own browser
localStorage (see public/js/public-auth.js) — there was no server-side user
table at all, which is why "forgot password" couldn't be real. This is that
table: email + password hash, nothing else sensitive. Runtime-generated (real
emails/hashes from actual use), so agriprice_users.db is gitignored — unlike
the committed market-data DB in datasets/.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Iterator

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
USERS_DB_PATH = os.path.join(MODEL_DIR, "agriprice_users.db")


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    """`with sqlite3.Connection` only commits/rolls back on exit — it does NOT
    close the connection, which leaks file handles (and on Windows, holds the
    DB file locked) over a long-running server. This wraps that up properly."""
    conn = sqlite3.connect(USERS_DB_PATH)
    conn.row_factory = sqlite3.Row
    # Keep the rollback journal in memory: the default mode creates and deletes a side file
    # (agriprice_users.db-journal) on every write, and sign-in now writes last-login times —
    # a dev file-watcher (Live/Five Server) sees that file appear and reloads the login page
    # mid-flow. These writes are single-row updates, so the durability trade-off is negligible.
    conn.execute("PRAGMA journal_mode=MEMORY")
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              email TEXT NOT NULL UNIQUE COLLATE NOCASE,
              password_hash TEXT NOT NULL,
              role TEXT NOT NULL DEFAULT 'retailer',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        _migrate(conn)
        yield conn
        conn.commit()
    finally:
        conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    """Additive, idempotent schema upgrades for the User Management module.

    Deactivation is a soft delete (status flag), never a row delete: a deactivated account keeps
    its email reserved and its history, and can be reactivated. Additional admin accounts live in
    their own table; the original built-in admin stays in system_settings.json (see admin_auth.py)
    so existing sign-in, Settings, and Account Profile keep working unchanged.
    """
    cols = {r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "status" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
    if "last_login_at" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN last_login_at TEXT")
    if "deactivated_at" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN deactivated_at TEXT")
    # Profile fields, the same set the admin Account Profile has (title, phone, bio, photo,
    # additional label/value rows). extra_info is a JSON list; avatar a small image data URL.
    for col in ("title", "phone", "bio", "avatar", "extra_info"):
        if col not in cols:
            conn.execute(f"ALTER TABLE users ADD COLUMN {col} TEXT")
    # The account's own sign-in and account activity, for its Profile page's Recent Activity.
    # Time, level and a message only: no IP addresses (the paper states the public site does not
    # log end-user IPs). Trimmed to the newest ACTIVITY_KEEP rows per user.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS user_activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          at TEXT NOT NULL,
          level TEXT NOT NULL,
          msg TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_user_activity_user ON user_activity (user_id, id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS admin_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          name TEXT NOT NULL,
          email TEXT,
          role TEXT NOT NULL DEFAULT 'admin',
          password_hash TEXT NOT NULL,
          access_code_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login_at TEXT,
          deactivated_at TEXT
        )
        """
    )
    admin_cols = {r[1] for r in conn.execute("PRAGMA table_info(admin_accounts)").fetchall()}
    if "avatar" not in admin_cols:
        conn.execute("ALTER TABLE admin_accounts ADD COLUMN avatar TEXT")
    # One-time welcome popup on an account's first sign-in. Accounts that already existed when the
    # column was added count as welcomed (created_at), so only accounts made from now on see it.
    if "welcome_seen_at" not in admin_cols:
        conn.execute("ALTER TABLE admin_accounts ADD COLUMN welcome_seen_at TEXT")
        conn.execute("UPDATE admin_accounts SET welcome_seen_at = created_at")
    # "Continue with Google": the Google account id (the token's `sub`) linked to this account.
    if "google_sub" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN google_sub TEXT")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL")
    if "welcome_seen_at" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN welcome_seen_at TEXT")
        conn.execute("UPDATE users SET welcome_seen_at = created_at")
    # Small key/value store for sign-in bookkeeping (e.g. the built-in admin's last sign-in).
    # Kept in this .db rather than system_settings.json on purpose: dev file-watchers (Live/Five
    # Server) ignore *.db but reload the page on any .json write, which interrupted the login flow.
    conn.execute("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)")
    # Signed-in retailer sessions. Only a SHA-256 of each token is stored, so a copy of this file
    # does not hand out live logins. Keyed by user id (not email) so changing the email keeps the
    # session; persisted (unlike admin sessions) so "Remember me" survives a server restart.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS user_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          created_at REAL NOT NULL,
          expires_at REAL NOT NULL
        )
        """
    )


def get_meta(key: str) -> str | None:
    with _connect() as conn:
        row = conn.execute("SELECT value FROM app_meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(key: str, value: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO app_meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _extra_rows(raw: Any) -> list[dict[str, str]]:
    try:
        rows = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return []
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    keys = row.keys()
    opt = lambda k: row[k] if k in keys else None  # noqa: E731 — columns added by _migrate
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "password_hash": row["password_hash"],
        "role": row["role"],
        "status": row["status"] or "active",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_login_at": row["last_login_at"],
        "deactivated_at": row["deactivated_at"],
        "title": opt("title") or "",
        "phone": opt("phone") or "",
        "bio": opt("bio") or "",
        "avatar": opt("avatar") or "",
        "extra_info": _extra_rows(opt("extra_info")),
        "welcome_seen_at": opt("welcome_seen_at"),
        "google_linked": bool(opt("google_sub")),
    }


def get_user_by_email(email: str) -> dict[str, Any] | None:
    email = (email or "").strip().lower()
    if not email:
        return None
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    return _row_to_dict(row) if row else None


def create_user(name: str, email: str, password_hash: str, role: str = "retailer") -> dict[str, Any]:
    email = (email or "").strip().lower()
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            "INSERT INTO users (name, email, password_hash, role, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (name, email, password_hash, role, now, now),
        )
    return get_user_by_email(email)


def update_password_hash(email: str, new_hash: str) -> bool:
    email = (email or "").strip().lower()
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE users SET password_hash = ?, updated_at = ? WHERE email = ?",
            (new_hash, now, email),
        )
        rowcount = cur.rowcount
    return rowcount > 0


# Same fields and limits as the admin Account Profile's edit dialog (admin/pages/account.html).
PROFILE_LIMITS = {"name": 80, "title": 60, "phone": 30, "bio": 280}
EXTRA_MAX_ROWS = 20
EXTRA_LABEL_MAX = 40
EXTRA_VALUE_MAX = 120
AVATAR_MAX_CHARS = 400_000   # the page sends a ≤240px JPEG, ~20–40 KB; this is generous headroom
_AVATAR_RE = re.compile(r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$")
_EXTRA_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def check_avatar(avatar: Any) -> tuple[bool, str]:
    """A profile photo is "" (none) or a small PNG/JPG/WEBP data URL — shared by public users and
    admin accounts, so both are held to the same format and size limit."""
    avatar = str(avatar or "")
    if avatar and (len(avatar) > AVATAR_MAX_CHARS or not _AVATAR_RE.match(avatar)):
        return False, "That photo could not be saved. Please choose a PNG, JPG, or WEBP image."
    return True, avatar


def update_profile(user_id: int, patch: dict[str, Any]) -> tuple[bool, str]:
    """Update the account behind a verified session. Only the fields present in `patch` change
    (name, email, title, phone, bio, avatar, extra_info) — the same partial-save behaviour as
    the admin profile, where the photo and the additional-info rows save on their own. The
    account is the session's user id, never an email from the request body."""
    sets: dict[str, Any] = {}
    if "name" in patch:
        name = str(patch.get("name") or "").strip()
        if not name:
            return False, "Please enter a display name."
        if len(name) > PROFILE_LIMITS["name"]:
            return False, f"Display name must be {PROFILE_LIMITS['name']} characters or fewer."
        sets["name"] = name
    if "email" in patch:
        email = str(patch.get("email") or "").strip().lower()
        if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email) or len(email) > 120:
            return False, "Please enter a valid email address."
        other = get_user_by_email(email)
        if other and other["id"] != user_id:
            return False, "That email is already used by another account."
        sets["email"] = email
    for key in ("title", "phone", "bio"):
        if key in patch:
            val = str(patch.get(key) or "").strip()
            if len(val) > PROFILE_LIMITS[key]:
                return False, f"{key.capitalize()} must be {PROFILE_LIMITS[key]} characters or fewer."
            sets[key] = val
    if "avatar" in patch:
        ok, avatar = check_avatar(patch.get("avatar"))
        if not ok:
            return False, avatar
        sets["avatar"] = avatar
    if "extra_info" in patch:
        rows = patch.get("extra_info")
        if not isinstance(rows, list) or len(rows) > EXTRA_MAX_ROWS:
            return False, f"Additional information can have up to {EXTRA_MAX_ROWS} rows."
        clean = []
        for r in rows:
            if not isinstance(r, dict):
                return False, "Additional information is not in the expected format."
            rid = str(r.get("id") or "")
            label = str(r.get("label") or "").strip()
            value = str(r.get("value") or "").strip()
            if not _EXTRA_ID_RE.match(rid) or not label or not value:
                return False, "Each additional info row needs a label and a value."
            if len(label) > EXTRA_LABEL_MAX or len(value) > EXTRA_VALUE_MAX:
                return False, f"Labels are limited to {EXTRA_LABEL_MAX} characters and values to {EXTRA_VALUE_MAX}."
            clean.append({"id": rid, "label": label, "value": value})
        sets["extra_info"] = json.dumps(clean, ensure_ascii=False)
    if not sets:
        return False, "Nothing to update."
    sets["updated_at"] = _now()
    cols = ", ".join(f"{k} = ?" for k in sets)
    with _connect() as conn:
        cur = conn.execute(f"UPDATE users SET {cols} WHERE id = ?", (*sets.values(), user_id))
        rowcount = cur.rowcount
    if rowcount == 0:
        return False, "Account not found."
    return True, "Profile updated."


# ─── Account activity (the Profile page's Recent Activity) ───

ACTIVITY_KEEP = 100


def add_activity(user_id: int | None, level: str, msg: str) -> None:
    """Record one event on an account's own history. level: INFO | WARN | ERROR."""
    if not user_id:
        return
    with _connect() as conn:
        conn.execute(
            "INSERT INTO user_activity (user_id, at, level, msg) VALUES (?, ?, ?, ?)",
            (user_id, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), level, msg[:200]),
        )
        conn.execute(
            "DELETE FROM user_activity WHERE user_id = ? AND id NOT IN "
            "(SELECT id FROM user_activity WHERE user_id = ? ORDER BY id DESC LIMIT ?)",
            (user_id, user_id, ACTIVITY_KEEP),
        )


def list_activity(user_id: int, limit: int = 6) -> list[dict[str, str]]:
    """Newest first, in the same {time, level, msg} shape as the admin System Logs rows."""
    limit = max(1, min(50, int(limit or 6)))
    with _connect() as conn:
        rows = conn.execute(
            "SELECT at, level, msg FROM user_activity WHERE user_id = ? ORDER BY id DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    return [{"time": r["at"], "level": r["level"], "msg": r["msg"]} for r in rows]


# ─── Retailer sessions ───

def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_user_session(user_id: int, ttl_seconds: int) -> str:
    token = secrets.token_urlsafe(48)
    now = time.time()
    with _connect() as conn:
        conn.execute("DELETE FROM user_sessions WHERE expires_at < ?", (now,))
        conn.execute(
            "INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (_token_hash(token), user_id, now, now + ttl_seconds),
        )
    return token


def get_session_user(token: str | None) -> dict[str, Any] | None:
    """The active account a session token belongs to, or None (unknown, expired, or the account
    was deactivated since — deactivation signs the retailer out everywhere at once)."""
    if not token or not isinstance(token, str):
        return None
    th = _token_hash(token.strip())
    with _connect() as conn:
        row = conn.execute(
            "SELECT u.*, s.expires_at AS s_expires FROM user_sessions s "
            "JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
            (th,),
        ).fetchone()
        if not row:
            return None
        if row["s_expires"] < time.time() or (row["status"] or "active") != "active":
            conn.execute("DELETE FROM user_sessions WHERE token_hash = ?", (th,))
            return None
    return _row_to_dict(row)


def revoke_user_session(token: str | None) -> None:
    if token:
        with _connect() as conn:
            conn.execute("DELETE FROM user_sessions WHERE token_hash = ?", (_token_hash(token.strip()),))


def revoke_user_sessions(user_id: int, keep_token: str | None = None) -> None:
    """Sign a retailer out everywhere — after a password change/reset — optionally keeping the
    session that made the change."""
    keep = _token_hash(keep_token.strip()) if keep_token else ""
    with _connect() as conn:
        conn.execute("DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?", (user_id, keep))


# ─── User Management (admin side) — public/retailer accounts ───

def list_users() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY created_at DESC, id DESC").fetchall()
    return [_row_to_dict(r) for r in rows]


def get_user_by_id(user_id: int) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_dict(row) if row else None


def update_user_by_id(user_id: int, name: str, email: str, password_hash: str | None = None) -> bool:
    with _connect() as conn:
        if password_hash:
            cur = conn.execute(
                "UPDATE users SET name = ?, email = ?, password_hash = ?, updated_at = ? WHERE id = ?",
                (name, email, password_hash, _now(), user_id),
            )
        else:
            cur = conn.execute(
                "UPDATE users SET name = ?, email = ?, updated_at = ? WHERE id = ?",
                (name, email, _now(), user_id),
            )
        return cur.rowcount > 0


def set_user_status(user_id: int, status: str) -> bool:
    now = _now()
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE users SET status = ?, deactivated_at = ?, updated_at = ? WHERE id = ?",
            (status, now if status == "deactivated" else None, now, user_id),
        )
        return cur.rowcount > 0


def touch_user_login(email: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET last_login_at = ? WHERE email = ?", (_now(), (email or "").strip().lower()))


# ─── User Management (admin side) — additional admin accounts ───

def _admin_row(row: sqlite3.Row) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def list_admin_accounts() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM admin_accounts ORDER BY created_at DESC, id DESC").fetchall()
    return [_admin_row(r) for r in rows]


def get_admin_account(admin_id: int) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM admin_accounts WHERE id = ?", (admin_id,)).fetchone()
    return _admin_row(row) if row else None


def get_admin_account_by_username(username: str) -> dict[str, Any] | None:
    username = (username or "").strip()
    if not username:
        return None
    with _connect() as conn:
        row = conn.execute("SELECT * FROM admin_accounts WHERE username = ?", (username,)).fetchone()
    return _admin_row(row) if row else None


def create_admin_account(username: str, name: str, email: str, role: str,
                         password_hash: str, access_code_hash: str, created_by: str) -> dict[str, Any]:
    now = _now()
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO admin_accounts (username, name, email, role, password_hash, access_code_hash, "
            "status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
            (username, name, email, role, password_hash, access_code_hash, created_by, now, now),
        )
        new_id = cur.lastrowid
    return get_admin_account(new_id)


def update_admin_account(admin_id: int, fields: dict[str, Any]) -> bool:
    allowed = {"name", "email", "role", "password_hash", "access_code_hash", "avatar"}
    fields = {k: v for k, v in fields.items() if k in allowed}
    if not fields:
        return False
    fields["updated_at"] = _now()
    cols = ", ".join(f"{k} = ?" for k in fields)
    with _connect() as conn:
        cur = conn.execute(f"UPDATE admin_accounts SET {cols} WHERE id = ?", (*fields.values(), admin_id))
        return cur.rowcount > 0


def set_admin_account_status(admin_id: int, status: str) -> bool:
    now = _now()
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE admin_accounts SET status = ?, deactivated_at = ?, updated_at = ? WHERE id = ?",
            (status, now if status == "deactivated" else None, now, admin_id),
        )
        return cur.rowcount > 0


def get_user_by_google_sub(sub: str) -> dict[str, Any] | None:
    if not sub:
        return None
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE google_sub = ?", (str(sub),)).fetchone()
    return _row_to_dict(row) if row else None


def set_google_sub(user_id: int, sub: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET google_sub = ?, updated_at = ? WHERE id = ?", (str(sub), _now(), user_id))


def mark_user_welcomed(user_id: int) -> bool:
    """Record that a public user has seen the one-time welcome. True only the first time."""
    with _connect() as conn:
        cur = conn.execute("UPDATE users SET welcome_seen_at = ? WHERE id = ? AND welcome_seen_at IS NULL",
                           (_now(), user_id))
        return cur.rowcount > 0


def mark_admin_welcomed(admin_id: int) -> bool:
    with _connect() as conn:
        cur = conn.execute("UPDATE admin_accounts SET welcome_seen_at = ? WHERE id = ? AND welcome_seen_at IS NULL",
                           (_now(), admin_id))
        return cur.rowcount > 0


def touch_admin_login(admin_id: int) -> None:
    with _connect() as conn:
        conn.execute("UPDATE admin_accounts SET last_login_at = ? WHERE id = ?", (_now(), admin_id))
