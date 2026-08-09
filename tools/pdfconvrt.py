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

_SECTION_KEYS = {
    "IMPORTED": [
        "Imported Special",
        "Imported Premium",
        "Imported Well Milled",
        "Imported Regular Milled",
    ],
    "LOCAL": [
        "Local Special",
        "Local Premium",
        "Local Well Milled",
        "Local Regular Milled",
    ],
}

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


def _price_only(line: str) -> Optional[float]:
    """Line that is only a retail rice price (DA PDF split layout)."""
    cleaned = _clean_line(line)
    match = re.match(r"^(\d{2,3}\.\d{1,2})$", cleaned)
    if not match:
        return None
    value = float(match.group(1))
    if 30 <= value <= 80:
        return value
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


def _assign_section_prices(section: str, prices: List[float], results: Dict[str, Optional[float]]) -> None:
    """Map the last four rice prices in a section to Special → Regular."""
    if len(prices) < 4:
        return
    for key, value in zip(_SECTION_KEYS[section], prices[-4:]):
        results[key] = value


def _parse_rice_section_lines(text: str, results: Dict[str, Optional[float]]) -> None:
    """
    Parse DA Daily Price Index rice blocks.

    Supports:
    - Inline prices (May 22 style):  "Premium 5% broken 55.24"
    - Split layout (May 23 style):   "Premium 5% broken" then "55.24" on next line
    - Extra specialty rows (Basmati/Glutinous): ignored; last 4 prices in section win
    """
    section: Optional[str] = None
    section_prices: List[float] = []
    lines = [_clean_line(raw) for raw in text.splitlines()]
    lines = [line for line in lines if line]

    idx = 0
    while idx < len(lines):
        line = lines[idx]
        upper_line = line.upper()

        if "IMPORTED COMMERCIAL RICE" in upper_line:
            if section and section_prices:
                _assign_section_prices(section, section_prices, results)
            section = "IMPORTED"
            section_prices = []
            idx += 1
            continue

        if "LOCAL COMMERCIAL RICE" in upper_line:
            if section and section_prices:
                _assign_section_prices(section, section_prices, results)
            section = "LOCAL"
            section_prices = []
            idx += 1
            continue

        if section and any(marker in upper_line for marker in _SECTION_END_MARKERS):
            _assign_section_prices(section, section_prices, results)
            section = None
            section_prices = []
            idx += 1
            continue

        if not section:
            idx += 1
            continue

        label = _label_for_line(section, upper_line)
        price = _extract_price(line)

        if label:
            if price is None and idx + 1 < len(lines):
                next_price = _price_only(lines[idx + 1])
                if next_price is not None:
                    price = next_price
                    idx += 1
            if price is not None:
                results[label] = price
                section_prices.append(price)
        elif price is not None:
            # Standalone price line (split PDF layout), e.g. "60.20" after Jasponica row
            section_prices.append(price)
        else:
            standalone = _price_only(line)
            if standalone is not None:
                section_prices.append(standalone)

        idx += 1

    if section and section_prices:
        _assign_section_prices(section, section_prices, results)


def extract_rice_prices_from_pdf_bytes(pdf_bytes: bytes) -> Dict[str, Optional[float]]:
    results: Dict[str, Optional[float]] = {key: None for key in TARGET_ORDER}

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            _parse_rice_section_lines(text, results)
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
