"""
AgriPricePH — Admin → User Management: create / read / update / deactivate accounts.

Two kinds of account are managed here:
  * Retailer (public site) accounts — the `users` table (model/user_store.py). Any signed-in
    admin may manage these.
  * Admin accounts — the built-in admin in system_settings.json (always the Super Admin; edited
    from Account Profile / Settings, never from here) plus any additional admins in the
    `admin_accounts` table. Only a Super Admin may create, edit, or deactivate admin accounts.

"Delete" is deliberately a soft deactivation: the row, its email/username, and its history are
kept, sign-in is refused with a clear message, and the account can be reactivated. Every
function returns (ok, message, data) and never serialises a password or access-code hash.
"""

from __future__ import annotations

import re
from typing import Any

from werkzeug.security import generate_password_hash

import user_store as store
from admin_auth import (
    ADMIN_ROLES,
    ROLE_ADMIN,
    ROLE_SUPER_ADMIN,
    _security,
    primary_admin_username,
    primary_last_login,
    revoke_sessions_for_admin,
)
from user_auth import validate_password_strength

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{3,32}$")
ROLE_LABELS = {ROLE_SUPER_ADMIN: "Super Admin", ROLE_ADMIN: "Admin", "retailer": "Retailer"}


# ─── serialisers (no secrets ever leave this module) ───

def _user_out(u: dict) -> dict[str, Any]:
    return {
        "id": u["id"],
        "name": u["name"],
        "email": u["email"],
        "role": u.get("role") or "retailer",
        "role_label": ROLE_LABELS.get(u.get("role"), "Retailer"),
        "status": u.get("status") or "active",
        "created_at": u.get("created_at"),
        "updated_at": u.get("updated_at"),
        "last_login_at": u.get("last_login_at"),
        "deactivated_at": u.get("deactivated_at"),
    }


def _admin_out(a: dict) -> dict[str, Any]:
    role = a.get("role") if a.get("role") in ADMIN_ROLES else ROLE_ADMIN
    return {
        "id": a["id"],
        "username": a["username"],
        "name": a["name"],
        "email": a.get("email") or "",
        "role": role,
        "role_label": ROLE_LABELS[role],
        "status": a.get("status") or "active",
        "created_by": a.get("created_by") or "",
        "created_at": a.get("created_at"),
        "updated_at": a.get("updated_at"),
        "last_login_at": a.get("last_login_at"),
        "deactivated_at": a.get("deactivated_at"),
        "is_primary": False,
    }


def _primary_out() -> dict[str, Any]:
    sec = _security()
    return {
        "id": "primary",
        "username": sec.get("admin_username", "admin"),
        "name": sec.get("admin_display_name") or "Admin User",
        "email": sec.get("admin_email") or "",
        "role": ROLE_SUPER_ADMIN,
        "role_label": ROLE_LABELS[ROLE_SUPER_ADMIN],
        "status": "active",
        "created_by": "",
        "created_at": None,
        "updated_at": None,
        "last_login_at": primary_last_login(),
        "deactivated_at": None,
        "is_primary": True,
    }


# ─── read ───

def list_accounts(me: dict) -> dict[str, Any]:
    users = [_user_out(u) for u in store.list_users()]
    admins = [_primary_out()] + [_admin_out(a) for a in store.list_admin_accounts()]
    active_users = sum(1 for u in users if u["status"] == "active")
    active_admins = sum(1 for a in admins if a["status"] == "active")
    return {
        "users": users,
        "admins": admins,
        "stats": {
            "total": len(users) + len(admins),
            "users_active": active_users,
            "users_total": len(users),
            "admins_active": active_admins,
            "admins_total": len(admins),
            "deactivated": (len(users) - active_users) + (len(admins) - active_admins),
        },
        "me": {**me, "role_label": ROLE_LABELS.get(me.get("role"), "Admin"),
               "can_manage_admins": me.get("role") == ROLE_SUPER_ADMIN},
    }


# ─── shared validation ───

def _clean_name(name: Any) -> tuple[str | None, str]:
    name = " ".join(str(name or "").split())
    if len(name) < 2 or len(name) > 60:
        return None, "Full name must be 2–60 characters."
    return name, ""


def _clean_email(email: Any, required: bool = True) -> tuple[str | None, str]:
    email = str(email or "").strip().lower()
    if not email:
        return ("", "") if not required else (None, "Email is required.")
    if len(email) > 120 or not EMAIL_RE.match(email):
        return None, "Please enter a valid email address."
    return email, ""


# ─── retailer accounts ───

def create_user(payload: dict) -> tuple[bool, str, dict | None]:
    name, err = _clean_name(payload.get("name"))
    if not name:
        return False, err, None
    email, err = _clean_email(payload.get("email"))
    if not email:
        return False, err, None
    if store.get_user_by_email(email):
        return False, "That email is already registered to another account.", None
    password = payload.get("password") or ""
    ok, err = validate_password_strength(password)
    if not ok:
        return False, err, None
    user = store.create_user(name, email, generate_password_hash(password), "retailer")
    return True, f"Account created for {name}.", _user_out(user)


def update_user(user_id: int, payload: dict) -> tuple[bool, str, dict | None]:
    user = store.get_user_by_id(user_id)
    if not user:
        return False, "Account not found.", None
    name, err = _clean_name(payload.get("name"))
    if not name:
        return False, err, None
    email, err = _clean_email(payload.get("email"))
    if not email:
        return False, err, None
    other = store.get_user_by_email(email)
    if other and other["id"] != user_id:
        return False, "That email is already registered to another account.", None
    new_hash = None
    password = payload.get("password") or ""
    if password:
        ok, err = validate_password_strength(password)
        if not ok:
            return False, err, None
        new_hash = generate_password_hash(password)
    store.update_user_by_id(user_id, name, email, new_hash)
    if new_hash:
        store.revoke_user_sessions(user_id)  # an admin-set password signs the retailer out everywhere
        store.add_activity(user_id, "WARN", "An administrator set a new password (all devices signed out)")
    msg = "Account updated." + (" A new password was set." if new_hash else "")
    return True, msg, _user_out(store.get_user_by_id(user_id))


def set_user_active(user_id: int, active: bool) -> tuple[bool, str, dict | None]:
    user = store.get_user_by_id(user_id)
    if not user:
        return False, "Account not found.", None
    store.set_user_status(user_id, "active" if active else "deactivated")
    store.add_activity(user_id, "INFO" if active else "ERROR",
                       "Account reactivated by an administrator" if active else "Account deactivated by an administrator")
    verb = "reactivated" if active else "deactivated"
    return True, f"{user['name']}'s account was {verb}.", _user_out(store.get_user_by_id(user_id))


# ─── admin accounts (Super Admin only — enforced by the caller via can_manage_admins) ───

def _clean_role(role: Any) -> str | None:
    role = str(role or ROLE_ADMIN).strip().lower()
    return role if role in ADMIN_ROLES else None


def _clean_code(code: Any) -> str | None:
    digits = "".join(c for c in str(code or "") if c.isdigit())
    return digits if len(digits) == 6 and len(str(code).strip()) == 6 else None


def create_admin(payload: dict, me: dict) -> tuple[bool, str, dict | None]:
    username = str(payload.get("username") or "").strip()
    if not USERNAME_RE.match(username):
        return False, "Username must be 3–32 characters: letters, numbers, dot, dash or underscore.", None
    if username.lower() == primary_admin_username().lower() or store.get_admin_account_by_username(username):
        return False, "That username is already taken.", None
    name, err = _clean_name(payload.get("name"))
    if not name:
        return False, err, None
    email, err = _clean_email(payload.get("email"), required=False)
    if email is None:
        return False, err, None
    role = _clean_role(payload.get("role"))
    if not role:
        return False, "Choose a valid role.", None
    password = payload.get("password") or ""
    ok, err = validate_password_strength(password)
    if not ok:
        return False, err, None
    code = _clean_code(payload.get("access_code"))
    if not code:
        return False, "Access code must be exactly 6 digits.", None
    acct = store.create_admin_account(
        username, name, email, role,
        generate_password_hash(password), generate_password_hash(code),
        created_by=me.get("username") or "",
    )
    return True, f"Admin account '{username}' created.", _admin_out(acct)


def update_admin(admin_id: int, payload: dict, me: dict) -> tuple[bool, str, dict | None]:
    acct = store.get_admin_account(admin_id)
    if not acct:
        return False, "Admin account not found.", None
    fields: dict[str, Any] = {}
    name, err = _clean_name(payload.get("name"))
    if not name:
        return False, err, None
    fields["name"] = name
    email, err = _clean_email(payload.get("email"), required=False)
    if email is None:
        return False, err, None
    fields["email"] = email
    role = _clean_role(payload.get("role"))
    if not role:
        return False, "Choose a valid role.", None
    if me.get("kind") == "account" and me.get("id") == admin_id and role != acct["role"]:
        return False, "You can't change your own role.", None
    fields["role"] = role
    notes = []
    password = payload.get("password") or ""
    if password:
        ok, err = validate_password_strength(password)
        if not ok:
            return False, err, None
        fields["password_hash"] = generate_password_hash(password)
        notes.append("password")
    if str(payload.get("access_code") or "").strip():
        code = _clean_code(payload.get("access_code"))
        if not code:
            return False, "Access code must be exactly 6 digits.", None
        fields["access_code_hash"] = generate_password_hash(code)
        notes.append("access code")
    store.update_admin_account(admin_id, fields)
    msg = "Admin account updated." + (f" New {' and '.join(notes)} set." if notes else "")
    return True, msg, _admin_out(store.get_admin_account(admin_id))


def set_admin_active(admin_id: int, active: bool, me: dict) -> tuple[bool, str, dict | None]:
    acct = store.get_admin_account(admin_id)
    if not acct:
        return False, "Admin account not found.", None
    if not active and me.get("kind") == "account" and me.get("id") == admin_id:
        return False, "You can't deactivate the account you're signed in with.", None
    store.set_admin_account_status(admin_id, "active" if active else "deactivated")
    if not active:
        revoke_sessions_for_admin(admin_id)
    verb = "reactivated" if active else "deactivated"
    return True, f"Admin '{acct['username']}' was {verb}.", _admin_out(store.get_admin_account(admin_id))
