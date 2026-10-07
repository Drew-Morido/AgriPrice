"""
AgriPricePH — file every catalog product under the grade its VARIETY belongs to.

The catalog was originally filed by survey price band, so the same variety could sit in different
grades (Sinandomeng in both Premium and Special; Dinorado, Jasmine, Brown/Red/Black rice in both
Premium and Special). The DA defines the grades by what the rice is, not by its shelf price:

  Special rice  = "glutinous, aromatic, pigmented japonica, micronutrient-dense rice" — e.g. organic
                  brown rice, red and black rice, Dinorado, Milagrosa, Malagkit (DA price monitoring /
                  SRP notice, https://www.da.gov.ph/suggested-retail-price-for-rice-starts-today/).
  Premium       = well-milled rice with a maximum of 5% broken kernels (PNS/BAFS 290).

So, within the SAME segment (Local stays Local, Imported stays Imported):
  * aromatic / pigmented / glutinous varieties  -> Special
  * Sinandomeng, Angelica (ordinary non-special varieties) -> Premium
  * anything whose variety is unknown or unclassifiable ("Regular Milled", "Long Grain", codes,
    "100% broken") is LEFT WHERE IT IS — this script never guesses.

Moved products get their variance weight recomputed against the new category's base price (same
formula and 2026-09-04 survey point as seed_brand_weights.py). A brand-website duplicate of a product
that already has a priced grocery row in the same grade is soft-deactivated, not deleted.
Every change is audited (brand_audit / brand_weight_audit). DB is backed up first. Idempotent.

Run:  py -3.13 datasets/reclassify_by_variety.py [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402  (datasets/scripts/paths.py: every datasets/ location)
import re
import shutil
import sys
from datetime import datetime

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # datasets/scripts/ -> root
sys.path.insert(0, os.path.join(PROJECT_ROOT, "api"))
import catalog_service as cs  # noqa: E402

ACTOR = "reclassify_by_variety.py"

SPECIAL = re.compile(
    r"dinorado|malagkit|jasmine|hom mali|\bred rice\b|\bblack rice\b|\bbrown rice\b|"
    r"jasponica|miponica|scented|aromatic", re.I)
PREMIUM_VARIETY = re.compile(r"sinandomeng|angelica", re.I)


def target_grade(text: str) -> str | None:
    """'Special' / 'Premium' when the variety text is clearly one, else None (leave in place)."""
    if not text:
        return None
    if SPECIAL.search(text):
        return "Special"
    if PREMIUM_VARIETY.search(text):
        return "Premium"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = cs._connect()
    try:
        cs._ensure_brand_image(conn)
        rows = [dict(r) for r in conn.execute(
            "SELECT b.id,b.brand_name,b.package,b.variety_names,b.notes,c.canonical_key,c.segment "
            "FROM rice_brand b JOIN dti_category c ON c.id=b.category_id WHERE b.active=1 ORDER BY b.id")]

        moves, dups = [], []
        for r in rows:
            text = r["variety_names"] or r["package"] or ""
            grade = target_grade(text)
            if not grade:
                continue
            prefix = "imp" if r["segment"] == "Imported" else "loc"
            new_key = prefix + grade
            if new_key != r["canonical_key"]:
                moves.append((r, new_key))

        # a priced grocery row for the same brand+variety already in the target grade -> the
        # unpriced brand-website row is a duplicate card
        by_brand = {(r["brand_name"], r["canonical_key"]): r for r in rows}
        for r, new_key in list(moves):
            same = [x for x in rows if x["brand_name"] == r["brand_name"] and x["id"] != r["id"]
                    and x["canonical_key"] == new_key
                    and re.sub(r"[^a-z]", "", (x["package"] or "").lower()) in
                    re.sub(r"[^a-z]", "", (r["package"] or "").lower())
                    and x["package"] and len(x["package"]) > 3]
            if same and not cs._surveyed_price(r["notes"])[0]:
                dups.append(r)
                moves.remove((r, new_key))

        for r, new_key in moves:
            print(f"  move  {r['brand_name']:18} {(r['variety_names'] or r['package'])[:32]:32} "
                  f"{r['canonical_key']:12} -> {new_key}")
        for r in dups:
            print(f"  dedupe {r['brand_name']:17} {r['package'][:32]:32} (duplicate of a priced row)")
        if args.dry_run or not (moves or dups):
            print(f"{'Would move' if args.dry_run else 'Moved'} {len(moves)}; dedupe {len(dups)}.")
            return 0

        backup = paths.backup_path("pre-reclass")
        shutil.copy2(cs._db_path(), backup)
        print(f"Backup: {os.path.basename(backup)}")

        for r, new_key in moves:
            res = cs.update_brand(r["id"], category_key=new_key, actor=ACTOR)
            if not res.get("ok"):
                print(f"    ! {r['brand_name']}: {res.get('error')}")
                continue
            price_lo, _hi = cs._surveyed_price(r["notes"])
            old_w = conn.execute(
                "SELECT sample_date,sample_locations FROM brand_price_adjustment WHERE brand_id=?",
                (r["id"],)).fetchone()
            if price_lo and old_w:
                base, _ = cs._latest_base_price(conn, new_key)
                if base:
                    w = round((price_lo - base) / base * 100.0, 2)
                    out = cs.set_brand_weight(
                        r["id"], w, sample_date=old_w["sample_date"], sample_locations=old_w["sample_locations"],
                        sample_n=1, actor=ACTOR,
                        source_notes=f"Weight recomputed after re-filing under {new_key} by variety "
                                     "(same surveyed shelf price, new category base).")
                    if not out.get("ok"):
                        print(f"    ! weight for {r['brand_name']} rejected: {out.get('error')}")
        for r in dups:
            cs.deactivate_brand(r["id"], active=False, actor=ACTOR)
        print(f"Moved {len(moves)}; deduplicated {len(dups)}.")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
