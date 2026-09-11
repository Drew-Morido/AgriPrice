"""
AgriPricePH — persisted system settings (JSON).
"""

from __future__ import annotations

import json
import os
from copy import deepcopy
from datetime import datetime
from typing import Any

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
SETTINGS_PATH = os.path.join(MODEL_DIR, "system_settings.json")

DEFAULT_SETTINGS: dict[str, Any] = {
    "general": {
        "system_name": "AgriPricePH",
        "currency": "PHP",
        "dark_mode": False,
        "api_base_url": "http://127.0.0.1:5000",
        "date_format": "mdy",
    },
    "data_sources": {
        "auto_scrape": True,
        "scrape_interval_hours": 24,
        "da_enabled": True,
        "fuel_enabled": True,
        "exchange_enabled": True,
    },
    "model": {
        "forecast_horizon": 2,
        "sliding_window": 30,
        "training_epochs": 100,
        "train_all_rice_types": True,
        "auto_retrain": True,
        "retrain_schedule": "weekly_sunday",
        "target_rice": "locWellMilled",
    },
    "notifications": {
        "email_alerts": False,
        "alert_email": "admin@agripriceph.gov.ph",
        "browser_notifications": True,
        "alert_check_on_startup": True,
    },
    "security": {
        "session_timeout_minutes": 60,
        "lock_after_idle": False,
        "admin_display_name": "Admin User",
        "admin_username": "admin",
        "password_hash": None,
        "admin_access_code_hash": None,
    },
}


def _hash_password(password: str) -> str:
    """Hash a secret for storage.

    Was unsalted SHA-256 — a single-pass fast hash, so identical passwords produced identical
    digests (rainbow-table lookup) and offline brute force ran at GPU speed. Public user accounts
    already used werkzeug's salted PBKDF2 via `user_auth.py`, so the ADMIN credential was the
    weakest secret in the system. Now uses the same PBKDF2 as the public path.

    Verify with `_verify_password()`, never by re-hashing and comparing: PBKDF2 digests embed a
    random salt, so two hashes of the same password are intentionally different.
    """
    from werkzeug.security import generate_password_hash
    return generate_password_hash(password or "")


def _looks_legacy_sha256(stored: str) -> bool:
    """True for the pre-migration format: bare 64-char hex, no algorithm prefix."""
    if not stored or ":" in stored or stored.startswith(("pbkdf2", "scrypt", "argon2")):
        return False
    s = stored.strip()
    return len(s) == 64 and all(c in "0123456789abcdefABCDEF" for c in s)


def _verify_password(password: str, stored: str) -> bool:
    """Constant-time verification that accepts both PBKDF2 and legacy SHA-256 digests.

    Legacy support exists only so an existing deployment is not locked out on upgrade; callers
    should re-hash with `_hash_password()` after a successful legacy verification so each
    credential migrates on first use. Comparison is via `hmac.compare_digest` to remove the
    timing side-channel the old `==` comparison had.
    """
    import hashlib
    import hmac

    if not stored:
        return False
    if _looks_legacy_sha256(stored):
        digest = hashlib.sha256((password or "").encode("utf-8")).hexdigest()
        return hmac.compare_digest(digest, stored.strip())
    try:
        from werkzeug.security import check_password_hash
        return bool(check_password_hash(stored, password or ""))
    except Exception:
        return False


def change_password(current: str, new_password: str) -> tuple[bool, str]:
    data = _load_raw()
    sec = data.get("security") or {}
    stored = sec.get("password_hash")
    if stored and not _verify_password(current, stored):
        return False, "Current password is incorrect."
    if len(new_password) < 6:
        return False, "New password must be at least 6 characters."
    sec["password_hash"] = _hash_password(new_password)
    data["security"] = sec
    _save_raw(data)
    return True, "Password updated successfully."


def reset_to_defaults() -> dict:
    _save_raw(deepcopy(DEFAULT_SETTINGS))
    return get_settings()


def _deep_merge(base: dict, patch: dict) -> dict:
    out = deepcopy(base)
    for key, val in patch.items():
        if isinstance(val, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], val)
        else:
            out[key] = val
    return out


def _load_raw() -> dict:
    if not os.path.exists(SETTINGS_PATH):
        return deepcopy(DEFAULT_SETTINGS)
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return _deep_merge(DEFAULT_SETTINGS, data if isinstance(data, dict) else {})
    except (json.JSONDecodeError, OSError):
        return deepcopy(DEFAULT_SETTINGS)


def _save_raw(data: dict) -> None:
    data["updated_at"] = datetime.now().isoformat(timespec="seconds")
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _model_runtime() -> dict:
    meta = {}
    meta_path = os.path.join(MODEL_DIR, "meta.json")
    if os.path.exists(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    has_model = os.path.exists(os.path.join(MODEL_DIR, "lstm_model.keras")) or os.path.exists(
        os.path.join(MODEL_DIR, "rice_mlp.joblib")
    )
    return {
        "trained": has_model,
        "backend": meta.get("backend"),
        "mae_peso": meta.get("mae_peso"),
        "accuracy_pct": meta.get("accuracy_pct"),
        "last_data_date": meta.get("last_date"),
        "seq_len": meta.get("seq_len"),
        "horizon": meta.get("horizon"),
        "target": meta.get("target"),
    }


def _prepare_security_on_save(patch_sec: dict) -> dict:
    """Hash access code on save; never store plain text."""
    from admin_auth import set_admin_access_code

    sec = dict(patch_sec or {})
    new_code = sec.pop("admin_access_code", None)
    if new_code is not None and str(new_code).strip() and str(new_code) != "******":
        ok, msg = set_admin_access_code(str(new_code))
        if not ok:
            raise ValueError(msg)
    sec.pop("admin_access_code_hash", None)
    sec.pop("admin_password_hash", None)
    return sec


def get_settings() -> dict:
    from admin_auth import _migrate_security, sanitize_settings_security

    data = _load_raw()
    data["security"] = sanitize_settings_security(_migrate_security(data.get("security") or {}))
    runtime = _model_runtime()
    if runtime.get("horizon") is not None:
        data["model"]["forecast_horizon"] = runtime["horizon"]
    if runtime.get("seq_len") is not None:
        data["model"]["sliding_window"] = runtime["seq_len"]
    if runtime.get("target"):
        data["model"]["target_rice"] = runtime["target"]
    return {
        "settings": data,
        "runtime": runtime,
        "path": SETTINGS_PATH,
    }


def update_settings(patch: dict) -> dict:
    current = _load_raw()
    patch = patch if isinstance(patch, dict) else {}
    if "security" in patch and isinstance(patch["security"], dict):
        sec_patch = _prepare_security_on_save(patch["security"])
        other = {k: v for k, v in patch.items() if k != "security"}
        sec_current = _deep_merge(current.get("security") or {}, sec_patch)
        merged = _deep_merge(current, {**other, "security": sec_current})
    else:
        merged = _deep_merge(current, patch)
    _save_raw(merged)
    return get_settings()
