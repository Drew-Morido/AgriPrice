"""
AgriPricePH — read the cached DA daily price bulletins (fetch_da_bulletins.py) into one table of daily NCR
prevailing rice prices, 2018 onward.

DA changed the bulletin layout many times. Every PAGE is classified from its own text before anything is read; only
a layout with a dedicated reader is read. Anything else — an unknown layout, an image-only page (infographic or
scan), text garbled by cid-encoded fonts, a bulletin with no rice rows — is NOT guessed: it goes to the review list
with the reason. Nothing is interpolated or averaged across layouts.

Layouts (how they are recognised -> what is read):
  PW   No imported/local split; rows Fancy|Special, Premium, Well milled, Regular milled; each row is per-market
       Prevailing/Low/High triplets ending with the NCR-wide Prevailing/Low/High/Average (Price Watch, Feb 2018 -
       Sep 2019, incl. the "Sum-Market" and early "Preliminary" files). The NCR-wide Prevailing (4th value from the
       end) is used, for local AND imported (no split published); Fancy = Special.
  SEC  Imported and local sections ("IMPORTED COMMERCIAL RICE" / "COMMERCIAL IMPORTED", "LOCAL COMMERCIAL RICE" /
       "COMMERCIAL LOCAL"), one summary row per grade:
         4 values = Prevailing Low High Average -> Prevailing (1st)      (Oct 2019 - mid 2020, "layout A")
         3 values = High Low Prevailing          -> Prevailing (3rd)      (mid 2020 - Aug 2021, "layout B")
       A page whose rows carry per-market blocks (more values) is skipped; its summary page is read instead.
  P19  Sep 2019 "Preliminary": imported lists only well-milled and regular milled, local all four; Prevailing first.
  C    Side-by-side "TODAY'S / YESTERDAY'S (or LAST FRIDAY'S) PREVAILING PRICE" (Sep 2021 onward): row
       "Special a b Special c d" = imported (today, earlier), local (today, earlier). Today's values are used.
  DPI  "Daily Price Index" (2025 onward): tools/pdfconvrt.py, the reader the live scraper uses.
NOT read on purpose:
  RANGE_ONLY  "Retail Price Range ..." (2023 - Feb 2025): DA published only a low-high range per grade, no prevailing
       price. A range midpoint is a derived number, not DA's figure, and it does not match DA's prevailing prices
       (2023 sample: mean |gap| PHP 1.83 vs DA-AMAS weekly prevailing, 43% within PHP 1, bias +0.83), so these days stay
       on the DA weekly prevailing series (DA-AMAS weekly, DA Weekly Average Price).
"NONE", "NOT", "NOT AVAILABLE", "#N/A" in the prevailing position mean DA had no prevailing price for that grade that
day: the cell is left empty (the rebuild carries the previous published figure).

Every row read must pass: a price band; Regular milled not above any other grade of the same origin, and
Well-milled not above Special (PHP 0.50 tolerance; Premium vs Well-milled is NOT checked — DA's imported premium is
genuinely below imported well-milled on some days); and the bulletin's printed date within 3 days of the file
name's date (the printed date is used). A failing row goes to review, not to the output.

Output: da_daily_bulletins.csv (Date, template, file, the 8 prices) and da_daily_bulletins_review.csv (file, date,
template, reason). Nothing here writes the database.

Run:  cd datasets/scripts && py -3.13 parse_da_daily_bulletins.py [--years 2018-2021]
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import logging
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402  (datasets/scripts/paths.py: every datasets/ location)
import re
import sys
from collections import Counter

import pdfplumber

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))   # datasets/scripts/ -> project root
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, HERE)
logging.getLogger("pdfminer").setLevel(logging.ERROR)

from fetch_da_bulletins import CACHE, MANIFEST  # noqa: E402

OUT_CSV = paths.da_parsed("da_daily_bulletins.csv")
REVIEW_CSV = paths.da_parsed("da_daily_bulletins_review.csv")
KEYS = ["impSpecial", "impPremium", "impWellMilled", "impRegular",
        "locSpecial", "locPremium", "locWellMilled", "locRegular"]
GRADES = ("Special", "Premium", "WellMilled", "Regular")
BAND = (15.0, 150.0)
ORDER_TOL = 0.50
MAX_PAGES = 4

NUM = r"\d+(?:\.\d+)?"
TOKEN = r"NOT\s+AVAILABLE|#N/A|N/A|#DIV/0!|NONE|NOT|\d+(?:\.\d+)?"
GRADE_RE = {"Special": r"(?:Fancy|Special)", "Premium": r"Premium", "WellMilled": r"Well[\s-]?milled",
            "Regular": r"Regular[\s-]?milled"}
MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"
IMP_HEAD = r"IMPORTED\s+COMMERCIAL(?:\s+RICE)?|COMMERCIAL\s+IMPORTED"
LOC_HEAD = r"LOCAL\s+COMMERCIAL(?:\s+RICE)?|COMMERCIAL\s+LOCAL"
END_HEAD = r"\bFISH\b|LIVESTOCK|POULTRY|LOWLAND|HIGHLAND|FRUITS|\bSPICES\b"


def _num(tok: str) -> float | None:
    return round(float(tok), 2) if re.fullmatch(NUM, tok) else None


def _prevailing(prev: str, low: str, high: str, avg: str | None = None) -> float | None:
    """A summary block's prevailing price, only if the block is internally consistent: Low <= Prevailing <= High
    (and Low <= Average <= High when an average is given). A block that fails is a misread, not a price."""
    p, lo, hi = _num(prev), _num(low), _num(high)
    if p is None or lo is None or hi is None or not (lo - 0.01 <= p <= hi + 0.01):
        return None
    if avg is not None:
        a = _num(avg)
        if a is None or not (lo - 0.01 <= a <= hi + 0.01):
            return None
    return p


def _tokens(s: str) -> list[str]:
    return [re.sub(r"\s+", " ", t) for t in re.findall(TOKEN, s)]


def _repair_split_numbers(line: str) -> str:
    """2019 Price Watch text splits a price's first digit off ("5 0.00" for 50.00); rejoin a lone digit followed by a
    d.dd token (every value in those rows has two decimals, so a lone digit never occurs on its own)."""
    return re.sub(r"(?<![\d.])(\d) (\d\.\d{2})\b", r"\1\2", line)


# ─────────────────────────── page classification ───────────────────────────

def classify_page(text: str) -> str:
    t = text.upper()
    if len(text.strip()) < 200:
        return "NO_TEXT"
    if t.count("(CID:") > 20:
        return "GARBLED"
    if "DAILY PRICE INDEX" in t:
        return "DPI"
    if "RETAIL PRICE RANGE" in t:
        return "RANGE_ONLY"
    has_imp, has_loc = re.search(IMP_HEAD, t), re.search(LOC_HEAD, t)
    if has_imp and ("TODAY'S PREVAILING" in t or "TODAY’S PREVAILING" in t):
        return "C"
    if has_imp and has_loc:
        if re.search(r"IMPORTED\s*\(\s*(?:WELL|REGULAR)", t):
            return "P19"
        w = _section_width(text)
        return "SEC4" if w == 4 else "SEC3" if w == 3 else "WIDE" if w > 4 else "UNKNOWN"
    if re.search(r"^\s*(?:FANCY|SPECIAL|PREMIUM)\b", t, re.M) and "PREVAILING" in t:
        return "PW"
    if not re.search(r"\bRICE\b", t):
        return "NO_RICE"
    if "BANTAY PRESYO" in t:
        return "POSTER_NO_SPLIT"
    return "UNKNOWN"


def _block(text: str, start: str, ends: list[str]) -> str:
    m = re.search(start, text, re.I)
    if not m:
        return ""
    rest = text[m.end():]
    cut = len(rest)
    for e in ends:
        n = re.search(e, rest, re.I)
        if n:
            cut = min(cut, n.start())
    return rest[:cut]


def _grade_rows(block: str) -> dict[str, list[str]]:
    """{grade: value tokens} for the first row of each grade in a section."""
    out = {}
    for line in block.splitlines():
        line = line.strip()
        for g, pat in GRADE_RE.items():
            m = re.match(rf"{pat}\b", line, re.I)
            if g not in out and m:
                rest = line[m.end():]
                rest = re.split(r"\bkg\b", rest, maxsplit=1, flags=re.I)[-1]   # values follow the unit, if any
                rest = re.sub(r"\((?:Blue|Yellow|White)\s+tag\)|\b(?:Blue|Yellow|White)\s+tag\b", " ", rest, flags=re.I)
                out[g] = _tokens(rest)
    return out


def _section_width(text: str) -> int:
    rows = _grade_rows(_block(text, IMP_HEAD, [LOC_HEAD]))
    widths = [len(v) for v in rows.values() if v]
    return max(widths) if widths else 0


# ─────────────────────────── readers ───────────────────────────

def read_sec(text: str, width: int) -> dict:
    out = {k: None for k in KEYS}
    for side, head, ends in (("imp", IMP_HEAD, [LOC_HEAD, END_HEAD]), ("loc", LOC_HEAD, [END_HEAD])):
        for g, toks in _grade_rows(_block(text, head, ends)).items():
            if len(toks) == width:
                out[side + g] = (_prevailing(toks[0], toks[1], toks[2], toks[3]) if width == 4      # Prev Low High Avg
                                 else _prevailing(toks[2], toks[1], toks[0]))                         # High Low Prev
    return out


def read_p19(text: str) -> dict:
    out = {k: None for k in KEYS}
    imp = _block(text, IMP_HEAD, [LOC_HEAD])
    for line in imp.splitlines():
        m = re.match(r"\s*Imported\s*\(\s*(well|regular)\s*milled\s*\)(.*)", line, re.I)
        if m:
            toks = _tokens(re.split(r"\bkg\b", m.group(2), maxsplit=1, flags=re.I)[-1])
            key = "impWellMilled" if m.group(1).lower() == "well" else "impRegular"
            if len(toks) == 4 and out[key] is None:
                out[key] = _prevailing(*toks)
    for g, toks in _grade_rows(_block(text, LOC_HEAD, [END_HEAD])).items():
        if len(toks) == 4:
            out["loc" + g] = _prevailing(*toks)
    return out


def read_pw(text: str) -> dict:
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines) if re.match(r"\s*(COMMERCIAL|RICE)\b", l, re.I)), None)
    if start is None:
        return {}
    vals = {}
    for line in lines[start + 1:start + 12]:
        line = _repair_split_numbers(line.strip())
        if re.match(r"(NFA|FISH|BANGUS|LIVESTOCK)", line, re.I):
            if vals and re.match(r"(FISH|BANGUS|LIVESTOCK)", line, re.I):
                break
            continue
        for g, pat in GRADE_RE.items():
            m = re.match(rf"{pat}\b", line, re.I)
            if g not in vals and m:
                # Market triplets (Prevailing Low High) then the NCR-wide Prevailing Low High Average. A row whose
                # length is not 3k + 4 lost its summary (wide tables get cut off in the PDF text): not read.
                toks = [t for t in _tokens(line[m.end():].replace("(", " ").replace(")", " "))]
                if len(toks) >= 7 and (len(toks) - 4) % 3 == 0:
                    vals[g] = _prevailing(*toks[-4:])
    if not vals:
        return {}
    out = {}
    for g in GRADES:
        out["imp" + g] = vals.get(g)
        out["loc" + g] = vals.get(g)
    return out


def read_c(text: str) -> tuple[dt.date | None, dict]:
    dm = re.search(rf"({MONTHS})\s+(\d{{1,2}}),?\s+(\d{{4}})\s+({MONTHS})\s+(\d{{1,2}}),?\s+(\d{{4}})", text)
    today = dt.datetime.strptime(f"{dm.group(1)} {dm.group(2)} {dm.group(3)}", "%B %d %Y").date() if dm else None
    out = {k: None for k in KEYS}
    v = r"(NOT|NONE|#N/A|\d+(?:\.\d+)?)"
    for g, pat in GRADE_RE.items():
        m = re.search(rf"^\s*{pat}\*?\s+{v}\s+{v}\s+{pat}\*?\s+{v}\s+{v}", text, re.I | re.M)
        if m:
            out["imp" + g] = _num(m.group(1))
            out["loc" + g] = _num(m.group(3))
    return today, out


def read_dpi(pdf_bytes: bytes) -> dict:
    import pdfconvrt
    raw = pdfconvrt.extract_rice_prices_from_pdf_bytes(pdf_bytes)
    names = {"Imported Special": "impSpecial", "Imported Premium": "impPremium",
             "Imported Well Milled": "impWellMilled", "Imported Regular Milled": "impRegular",
             "Local Special": "locSpecial", "Local Premium": "locPremium",
             "Local Well Milled": "locWellMilled", "Local Regular Milled": "locRegular"}
    return {names[k]: v for k, v in raw.items() if k in names}


def printed_date(text: str) -> dt.date | None:
    for pat, order in ((rf"({MONTHS})\s+(\d{{1,2}}),?\s+(\d{{4}})", (1, 2, 3)),
                       (rf"(\d{{1,2}})\s+({MONTHS}),?\s+(\d{{4}})", (2, 1, 3))):
        m = re.search(pat, text)
        if m:
            mon, day, yr = (m.group(i) for i in order)
            return dt.datetime.strptime(f"{mon} {day} {yr}", "%B %d %Y").date()
    return None


# ─────────────────────────── checks ───────────────────────────

def check(row: dict) -> str | None:
    vals = {k: row.get(k) for k in KEYS}
    if all(v is None for v in vals.values()):
        return "no rice prices found"
    for k, v in vals.items():
        if v is not None and not (BAND[0] <= v <= BAND[1]):
            return f"{k}={v} outside {BAND}"
    for side in ("imp", "loc"):
        sp, pr, wm, rg = (vals[side + g] for g in GRADES)
        for name, hi in (("Special", sp), ("Premium", pr), ("Well-milled", wm)):
            if hi is not None and rg is not None and rg > hi + ORDER_TOL:
                return f"{side} Regular {rg} above {name} {hi}"
        if sp is not None and wm is not None and wm > sp + ORDER_TOL:
            return f"{side} Well-milled {wm} above Special {sp}"
    return None


# ─────────────────────────── driver ───────────────────────────

UNREAD = {"NO_TEXT": "image-only page (infographic or scan) - not guessed",
          "GARBLED": "text is cid-encoded - not guessed",
          "UNKNOWN": "layout not recognised - not guessed",
          "WIDE": "only per-market table found, no summary row",
          "POSTER_NO_SPLIT": "per-market poster, no grade/origin split",
          "NO_RICE": "bulletin has no rice rows that day",
          "RANGE_ONLY": "DA published a low-high range, not a prevailing price - not converted"}


def read_file(path: str, name_date: dt.date | None) -> tuple[dt.date | None, dict, str, str | None]:
    """(date, prices, template, problem)."""
    with open(path, "rb") as f:
        data = f.read()
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            texts = [(p.extract_text() or "") for p in pdf.pages[:MAX_PAGES]]
    except Exception as exc:  # noqa: BLE001
        return None, {}, "UNREADABLE", f"cannot open ({exc})"
    seen = []
    for text in texts:
        template = classify_page(text)
        seen.append(template)
        if template in UNREAD:
            continue
        d = printed_date(text) or name_date
        if template == "C":
            d2, row = read_c(text)
            d = d2 or d
        elif template == "DPI":
            row = read_dpi(data)
        elif template == "PW":
            row = read_pw(text)
        elif template == "P19":
            row = read_p19(text)
        else:
            row = read_sec(text, 4 if template == "SEC4" else 3)
        row = {k: (None if v is not None and v <= 0 else v) for k, v in row.items()}
        if not any(row.get(k) is not None for k in KEYS):
            continue
        if name_date and d and abs((d - name_date).days) > 3:
            return d, {}, template, f"printed date {d} is far from file name {name_date}"
        problem = check(row)
        return d, ({} if problem else row), template, problem
    best = next((t for t in seen if t not in ("NO_RICE",)), seen[0] if seen else "UNREADABLE")
    return name_date, {}, best, UNREAD.get(best, "no rice prices found")


def run(years: tuple[int, int] | None = None) -> dict:
    with open(MANIFEST, newline="", encoding="utf-8") as f:
        items = [r for r in csv.DictReader(f) if r["status"] == "ok"]
    if years:
        items = [r for r in items if years[0] <= int(r["date"][:4]) <= years[1]]
    # A "Revised"/"Final" bulletin beats the original for the same date.
    items.sort(key=lambda r: (r["date"], not re.search(r"revised|final", r["file"], re.I)))
    rows, review, templates = {}, [], Counter()
    for r in items:
        name_date = dt.date.fromisoformat(r["date"])
        d, row, template, problem = read_file(os.path.join(CACHE, r["file"]), name_date)
        templates[template] += 1
        if problem:
            review.append({"file": r["file"], "date": r["date"], "template": template, "reason": problem})
            continue
        if d.isoformat() not in rows:
            rows[d.isoformat()] = {"Date": d.isoformat(), "template": template, "file": r["file"], **row}
    cols = ["Date", "template", "file", *KEYS]
    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for k in sorted(rows):
            w.writerow({c: rows[k].get(c) for c in cols})
    with open(REVIEW_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["file", "date", "template", "reason"])
        w.writeheader()
        w.writerows(review)
    return {"files": len(items), "days_read": len(rows), "review": len(review), "templates": dict(templates)}


def main() -> int:
    ap = argparse.ArgumentParser(description="Read cached DA daily bulletins into da_daily_bulletins.csv")
    ap.add_argument("--years", help="e.g. 2018-2021")
    a = ap.parse_args()
    yrs = tuple(int(x) for x in a.years.split("-")) if a.years else None
    print(run(yrs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
