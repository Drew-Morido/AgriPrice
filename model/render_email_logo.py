"""
AgriPricePH — one-off dev tool: renders the site's real logo mark (the exact
SVG path data used in public/login.html's / public/signup.html's .ah-card-logo
tile, and everywhere else the brand mark appears) to model/assets/email_logo.png
for model/mailer.py to embed inline (cid:) in password-reset emails.

Email clients don't render inline SVG reliably (Outlook desktop doesn't at
all), so the email needs a real raster image instead of the emoji-tile
approximation the first draft of the reset email shipped with — this script
exists so that image stays pixel-faithful to the actual site logo instead of
hand-drawn or approximated, and can be regenerated if the logo ever changes.

NOT a runtime dependency of the app — run manually, only when the logo
changes:
    py -3.13 -m pip install svgpathtools Pillow
    cd model && py -3.13 render_email_logo.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw
from svgpathtools import parse_path

# Exact path data from public/login.html's .ah-card-logo SVG (viewBox 0 0 24 24).
# Keep this in sync if the site logo ever changes — it's copy-pasted, not
# imported, since this is a one-off dev script with no reason to depend on
# the HTML at import time.
PATH_D = [
    "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z",
    "M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12",
]
VIEWBOX = 24.0
STROKE_W_SVG = 2.2  # matches the SVG's stroke-width="2.2"

SS = 4                    # supersample factor for anti-aliasing
TILE = 256                 # final output size (px) — high-res for retina email clients
RENDER = TILE * SS
RADIUS = int(58 * SS)      # proportional to the site's .ah-logo-tile border-radius
BG = (0x2A, 0x5C, 0x3F, 255)    # exact .ah-logo-tile background (#2a5c3f)
FG = (255, 255, 255, 255)        # stroke color (white)
ICON_SCALE = 0.55          # icon occupies ~55% of the tile, matching the site's proportions

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "email_logo.png")


def _sample_path(d: str, offset: float, scale: float, points_per_svg_unit: int = 8):
    """Sample points along an SVG path, proportional to each segment's own
    length so spacing stays roughly constant (curvier segments get more
    points) — always dense enough (min 40/segment) that stamped circles
    (see below) overlap smoothly with no visible faceting."""
    path = parse_path(d)
    pts = []
    for seg in path:
        n = max(40, int(seg.length() * points_per_svg_unit))
        for i in range(n + 1):
            t = i / n
            p = seg.point(t)
            pts.append((offset + p.real * scale, offset + p.imag * scale))
    return pts


def render() -> str:
    img = Image.new("RGBA", (RENDER, RENDER), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([0, 0, RENDER, RENDER], radius=RADIUS, fill=BG)

    icon_render = RENDER * ICON_SCALE
    offset = (RENDER - icon_render) / 2
    scale = icon_render / VIEWBOX
    stroke_w = max(1, round(STROKE_W_SVG * scale))
    r = stroke_w / 2

    # "Stamped circles" stroke: a filled circle at every sample point. With
    # dense-enough sampling this unions into a smooth thick stroke with
    # naturally rounded joints/caps (matching stroke-linecap/linejoin="round")
    # — far smoother than Pillow's ImageDraw.line(width=..., joint="curve"),
    # which visibly facets on tight curves at this stroke-width-to-radius ratio.
    for d in PATH_D:
        for (x, y) in _sample_path(d, offset, scale):
            draw.ellipse([x - r, y - r, x + r, y + r], fill=FG)

    img = img.resize((TILE, TILE), Image.LANCZOS)
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    img.save(OUT_PATH)
    return OUT_PATH


if __name__ == "__main__":
    path = render()
    print(f"saved {path}")
