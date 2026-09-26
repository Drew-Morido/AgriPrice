import io
import re
from typing import Dict, List, Optional, Union

import pdfplumber

TARGET_ORDER = [
    "Local Special",
    "Local Premium",
    "Local Well Milled",
    "Local Regular Milled",
    "Imported Special",
    "Imported Premium",
    "Imported Well Milled",
    "Imported Regular Milled",
]

_SECTION_END_MARKERS = (
    "CORN PRODUCTS",
    "FISH PRODUCTS",
    "LIVESTOCK",
    "POULTRY",
    "VEGETABLES",
    "FRUITS",
    "SPICES",
)


def _clean_line(line: str) -> str:
    return re.sub(r"\s+", " ", (line or "").strip())


def _extract_price(line: str) -> Optional[float]:
    """Return the last plausible rice price on the line (usually after the label)."""
    matches = re.findall(r"(\d{2,3}\.\d{1,2})", line)
    if not matches:
        return None

    for token in reversed(matches):
        try:
            value = float(token)
            if 30 <= value <= 80:
                return value
        except ValueError:
            continue
    return None


def _label_for_line(section: Optional[str], upper_line: str) -> Optional[str]:
    if section not in {"LOCAL", "IMPORTED"}:
        return None

    prefix = "Local" if section == "LOCAL" else "Imported"
    if re.search(r"OTHER\s+SPECIAL\s+RICE", upper_line):
        return f"{prefix} Special"
    if re.search(r"\bPREMIUM\b", upper_line):
        return f"{prefix} Premium"
    if "WELL MILLED" in upper_line:
        return f"{prefix} Well Milled"
    if "REGULAR MILLED" in upper_line:
        return f"{prefix} Regular Milled"
    return None


_PRICE_TOKEN = re.compile(r"^\d{1,3}(?:,\d{3})*\.\d{1,2}$")
_MISSING_TOKEN = re.compile(r"^(?:n/?a|-+|—|–)$", re.IGNORECASE)
_ROW_TOL = 2.0        # label words within 2pt vertically belong to the same row
_MATCH_TOL = 9.0      # a price belongs to a row only if its centre is within 9pt (rows are ~21pt apart)
_CORE_MIN, _CORE_MAX = 20.0, 150.0


def _parse_rice_by_position(page, results: Dict[str, Optional[float]]) -> bool:
    """
    Read the rice blocks by WHERE each price sits, not by the order the text comes out in.

    The price column is drawn a few points above or below its label row, so pdfplumber's text
    order is unstable: some bulletins come out inline ("Premium 5% broken 53.46"), some put each
    price on the line BEFORE its label (Sep 20/22/24 2026), others on the line after. The old
    reader guessed from that order and then overwrote everything with "the last four prices in the
    section are Special → Regular". When one grade was printed as "n/a" (Imported Regular on
    Sep 19, 20 and 22 2026) that slid every imported grade down one row — the Premium column got
    the Special price, and so on. Here every price is paired with the label row whose vertical
    centre is closest, and "n/a" is kept as a missing value rather than dropped, so nothing can
    shift. Rows for grades this system does not track (Basmati, Glutinous, Japonica) still claim
    their own prices, so those can never be taken by a neighbouring grade.

    Returns False when the page has no rice section (the caller then tries the next page).
    """
    words = page.extract_words() or []
    values, labels = [], []
    for w in words:
        text = w["text"].strip()
        if _PRICE_TOKEN.match(text) or _MISSING_TOKEN.match(text):
            values.append(w)
        else:
            labels.append(w)

    rows: List[dict] = []
    for w in sorted(labels, key=lambda w: (w["top"], w["x0"])):
        if rows and abs(rows[-1]["top"] - w["top"]) <= _ROW_TOL:
            row = rows[-1]
            row["words"].append(w)
            row["bottom"] = max(row["bottom"], w["bottom"])
        else:
            rows.append({"top": w["top"], "bottom": w["bottom"], "words": [w]})

    section: Optional[str] = None
    section_rows: List[dict] = []
    for row in rows:
        upper = _clean_line(" ".join(w["text"] for w in sorted(row["words"], key=lambda w: w["x0"]))).upper()
        if "IMPORTED COMMERCIAL RICE" in upper:
            section = "IMPORTED"
            continue
        if "LOCAL COMMERCIAL RICE" in upper:
            section = "LOCAL"
            continue
        if section and any(marker in upper for marker in _SECTION_END_MARKERS):
            section = None
            continue
        if section:
            section_rows.append({
                "label": _label_for_line(section, upper),
                "centre": (row["top"] + row["bottom"]) / 2,
                "right": max(w["x1"] for w in row["words"]),
                "top": row["top"],
                "bottom": row["bottom"],
            })
    if not section_rows:
        return False

    first, last = section_rows[0]["top"] - _MATCH_TOL, section_rows[-1]["bottom"] + _MATCH_TOL
    claimed: Dict[int, tuple] = {}
    for v in values:
        centre = (v["top"] + v["bottom"]) / 2
        if not (first <= centre <= last):
            continue
        idx = min(range(len(section_rows)), key=lambda i: abs(section_rows[i]["centre"] - centre))
        row = section_rows[idx]
        dist = abs(row["centre"] - centre)
        if dist > _MATCH_TOL or v["x0"] < row["right"]:
            continue                                   # not in this row's price column
        if idx in claimed and claimed[idx][0] <= dist:
            continue                                   # a closer value already belongs to this row
        claimed[idx] = (dist, v["text"].strip())

    for idx, (_, text) in claimed.items():
        label = section_rows[idx]["label"]
        if not label or results.get(label) is not None:
            continue
        if _MISSING_TOKEN.match(text):
            continue                                   # DA printed n/a: leave the grade empty
        value = float(text.replace(",", ""))
        if _CORE_MIN <= value <= _CORE_MAX:
            results[label] = value
    return True


def _parse_rice_section_lines(text: str, results: Dict[str, Optional[float]]) -> None:
    """
    Text-only fallback for a page with no usable word positions.

    Only a price printed on the SAME line as its grade label is accepted. A price on a line of its
    own cannot be tied to a grade from text order alone (it may belong to the row above or below),
    so it is skipped — a missing grade is safer than the wrong grade's price.
    """
    section: Optional[str] = None
    for raw in text.splitlines():
        line = _clean_line(raw)
        if not line:
            continue
        upper_line = line.upper()
        if "IMPORTED COMMERCIAL RICE" in upper_line:
            section = "IMPORTED"
            continue
        if "LOCAL COMMERCIAL RICE" in upper_line:
            section = "LOCAL"
            continue
        if section and any(marker in upper_line for marker in _SECTION_END_MARKERS):
            section = None
            continue
        label = _label_for_line(section, upper_line)
        if label and results.get(label) is None:
            price = _extract_price(line)
            if price is not None:
                results[label] = price


def extract_rice_prices_from_pdf_bytes(pdf_bytes: bytes) -> Dict[str, Optional[float]]:
    results: Dict[str, Optional[float]] = {key: None for key in TARGET_ORDER}

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            if not _parse_rice_by_position(page, results):
                _parse_rice_section_lines(page.extract_text() or "", results)
            if all(results.get(key) is not None for key in TARGET_ORDER):
                break

    return results


def extract_rice_prices_from_pdf_file(pdf_path: Union[str, bytes]) -> Dict[str, Optional[float]]:
    if isinstance(pdf_path, bytes):
        return extract_rice_prices_from_pdf_bytes(pdf_path)
    with open(pdf_path, "rb") as f:
        return extract_rice_prices_from_pdf_bytes(f.read())


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Extract rice prices from a DA Daily Price Index PDF.")
    parser.add_argument("pdf_path", help="Path to the PDF file")
    args = parser.parse_args()

    result = extract_rice_prices_from_pdf_file(args.pdf_path)
    print(json.dumps(result, indent=2))
