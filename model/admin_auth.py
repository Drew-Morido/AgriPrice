"""
AgriPricePH — admin login sessions, rate limiting, credential checks.
"""

from __future__ import annotations

import secrets
import time
from typing import Any

from settings_store import _hash_password, _load_raw, _save_raw

MAX_ATTEMPTS = 5
LOCKOUT_SECONDS = 15 * 60
DEFAULT_SESSION_MINUTES = 60

_SESSIONS: dict[str, dict[str, Any]] = {}
_FAILED: dict[str, dict[str, Any]] = {}


def _migrate_security(sec: dict) -> dict:
    sec = dict(sec or {})
    if not sec.get("admin_username"):
        sec["admin_username"] = "admin"
    if not sec.get("admin_password_hash"):
        sec["admin_password_hash"] = _hash_password("Admin@123")
    plain = sec.get("admin_access_code")
    if plain and not sec.get("admin_access_code_hash"):
        digits = "".join(c for c in str(plain) if c.isdigit())
        if len(digits) == 6:
            sec["admin_access_code_hash"] = _hash_password(digits)
        sec.pop("admin_access_code", None)
    if not sec.get("admin_access_code_hash"):
        sec["admin_access_code_hash"] = _hash_password("123456")
    return sec


def _security() -> dict:
    data = _load_raw()
    sec = _migrate_security(data.get("security") or {})
    if data.get("security") != sec:
        data["security"] = sec
        _save_raw(data)
    return sec


def verify_access_code(code: str) -> bool:
    digits = "".join(c for c in str(code) if c.isdigit())
    if len(digits) != 6:
        return False
    sec = _security()
    expected = sec.get("admin_access_code_hash")
    if expected and _hash_password(digits) == expected:
        return True
    plain = sec.get("admin_access_code")
    return bool(plain and digits == str(plain).strip())


def verify_admin_password(username: str, password: str) -> tuple[bool, str]:
    sec = _security()
    user = (username or "").strip()
    if user != sec.get("admin_username", "admin"):
        return False, "Invalid sign-in details."
    if _hash_password(password or "") != sec.get("admin_password_hash"):
        return False, "Invalid sign-in details."
    return True, ""


def verify_admin_credentials(username: str, password: str, access_code: str) -> tuple[bool, str]:
    sec = _security()
    user = (username or "").strip()
    if user != sec.get("admin_username", "admin"):
        return False, "Invalid sign-in details."
    if _hash_password(password or "") != sec.get("admin_password_hash"):
        return False, "Invalid sign-in details."
    if not verify_access_code(access_code):
        return False, "Invalid access code."
    return True, ""


def set_admin_access_code(new_code: str) -> tuple[bool, str]:
    digits = "".join(c for c in str(new_code) if c.isdigit())
    if len(digits) != 6:
        return False, "Access code must be exactly 6 numbers."
    data = _load_raw()
    sec = _migrate_security(data.get("security") or {})
    sec["admin_access_code_hash"] = _hash_password(digits)
    sec.pop("admin_access_code", None)
    data["security"] = sec
    _save_raw(data)
    return True, "Access code updated."


def sanitize_settings_security(sec: dict) -> dict:
    out = dict(sec or {})
    out.pop("admin_password_hash", None)
    out.pop("admin_access_code_hash", None)
    out.pop("admin_access_code", None)
    out["admin_access_code_set"] = True
    out["admin_username"] = out.get("admin_username", "admin")
    return out


def check_lockout(client_key: str) -> tuple[bool, str | None]:
    rec = _FAILED.get(client_key)
    if not rec:
        return True, None
    lock_until = rec.get("lock_until", 0)
    if lock_until > time.time():
        mins = max(1, int((lock_until - time.time()) / 60) + 1)
        return False, f"Too many failed attempts. Try again in about {mins} minutes."
    if lock_until and lock_until <= time.time():
        _FAILED.pop(client_key, None)
    return True, None


def record_failure(client_key: str) -> None:
    rec = _FAILED.setdefault(client_key, {"count": 0, "lock_until": 0})
    rec["count"] = rec.get("count", 0) + 1
    if rec["count"] >= MAX_ATTEMPTS:
        rec["lock_until"] = time.time() + LOCKOUT_SECONDS
        rec["count"] = 0


def clear_failures(client_key: str) -> None:
    _FAILED.pop(client_key, None)


def session_timeout_minutes() -> int:
    sec = _security()
    try:
        return max(15, min(480, int(sec.get("session_timeout_minutes", DEFAULT_SESSION_MINUTES))))
    except (TypeError, ValueError):
        return DEFAULT_SESSION_MINUTES


def create_session(client_key: str) -> tuple[str, int]:
    _purge_expired_sessions()
    token = secrets.token_urlsafe(48)
    ttl = session_timeout_minutes() * 60
    _SESSIONS[token] = {
        "expires": time.time() + ttl,
        "ip": client_key,
        "created": time.time(),
    }
    return token, ttl


def validate_session(token: str | None) -> bool:
    if not token or not isinstance(token, str):
        return False
    _purge_expired_sessions()
    rec = _SESSIONS.get(token.strip())
    if not rec:
        return False
    if rec["expires"] < time.time():
        _SESSIONS.pop(token.strip(), None)
        return False
    return True


def revoke_session(token: str | None) -> None:
    if token:
        _SESSIONS.pop(token.strip(), None)


def _purge_expired_sessions() -> None:
    now = time.time()
    expired = [k for k, v in _SESSIONS.items() if v.get("expires", 0) < now]
    for k in expired:
        _SESSIONS.pop(k, None)
