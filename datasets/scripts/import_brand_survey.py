"""
AgriPricePH — import the updated local-market brand survey into the Rice Catalog.

Source: a "30-Day Price Log" sheet (Aug 6 – Sep 4, 2026), one row per product *pack*:
    Segment | Classification | Brand Name | Package / Variety | Location / Origin | Day 1..Day 30 | ...

What this script does
  * Product = (grade, brand, variety). A variety sold in several packs ("Jasponica White (1kg)",
    "(2kg)", "(5kg)") is ONE catalog product with several pack prices — stored in the new
    brand_pack_price table (pack_kg, pack_price, per_kg). A row with no "(Nkg)" is priced per kilo.
  * Grade = the survey's own Segment + Classification (Special Rice / Premium / Well Milled /
    Regular). The survey is the field authority; this script does not re-classify.
  * Price = the Day 30 (Sep 4, 2026) figure — the 30th and last day of a 30-day daily canvass
    (Aug 6 – Sep 4). sample_n records the number of daily readings in the sheet (30).
  * Variance weight (the brand's usual premium vs its grade) = median per-kg price across its packs
    vs the grade's current base price — same formula as seed_brand_weights.py.
  * Rows priced 0 (the "Unknown" imported regular-milled placeholder) are skipped: the survey marks
    that grade as not sold under a brand in the Philippines.
  * Existing catalog rows are updated in place when (grade, brand, variety) match, new ones are
    added, and anything not in this survey is soft-deactivated (kept for audit, never deleted).
    Uploaded brand images and source-verified variety names carry over (incl. renamed brands).
  * The database is backed up first. Every change is written to brand_audit / brand_weight_audit.

Run:  cd datasets/scripts && py -3.13 import_brand_survey.py "D:/Downloads/NEW_UPDATED_Rice_Brand_Final_Survey.xlsx" [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402  (datasets/scripts/paths.py: every datasets/ location)
import re
import shutil
import statistics
import sys
from datetime import datetime

import openpyxl

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # datasets/scripts/ -> root
sys.path.insert(0, os.path.join(PROJECT_ROOT, "api"))
import catalog_service as cs  # noqa: E402

ACTOR = "import_brand_survey.py"
SURVEY_DATE = "2026-09-04"          # Day 30
# Shown as "Source" in the catalog popup: the local-market canvass, verified by the local
# government (barangay). Verification in progress the week of Sep 26, 2026, per the project team.
SOURCE = "Verified by Local Government"

CLASS_TO_GRADE = {"special rice": "Special", "special": "Special", "premium": "Premium",
                  "well milled": "WellMilled", "well-milled": "WellMilled", "regular": "Regular"}

# Corrections to rows whose own figures contradict each other. Each is logged in the run report.
# Keyed (brand, package), lower-case: (price to use, reason). Empty for the revised survey — the
# Henri & Isabelle Black Rice (2kg) mix-up (₱219 vs ₱97.25) was fixed at source (₱219 all 30 days).
PRICE_CORRECTIONS: dict[tuple[str, str], tuple[float, str]] = {}

# Old brand name -> new brand name, for carrying uploaded images across the survey's renames.
IMAGE_ALIASES = {"1230": "1230", "1260": "1260 berry", "angelika": "angelica", "boy kanin": "boy kanin",
                 "buko pandan": "buko pandan"}

# Source-verified variety names from earlier research, applied only when the survey's own variety
# text is a grade word or pack spec (no rice name to show). Keys: lower-case brand base name.
VERIFIED_VARIETY = {
    "lion ivory": ("Sinandomeng", "https://www.landers.ph/food-cupboard/lion-ivory-grains-classic-sinandomeng-special-rice-25kg-112967-26660"),
    "ganador": ("Long Grain Rice", "https://www.landers.ph/food-cupboard/ganador-oliver-well-milled-rice-5kg-112962-22640"),
    "binhi alsa": ("Long Grain Soft Rice", "https://shopee.ph/25kg-Binhi-Rice-Soft-and-Long-Grain-i.192655827.56861559825"),
    "master chef super alsa": ("Thai Rice (5% broken)", "recorded pack spec: Whole Grain Rice 5% Thai"),
    "planters": ("Thai Rice (5% broken)", "recorded pack spec: Thai 5% broken"),
    "royal peregrine": ("Thai Rice (5% broken)", "recorded pack spec: Thai 5%"),
    "royal sheep": ("Thai Rice (5% broken)", "recorded pack spec: Thai 5% broken"),
}
# Same rule the public site uses (public-varieties.js) to decide a text is not a rice name.
NOT_A_VARIETY = re.compile(r"%|\bbroken\b|\b(regular[- ]?milled|well[- ]?milled|premium|special)\b|^unknown$|^[a-z]{1,4}-?\d+$|whole grain|(long|fine) grain", re.I)
PACK_RE = re.compile(r"\(\s*(\d+(?:\.\d+)?)\s*kg\s*\)", re.I)


def base_name(brand: str) -> str:
    return brand.split("/")[0].strip().lower()


def read_rows(path: str) -> list[dict]:
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    hdr_i = next(i for i, r in enumerate(rows) if r and str(r[0] or "").strip() == "Segment")
    hdr = [str(c or "") for c in rows[hdr_i]]
    day_cols = [i for i, h in enumerate(hdr) if h.startswith("Day ")]
    out = []
    for r in rows[hdr_i + 1:]:
        if not r or not str(r[0] or "").strip():
            continue
        seg, cls, brand, pkg, origin = (str(r[i] or "").strip() for i in range(5))
        days = [r[i] for i in day_cols if isinstance(r[i], (int, float))]
        out.append({"segment": seg, "cls": cls, "brand": re.sub(r"\s+", " ", brand),
                    "package": re.sub(r"\s+", " ", pkg), "origin": origin,
                    "day1": days[0] if days else None, "day30": days[-1] if days else None, "ndays": len(days),
                    "distinct": sorted(set(round(float(d), 2) for d in days))})
    return out


def build_products(rows: list[dict], report: list[str]) -> dict:
    products: dict[tuple, dict] = {}
    for r in rows:
        grade = CLASS_TO_GRADE.get(r["cls"].lower())
        key_prefix = "imp" if r["segment"].lower().startswith("imp") else "loc"
        if not grade:
            report.append(f"SKIP unknown classification {r['cls']!r}: {r['brand']} / {r['package']}")
            continue
        price = r["day30"]
        corr = PRICE_CORRECTIONS.get((r["brand"].lower(), r["package"].lower()))
        if corr:
            price = corr[0]
            report.append(f"CORRECTED {r['brand']} {r['package']}: {corr[1]}")
        elif len(r["distinct"]) > 1:
            report.append(f"NOTE {r['brand']} {r['package']}: prices change within the 30 days {r['distinct']} - Day 30 used")
        if not price or price <= 0:
            report.append(f"SKIP no price (placeholder): {r['segment']} {r['cls']} {r['brand']} / {r['package']}")
            continue
        m = PACK_RE.search(r["package"])
        pack_kg = float(m.group(1)) if m else None
        variety = PACK_RE.sub("", r["package"]).strip() or r["package"]
        per_kg = round(price / pack_kg, 2) if pack_kg else round(float(price), 2)
        key = (key_prefix + grade, r["brand"], variety)
        p = products.setdefault(key, {"cat": key_prefix + grade, "brand": r["brand"], "variety": variety,
                                      "origin": r["origin"], "cls": r["cls"], "packs": [], "days": r["ndays"] or 1})
        p["packs"].append({"pack_kg": pack_kg, "price": round(float(price), 2), "per_kg": per_kg})

    # sanity: a bigger pack costing MORE per kilo than a smaller one is unusual — report it
    for p in products.values():
        sized = sorted([x for x in p["packs"] if x["pack_kg"]], key=lambda x: x["pack_kg"])
        for a, b in zip(sized, sized[1:]):
            if b["per_kg"] > a["per_kg"] * 1.05:
                report.append(f"CHECK {p['brand']} {p['variety']}: {b['pack_kg']:g}kg is ₱{b['per_kg']:.2f}/kg vs "
                              f"{a['pack_kg']:g}kg ₱{a['per_kg']:.2f}/kg (larger pack dearer per kilo)")
    return products


def ensure_pack_table(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS brand_pack_price (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        brand_id    INTEGER NOT NULL REFERENCES rice_brand(id),
        pack_kg     REAL,                 -- NULL = sold per kilo (loose / palengke)
        pack_price  REAL NOT NULL,        -- price of the whole pack as surveyed
        per_kg      REAL NOT NULL,        -- pack_price / pack_kg
        sample_date TEXT,
        source      TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_brand_pack_brand ON brand_pack_price(brand_id)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    report: list[str] = []
    products = build_products(read_rows(args.xlsx), report)

    conn = cs._connect()
    try:
        cs._ensure_brand_image(conn)
        cats = {r["canonical_key"]: r["id"] for r in conn.execute("SELECT id, canonical_key FROM dti_category")}
        old_images = {}
        for r in conn.execute("SELECT brand_name, image_path FROM rice_brand WHERE image_path IS NOT NULL ORDER BY active DESC, id DESC"):
            old_images.setdefault(r["brand_name"].strip().lower(), r["image_path"])

        print(f"{len(products)} products from the survey ({sum(len(p['packs']) for p in products.values())} pack prices).")
        if args.dry_run:
            for p in sorted(products.values(), key=lambda x: (x["cat"], x["brand"])):
                packs = ", ".join((f"{x['pack_kg']:g}kg ₱{x['price']:,.2f}" if x["pack_kg"] else f"per kg ₱{x['price']:.2f}") for x in p["packs"])
                print(f"  {p['cat']:13} {p['brand'][:28]:28} {p['variety'][:34]:34} {packs}")
            print("\n".join(report))
            return 0

        backup = paths.backup_path("pre-survey")
        shutil.copy2(cs._db_path(), backup)
        print(f"Backup: {os.path.basename(backup)}")
        ensure_pack_table(conn)

        touched, added, updated = set(), 0, 0
        for p in products.values():
            cat_id = cats[p["cat"]]
            per = [x["per_kg"] for x in p["packs"]]
            lo, hi = min(per), max(per)
            notes = f"Source price: ₱{lo:.2f}/kg" if abs(hi - lo) < 0.005 else f"Source price: ₱{lo:.2f}–{hi:.2f}/kg"
            cls_note = f"Classified as {p['cls'].strip()} under the DA rice classification."
            base = base_name(p["brand"])
            var_names = var_src = None
            if NOT_A_VARIETY.search(p["variety"]) and base in VERIFIED_VARIETY:
                var_names, var_src = VERIFIED_VARIETY[base]

            row = conn.execute("SELECT id, image_path FROM rice_brand WHERE category_id=? AND brand_name=? AND package=?",
                               (cat_id, p["brand"], p["variety"])).fetchone()
            if row:
                bid = row["id"]
                conn.execute("""UPDATE rice_brand SET location=?, source=?, source_url=NULL, last_verified=?,
                                classification_note=?, notes=?, verification_status='field_verified',
                                active=1, variety_names=?, variety_source=? WHERE id=?""",
                             (p["origin"], SOURCE, SURVEY_DATE, cls_note, notes, var_names, var_src, bid))
                action, updated = "update", updated + 1
                image = row["image_path"]
            else:
                cur = conn.execute("""INSERT INTO rice_brand(category_id, brand_name, package, location, source,
                                      last_verified, classification_note, notes, verification_status, verified_by,
                                      verified_at, active, variety_names, variety_source)
                                      VALUES (?,?,?,?,?,?,?,?,'field_verified',?,datetime('now'),1,?,?)""",
                                   (cat_id, p["brand"], p["variety"], p["origin"], SOURCE, SURVEY_DATE,
                                    cls_note, notes, ACTOR, var_names, var_src))
                bid, action, added, image = cur.lastrowid, "add", added + 1, None
            if not image:
                alias = IMAGE_ALIASES.get(base, base)
                if alias in old_images:
                    conn.execute("UPDATE rice_brand SET image_path=? WHERE id=?", (old_images[alias], bid))
            touched.add(bid)

            conn.execute("DELETE FROM brand_pack_price WHERE brand_id=?", (bid,))
            conn.executemany("INSERT INTO brand_pack_price(brand_id, pack_kg, pack_price, per_kg, sample_date, source) VALUES (?,?,?,?,?,?)",
                             [(bid, x["pack_kg"], x["price"], x["per_kg"], SURVEY_DATE, SOURCE) for x in p["packs"]])
            conn.execute("INSERT INTO brand_audit(brand_id, action, actor, detail) VALUES (?,?,?,?)",
                         (bid, action, ACTOR, f"{p['brand']} / {p['variety']} -> {p['cat']}; {len(p['packs'])} pack price(s) from {SOURCE}."))
            p["id"], p["median"] = bid, statistics.median(per)

        stale = [r["id"] for r in conn.execute("SELECT id FROM rice_brand WHERE active=1") if r["id"] not in touched]
        for bid in stale:
            conn.execute("UPDATE rice_brand SET active=0 WHERE id=?", (bid,))
            conn.execute("INSERT INTO brand_audit(brand_id, action, actor, detail) VALUES (?, 'deactivate', ?, ?)",
                         (bid, ACTOR, "Not in the updated local market survey."))
        conn.commit()

        # weights go through catalog_service so the sanity band and weight audit still apply
        rejected = []
        for p in products.values():
            base_price, _ = cs._latest_base_price(conn, p["cat"])
            if not base_price:
                continue
            w = round((p["median"] - base_price) / base_price * 100.0, 2)
            res = cs.set_brand_weight(p["id"], w, sample_date=SURVEY_DATE, sample_locations=p["origin"], sample_n=p["days"],
                                      source_notes="Median per-kg price across this product's packs on day 30 (Sep 4, 2026) of a "
                                                   "30-day daily canvass (Aug 6 - Sep 4), vs the grade's base price.", actor=ACTOR)
            if not res.get("ok"):
                rejected.append(f"{p['brand']} {p['variety']}: {res.get('error')}")
        print(f"Added {added}, updated {updated}, deactivated {len(stale)} (not in the survey).")
        for line in report + [f"WEIGHT REJECTED {x}" for x in rejected]:
            print(" ", line)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
