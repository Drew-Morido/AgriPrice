"""
AgriPricePH — offline research statistics helper.

Covers the second-panel methodology requirements:
  * Slovin sample-size formula (e = 0.05)
  * One-Way ANOVA across respondent groups (+ assumption checks + Tukey HSD)
  * Forecast-accuracy metrics (MAE, RMSE, MAPE, sMAPE, R^2)

This is a STANDALONE offline tool — it is not imported by the Flask app. Run:

    py -3.13 research/stats.py --selftest
    py -3.13 research/stats.py --slovin 100
    py -3.13 research/stats.py --anova responses.csv --group-col Group --score-col Score

`responses.csv` is a long-format export (e.g., from Google Forms) with one row per respondent:
a group column (Households/Distributors/IT/DTI) and a numeric evaluation-score column.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
import warnings
from collections import OrderedDict

warnings.filterwarnings("ignore")  # offline tool: silence scipy zero-variance shapiro notices

ALPHA = 0.05
DEFAULT_MARGIN = 0.05


# ─────────────────────────── Sampling ───────────────────────────
def slovin(population: int, e: float = DEFAULT_MARGIN) -> int:
    """Slovin's formula: n = N / (1 + N e^2), rounded up. e is the margin of error."""
    if population <= 0:
        raise ValueError("population (N) must be a positive integer")
    if not (0 < e < 1):
        raise ValueError("margin of error e must be in (0, 1)")
    n = population / (1.0 + population * e * e)
    return min(population, math.ceil(n))


def min_population_for_sample(target_n: int, e: float = DEFAULT_MARGIN) -> int:
    """Smallest population N whose Slovin sample size reaches target_n (e.g., 80)."""
    N = target_n
    while slovin(N, e) < target_n:
        N += 1
    return N


def respondent_plan(population: int, e: float = DEFAULT_MARGIN,
                    weights: "OrderedDict[str, float] | None" = None) -> dict:
    """Compute n via Slovin and allocate across groups by weight (defaults sum-to-80 style)."""
    n = slovin(population, e)
    weights = weights or OrderedDict([
        ("Households/Consumers", 0.375),
        ("Rice Distributors/Vendors", 0.3125),
        ("IT Evaluators", 0.1875),
        ("DTI Personnel", 0.125),
    ])
    total = sum(weights.values()) or 1.0
    alloc = {g: max(1, round(n * w / total)) for g, w in weights.items()}
    # Fix rounding drift so the allocation sums to n.
    drift = n - sum(alloc.values())
    if drift:
        biggest = max(alloc, key=alloc.get)
        alloc[biggest] += drift
    return {"population": population, "e": e, "sample_size": n, "allocation": alloc}


# ─────────────────────────── Forecast metrics ───────────────────────────
def forecast_metrics(y_true, y_pred) -> dict:
    """MAE, RMSE, MAPE, sMAPE, R^2. Pure-python (no numpy dependency required)."""
    yt = [float(a) for a in y_true]
    yp = [float(b) for b in y_pred]
    if len(yt) != len(yp) or not yt:
        raise ValueError("y_true and y_pred must be same non-zero length")
    n = len(yt)
    errs = [a - b for a, b in zip(yt, yp)]
    mae = sum(abs(e) for e in errs) / n
    rmse = math.sqrt(sum(e * e for e in errs) / n)
    # MAPE / sMAPE skip points where the denominator is ~0.
    mape_terms = [abs(e) / abs(a) for e, a in zip(errs, yt) if abs(a) > 1e-9]
    mape = 100.0 * sum(mape_terms) / len(mape_terms) if mape_terms else float("nan")
    smape_terms = [2 * abs(e) / (abs(a) + abs(b))
                   for e, a, b in zip(errs, yt, yp) if (abs(a) + abs(b)) > 1e-9]
    smape = 100.0 * sum(smape_terms) / len(smape_terms) if smape_terms else float("nan")
    mean_t = sum(yt) / n
    ss_res = sum(e * e for e in errs)
    ss_tot = sum((a - mean_t) ** 2 for a in yt)
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 1e-12 else float("nan")
    return {"n": n, "mae": mae, "rmse": rmse, "mape_pct": mape, "smape_pct": smape, "r2": r2}


# ─────────────────────────── One-Way ANOVA ───────────────────────────
def one_way_anova(groups: "dict[str, list]", alpha: float = ALPHA) -> dict:
    """
    One-Way ANOVA across ≥2 groups. Returns F, p, dfs, group means, assumption checks,
    a decision at alpha, and Tukey HSD when scipy/statsmodels are available.
    Falls back to a pure-python F/p (via a small F-distribution survival approx) if scipy
    is missing, so it always returns numbers — but scipy/statsmodels is recommended.
    """
    clean = {g: [float(v) for v in vals] for g, vals in groups.items() if len(vals) >= 2}
    if len(clean) < 2:
        raise ValueError("need ≥2 groups with ≥2 observations each")

    means = {g: sum(v) / len(v) for g, v in clean.items()}
    ns = {g: len(v) for g, v in clean.items()}
    grand = sum(sum(v) for v in clean.values()) / sum(ns.values())
    k = len(clean)
    N = sum(ns.values())
    ss_between = sum(ns[g] * (means[g] - grand) ** 2 for g in clean)
    ss_within = sum((x - means[g]) ** 2 for g, v in clean.items() for x in v)
    df_b, df_w = k - 1, N - k
    ms_b = ss_between / df_b if df_b else float("nan")
    ms_w = ss_within / df_w if df_w else float("nan")
    F = ms_b / ms_w if ms_w > 1e-12 else float("inf")

    result = {
        "groups": {g: {"n": ns[g], "mean": round(means[g], 4)} for g in clean},
        "grand_mean": round(grand, 4), "df_between": df_b, "df_within": df_w,
        "SS_between": round(ss_between, 4), "SS_within": round(ss_within, 4),
        "MS_between": round(ms_b, 4), "MS_within": round(ms_w, 4),
        "F": round(F, 4), "alpha": alpha, "backend": "manual",
    }

    p = None
    try:
        from scipy import stats as ss
        F_sp, p = ss.f_oneway(*clean.values())
        result["F"] = round(float(F_sp), 4)
        result["backend"] = "scipy"
        # Assumption checks
        try:
            result["levene_p"] = round(float(ss.levene(*clean.values()).pvalue), 4)
        except Exception:
            result["levene_p"] = None
        result["shapiro_p"] = {}
        for g, v in clean.items():
            try:
                result["shapiro_p"][g] = round(float(ss.shapiro(v).pvalue), 4) if len(v) >= 3 else None
            except Exception:
                result["shapiro_p"][g] = None
    except Exception:
        # Pure-python p-value via regularized incomplete beta (no scipy).
        p = _f_sf(F, df_b, df_w)

    result["p_value"] = round(float(p), 6) if p is not None else None
    result["reject_H0"] = bool(result["p_value"] is not None and result["p_value"] < alpha)
    result["interpretation"] = (
        "Reject H0: at least one group's mean rating differs significantly (run post-hoc)."
        if result["reject_H0"] else
        "Fail to reject H0: no significant difference in mean ratings across groups."
    )

    # Post-hoc Tukey HSD (only meaningful if H0 rejected)
    if result["reject_H0"]:
        try:
            from statsmodels.stats.multicomp import pairwise_tukeyhsd
            labels, data = [], []
            for g, v in clean.items():
                labels += [g] * len(v)
                data += v
            tuk = pairwise_tukeyhsd(data, labels, alpha=alpha)
            result["tukey"] = str(tuk)
        except Exception:
            result["tukey"] = "statsmodels not available — run Tukey HSD in SPSS/Excel."
    return result


def _betacf(a, b, x, itmax=200, eps=3e-7):
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    d = 1e-30 if abs(d) < 1e-30 else d
    d = 1.0 / d
    h = d
    for m in range(1, itmax + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        d = 1e-30 if abs(d) < 1e-30 else d
        c = 1.0 + aa / c
        c = 1e-30 if abs(c) < 1e-30 else c
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        d = 1e-30 if abs(d) < 1e-30 else d
        c = 1.0 + aa / c
        c = 1e-30 if abs(c) < 1e-30 else c
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < eps:
            break
    return h


def _betai(a, b, x):
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    lbeta = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
    bt = math.exp(lbeta + a * math.log(x) + b * math.log(1.0 - x))
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * _betacf(a, b, x) / a
    return 1.0 - bt * _betacf(b, a, 1.0 - x) / b


def _f_sf(F, d1, d2):
    """Survival function P(X > F) for an F(d1, d2) distribution (no scipy)."""
    if F <= 0 or math.isinf(F):
        return 0.0 if math.isinf(F) else 1.0
    x = d2 / (d2 + d1 * F)
    return _betai(d2 / 2.0, d1 / 2.0, x)


# ─────────────────────────── CLI ───────────────────────────
def _read_groups(path, group_col, score_col):
    groups: "OrderedDict[str, list]" = OrderedDict()
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            g = (row.get(group_col) or "").strip()
            raw = (row.get(score_col) or "").strip()
            if not g or not raw:
                continue
            try:
                groups.setdefault(g, []).append(float(raw))
            except ValueError:
                continue
    return groups


def _selftest() -> int:
    ok = True

    def check(name, cond):
        nonlocal ok
        ok = ok and cond
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}")

    print("Slovin:")
    check("N=100, e=0.05 -> 80 (exact)", slovin(100) == 80)
    check("n first reaches 80 at N=99 (ceil)", min_population_for_sample(80) == 99)
    check("N=200, e=0.05 -> 134", slovin(200) == 134)
    try:
        slovin(0); check("N=0 raises", False)
    except ValueError:
        check("N=0 raises", True)

    print("Forecast metrics (perfect prediction):")
    m = forecast_metrics([1, 2, 3, 4], [1, 2, 3, 4])
    check("MAE=0", abs(m["mae"]) < 1e-9)
    check("R2=1", abs(m["r2"] - 1.0) < 1e-9)
    m2 = forecast_metrics([10, 20, 30], [11, 19, 33])
    check("MAPE reasonable", 0 < m2["mape_pct"] < 20)

    print("ANOVA (clearly different groups -> reject H0):")
    a = one_way_anova({"A": [4, 4, 4, 4], "B": [1, 1, 1, 2], "C": [3, 3, 3, 3]})
    check("F computed", a["F"] > 0)
    check("rejects H0", a["reject_H0"] is True)
    print(f"    (backend={a['backend']}, F={a['F']}, p={a['p_value']})")
    b = one_way_anova({"A": [3, 3, 3], "B": [3, 3, 3], "C": [3, 3, 3.0001]})
    check("near-identical -> fail to reject", b["reject_H0"] is False)

    print("\nRespondent plan (N=100):")
    plan = respondent_plan(100)
    print(f"    n={plan['sample_size']} alloc={plan['allocation']} (sum={sum(plan['allocation'].values())})")
    check("allocation sums to n", sum(plan["allocation"].values()) == plan["sample_size"])

    print("\nSELFTEST:", "ALL PASS" if ok else "FAILURES PRESENT")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="AgriPricePH offline research statistics")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--slovin", type=int, metavar="N", help="compute Slovin sample size for population N")
    ap.add_argument("--e", type=float, default=DEFAULT_MARGIN, help="margin of error (default 0.05)")
    ap.add_argument("--anova", metavar="CSV", help="responses CSV for One-Way ANOVA")
    ap.add_argument("--group-col", default="Group")
    ap.add_argument("--score-col", default="Score")
    args = ap.parse_args()

    if args.selftest:
        return _selftest()
    if args.slovin is not None:
        plan = respondent_plan(args.slovin, args.e)
        print(f"Slovin: N={args.slovin}, e={args.e} -> n={plan['sample_size']}")
        for g, c in plan["allocation"].items():
            print(f"  {g}: {c}")
        return 0
    if args.anova:
        groups = _read_groups(args.anova, args.group_col, args.score_col)
        res = one_way_anova(groups)
        import json
        print(json.dumps(res, indent=2))
        return 0
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
