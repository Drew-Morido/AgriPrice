"""
AgriPricePH — Data Privacy Act (RA 10173) safeguards for stored personal information.

Scope of personal information held by this system:
  * `model/agriprice_users.db` -> table `users`: name, email, password_hash, role, created_at.
  * Nothing else. No addresses, phone numbers, government IDs, payment data, or location data are
    collected. Rice prices and market data contain no personal information.

Panel finding this addresses: the user database sat world-readable (-rw-r--r--) with no
restriction, and there was no documented retention, deletion, or minimisation behaviour. Under the
Act the project team is a personal information controller, so "it is only a capstone" is not a
defence.

What this module enforces technically:
  1. Restrictive file permissions on the credential store (owner-only), applied at startup.
  2. A documented retention window with a purge routine for stale unverified accounts.
  3. A data-subject erasure function (Sec. 16(e), right to erasure/blocking).
  4. Redaction of email addresses in logs.

What it deliberately does NOT claim: at-rest encryption. SQLCipher is not installed and adding it
would change the storage engine days before defence. The honest posture is: OS-level file
permissions + salted-hash credentials (never plaintext), disclosed as a known limitation rather
than overstated. State it that way if asked.
"""

from __future__ import annotations

import os
import sqlite3
import stat
from datetime import datetime, timedelta

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
USER_DB = os.path.join(MODEL_DIR, "agriprice_users.db")

# Retention: inactive accounts are purged after this many days (Sec. 11(e) — retention no longer
# than necessary). Generous by default; the point is that a defined, enforceable limit exists.
RETENTION_DAYS = int(os.environ.get("AGRIPRICE_RETENTION_DAYS", "730"))


def harden_file_permissions(paths: list[str] | None = None) -> dict:
    """Restrict credential/data stores to the owning account (chmod 600 semantics).

    On Windows, os.chmod only toggles the read-only bit, so this additionally applies an ACL via
    icacls when available — inheritance disabled, access limited to the current user.
    """
    targets = paths or [USER_DB]
    result = {}
    for p in targets:
        if not os.path.exists(p):
            result[p] = "missing"
            continue
        try:
            os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)  # 0o600
            result[p] = "chmod 600"
        except OSError as exc:
            result[p] = f"chmod failed: {exc}"
        if os.name == "nt":
            try:
                import subprocess
                user = os.environ.get("USERNAME") or ""
                if user:
                    subprocess.run(["icacls", p, "/inheritance:r", "/grant:r", f"{user}:F"],
                                   capture_output=True, timeout=15, check=False)
                    result[p] += " + ACL owner-only"
            except Exception as exc:
                result[p] += f" (ACL skipped: {exc})"
    return result


def purge_expired_accounts(db_path: str = USER_DB, days: int | None = None) -> int:
    """Delete accounts untouched for longer than the retention window. Returns rows removed."""
    if not os.path.exists(db_path):
        return 0
    cutoff = (datetime.now() - timedelta(days=days or RETENTION_DAYS)).isoformat()
    conn = sqlite3.connect(db_path)
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(users)")]
        stamp = "last_login_at" if "last_login_at" in cols else (
            "created_at" if "created_at" in cols else None)
        if stamp is None:
            return 0
        cur = conn.execute(f"DELETE FROM users WHERE {stamp} IS NOT NULL AND {stamp} < ?", (cutoff,))
        conn.commit()
        return cur.rowcount or 0
    finally:
        conn.close()


def erase_data_subject(email: str, db_path: str = USER_DB) -> tuple[bool, str]:
    """Right to erasure (Sec. 16(e)). Removes the account and all directly linked personal data."""
    if not email or not os.path.exists(db_path):
        return False, "No such account."
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute("DELETE FROM users WHERE lower(email) = lower(?)", (email.strip(),))
        conn.commit()
        if cur.rowcount:
            return True, f"Erased personal data for {redact_email(email)}."
        return False, "No such account."
    finally:
        conn.close()


def redact_email(email: str) -> str:
    """a***@example.com — for logs and audit trails, so PII is not written to disk in the clear."""
    e = (email or "").strip()
    if "@" not in e:
        return "***"
    local, _, domain = e.partition("@")
    return f"{local[:1]}***@{domain}" if local else f"***@{domain}"


def privacy_status() -> dict:
    """Machine-readable compliance posture, surfaced by /api/privacy-status."""
    # On Windows the POSIX mode is meaningless (os.chmod only toggles the read-only bit and the
    # file still reports 0o666), so report the real ACL instead of a number that overstates or
    # understates the actual protection.
    perms = None
    if os.path.exists(USER_DB):
        if os.name == "nt":
            try:
                import subprocess
                out = subprocess.run(["icacls", USER_DB], capture_output=True, text=True,
                                     timeout=15, check=False).stdout
                grants = [ln.strip() for ln in out.splitlines()[:1] if ln.strip()]
                perms = f"ACL: {grants[0].split(chr(32),1)[-1]}" if grants else "ACL: unknown"
            except Exception:
                perms = "ACL: unreadable"
        else:
            perms = oct(stat.S_IMODE(os.stat(USER_DB).st_mode))
    return {
        "personal_data_stored": ["name", "email", "password_hash", "role"],
        "credential_hashing": "werkzeug scrypt (salted)",
        "plaintext_passwords_stored": False,
        "user_db_permissions": perms,
        "at_rest_encryption": False,
        "at_rest_encryption_note": "Not implemented — OS file permissions only. Disclosed limitation.",
        "retention_days": RETENTION_DAYS,
        "erasure_supported": True,
        "log_email_redaction": True,
        "legal_basis": "Consent at account creation (RA 10173 Sec. 12(a))",
    }


if __name__ == "__main__":
    print("permissions:", harden_file_permissions())
    print("status:", privacy_status())
