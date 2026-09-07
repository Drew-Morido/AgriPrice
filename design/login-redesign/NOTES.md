## Update: Escape on the unlock popup now always goes home too (2026-09-04)

Escape, the × button, and clicking the backdrop already called the same
`dismissUnlockToHome()` function — but that function only redirected `if
(document.body.dataset.page === 'historical' || 'statistics')`, a check that
could quietly do nothing (just close the popup, leaving the locked page
behind) for any path where that didn't hold. Removed the condition —
`dismissUnlockToHome()` now unconditionally closes the popup and sends the
visitor to `landpage.html` every time, no exceptions, for all three triggers.

## Update: redesigned the "Members Only" unlock popup too (2026-09-04)

This is a DIFFERENT popup from the success/error one — it's `public-auth-modal.js`'s
`showUnlock()` (`.public-unlock-*` in `public.css`), shown when a signed-out visitor
opens historical.html (Price History) or statistics.html (Charts & Stats).

- **Found and fixed a real pre-existing bug**: `.public-unlock-card` had a
  **hardcoded white** background while its title/body used **theme-reactive**
  text tokens (`--text-primary` etc.) — in dark mode those tokens turn
  near-white, so the text went nearly invisible on the still-white card
  (screenshotted by the user). Fixed by making the card itself theme-reactive
  (`var(--bg-card)`, `var(--border-color)`) so text and background now always
  move together, in both themes — unlike login/signup, this modal lives on
  pages that DO follow the site's theme toggle, so "always light" wasn't the
  right fix here.
- Redesigned to match the same language as the success/error popup: icon +
  title in one row (`.public-unlock-head`) instead of a big centered icon
  over a centered title; body text indented under the title; dropped the
  redundant "DO YOU WANT TO OPEN THIS FEATURE?" eyebrow line (the badge +
  title already say that).
- Title now actually uses **DM Serif Display** (historical.html/statistics.html's
  real serif font) — it was set to `var(--font-serif, Georgia, serif)`, a
  variable that's never defined anywhere in the codebase, so it had silently
  always rendered in the Georgia fallback instead.
- The card's own **Log in / Sign up free** buttons now go to the real
  `login.html` / `signup.html` (with `?next=` back to the page they were
  unlocking) instead of opening the old modal — same reasoning as the nav
  buttons: the real pages are the better experience now.

## Update: fixed the dark-card bug + a second popup redesign pass (2026-09-04)

- **Root cause of the popup/card rendering dark**: `js/public-settings.js`
  (loaded in `<head>` on every public page) reads the visitor's *saved*
  site-wide dark-mode preference from localStorage/OS and immediately
  applies `html.theme-dark`, which repoints `--bg-card` etc. to the dark
  palette in `css/global.css`. login.html/signup.html were still loading
  it, so a visitor with dark mode saved elsewhere on the site got a dark
  card here too — even though this page is meant to always be the light
  card + dark photo look. Fix: **removed the `public-settings.js` `<script>`
  tag from both pages' `<head>`** — nothing else on this page needs it, and
  without it `html.theme-dark` is never applied here.
- **Popup redesigned again**: dropped the top accent bar (felt like an
  unnecessary added line); icon + title now sit in one row
  (`.public-alert-head`) instead of stacked; the message is indented to
  align under the title rather than the icon (`padding-left: 48px`, the
  detail that keeps it from reading as a generic centered
  icon/title/text/button stack). Close-X stays. Same ids/classes JS
  depends on, so `public-alert.js`'s `show()`/`close()` didn't need to change
  beyond wrapping icon+title in the new `.public-alert-head` div.

## Update: polish pass — credits, fade-in, first/last name, Terms modal (2026-09-04)

- Photo credit forced to one line (`white-space:nowrap` + ellipsis, smaller
  font) so it never wraps past the slide-dots.
- `.ah-hero h1`, `.ah-hero p`, and `.ah-card` fade/slide in on load
  (`@keyframes ah-fade-in`, staggered); respects `prefers-reduced-motion`.
- Submit/ghost buttons inside the card are centered (`.ah-card-body .btn { justify-content: center; }`).
- Sign-up form: **Full name** replaced with **First name** / **Last name**
  (`.ah-field-row`, side by side), submitted to `Auth().signup()` joined as
  `"First Last"`. Every field (first/last name, email, password, confirm,
  terms) now gets an inline error message under it on submit
  (`.ah-field-error`, red input border) instead of relying only on the popup
  — the popup (`Alert().authFailure`) is now reserved for server/account-level
  failures like "email already registered", which aren't any one field's fault.
- `public-alert.css` (the shared popup used site-wide) got a visual pass to
  match: Fraunces title, tokenized colors/radius (`var(--color-accent)`,
  `var(--border-radius-xl)`, etc.) instead of hardcoded hex — same DOM/JS
  contract, so nothing else on the site broke.
- **Terms & Conditions** in the sign-up form is now a bold inline button
  (`#ah-terms-link`) that opens a real modal (`#ah-terms-modal`) with the
  same honest capstone-demo notice text the shared auth modal uses —
  self-contained in `auth-hero.js`/`auth-hero.css`, not a dependency on
  `public-auth-modal.js`.

## Update: top/bottom alignment + title↔description swap + Price Forecast fonts (2026-09-04)

- **Alignment**: `.ah-hero` and `.ah-form-panel` now share the exact same
  `padding: 48px … 40px` and both use `justify-content: space-between`
  (3 groups on the hero side — topbar / `.ah-hero-mid` / slide-bar; 2 on the
  form side — card / footer). That's a CSS-only guarantee that the logo
  lines up with the top of the card and the slide-bar lines up with the
  footer, regardless of the card's height (login vs. sign-up vs. the admin
  PIN step) — no JS measurement needed.
- **Copy swap**: the `<h1>` title is now the quote text ("Rice prices
  shouldn't be a guessing game…"); the original descriptive sentence
  ("Track today's price and a 3-day forecast…") is back as a plain
  paragraph below it. The `.ah-quote` blockquote styling was removed.
- **Fonts now match the real "Price Forecast" module** (`current-prices.html`)
  instead of the admin dashboard's font pair: **Fraunces** (serif) for the
  hero `<h1>` and the card's `<h2>`, **Plus Jakarta Sans** for body/UI text
  (unchanged), **JetBrains Mono** for the stat row's price figures (was DM
  Mono). The Google Fonts `<link>` in both pages now pulls the identical
  family string `current-prices.html` uses.

## Update: 5-image Wikimedia-only slideshow + quote + wider card padding (2026-09-04)

Per request: removed the Pexels photo (no longer used anywhere), added 2 more
— **all 5 slides are now Wikimedia Commons only**:

1. `login-hero-1.jpg` — Patrickroque01, CC BY-SA 4.0 (Banaue sunset)
2. `login-hero-2.jpg` — Jophel Botero Ybiosa, CC BY-SA 4.0 (Batad hillside)
3. `login-hero-3.jpg` — Bien02, CC BY 4.0 (Batad aerial)
4. `login-hero-4.jpg` — Tyrel Fang-asan Faniswa, CC BY-SA 4.0 (Payew Rice Terraces of Besao, Mountain Province)
   https://commons.wikimedia.org/wiki/File:Payew_Rice_Terraces_of_Besao.jpg
5. `login-hero-5.jpg` — Jsinglador, CC BY-SA 3.0 (Early Morning Scene at Banaue Rice Terraces)
   https://commons.wikimedia.org/wiki/File:Early_Morning_Scene_at_Banaue_Rice_Terraces.jpg

Also: the hero paragraph became a styled `<blockquote class="ah-quote">`
(left accent rule + italic), and the card's left/right padding grew from
34px to 48px (`.ah-card-body`, `.ah-card` max-width bumped 416px → 448px
to compensate). All backed up as `login-bg-besao-*` / `login-bg-earlymorning-*`
above; the Pexels backup files were deleted since that photo is retired.

## Update: 70/30 split + slideshow + admin PIN (2026-09-04, later same day)

Layout changed to a real split screen: the photo (now a 4-image credited
slideshow with bullet dots) fills the left ~70%, a plain `var(--bg-body)`
panel holds the login/sign-up card on the right ~30%. Images now live at
`public/assets/img/login-hero-1.jpg` … `login-hero-4.jpg`:

1. `login-hero-1.jpg` — chiến bá, **Pexels** (free to use, no attribution required)
   https://www.pexels.com/photo/stunning-golden-rice-terraces-in-vietnam-28955424/
2. `login-hero-2.jpg` — Patrickroque01, **Wikimedia Commons, CC BY-SA 4.0** (Banaue, Ifugao, PH)
   https://commons.wikimedia.org/wiki/File:Banaue_Rice_Terraces_main_south_sunset_(Banaue,_Ifugao;_11-25-2022).jpg
3. `login-hero-3.jpg` — Jophel Botero Ybiosa, **Wikimedia Commons, CC BY-SA 4.0** (Batad, Ifugao, PH)
   https://commons.wikimedia.org/wiki/File:SPLENDOR_OF_BATAD_RICE_TERRACES.jpg
4. `login-hero-4.jpg` — Bien02, **Wikimedia Commons, CC BY 4.0** (Batad aerial, Ifugao, PH)
   https://commons.wikimedia.org/wiki/File:Batad_Rice_Terraces_(aerial).jpg

Credits are shown live on the page (bottom-left of the photo side, next to
the slide dots) and rotate with the active slide — kept even though #1
doesn't require it, per the "credit every image" request. Originals +
optimized copies of the two new Batad photos are backed up alongside the
earlier two in this folder.

`public/js/public-auth-modal.js`'s `#public-btn-login` / `#public-btn-signup`
(the shared site nav's buttons, rendered by `public-shell.js` on every public
page) now navigate to `login.html` / `signup.html` instead of opening the
modal. `login.html` gained the admin-username → 6-digit-PIN step (mirrors
the modal's `verifyAdminPassword` → `adminLogin` flow) so admin sign-in
still works from the nav. The modal itself is otherwise untouched and still
opens for the gated-content unlock prompts on historical.html/statistics.html.

## Shipped to the real site (2026-09-04)

The design was implemented for real in `public/login.html` + `public/signup.html`:
- `public/css/auth-hero.css` — the hero/card styles (reuses `css/global.css`
  tokens where it can; the dark/gold hero itself stays one fixed look, not
  tied to the app's light/dark theme toggle).
- `public/js/auth-hero.js` — password show/hide, the sign-up strength meter,
  the live stat row (local/imported rice + fuel + USD/PHP via
  `AgriPricePH.API.historical()`, mock fallback), and the real
  `#form-login` / `#form-signup` submit handlers (`AgriPricePH.PublicAuth`).
- `public/assets/img/login-hero.jpg` — the background photo actually served
  by the app (copy of `login-bg-pexels-golden-optimized.jpg` below).
- `public/js/public-pages.js` was edited: visiting `login.html`/`signup.html`
  no longer auto-redirects to the modal — only an already-logged-in visitor
  gets bounced away. The shared login/sign-up **modal** (`public-auth-modal.js`)
  was left untouched and still opens from other "Log in" buttons across the site.

# Login page background — image backups

These are backups of background photo candidates for the redesigned login page
mockup, saved here so they survive even after the temp session scratchpad is
cleared. The live mockup artifact currently uses **login-bg-pexels-golden**.

## Currently used: `login-bg-pexels-golden-*.jpg`

- Source: https://www.pexels.com/photo/stunning-golden-rice-terraces-in-vietnam-28955424/
- Photographer: chiến bá
- License: **Pexels License** — free for commercial & personal use, **no
  attribution required**. (Photo is of terraced rice fields in Vietnam, not
  the Philippines specifically — Pexels/stock-site location titles are not
  reliably accurate, so don't caption it as a named PH location.)
- `-original.jpg` — as downloaded, 7952×5304 (~11.2 MB)
- `-optimized.jpg` — resized to 2000px wide, JPEG q76 (~855 KB), this is the
  one base64-embedded into the mockup HTML

## Backup alternative: `login-bg-banaue-*.jpg`

- Source: https://commons.wikimedia.org/wiki/File:Banaue_Rice_Terraces_main_south_sunset_(Banaue,_Ifugao;_11-25-2022).jpg
- Photographer: Patrickroque01
- License: **CC BY-SA 4.0** — free to use, but **attribution is required**
  (credit the photographer + link to the license; note if modified/resized).
  This is a real, verified Banaue, Ifugao (Philippines) photo, shot at 5:05pm.
- `-original.jpg` — as downloaded, 3552×2664 (~2.7 MB)
- `-optimized.jpg` — resized to 2000px wide, JPEG q76 (~205 KB)

## To swap the background later

1. Pick an image (either backup above, or a new one — resize the long edge to
   ~2000px and export as JPEG quality ~75-80 to keep the page light).
2. Base64-encode it and replace the `data:image/jpeg;base64,...` value inside
   the `<img class="bg-illustration" ...>` tag in the mockup HTML.
3. If the replacement image's license requires attribution (like the Banaue
   CC BY-SA one), add back a small credit line — see the `.photo-credit` CSS
   rule pattern used in earlier versions of the mockup.
