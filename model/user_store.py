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

import os
import sqlite3
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
    # Small key/value store for sign-in bookkeeping (e.g. the built-in admin's last sign-in).
    # Kept in this .db rather than system_settings.json on purpose: dev file-watchers (Live/Five
    # Server) ignore *.db but reload the page on any .json write, which interrupted the login flow.
    conn.execute("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)")


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


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
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


def update_profile(email: str, new_name: str, new_email: str) -> tuple[bool, str]:
    email = (email or "").strip().lower()
    new_name = (new_name or "").strip()
    new_email = (new_email or "").strip().lower()
    if not new_name or not new_email:
        return False, "Name and email are required."
    if new_email != email and get_user_by_email(new_email):
        return False, "That email is already used by another account."
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE users SET name = ?, email = ?, updated_at = ? WHERE email = ?",
            (new_name, new_email, now, email),
        )
        rowcount = cur.rowcount
    if rowcount == 0:
        return False, "Account not found."
    return True, "Profile updated."


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
    allowed = {"name", "email", "role", "password_hash", "access_code_hash"}
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


def touch_admin_login(admin_id: int) -> None:
    with _connect() as conn:
        conn.execute("UPDATE admin_accounts SET last_login_at = ? WHERE id = ?", (_now(), admin_id))
