"""
AgriPricePH — sanity guard for scraped DA rice prices.

Why: on Sep 19, 20 and 22 2026 the old PDF reader saved three imported grades one column off (the
Premium column held the Special price, ...), and nothing noticed until the numbers reached the
charts and the training data. The reader is fixed (tools/pdfconvrt.py reads by position), but a
scraper should not trust itself blindly. Before a scraped row is saved, each price is checked; a
suspicious one is HELD — saved as empty and queued for a person to approve or reject in
Admin → Web Scraper — instead of flowing straight into the forecasts. Nothing is thrown away: the
raw value stays in the queue.

A price is held when:
  - it equals the price of the grade next to it in the same section (a copied / shifted cell), or
  - it is more than GUARD_PCT away from the median of that grade's last 7 official readings.
    Real day-to-day moves stay well under this; the Sep 19-22 shift was 7-12%. A genuine jump can
    still be held for one day — approving it takes one click.

Queue file: tools/scrape_review.json (list of entries; status pending | approved | rejected).
"""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime
from threading import Lock
from typing import Dict, List, Optional, Tuple

import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REVIEW_PATH = os.path.join(BASE_DIR, "scrape_review.json")
GUARD_PCT = float(os.environ.get("AGRIPRICE_SCRAPE_GUARD_PCT", "6.0"))
HISTORY_N = 7

# Grades in bulletin order; neighbours are checked for copied values.
_SECTIONS = [
    ["Imported Special", "Imported Premium", "Imported Well Milled", "Imported Regular Milled"],
    ["Local Special", "Local Premium", "Local Well Milled", "Local Regular Milled"],
]
_LOCK = Lock()


def _load() -> List[dict]:
    try:
        with open(REVIEW_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save(entries: List[dict]) -> None:
    tmp = REVIEW_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entries, f, indent=2)
    os.replace(tmp, REVIEW_PATH)


def _recent_official(history: pd.DataFrame, col: str, before: pd.Timestamp) -> List[float]:
    if history is None or history.empty or col not in history.columns:
        return []
    h = history[history["_date"] < before]
    vals = pd.to_numeric(h[col], errors="coerce").dropna()
    return [float(v) for v in vals.tail(HISTORY_N)]


def check_rice_row(date_str: str, prices: Dict[str, Optional[float]],
                   history: Optional[pd.DataFrame]) -> Tuple[Dict[str, Optional[float]], List[dict]]:
    """Return (prices with held cells set to None, list of held entries). Pure — writes nothing."""
    day = pd.to_datetime(date_str, format="%m/%d/%Y", errors="coerce")
    cleaned = dict(prices)
    held: List[dict] = []
    # A bulletin with an "n/a" grade never counts as complete, so the scraper re-syncs it every
    # cycle; a reading an admin already approved must not be held (and blanked) again.
    approved = {(e["date"], e["column"], e["value"]) for e in _load() if e.get("status") == "approved"}
    for section in _SECTIONS:
        for i, col in enumerate(section):
            v = prices.get(col)
            if v is None:
                continue
            reason = None
            for j in (i - 1, i + 1):
                if 0 <= j < len(section):
                    other = prices.get(section[j])
                    if other is not None and abs(float(other) - float(v)) < 0.005:
                        reason = f"same price as {section[j]} ({float(other):.2f}) — possible copied/shifted cell"
                        break
            recent = _recent_official(history, col, day) if pd.notna(day) else []
            med = float(pd.Series(recent).median()) if len(recent) >= 3 else None
            if reason is None and med:
                pct = abs(float(v) - med) / med * 100
                if pct > GUARD_PCT:
                    reason = f"{pct:.1f}% away from the median of the last {len(recent)} readings (₱{med:.2f})"
            if reason and (date_str, col, round(float(v), 2)) in approved:
                reason = None
            if reason:
                cleaned[col] = None
                held.append({
                    "date": date_str, "column": col, "value": round(float(v), 2),
                    "reason": reason, "recent_median": round(med, 2) if med else None,
                })
    return cleaned, held


def queue(held: List[dict], source: str = "da_official") -> int:
    """Add held readings to the review queue (deduplicated). Returns how many were new."""
    if not held:
        return 0
    with _LOCK:
        entries = _load()
        seen = {(e["date"], e["column"], e["value"]) for e in entries}
        new = 0
        for h in held:
            key = (h["date"], h["column"], h["value"])
            if key in seen:
                continue
            entries.append({**h, "source": source, "status": "pending",
                            "detected_at": datetime.now().isoformat(timespec="seconds")})
            seen.add(key)
            new += 1
        _save(entries)
    return new


def pending() -> List[dict]:
    return [e for e in _load() if e.get("status") == "pending"]


def resolve(date_str: str, column: str, action: str, db_path: str,
            csv_path: Optional[str] = None, actor: str = "admin") -> dict:
    """Approve (write the held value into WS_rice_price and the scraper CSV) or reject a reading."""
    if action not in ("approve", "reject"):
        raise ValueError("action must be 'approve' or 'reject'")
    with _LOCK:
        entries = _load()
        hit = next((e for e in entries if e["date"] == date_str and e["column"] == column
                    and e.get("status") == "pending"), None)
        if hit is None:
            raise KeyError("no pending reading for that date and column")
        if action == "approve":
            con = sqlite3.connect(db_path)
            try:
                con.execute(f'UPDATE "WS_rice_price" SET "{column}" = ? WHERE Date = ?',
                            (hit["value"], date_str))
                con.commit()
            finally:
                con.close()
            if csv_path and os.path.exists(csv_path):
                df = pd.read_csv(csv_path)
                if column in df.columns:
                    df.loc[df["Date"] == date_str, column] = hit["value"]
                    df.to_csv(csv_path, index=False)
        hit["status"] = "approved" if action == "approve" else "rejected"
        hit["resolved_at"] = datetime.now().isoformat(timespec="seconds")
        hit["resolved_by"] = actor
        _save(entries)
    return hit
