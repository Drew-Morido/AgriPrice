"""
AgriPricePH — price alert rules, evaluation, and notification log.

Checks run automatically after every scrape and every forecast refresh (api/app.py::_run_alert_check), and on
demand from Admin → Price Alerts. A rule fires at most once per DA bulletin day for each rice type, so a price
that stays above a threshold for a week gives one notice per new bulletin, not one every scrape.

Default rules (DA-AMAS feedback B2/B3): every rice type gets a "price above" and a "price below" rule, set
5% above and below its DA price on the day the defaults were created, plus "moved ₱1.00 or more since the
previous bulletin" and "tomorrow's forecast moves ₱1.00 or more" for all types. They are ordinary rules:
editable, can be switched off or deleted (a deleted default is not re-created), and more can be added.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta
from typing import Any
from uuid import uuid4

_CTX_CACHE: dict | None = None
_CTX_CACHE_AT: float = 0.0
_CTX_TTL_SEC = 120

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
RULES_PATH = os.path.join(MODEL_DIR, "alerts_rules.json")
LOG_PATH = os.path.join(MODEL_DIR, "alerts_log.json")
STATE_PATH = os.path.join(MODEL_DIR, "alerts_state.json")   # which default rules were already created
DEFAULT_BAND_PCT = 5.0          # default "above" / "below" thresholds: ±5% of the DA price when created
DEFAULT_MOVE_PESO = 1.0         # default day-to-day and forecast move, ₱/kg
MAX_LOG_ENTRIES = 200
DEBOUNCE_HOURS = 6

RICE_LABELS = {
    "locWellMilled": "Local Well-Milled",
    "locRegular": "Local Regular",
    "locPremium": "Local Premium",
    "locSpecial": "Local Special",
    "impWellMilled": "Imported Well-Milled",
    "impRegular": "Imported Regular",
    "impPremium": "Imported Premium",
    "impSpecial": "Imported Special",
    "all": "All Rice Types",
}

ALL_RICE_KEYS = [
    "locWellMilled",
    "locRegular",
    "locPremium",
    "locSpecial",
    "impWellMilled",
    "impRegular",
    "impPremium",
    "impSpecial",
]

CONDITION_LABELS = {
    "above": "Price above",
    "below": "Price below",
    "change_up": "3-day change >",
    "change_down": "3-day drop >",
    "confidence_below": "Forecast confidence <",
    "day_change": "Moved since the previous bulletin by at least",
    "forecast_move": "Tomorrow's forecast moves by at least",
}

DEFAULT_RULES = [
    {
        "id": "rule-wm-above",
        "name": "Well Milled Above Threshold",
        "rice_key": "locWellMilled",
        "condition": "above",
        "threshold": 55.0,
        "type": "danger",
        "active": True,
        "triggered_count": 0,
        "last_triggered": None,
        "created_at": "2026-01-01T00:00:00",
    },
    {
        "id": "rule-rm-below",
        "name": "Regular Milled Drop Alert",
        "rice_key": "locRegular",
        "condition": "below",
        "threshold": 44.0,
        "type": "info",
        "active": True,
        "triggered_count": 0,
        "last_triggered": None,
        "created_at": "2026-01-01T00:00:00",
    },
    {
        "id": "rule-spike",
        "name": "Large 3-Day Price Spike",
        "rice_key": "all",
        "condition": "change_up",
        "threshold": 5.0,
        "type": "warning",
        "active": True,
        "triggered_count": 0,
        "last_triggered": None,
        "created_at": "2026-01-01T00:00:00",
    },
    {
        "id": "rule-confidence",
        "name": "Low Forecast Confidence",
        "rice_key": "locWellMilled",
        "condition": "confidence_below",
        "threshold": 75.0,
        "type": "info",
        "active": False,
        "triggered_count": 0,
        "last_triggered": None,
        "created_at": "2026-01-01T00:00:00",
    },
]


def _load_json(path: str, default: Any) -> Any:
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return default


def _save_json(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path) or MODEL_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _ensure_defaults() -> None:
    rules = _load_json(RULES_PATH, None)
    if not rules:
        _save_json(RULES_PATH, DEFAULT_RULES.copy())
    log = _load_json(LOG_PATH, None)
    if log is None:
        _save_json(LOG_PATH, [])


def _relative_time(iso_str: str | None) -> str:
    if not iso_str:
        return "—"
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        if dt.tzinfo:
            dt = dt.replace(tzinfo=None)
        secs = int((datetime.now() - dt).total_seconds())
        if secs < 60:
            return "Just now"
        if secs < 3600:
            return f"{secs // 60} min ago"
        if secs < 86400:
            return f"{secs // 3600} hr ago"
        days = secs // 86400
        return f"{days} day{'s' if days != 1 else ''} ago"
    except (ValueError, TypeError):
        return "—"


def _format_threshold(rule: dict) -> str:
    cond = rule.get("condition", "")
    th = rule.get("threshold", 0)
    if cond in ("above", "below"):
        return f"₱{float(th):.2f}"
    if cond in ("change_up", "change_down"):
        return f"{float(th):.1f}%"
    if cond == "confidence_below":
        return f"{float(th):.0f}%"
    if cond in ("day_change", "forecast_move"):
        return f"₱{float(th):.2f}"
    return str(th)


def rule_to_api(rule: dict) -> dict:
    rice_key = rule.get("rice_key", "locWellMilled")
    cond = rule.get("condition", "above")
    return {
        **rule,
        "rice": RICE_LABELS.get(rice_key, rice_key),
        "condition_label": CONDITION_LABELS.get(cond, cond),
        "value": _format_threshold(rule),
        "triggered": int(rule.get("triggered_count") or 0),
        "default": bool(rule.get("default")),
        "origin": origin_of(rice_key),
    }


def list_rules() -> list[dict]:
    _ensure_defaults()
    rules = _load_json(RULES_PATH, [])
    return [rule_to_api(r) for r in rules if isinstance(r, dict)]


def _find_rule(rules: list, rule_id: str) -> dict | None:
    for r in rules:
        if r.get("id") == rule_id:
            return r
    return None


def create_rule(payload: dict) -> dict:
    _ensure_defaults()
    rules = _load_json(RULES_PATH, [])
    rule = {
        "id": f"rule-{uuid4().hex[:10]}",
        "name": (payload.get("name") or "New Alert").strip(),
        "rice_key": payload.get("rice_key") or "locWellMilled",
        "condition": payload.get("condition") or "above",
        "threshold": float(payload.get("threshold", 0)),
        "type": payload.get("type") or "warning",
        "active": bool(payload.get("active", True)),
        "triggered_count": 0,
        "last_triggered": None,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    rules.append(rule)
    _save_json(RULES_PATH, rules)
    return rule_to_api(rule)


def update_rule(rule_id: str, payload: dict) -> dict | None:
    _ensure_defaults()
    rules = _load_json(RULES_PATH, [])
    rule = _find_rule(rules, rule_id)
    if not rule:
        return None
    for key in ("name", "rice_key", "condition", "type", "active"):
        if key in payload:
            rule[key] = payload[key]
    if "threshold" in payload:
        rule["threshold"] = float(payload["threshold"])
    _save_json(RULES_PATH, rules)
    return rule_to_api(rule)


def delete_rule(rule_id: str) -> bool:
    _ensure_defaults()
    rules = _load_json(RULES_PATH, [])
    new_rules = [r for r in rules if r.get("id") != rule_id]
    if len(new_rules) == len(rules):
        return False
    _save_json(RULES_PATH, new_rules)
    return True


def toggle_rule(rule_id: str, active: bool | None = None) -> dict | None:
    _ensure_defaults()
    rules = _load_json(RULES_PATH, [])
    rule = _find_rule(rules, rule_id)
    if not rule:
        return None
    rule["active"] = (not rule.get("active", True)) if active is None else bool(active)
    _save_json(RULES_PATH, rules)
    return rule_to_api(rule)


def origin_of(rice_key: str | None) -> str:
    """'local' / 'imported' for one rice type, 'all' for a rule that covers every type."""
    key = rice_key or ""
    return "imported" if key.startswith("imp") else "local" if key.startswith("loc") else "all"


def _describe_entry(entry: dict, rules_by_id: dict) -> dict:
    """The full summary of one notification, for the bell and the Price Alerts detail view."""
    rule = rules_by_id.get(entry.get("rule_id")) or {}
    cond = entry.get("condition") or rule.get("condition") or ""
    th = entry.get("threshold", rule.get("threshold"))
    return {
        **entry,
        "time": _relative_time(entry.get("created_at")),
        "rice": RICE_LABELS.get(entry.get("rice_key"), entry.get("rice_key") or "—"),
        "origin": origin_of(entry.get("rice_key")),
        "rule_name": rule.get("name") or str(entry.get("title", "")).replace("Price Alert: ", "") or "—",
        "rule_exists": bool(rule),
        "rule_scope": origin_of(rule.get("rice_key")) if rule else None,
        "condition_label": CONDITION_LABELS.get(cond, cond),
        "threshold_text": _format_threshold({"condition": cond, "threshold": th}) if th is not None else "—",
    }


def list_log(limit: int = 50) -> list[dict]:
    _ensure_defaults()
    log = _load_json(LOG_PATH, [])
    if not isinstance(log, list):
        log = []
    rules_by_id = {r.get("id"): r for r in _load_json(RULES_PATH, []) if isinstance(r, dict)}
    out = []
    for entry in reversed(log[-limit:]):
        if not isinstance(entry, dict):
            continue
        out.append(_describe_entry(entry, rules_by_id))
    return out


def clear_log() -> None:
    _save_json(LOG_PATH, [])


def _pct_change(series: list[float], days: int = 3) -> float | None:
    clean = [float(x) for x in series if x and float(x) > 0]
    if len(clean) < days + 1:
        return None
    prev = clean[-(days + 1)]
    curr = clean[-1]
    if prev <= 0:
        return None
    return ((curr - prev) / prev) * 100.0


def _build_context() -> dict:
    global _CTX_CACHE, _CTX_CACHE_AT
    now = time.time()
    if _CTX_CACHE is not None and (now - _CTX_CACHE_AT) < _CTX_TTL_SEC:
        return _CTX_CACHE

    ctx: dict[str, Any] = {
        "current_prices": {},
        "history": {},
        "forecast_confidence_min": None,
        "forecast_day1": {},     # rice key -> tomorrow's forecast price
        "data_date": None,       # the DA bulletin day the current prices come from
        "ready": False,
    }
    try:
        from data_pipeline import load_merged_frame

        df = load_merged_frame()
        for key in ALL_RICE_KEYS:
            if key in df.columns:
                series = df[key].dropna().astype(float).tolist()
                if series:
                    ctx["history"][key] = series
                    ctx["current_prices"][key] = float(series[-1])
    except Exception:
        pass

    try:
        from predict import predict

        pred = predict()
        if pred.get("ready"):
            ctx["ready"] = True
            for k, v in (pred.get("current_prices") or {}).items():
                if v is not None:
                    ctx["current_prices"][k] = float(v)
            ctx["data_date"] = pred.get("last_data_date")
            for k, rows in (pred.get("forecasts_by_key") or {}).items():
                if rows and rows[0].get("price") is not None:
                    ctx["forecast_day1"][k] = float(rows[0]["price"])
            confs = [f.get("confidence") for f in pred.get("forecast") or [] if f.get("confidence") is not None]
            if confs:
                ctx["forecast_confidence_min"] = min(float(c) for c in confs) * 100.0
    except Exception:
        pass

    _CTX_CACHE = ctx
    _CTX_CACHE_AT = now
    return ctx


def invalidate_context_cache() -> None:
    global _CTX_CACHE, _CTX_CACHE_AT
    _CTX_CACHE = None
    _CTX_CACHE_AT = 0.0


def _should_debounce(rule_id: str, rice_key: str, log: list, data_date: str | None = None) -> bool:
    """True when this rule already fired for this rice type: on the same DA bulletin day when the day is
    known (automatic checks run after every scrape), else within DEBOUNCE_HOURS."""
    cutoff = datetime.now() - timedelta(hours=DEBOUNCE_HOURS)
    for entry in reversed(log):
        if entry.get("rule_id") != rule_id:
            continue
        if entry.get("rice_key") != rice_key:
            continue
        if data_date and entry.get("data_date"):
            if entry.get("data_date") == data_date:
                return True
            continue
        try:
            ts = datetime.fromisoformat(str(entry.get("created_at", "")).replace("Z", ""))
            if ts >= cutoff:
                return True
        except (ValueError, TypeError):
            continue
    return False


def _append_log_entry(log: list, entry: dict) -> None:
    log.append(entry)
    if len(log) > MAX_LOG_ENTRIES:
        del log[: len(log) - MAX_LOG_ENTRIES]


def _evaluate_rule(rule: dict, ctx: dict, log: list) -> list[dict]:
    if not rule.get("active"):
        return []

    cond = rule.get("condition", "above")
    threshold = float(rule.get("threshold", 0))
    rice_key = rule.get("rice_key", "locWellMilled")
    keys = ALL_RICE_KEYS if rice_key == "all" else [rice_key]
    triggered_entries = []

    for key in keys:
        label = RICE_LABELS.get(key, key)
        price = ctx["current_prices"].get(key)
        hit = False
        desc = ""

        if cond in ("above", "below"):
            if price is None:
                continue
            if cond == "above" and price > threshold:
                hit = True
                desc = f"{label} rose to ₱{price:.2f} — above ₱{threshold:.2f} threshold."
            elif cond == "below" and price < threshold:
                hit = True
                desc = f"{label} dropped to ₱{price:.2f} — below ₱{threshold:.2f} threshold."

        elif cond in ("change_up", "change_down"):
            series = ctx["history"].get(key, [])
            pct = _pct_change(series, 3)
            if pct is None:
                continue
            if cond == "change_up" and pct > threshold:
                hit = True
                desc = f"{label} 3-day change is +{pct:.2f}% — exceeds +{threshold:.1f}% threshold."
            elif cond == "change_down" and pct < -threshold:
                hit = True
                desc = f"{label} 3-day change is {pct:.2f}% — exceeds -{threshold:.1f}% drop threshold."

        elif cond == "day_change":
            series = ctx["history"].get(key, [])
            clean = [float(x) for x in series if x and float(x) > 0]
            if len(clean) < 2:
                continue
            move = clean[-1] - clean[-2]
            if abs(move) >= threshold:
                hit = True
                desc = (f"{label} {'rose' if move > 0 else 'fell'} ₱{abs(move):.2f} since the previous DA bulletin "
                        f"(now ₱{clean[-1]:.2f}), at least the ₱{threshold:.2f} set for this rule.")

        elif cond == "forecast_move":
            nxt = ctx.get("forecast_day1", {}).get(key)
            if nxt is None or price is None:
                continue
            move = nxt - price
            if abs(move) >= threshold:
                hit = True
                desc = (f"{label}: tomorrow's forecast is ₱{nxt:.2f}, {'up' if move > 0 else 'down'} ₱{abs(move):.2f} "
                        f"from today's ₱{price:.2f} (rule: ₱{threshold:.2f} or more).")

        elif cond == "confidence_below":
            if key != "locWellMilled" and rice_key != "all":
                continue
            conf = ctx.get("forecast_confidence_min")
            if conf is None:
                continue
            if conf < threshold:
                hit = True
                desc = (
                    f"LSTM forecast confidence is {conf:.0f}% — "
                    f"below {threshold:.0f}% threshold for {label}."
                )

        if not hit:
            continue
        if _should_debounce(rule["id"], key, log, ctx.get("data_date")):
            continue

        entry = {
            "id": f"log-{uuid4().hex[:12]}",
            "rule_id": rule["id"],
            "type": rule.get("type", "warning"),
            "title": f"Price Alert: {rule.get('name', 'Rule')}",
            "desc": desc,
            "rice_key": key,
            "price": price,
            "threshold": threshold,
            "condition": cond,
            "data_date": ctx.get("data_date"),
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "read": False,
        }
        triggered_entries.append(entry)

    return triggered_entries


def _nice(value: float, step: float = 0.5) -> float:
    return round(round(value / step) * step, 2)


def default_rules_for(prices: dict) -> list[dict]:
    """The default rule set, with price thresholds DEFAULT_BAND_PCT above / below each type's DA price."""
    now = datetime.now().isoformat(timespec="seconds")
    base = {"active": True, "triggered_count": 0, "last_triggered": None, "created_at": now, "default": True}
    out = []
    for key in ALL_RICE_KEYS:
        price = prices.get(key)
        if not price:
            continue
        label = RICE_LABELS[key]
        hi = _nice(price * (1 + DEFAULT_BAND_PCT / 100))
        lo = _nice(price * (1 - DEFAULT_BAND_PCT / 100))
        out.append({**base, "id": f"default-{key}-above", "name": f"{label} above ₱{hi:.2f}",
                    "rice_key": key, "condition": "above", "threshold": hi, "type": "danger"})
        out.append({**base, "id": f"default-{key}-below", "name": f"{label} below ₱{lo:.2f}",
                    "rice_key": key, "condition": "below", "threshold": lo, "type": "info"})
    out.append({**base, "id": "default-all-day-change", "name": "Big move since the previous bulletin",
                "rice_key": "all", "condition": "day_change", "threshold": DEFAULT_MOVE_PESO, "type": "warning"})
    out.append({**base, "id": "default-all-forecast-move", "name": "Big move expected tomorrow",
                "rice_key": "all", "condition": "forecast_move", "threshold": DEFAULT_MOVE_PESO, "type": "warning"})
    return out


def seed_default_rules(rules: list, prices: dict) -> int:
    """Add the default rules that were never created before. A default the admin deleted stays deleted."""
    state = _load_json(STATE_PATH, {})
    seeded = set(state.get("seeded_defaults") or [])
    have = {r.get("id") for r in rules if isinstance(r, dict)}
    added = 0
    for rule in default_rules_for(prices):
        if rule["id"] in seeded:
            continue
        if rule["id"] not in have:
            rules.append(rule)
            added += 1
        seeded.add(rule["id"])
    if added or len(seeded) != len(state.get("seeded_defaults") or []):
        state["seeded_defaults"] = sorted(seeded)
        _save_json(STATE_PATH, state)
    return added


def mark_all_read() -> int:
    log = _load_json(LOG_PATH, [])
    n = 0
    for e in log if isinstance(log, list) else []:
        if isinstance(e, dict) and not e.get("read"):
            e["read"] = True
            n += 1
    if n:
        _save_json(LOG_PATH, log)
    return n


def evaluate_alerts() -> dict:
    """Run all active rules against live prices; append new notifications."""
    _ensure_defaults()
    rules = _load_json(RULES_PATH, [])
    log = _load_json(LOG_PATH, [])
    if not isinstance(log, list):
        log = []

    ctx = _build_context()
    if ctx.get("current_prices"):
        seed_default_rules(rules, ctx["current_prices"])
    new_entries: list[dict] = []

    for rule in rules:
        if not isinstance(rule, dict):
            continue
        entries = _evaluate_rule(rule, ctx, log)
        for entry in entries:
            _append_log_entry(log, entry)
            new_entries.append(entry)
            rule["triggered_count"] = int(rule.get("triggered_count") or 0) + 1
            rule["last_triggered"] = entry["created_at"]

    _save_json(RULES_PATH, rules)
    _save_json(LOG_PATH, log)

    today = datetime.now().date().isoformat()
    triggered_today = sum(
        1
        for e in log
        if isinstance(e, dict) and str(e.get("created_at", "")).startswith(today)
    )

    return {
        "rules": [rule_to_api(r) for r in rules if isinstance(r, dict)],
        "log": list_log(50),
        "new_entries": new_entries,
        "new_count": len(new_entries),
        "triggered_today": triggered_today,
        "context_ready": ctx.get("ready", False),
        "data_date": ctx.get("data_date"),
    }


def get_summary() -> dict:
    """Lightweight summary for dashboard."""
    _ensure_defaults()
    rules = _load_json(RULES_PATH, [])
    log = _load_json(LOG_PATH, [])
    active = sum(1 for r in rules if isinstance(r, dict) and r.get("active"))
    today = datetime.now().date().isoformat()
    triggered_today = sum(
        1
        for e in log
        if isinstance(e, dict) and str(e.get("created_at", "")).startswith(today)
    )
    recent = list_log(5)
    unread = sum(1 for e in log if isinstance(e, dict) and not e.get("read"))
    state = _load_json(STATE_PATH, {})
    return {
        "rules_count": len(rules),
        "active_rules": active,
        "triggered_today": triggered_today,
        "unread": unread,
        "recent": recent,
        "last_check": state.get("last_check"),
    }


def record_check(reason: str, new_count: int) -> None:
    """Remember when the last automatic check ran (shown on Admin → Price Alerts)."""
    state = _load_json(STATE_PATH, {})
    state["last_check"] = {"at": datetime.now().isoformat(timespec="seconds"), "reason": reason, "new": new_count}
    _save_json(STATE_PATH, state)
