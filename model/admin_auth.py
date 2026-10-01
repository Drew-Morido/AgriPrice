"""
AgriPricePH — admin login sessions, rate limiting, credential checks.
"""

from __future__ import annotations

import secrets
import time
from typing import Any

from werkzeug.security import check_password_hash

from settings_store import _hash_password, _load_raw, _looks_legacy_sha256, _save_raw, _verify_password
from user_store import get_admin_account, get_admin_account_by_username, get_meta, set_meta, touch_admin_login

# The built-in admin (credentials in system_settings.json) is always the Super Admin. Additional
# admin accounts created from Admin → User Management live in agriprice_users.db (admin_accounts)
# with their own password + 6-digit access code, and are either 'super_admin' (everything) or
# 'admin' (day-to-day operator: no User Management, no Settings changes, no model training, no
# clearing logs or deleting reports — enforced in api/app.py by _require_super_admin/_um_guard).
ROLE_SUPER_ADMIN = "super_admin"
ROLE_ADMIN = "admin"
ADMIN_ROLES = (ROLE_SUPER_ADMIN, ROLE_ADMIN)
DEACTIVATED_ADMIN_MSG = "This admin account has been deactivated. Contact the Super Admin."

# The documented first-run login. Still accepted so a fresh install can sign in, but a session
# opened with either default is limited to changing them (api/app.py MUST_CHANGE_MSG).
DEFAULT_ADMIN_PASSWORD = "Admin@123"
DEFAULT_ACCESS_CODE = "123456"

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
        sec["admin_password_hash"] = _hash_password(DEFAULT_ADMIN_PASSWORD)
    plain = sec.get("admin_access_code")
    if plain and not sec.get("admin_access_code_hash"):
        digits = "".join(c for c in str(plain) if c.isdigit())
        if len(digits) == 6:
            sec["admin_access_code_hash"] = _hash_password(digits)
        sec.pop("admin_access_code", None)
    if not sec.get("admin_access_code_hash"):
        sec["admin_access_code_hash"] = _hash_password(DEFAULT_ACCESS_CODE)
    return sec


def _security() -> dict:
    data = _load_raw()
    sec = _migrate_security(data.get("security") or {})
    if data.get("security") != sec:
        data["security"] = sec
        _save_raw(data)
    return sec


def _upgrade_hash_if_legacy(field: str, plaintext: str) -> None:
    """Re-hash a legacy unsalted-SHA-256 credential with PBKDF2 after it verifies correctly.

    Migration happens on first successful sign-in, so upgrading the code never locks anyone out
    and no password reset is required.
    """
    try:
        data = _load_raw()
        sec = data.get("security") or {}
        stored = sec.get(field)
        if stored and _looks_legacy_sha256(stored):
            sec[field] = _hash_password(plaintext)
            data["security"] = sec
            _save_raw(data)
    except Exception:
        pass  # never block a valid login on a migration failure


def verify_access_code(code: str) -> bool:
    digits = "".join(c for c in str(code) if c.isdigit())
    if len(digits) != 6:
        return False
    sec = _security()
    expected = sec.get("admin_access_code_hash")
    if expected and _verify_password(digits, expected):
        _upgrade_hash_if_legacy("admin_access_code_hash", digits)
        return True
    plain = sec.get("admin_access_code")
    return bool(plain and digits == str(plain).strip())


def verify_admin_pin(me: dict, pin: str) -> bool:
    """Does `pin` match the 6-digit PIN of the admin making this request? Used to confirm sensitive
    edits (re-authentication), on top of the session they already have."""
    digits = "".join(c for c in str(pin or "") if c.isdigit())
    if len(digits) != 6 or not me:
        return False
    if me.get("kind") == "account":
        acct = get_admin_account(me.get("id"))
        return bool(acct and acct.get("status") == "active" and check_password_hash(acct["access_code_hash"], digits))
    return verify_access_code(digits)


def primary_admin_username() -> str:
    return _security().get("admin_username", "admin")


def _primary_identity() -> dict[str, Any]:
    sec = _security()
    return {
        "kind": "primary",
        "id": "primary",
        "username": sec.get("admin_username", "admin"),
        "name": sec.get("admin_display_name") or "Admin User",
        "role": ROLE_SUPER_ADMIN,
        "avatar": sec.get("admin_avatar") or "",
    }


def _account_identity(acct: dict) -> dict[str, Any]:
    return {
        "kind": "account",
        "id": acct["id"],
        "username": acct["username"],
        "name": acct["name"],
        "role": acct["role"] if acct["role"] in ADMIN_ROLES else ROLE_ADMIN,
        "avatar": acct.get("avatar") or "",
    }


def _check_account_password(username: str, password: str) -> tuple[bool, str, dict | None]:
    acct = get_admin_account_by_username(username)
    if not acct or not check_password_hash(acct["password_hash"], password or ""):
        return False, "Invalid sign-in details.", None
    # Only disclosed after the password verifies, same as the retailer login.
    if acct.get("status") != "active":
        return False, DEACTIVATED_ADMIN_MSG, None
    return True, "", acct


def verify_admin_password(username: str, password: str) -> tuple[bool, str]:
    sec = _security()
    user = (username or "").strip()
    if user != sec.get("admin_username", "admin"):
        ok, err, _ = _check_account_password(user, password)
        return ok, err
    if not _verify_password(password or "", sec.get("admin_password_hash")):
        return False, "Invalid sign-in details."
    _upgrade_hash_if_legacy("admin_password_hash", password or "")
    return True, ""


def authenticate_admin(username: str, password: str, access_code: str) -> tuple[bool, str, dict | None]:
    """Full admin sign-in (password + 6-digit code). Returns (ok, error, identity)."""
    sec = _security()
    user = (username or "").strip()
    if user != sec.get("admin_username", "admin"):
        ok, err, acct = _check_account_password(user, password)
        if not ok:
            return False, err, None
        digits = "".join(c for c in str(access_code) if c.isdigit())
        if len(digits) != 6 or not check_password_hash(acct["access_code_hash"], digits):
            return False, "Invalid access code.", None
        touch_admin_login(acct["id"])
        return True, "", _account_identity(acct)
    if not _verify_password(password or "", sec.get("admin_password_hash")):
        return False, "Invalid sign-in details.", None
    _upgrade_hash_if_legacy("admin_password_hash", password or "")
    if not verify_access_code(access_code):
        return False, "Invalid access code.", None
    _touch_primary_login()
    digits = "".join(c for c in str(access_code) if c.isdigit())
    return True, "", {**_primary_identity(),
                      "must_change_credentials": password == DEFAULT_ADMIN_PASSWORD or digits == DEFAULT_ACCESS_CODE}


def _touch_primary_login() -> None:
    """Record the built-in admin's last sign-in for the User Management table.

    Written to agriprice_users.db, NOT system_settings.json: a .json write during sign-in makes a
    dev file-watcher (Live/Five Server) reload the login page mid-flow, bouncing the user back.
    """
    try:
        set_meta("primary_admin_last_login_at", time.strftime("%Y-%m-%dT%H:%M:%S"))
    except Exception:
        pass  # never block a valid login on bookkeeping


def primary_last_login() -> str | None:
    try:
        return get_meta("primary_admin_last_login_at")
    except Exception:
        return None


def verify_admin_credentials(username: str, password: str, access_code: str) -> tuple[bool, str]:
    ok, err, _ = authenticate_admin(username, password, access_code)
    return ok, err


EASY_PIN_MSG = "Choose a PIN that is harder to guess (not 123456, 111111, 121212 and the like)."


def easy_pin(digits: str) -> bool:
    """All one digit, a straight run (123456 / 654321), or a repeated pair/triple (121212, 123123)."""
    if len(digits) != 6:
        return False
    return (len(set(digits)) == 1 or digits in "01234567890" or digits in "09876543210"
            or digits[:3] == digits[3:] or digits[:2] * 3 == digits)


def set_admin_access_code(new_code: str) -> tuple[bool, str]:
    digits = "".join(c for c in str(new_code) if c.isdigit())
    if len(digits) != 6:
        return False, "Access code must be exactly 6 numbers."
    if digits == DEFAULT_ACCESS_CODE or easy_pin(digits):
        return False, EASY_PIN_MSG
    data = _load_raw()
    sec = _migrate_security(data.get("security") or {})
    sec["admin_access_code_hash"] = _hash_password(digits)
    sec.pop("admin_access_code", None)
    data["security"] = sec
    _save_raw(data)
    return True, "Access code updated."


def _password_problem(password: str, username: str) -> str:
    import re
    if (len(password) < 8 or not re.search(r"[A-Z]", password) or not re.search(r"[a-z]", password)
            or not re.search(r"[0-9]", password)):
        return "Password must be at least 8 characters with uppercase, lowercase, and a number."
    if password == DEFAULT_ADMIN_PASSWORD:
        return "Choose a password other than the default one."
    if username and len(username) >= 3 and username.lower() in password.lower():
        return "The password must not contain the username."
    return ""


def change_primary_credentials(current_password: str, new_password: str | None = None,
                               new_code: str | None = None) -> tuple[bool, str]:
    """Replace the built-in admin's password and/or 6-digit PIN after checking the current password.
    Once neither default remains, lifts the "change the defaults first" restriction on that admin's
    open sessions."""
    data = _load_raw()
    sec = _migrate_security(data.get("security") or {})
    if not _verify_password(current_password or "", sec.get("admin_password_hash")):
        return False, "Current password is incorrect."
    if not new_password and not new_code:
        return False, "Enter a new password or a new PIN."
    if new_password:
        problem = _password_problem(new_password, sec.get("admin_username", "admin"))
        if problem:
            return False, problem
        if new_password == current_password:
            return False, "The new password must be different from the current one."
    digits = ""
    if new_code:
        digits = "".join(c for c in str(new_code) if c.isdigit())
        if len(digits) != 6 or len(str(new_code).strip()) != 6:
            return False, "The PIN must be exactly 6 digits."
        if digits == DEFAULT_ACCESS_CODE or easy_pin(digits):
            return False, EASY_PIN_MSG
    if new_password:
        sec["admin_password_hash"] = _hash_password(new_password)
    if digits:
        sec["admin_access_code_hash"] = _hash_password(digits)
        sec.pop("admin_access_code", None)
    data["security"] = sec
    _save_raw(data)
    still_default = (_verify_password(DEFAULT_ADMIN_PASSWORD, sec["admin_password_hash"])
                     or _verify_password(DEFAULT_ACCESS_CODE, sec["admin_access_code_hash"]))
    if not still_default:
        for rec in _SESSIONS.values():
            if rec.get("kind") == "primary":
                rec["must_change"] = False
    parts = [x for x in ("password" if new_password else "", "PIN" if digits else "") if x]
    return True, f"Your {' and '.join(parts)} {'were' if len(parts) > 1 else 'was'} updated."


# Any settings key whose name contains one of these is a credential and must never be serialised
# to an API response. A denylist by substring rather than by exact name: the previous version
# popped `admin_password_hash` and `admin_access_code_hash` explicitly but missed the plain
# `password_hash` key, which /api/settings then returned to unauthenticated callers.
_SECRET_KEY_MARKERS = ("password", "passwd", "secret", "token", "access_code", "hash", "salt",
                       "api_key", "apikey", "private")


def sanitize_settings_security(sec: dict) -> dict:
    """Strip every credential-shaped field before settings leave the process.

    Keeps only the booleans/labels the admin UI needs (e.g. `admin_access_code_set`) so the
    frontend can render "configured / not configured" without ever seeing the value.
    """
    out = {}
    for key, value in dict(sec or {}).items():
        if any(marker in key.lower() for marker in _SECRET_KEY_MARKERS):
            continue
        out[key] = value
    out["admin_access_code_set"] = bool(
        (sec or {}).get("admin_access_code_hash") or (sec or {}).get("admin_access_code")
    )
    out["admin_password_set"] = bool((sec or {}).get("admin_password_hash"))
    out["admin_username"] = (sec or {}).get("admin_username", "admin")
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


def create_session(client_key: str, identity: dict | None = None) -> tuple[str, int]:
    _purge_expired_sessions()
    token = secrets.token_urlsafe(48)
    ttl = session_timeout_minutes() * 60
    ident = identity or _primary_identity()
    _SESSIONS[token] = {
        "expires": time.time() + ttl,
        "ip": client_key,
        "created": time.time(),
        "kind": ident["kind"],
        "admin_id": ident["id"],
        "must_change": bool(ident.get("must_change_credentials")),
    }
    return token, ttl


def session_identity(token: str | None) -> dict[str, Any] | None:
    """Who a valid session belongs to, read fresh so a rename or role change applies at once."""
    if not validate_session(token):
        return None
    rec = _SESSIONS.get(token.strip())
    if rec.get("kind") == "account":
        acct = get_admin_account(rec["admin_id"])
        if not acct or acct.get("status") != "active":
            _SESSIONS.pop(token.strip(), None)
            return None
        return _account_identity(acct)
    return {**_primary_identity(), "must_change_credentials": bool(rec.get("must_change"))}


def revoke_sessions_for_admin(admin_id: int) -> int:
    """Sign a deactivated admin out everywhere, immediately."""
    doomed = [k for k, v in _SESSIONS.items() if v.get("kind") == "account" and v.get("admin_id") == admin_id]
    for k in doomed:
        _SESSIONS.pop(k, None)
    return len(doomed)


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
