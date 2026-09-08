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
        yield conn
        conn.commit()
    finally:
        conn.close()


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "password_hash": row["password_hash"],
        "role": row["role"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
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
