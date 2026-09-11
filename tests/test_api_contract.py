"""
API and security contract tests. Requires the server running on :5000
(`cd api && py -3.13 app.py`); skips cleanly if it is not up.

Encodes the panel findings so they cannot silently regress: response-time budget on the core
endpoint, correct status codes for malformed input, injection strings treated as literals,
protected routes actually rejecting anonymous callers, and credentials never returned in plaintext.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

import pytest

BASE = "http://127.0.0.1:5000"
RICE_KEYS = {
    "locSpecial", "locPremium", "locWellMilled", "locRegular",
    "impSpecial", "impPremium", "impWellMilled", "impRegular",
}


def _get(path: str, timeout: int = 60):
    req = urllib.request.Request(BASE + path)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}
    except Exception:
        pytest.skip("API not running on :5000")


@pytest.fixture(scope="module", autouse=True)
def _server_up():
    code, _ = _get("/api/health", timeout=10)
    if code != 200:
        pytest.skip("API not healthy")


# ── availability ──────────────────────────────────────────────────────────────
@pytest.mark.parametrize("ep", [
    "/api/health", "/api/predictions", "/api/dashboard-metrics", "/api/historical-data",
    "/api/model-status", "/api/data-sources", "/api/alerts", "/api/catalog",
    "/api/brand-prices", "/api/taxes", "/api/training-status", "/api/reports/history",
])
def test_endpoint_returns_200(ep):
    code, _ = _get(ep)
    assert code == 200, f"{ep} returned {code}"


# ── performance budget (the 3.4s finding) ─────────────────────────────────────
def test_predictions_is_cached_and_fast():
    _get("/api/predictions")               # prime
    t0 = time.perf_counter()
    code, _ = _get("/api/predictions")
    elapsed = time.perf_counter() - t0
    assert code == 200
    assert elapsed < 1.0, (
        f"/api/predictions took {elapsed:.2f}s on a warm cache — the payload cache has regressed "
        f"(it recomputes ~480 model inferences per request without it)"
    )


# ── input validation ──────────────────────────────────────────────────────────
@pytest.mark.parametrize("bad", [
    "../../etc/passwd", "<script>alert(1)</script>", "' OR 1=1--", "DROP TABLE users",
])
def test_invalid_rice_type_is_rejected_with_400(bad):
    code, body = _get("/api/predictions?type=" + urllib.request.quote(bad))
    assert code == 400, f"expected 400 for {bad!r}, got {code}"
    assert "valid_types" in body


def test_valid_rice_type_still_accepted():
    code, body = _get("/api/predictions?type=locWellMilled")
    assert code == 200
    assert set(body["forecasts_by_key"]) == RICE_KEYS


def test_injection_strings_are_treated_as_literals_not_sql():
    code, body = _get("/api/brand-prices?category=" + urllib.request.quote("' OR 1=1--"))
    assert code == 200
    assert body.get("brands") == [] and "Unknown category" in (body.get("error") or "")


# ── authorization ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize("ep", ["/api/logs", "/api/import-2026"])
def test_protected_endpoints_reject_anonymous(ep):
    code, _ = _get(ep)
    assert code in (401, 403), f"{ep} allowed an unauthenticated request ({code})"


# ── data-protection posture ───────────────────────────────────────────────────
def test_privacy_status_declares_no_plaintext_passwords():
    code, body = _get("/api/privacy-status")
    assert code == 200
    assert body["plaintext_passwords_stored"] is False
    assert "scrypt" in body["credential_hashing"] or "pbkdf2" in body["credential_hashing"].lower()
    assert body["erasure_supported"] is True


def test_no_endpoint_leaks_credentials():
    for ep in ("/api/settings", "/api/model-status", "/api/data-sources"):
        code, body = _get(ep)
        if code != 200:
            continue
        blob = json.dumps(body).lower()
        for secret in ("admin@123", "password_hash", "access_code_hash", "123456"):
            assert secret not in blob, f"{ep} leaked {secret!r}"


# ── forecast sanity over the wire ─────────────────────────────────────────────
def test_forecast_shape_and_intervals():
    code, body = _get("/api/predictions")
    assert code == 200
    fc = body["forecast"]
    assert len(fc) == 3, "3-day horizon"
    for day in fc:
        assert day["price"] > 0
        if "low" in day:
            assert day["low"] < day["price"] < day["high"], "price outside its own interval"
            assert day["interval_pct"] == 90


def test_metrics_expose_honest_headline_not_only_legacy_accuracy():
    code, body = _get("/api/predictions")
    m = body["metrics"]
    for field in ("hit_rate_pct", "skill_vs_baseline_pct", "movement_ratio", "beats_baseline"):
        assert field in m, f"/api/predictions.metrics missing {field}"
    assert "do not report" in (m.get("accuracy_pct_note") or "").lower()
