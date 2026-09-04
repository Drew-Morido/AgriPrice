"""
AgriPricePH — outbound email via Gmail SMTP (password-reset codes).

Sends from agripriceph@gmail.com using a Gmail "App Password" (not the real
account password — generate one at myaccount.google.com/apppasswords, which
requires 2-Step Verification to be turned on first). The App Password is read
from the AGRIPRICE_GMAIL_APP_PASSWORD environment variable (see .env.example
at the project root) — never hardcoded, never written to system_settings.json
(that file isn't gitignored). See README.txt "Gmail SMTP setup" for the full
walkthrough.

The HTML template below is a "bulletproof" table-based layout (no flexbox/
grid/external CSS) because email clients strip <style>/modern CSS far more
aggressively than any browser; Outlook desktop in particular renders with
Word's engine. Colors/fonts mirror the site's real brand tokens (css/
global.css's --color-primary-dark/--color-accent/etc.) with web-safe
font-family fallbacks, since custom web fonts are unreliable in email.

The header logo is the site's ACTUAL logo mark (same SVG path data as
public/login.html's .ah-card-logo), not an emoji stand-in — email clients
don't render inline SVG reliably (Outlook desktop doesn't at all), so
model/assets/email_logo.png is a pixel-faithful PNG render of that exact
path/color, generated once via model/render_email_logo.py (a one-off dev
tool, not a runtime dependency — see its own docstring) and committed as a
static asset. It's attached inline via Content-ID (cid:) rather than a
data: URI or a hosted <img src>, since data: URIs get stripped by some
clients/security-filtered inboxes and there's no image host for this project.
"""

from __future__ import annotations

import html
import os
import smtplib
import ssl
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

GMAIL_SENDER = "agripriceph@gmail.com"
GMAIL_APP_PASSWORD_ENV = "AGRIPRICE_GMAIL_APP_PASSWORD"
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465  # SSL — not 587/STARTTLS

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
LOGO_PATH = os.path.join(MODEL_DIR, "assets", "email_logo.png")
LOGO_CID = "agripriceph-logo"

# Brand tokens, matching css/global.css (--color-primary-dark/-mid/--color-accent/
# --bg-body/--text-primary/--text-secondary/--border-color) and the site's real
# logo-tile green (auth-hero.css's .ah-logo-tile, #2a5c3f).
_INK = "#1C2B1E"        # --text-primary
_INK_SOFT = "#5A7060"   # --text-secondary
_MUTED = "#849C8E"      # --text-muted
_LINE = "#E2EAE4"       # --border-color
_PAPER = "#F4F6F3"      # --bg-body
_HEADER_BG = "#122A1E"  # --color-primary-dark
_ACCENT = "#4CAF6E"     # --color-accent
_SERIF = "Georgia, 'Times New Roman', Times, serif"          # stands in for Fraunces
_SANS = "Arial, Helvetica, 'Segoe UI', sans-serif"            # stands in for Plus Jakarta Sans
_MONO = "'Courier New', Courier, monospace"                   # stands in for JetBrains Mono

CODE_TTL_MINUTES = 15


def is_configured() -> bool:
    return bool(os.environ.get(GMAIL_APP_PASSWORD_ENV))


def _build_html(display_name: str, to_email: str, code: str) -> str:
    name = html.escape(display_name)
    email_esc = html.escape(to_email)
    spaced_code = " ".join(code)  # "1 2 3 4 5 6" — screen readers announce this digit-by-digit
    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Your AgriPricePH password reset code</title>
</head>
<body style="margin:0; padding:0; background:{_PAPER};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{_PAPER};">
<tr><td align="center" style="padding:32px 16px;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background:#ffffff; border:1px solid {_LINE}; border-radius:16px; overflow:hidden;">

  <!-- brand header (the real logo mark — see LOGO_PATH/LOGO_CID above) -->
  <tr>
    <td style="background:{_HEADER_BG}; padding:26px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:40px; height:40px;"><img src="cid:{LOGO_CID}" width="40" height="40" alt="AgriPricePH" style="display:block; border:0; border-radius:10px;"></td>
        <td style="padding-left:12px; font-family:{_SERIF}; font-size:20px; font-weight:700; color:#ffffff;">AgriPricePH</td>
      </tr></table>
    </td>
  </tr>

  <!-- heading + explanation -->
  <tr><td style="padding:32px 32px 4px;">
    <h1 style="margin:0 0 12px; font-family:{_SERIF}; font-size:22px; line-height:1.3; color:{_INK};">Reset your password</h1>
    <p style="margin:0 0 22px; font-family:{_SANS}; font-size:14px; line-height:1.65; color:{_INK_SOFT};">
      Hi {name}, we received a request to reset the password for the AgriPricePH account
      registered to <strong style="color:{_INK};">{email_esc}</strong>. Enter the code below on the
      reset-password screen to continue.
    </p>
  </td></tr>

  <!-- the code -->
  <tr><td style="padding:0 32px 8px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center" style="background:{_PAPER}; border:1px dashed {_ACCENT}; border-radius:12px; padding:22px 16px;">
        <div style="font-family:{_MONO}; font-size:32px; font-weight:700; letter-spacing:10px; color:{_INK};">{spaced_code}</div>
        <div style="margin-top:8px; font-family:{_SANS}; font-size:12px; color:{_INK_SOFT};">Expires in {CODE_TTL_MINUTES} minutes &middot; single use</div>
      </td></tr>
    </table>
  </td></tr>

  <!-- how to use it -->
  <tr><td style="padding:24px 32px 8px;">
    <p style="margin:0 0 10px; font-family:{_SANS}; font-size:13.5px; font-weight:700; color:{_INK};">How to use this code</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="24" valign="top" style="font-family:{_SANS}; font-size:13px; color:{_ACCENT}; font-weight:700; padding:0 0 8px;">1.</td>
        <td style="font-family:{_SANS}; font-size:13px; line-height:1.6; color:{_INK_SOFT}; padding:0 0 8px;">Go back to the AgriPricePH login page and open &ldquo;Forgot password?&rdquo; (or the reset-code screen if you already have it open).</td>
      </tr>
      <tr>
        <td width="24" valign="top" style="font-family:{_SANS}; font-size:13px; color:{_ACCENT}; font-weight:700; padding:0 0 8px;">2.</td>
        <td style="font-family:{_SANS}; font-size:13px; line-height:1.6; color:{_INK_SOFT}; padding:0 0 8px;">Enter the 6-digit code above exactly as shown.</td>
      </tr>
      <tr>
        <td width="24" valign="top" style="font-family:{_SANS}; font-size:13px; color:{_ACCENT}; font-weight:700;">3.</td>
        <td style="font-family:{_SANS}; font-size:13px; line-height:1.6; color:{_INK_SOFT};">Once it's verified, choose your new password and confirm it &mdash; then log in with it from the login page.</td>
      </tr>
    </table>
  </td></tr>

  <!-- security notice -->
  <tr><td style="padding:22px 32px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF2E9; border:1px solid #F0DFC8; border-radius:10px;">
      <tr><td style="padding:14px 16px; font-family:{_SANS}; font-size:12.5px; line-height:1.6; color:#7A5B2E;">
        <strong>Didn't ask for this?</strong> Someone may have typed your email by mistake &mdash; you can
        safely ignore this message. Your password stays exactly as it is unless this code is actually
        used. Never share this code with anyone; AgriPricePH staff will never ask you for it by phone,
        chat, or email.
      </td></tr>
    </table>
  </td></tr>

  <!-- footer -->
  <tr><td style="padding:20px 32px; background:{_PAPER}; border-top:1px solid {_LINE};" align="center">
    <p style="margin:0 0 4px; font-family:{_SANS}; font-size:11.5px; color:{_MUTED};">
      AgriPricePH &middot; rice price monitoring &amp; a 3-day forecast for the Philippines
    </p>
    <p style="margin:0; font-family:{_SANS}; font-size:11px; color:{_MUTED};">
      This is an automated message from an unmonitored address &mdash; please don't reply to it.
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>
"""


def _build_plain_text(display_name: str, to_email: str, code: str) -> str:
    return f"""AgriPricePH — Reset your password

Hi {display_name},

We received a request to reset the password for the AgriPricePH account
registered to {to_email}. Use the code below to continue.

    Your code: {code}

    Expires in {CODE_TTL_MINUTES} minutes — single use only.

How to use this code:
  1. Go back to the AgriPricePH login page and open "Forgot password?"
     (or the reset-code screen if you already have it open).
  2. Enter the 6-digit code above exactly as shown.
  3. Once it's verified, choose your new password and confirm it — then
     log in with it from the login page.

Didn't ask for this? Someone may have typed your email by mistake — you
can safely ignore this message. Your password stays exactly as it is
unless this code is actually used. Never share this code with anyone;
AgriPricePH staff will never ask you for it by phone, chat, or email.

—
AgriPricePH · rice price monitoring & a 3-day forecast for the Philippines
This is an automated message from an unmonitored address — please don't
reply to it.
"""


def send_reset_code_email(to_email: str, name: str, code: str) -> tuple[bool, str]:
    """Send a branded, detailed 6-digit password-reset email. Returns (ok, error_message)."""
    app_password = os.environ.get(GMAIL_APP_PASSWORD_ENV)
    if not app_password:
        return False, f"{GMAIL_APP_PASSWORD_ENV} is not set on the server."

    display_name = (name or "there").strip() or "there"

    # multipart/related(  multipart/alternative(text, html),  inline logo image )
    # — the outer "related" carries the logo as a cid: attachment the HTML part
    # can reference; the inner "alternative" is the usual text-vs-html choice.
    msg = MIMEMultipart("related")
    msg["Subject"] = f"{code} is your AgriPricePH password reset code"
    msg["From"] = f"AgriPricePH <{GMAIL_SENDER}>"
    msg["To"] = to_email

    alt = MIMEMultipart("alternative")
    msg.attach(alt)
    # Plain-text part first, HTML second — email clients render the LAST part
    # of a multipart/alternative that they support, so HTML-capable clients
    # (the vast majority) show the branded version while text-only clients
    # and screen-reader-first users still get the fully detailed plain one.
    alt.attach(MIMEText(_build_plain_text(display_name, to_email, code), "plain", "utf-8"))
    alt.attach(MIMEText(_build_html(display_name, to_email, code), "html", "utf-8"))

    try:
        with open(LOGO_PATH, "rb") as f:
            logo = MIMEImage(f.read())
        logo.add_header("Content-ID", f"<{LOGO_CID}>")
        logo.add_header("Content-Disposition", "inline", filename="agripriceph-logo.png")
        msg.attach(logo)
    except OSError as exc:
        return False, f"Could not read email logo asset ({LOGO_PATH}): {exc}"

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context, timeout=10) as server:
            server.login(GMAIL_SENDER, app_password)
            server.sendmail(GMAIL_SENDER, [to_email], msg.as_string())
        return True, ""
    except Exception as exc:  # noqa: BLE001 — surfaced to the caller, not swallowed
        return False, str(exc)
