"""
AgriPricePH — "Continue with Google" for public user accounts.

The browser uses Google Identity Services, which hands back a signed ID token (a JWT). The server
checks that token with Google's public keys (google-auth): it must be issued by Google, for THIS
app's client ID, unexpired, and for a verified email. Only the Client ID is needed — the OAuth
client *secret* is not used by this flow and must not be stored in the project.

Accounts:
  * a Google account already linked (users.google_sub) signs straight in;
  * otherwise an existing AgriPricePH account with the same (Google-verified) email is linked to it,
    so one person never ends up with two accounts;
  * otherwise a new public account is created with no usable password (they can set one later with
    "Forgot password?"), and the Google profile picture becomes its photo.
Admins never sign in this way: admin sign-in stays username + password + 6-digit PIN.
"""

from __future__ import annotations

import base64
import os
import secrets
from typing import Any, Callable

from werkzeug.security import generate_password_hash

import user_store as store

GOOGLE_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}
DEACTIVATED_MSG = "This account has been deactivated. Please contact the AgriPricePH administrator."
PICTURE_MAX_BYTES = 200_000


def client_id() -> str:
    """The Google OAuth Web client ID, from AGRIPRICE_GOOGLE_CLIENT_ID in the project .env."""
    return (os.environ.get("AGRIPRICE_GOOGLE_CLIENT_ID") or "").strip()


def _google_verify(credential: str, audience: str) -> dict[str, Any]:
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token
    return id_token.verify_oauth2_token(credential, google_requests.Request(), audience, clock_skew_in_seconds=10)


def verify_credential(credential: str, verifier: Callable[[str, str], dict] | None = None) -> tuple[bool, str, dict | None]:
    """Check a Google ID token. Returns (ok, error, claims)."""
    cid = client_id()
    if not cid:
        return False, "Google sign-in is not set up on this server.", None
    if not credential or not isinstance(credential, str):
        return False, "Google did not return a sign-in token. Please try again.", None
    try:
        claims = (verifier or _google_verify)(credential, cid)
    except Exception:
        return False, "Google sign-in could not be verified. Please try again.", None
    if claims.get("aud") != cid or claims.get("iss") not in GOOGLE_ISSUERS:
        return False, "Google sign-in could not be verified. Please try again.", None
    if not claims.get("sub") or not claims.get("email"):
        return False, "Your Google account did not share an email address.", None
    if claims.get("email_verified") not in (True, "true"):
        return False, "Please verify your Google email address first, then try again.", None
    return True, "", claims


def _picture_data_url(url: str) -> str:
    """Best effort: copy the Google profile picture in as a small data URL (the same format as an
    uploaded photo). Any problem just means no photo."""
    try:
        if not url or not url.startswith("https://") or ".googleusercontent.com/" not in url:
            return ""
        import requests
        sized = url.split("=")[0] + "=s240-c"
        r = requests.get(sized, timeout=5)
        ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
        if r.status_code != 200 or ctype not in ("image/jpeg", "image/png", "image/webp") or len(r.content) > PICTURE_MAX_BYTES:
            return ""
        data_url = f"data:{ctype};base64,{base64.b64encode(r.content).decode('ascii')}"
        ok, clean = store.check_avatar(data_url)
        return clean if ok else ""
    except Exception:
        return ""


def sign_in(claims: dict, fetch_picture: Callable[[str], str] | None = None) -> tuple[bool, str, dict | None, dict]:
    """Find, link, or create the public account for verified Google claims.
    Returns (ok, error, user, info) where info = {"created": bool, "linked": bool}."""
    sub = str(claims["sub"])
    email = str(claims["email"]).strip().lower()
    name = " ".join(str(claims.get("name") or email.split("@")[0]).split())[: store.PROFILE_LIMITS["name"]]
    info = {"created": False, "linked": False}

    user = store.get_user_by_google_sub(sub)
    if not user:
        user = store.get_user_by_email(email)
        if user:
            # Same verified email as an existing account: link it rather than make a second one.
            store.set_google_sub(user["id"], sub)
            info["linked"] = True
    if not user:
        # No usable password: a random one nobody knows. "Forgot password?" can set a real one.
        user = store.create_user(name, email, generate_password_hash(secrets.token_urlsafe(32)), "retailer")
        store.set_google_sub(user["id"], sub)
        info["created"] = True

    if (user.get("status") or "active") != "active":
        return False, DEACTIVATED_MSG, None, info

    if not user.get("avatar"):
        avatar = (fetch_picture or _picture_data_url)(str(claims.get("picture") or ""))
        if avatar:
            store.update_profile(user["id"], {"avatar": avatar})

    store.touch_user_login(user["email"])
    return True, "", store.get_user_by_id(user["id"]), info
