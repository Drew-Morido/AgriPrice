"""
AgriPricePH — public/vendor account auth: password hashing, login, signup,
and the email-based password-reset flow (codes sent via model/mailer.py).

Mirrors model/admin_auth.py's shape (rate-limit buckets, secrets.* for
random values) with one deliberate difference: real user passwords are hashed
with werkzeug's salted PBKDF2 (generate_password_hash/check_password_hash —
already a Flask dependency, no new pip package), not settings_store's bare
unsalted SHA-256 that admin_auth.py uses. The 6-digit reset *code* is hashed
with plain SHA-256 instead — that's fine specifically because it's low-entropy
(10^6 possibilities), single-use, 15-minutes-lived, and rate-limited, so it
isn't a long-term credential the way a password is. Don't copy that shortcut
for anything password-shaped.

Deliberate product decision, not an oversight: request_reset() tells the
caller whether the email is actually registered (an explicit "email
verified" vs "no account found" response), rather than the generic
anti-enumeration wording a stricter design would use. Consistent with
signup_user() already revealing "This email is already registered" — this
app accepts that tradeoff project-wide, not just here. Per-IP rate limiting
(RESET_REQUEST_ATTEMPTS below) still throttles mass probing either way.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import time
from typing import Any

from werkzeug.security import check_password_hash, generate_password_hash

from mailer import send_reset_code_email
from user_store import create_user, get_user_by_email, update_password_hash

MAX_ATTEMPTS = 5
LOCKOUT_SECONDS = 15 * 60
CODE_TTL_SECONDS = 15 * 60
RESEND_COOLDOWN_SECONDS = 60  # how long a just-sent code blocks another send ("double codes")

# Separate buckets so a burst of failed login attempts doesn't also lock the
# visitor out of *requesting* a reset code, and vice versa.
LOGIN_ATTEMPTS: dict[str, dict[str, Any]] = {}
RESET_REQUEST_ATTEMPTS: dict[str, dict[str, Any]] = {}
RESET_VERIFY_ATTEMPTS: dict[str, dict[str, Any]] = {}

# email (lowercased) -> {code_hash, expires_at}. In-memory like admin_auth's
# _SESSIONS/_FAILED — lost on server restart, which just means an in-flight
# reset code has to be re-requested; acceptable for a 15-minute-lived value.
_RESET_CODES: dict[str, dict[str, Any]] = {}


# ─── rate limiting (generalized version of admin_auth.py's _FAILED pattern) ───

def check_lockout(bucket: dict, client_key: str) -> tuple[bool, str | None]:
    rec = bucket.get(client_key)
    if not rec:
        return True, None
    lock_until = rec.get("lock_until", 0)
    if lock_until > time.time():
        mins = max(1, int((lock_until - time.time()) / 60) + 1)
        return False, f"Too many attempts. Try again in about {mins} minutes."
    if lock_until and lock_until <= time.time():
        bucket.pop(client_key, None)
    return True, None


def record_failure(bucket: dict, client_key: str) -> None:
    rec = bucket.setdefault(client_key, {"count": 0, "lock_until": 0})
    rec["count"] = rec.get("count", 0) + 1
    if rec["count"] >= MAX_ATTEMPTS:
        rec["lock_until"] = time.time() + LOCKOUT_SECONDS
        rec["count"] = 0


def clear_failures(bucket: dict, client_key: str) -> None:
    bucket.pop(client_key, None)


# ─── password strength (server-side mirror of public-auth.js's passwordStrength) ───

def validate_password_strength(password: str) -> tuple[bool, str]:
    password = password or ""
    if (
        len(password) >= 8
        and re.search(r"[A-Z]", password)
        and re.search(r"[a-z]", password)
        and re.search(r"[0-9]", password)
    ):
        return True, ""
    return False, "Password must be at least 8 characters with uppercase, lowercase, and a number."


# ─── signup / login ───

def signup_user(name: str, email: str, password: str) -> tuple[bool, str]:
    name = (name or "").strip()
    email = (email or "").strip().lower()
    if not name or not email or not password:
        return False, "Please fill in all fields."
    if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email):
        return False, "Please enter a valid email address."
    ok, msg = validate_password_strength(password)
    if not ok:
        return False, msg
    if get_user_by_email(email):
        return False, "This email is already registered. Try logging in."
    create_user(name, email, generate_password_hash(password))
    return True, "Account created."


def login_user(email: str, password: str) -> tuple[bool, str, dict[str, Any] | None]:
    email = (email or "").strip().lower()
    user = get_user_by_email(email)
    if not user or not check_password_hash(user["password_hash"], password or ""):
        return False, "Email or password is incorrect.", None
    return True, "", {"name": user["name"], "email": user["email"], "role": user["role"]}


def change_password_for_user(email: str, current: str, new_password: str) -> tuple[bool, str]:
    email = (email or "").strip().lower()
    user = get_user_by_email(email)
    if not user:
        return False, "Account not found."
    if not check_password_hash(user["password_hash"], current or ""):
        return False, "Your current password is incorrect."
    ok, msg = validate_password_strength(new_password)
    if not ok:
        return False, msg
    update_password_hash(email, generate_password_hash(new_password))
    return True, "Password updated."


# ─── email-based password reset ───

def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def request_reset(email: str) -> tuple[str, str]:
    """Step 1 of 3: check the email against the account table (by design, this
    project deliberately reveals whether an account exists here — the same
    tradeoff signup_user() already makes with "This email is already
    registered" — so the caller can show an explicit "email verified" popup
    rather than a generic one) and, if found, email a 6-digit code.

    If a still-valid code was already sent recently, does NOT generate/send a
    new one — re-sending would silently invalidate the one already in the
    visitor's inbox (see verify_reset_code: only the latest code's hash is
    kept), producing exactly the "double codes" confusion this guards
    against. Returns (status, message):
      "sent"          — a fresh code was generated and emailed
      "already_sent"  — a valid code from a recent request is still active; nothing re-sent
      "not_found"     — no account with this email
      "mail_error"    — account exists, but the email failed to send (message is the SMTP error)
    """
    email = (email or "").strip().lower()
    user = get_user_by_email(email)
    if not user:
        return "not_found", "No AgriPricePH account is registered with that email."

    existing = _RESET_CODES.get(email)
    if existing and existing.get("code_hash") and existing["expires_at"] > time.time():
        sent_at = existing.get("sent_at", 0)
        remaining = int(sent_at + RESEND_COOLDOWN_SECONDS - time.time())
        if remaining > 0:
            return "already_sent", (
                f"A code was already sent to this email — check your inbox. "
                f"You can request a new one in {remaining}s."
            )

    code = f"{secrets.randbelow(1_000_000):06d}"
    _RESET_CODES[email] = {
        "code_hash": _hash_code(code),
        "expires_at": time.time() + CODE_TTL_SECONDS,
        "sent_at": time.time(),
    }
    ok, err = send_reset_code_email(to_email=email, name=user["name"], code=code)
    if not ok:
        return "mail_error", err
    return "sent", "Email verified — a 6-digit code was sent to your inbox."


def verify_reset_code(email: str, code: str) -> tuple[bool, str, str | None]:
    """Step 2 of 3: check the emailed code on its own (no new password yet).
    On success, mints a one-time "reset ticket" — a second, unguessable random
    value the client must hold onto and send back in step 3 — and marks the
    code itself as spent, so the 6-digit code (email-visible, comparatively
    low-entropy) can't be replayed once the visitor has moved on to the
    new-password screen. Returns (ok, message, ticket_or_None)."""
    email = (email or "").strip().lower()
    code = "".join(ch for ch in str(code or "") if ch.isdigit())
    entry = _RESET_CODES.get(email)
    if not entry or entry["expires_at"] < time.time():
        _RESET_CODES.pop(email, None)
        return False, "That code is invalid or has expired. Request a new one.", None
    if len(code) != 6 or _hash_code(code) != entry["code_hash"]:
        return False, "That code is incorrect.", None
    ticket = secrets.token_urlsafe(24)
    entry["ticket_hash"] = _hash_code(ticket)
    entry["code_hash"] = None  # the code itself is now spent — only the ticket unlocks step 3
    return True, "Code verified.", ticket


def reset_password_with_ticket(email: str, ticket: str, new_password: str) -> tuple[bool, str]:
    """Step 3 of 3: the actual password change, gated on the ticket verify_reset_code
    handed back — not the original code, so a leaked/guessed code alone is useless
    once verification has already happened once."""
    email = (email or "").strip().lower()
    entry = _RESET_CODES.get(email)
    if not entry or entry["expires_at"] < time.time() or not entry.get("ticket_hash"):
        _RESET_CODES.pop(email, None)
        return False, "Your session expired. Start over from “Forgot password?”."
    if not ticket or _hash_code(ticket) != entry["ticket_hash"]:
        return False, "Your session expired. Start over from “Forgot password?”."
    ok, msg = validate_password_strength(new_password)
    if not ok:
        return False, msg
    update_password_hash(email, generate_password_hash(new_password))
    _RESET_CODES.pop(email, None)  # single-use
    return True, "Password updated."
