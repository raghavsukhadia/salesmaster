"""Visit performance, follow-up, sales target and comparison reports."""
from django.db.models import Count, Exists, OuterRef, Q, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from apps.accounts.models import Salesman
from apps.dealers.access import accessible_dealers
from apps.dealers.models import Dealer
from apps.management.views import person
from apps.visits.models import Followup, VisitOrderItem

from .aggregates import by_salesman
from .common import (
    Ctx, card, change_pct, chart, col, daily, day_points, effective_span, pct, payload, salesman_names, stamp, table, totals, where,
)
from .people_reports import LINK_SALESMAN, ranked, ranking
from .ranges import custom_range, month_range, parse_day
from .scope import PRODUCT_KEY_RE, followups, lines, product_label, visits


# ───────────────────────────── visit performance ─────────────────────────────

def visit_performance(ctx: Ctx):
    f = ctx.f
    t = totals(f)
    without = max(t["visits"] - t["orders"], 0)
    pts, cut = day_points(daily(f), effective_span(f), keys=("visits", "orders"))
    cards = [card("visits", "Total dealer visits", t["visits"], hint=f"{t['dealers_visited']} dealers"),
             card("orders", "Visits converted into orders", t["orders"]), card("without", "Visits without orders", without),
             card("conversion", "Conversion", t["conversion"], "pct")]

    day_rows = []
    data = daily(f)
    for d, v in sorted(data.items(), reverse=True):
        if v["visits"] or v["orders"]:
            day_rows.append({"date": d.isoformat(), "visits": v["visits"], "orders": v["orders"], "without": max(v["visits"] - v["orders"], 0),
                             "conversion": pct(v["orders"], v["visits"])})
    tables = [table("days", "Visits by day", [col("date", "Date", "date"), col("visits", "Visits"), col("orders", "With an order"),
                                                col("without", "Without an order"), col("conversion", "Conversion", "pct")],
                    day_rows[:ctx.cap], total=len(day_rows),
                    totals={"date": "Total", "visits": t["visits"], "orders": t["orders"], "without": without, "conversion": t["conversion"]})]
    if f.management and not f.salesman_id:
        rows = sorted(by_salesman(f), key=lambda r: (-r["visits"], r["name"].lower()))
        for r in rows:
            r["without"] = max(r["visits"] - r["orders"], 0)
        tables.insert(0, table("salesmen", "Visits by salesman", [
            col("name", "Salesman", "text", link=LINK_SALESMAN), col("visits", "Visits"), col("orders", "With an order"),
            col("without", "Without an order"), col("conversion", "Conversion", "pct"), col("dealers_visited", "Dealers visited")], rows[:ctx.cap], total=len(rows)))

    barren = (visits(f).exclude(id__in=lines(f).values("visit_id")).select_related("salesman__user", "dealer").order_by("-visited_at", "-id"))
    n_barren = barren.count()
    brow = [{"id": v.id, "date": stamp(v.visited_at), "salesman": person(v.salesman), "dealer": v.dealer.name, "location": where(v.dealer),
             "notes": (v.notes or "")[:140]} for v in barren[:ctx.cap]]
    tables.append(table("barren", "Visits without an order", [
        col("id", "Visit", "order", link={"path": "/visits/{id}" if f.management else "/visit-history/{id}"}), col("date", "Date", "datetime"),
        *([col("salesman", "Salesman", "text")] if f.management else []), col("dealer", "Dealer", "text"), col("location", "Location", "text"),
        col("notes", "Notes", "text")], brow, total=n_barren))
    return payload(
        ctx, "visit-performance", "Visit performance", cards=cards, tables=tables, quantity=False,
        charts=[chart("outcome", "Visit outcome", "segments", [{"label": "Converted into an order", "value": t["orders"]},
                                                                {"label": "No order", "value": without}], [], subtitle="Share of all visits"),
                chart("daily", "Visits and orders by day", "line", pts, [{"key": "visits", "label": "Visits"}, {"key": "orders", "label": "Orders"}], x="day",
                      note=f"Showing the most recent {len(pts)} days of the period." if cut else "")],
        notes=["A visit is converted when it recorded at least one product line."]
        + (["With a Product filter, only orders containing that product count as conversions."] if f.product or f.category else []),
    )


# ───────────────────────────── follow-ups ─────────────────────────────

def _converted(qs):
    """Follow-ups (not cancelled) whose salesman later recorded an order with the same dealer.
    The visit that created the follow-up is excluded, so an order taken on that very visit does not count."""
    later = VisitOrderItem.objects.filter(
        visit__dealer_id=OuterRef("dealer_id"), visit__salesman_id=OuterRef("salesman_id"), visit__visited_at__gte=OuterRef("created_at"),
    ).exclude(visit_id=OuterRef("src"))
    return qs.exclude(status=Followup.Status.CANCELLED).annotate(src=Coalesce("visit_id", Value(0))).filter(Exists(later))


OUTCOMES = dict(Followup.Outcome.choices)


def followup_reports(ctx: Ctx):
    f = ctx.f
    today = timezone.localdate()
    base = followups(f)
    P, C, X = Followup.Status.PENDING, Followup.Status.COMPLETED, Followup.Status.CANCELLED
    a = base.aggregate(
        total=Count("id"), pending=Count("id", filter=Q(status=P)), completed=Count("id", filter=Q(status=C)),
        cancelled=Count("id", filter=Q(status=X)), overdue=Count("id", filter=Q(status=P, due_date__lt=today)),
        due_today=Count("id", filter=Q(status=P, due_date=today)))
    live = a["total"] - a["cancelled"]
    conv_by = dict(_converted(base).values_list("salesman_id").annotate(n=Count("id")))
    converted = sum(conv_by.values())

    cards = [card("total", "Total follow-ups", a["total"], hint="due in the period"), card("pending", "Pending", a["pending"], hint=f"{a['due_today']} due today"),
             card("completed", "Completed", a["completed"]), card("overdue", "Overdue", a["overdue"], hint="pending and past due"),
             card("converted", "Converted into orders", converted, hint=f"{pct(converted, live)}% of {live} active"), card("cancelled", "Cancelled", a["cancelled"])]
    upcoming = a["pending"] - a["overdue"]
    segments = chart("status", "Follow-up status", "segments", [
        {"label": "Completed", "value": a["completed"]}, {"label": "Pending", "value": upcoming},
        {"label": "Overdue", "value": a["overdue"]}, {"label": "Cancelled", "value": a["cancelled"]}], [], subtitle="Share of follow-ups due in the period")

    out = base.exclude(outcome="").values("outcome").annotate(n=Count("id")).order_by("-n")
    outcome_pts = [{"id": r["outcome"], "label": OUTCOMES.get(r["outcome"], r["outcome"]), "n": r["n"]} for r in out]
    charts = [segments, chart("outcomes", "Outcome of completed follow-ups", "hbar", outcome_pts, [{"key": "n", "label": "Follow-ups"}])]

    tables = []
    if f.management and not f.salesman_id:
        rows = list(base.values("salesman_id").annotate(
            total=Count("id"), pending=Count("id", filter=Q(status=P)), completed=Count("id", filter=Q(status=C)),
            cancelled=Count("id", filter=Q(status=X)), overdue=Count("id", filter=Q(status=P, due_date__lt=today))))
        names = salesman_names(r["salesman_id"] for r in rows)
        for r in rows:
            r["id"], r["name"] = r["salesman_id"], names.get(r["salesman_id"], "")
            r["converted"] = conv_by.get(r["salesman_id"], 0)
            r["rate"] = pct(r["converted"], r["total"] - r["cancelled"])
        rows.sort(key=lambda r: (-r["total"], r["name"].lower()))
        tables.append(table("salesmen", "Follow-ups by salesman", [
            col("name", "Salesman", "text", link=LINK_SALESMAN), col("total", "Total"), col("pending", "Pending"), col("completed", "Completed"),
            col("overdue", "Overdue"), col("cancelled", "Cancelled"), col("converted", "Converted into orders"), col("rate", "Conversion", "pct")],
            rows[:ctx.cap], total=len(rows)))

    late = base.filter(status=P, due_date__lt=today).select_related("salesman__user", "dealer").order_by("due_date", "id")
    n_late = late.count()
    lrows = [{"id": x.id, "due": x.due_date.isoformat(), "days": (today - x.due_date).days, "dealer": x.dealer.name, "salesman": person(x.salesman),
              "priority": x.priority.title()} for x in late[:ctx.cap]]
    tables.append(table("overdue", "Overdue follow-ups", [
        col("id", "Follow-up", "order", link={"path": "/followups-management/{id}"} if f.management else None), col("due", "Was due", "date"), col("days", "Days overdue"),
        col("dealer", "Dealer", "text"), *([col("salesman", "Salesman", "text")] if f.management else []), col("priority", "Priority", "text")],
        lrows, total=n_late))
    return payload(
        ctx, "followup-reports", "Follow-up reports", cards=cards, charts=charts, tables=tables, quantity=False,
        notes=["Follow-ups are selected by their due date. Product and Order ID filters do not apply to them.",
               "Converted: the same salesman recorded an order with the same dealer after the follow-up was created (the visit that created it is not counted). Cancelled follow-ups are left out."],
    )


# ───────────────────────────── sales targets ─────────────────────────────

def targets(ctx: Ctx):
    f = ctx.f
    month = ctx.params.get("month") or timezone.localdate().strftime("%Y-%m")
    rng = month_range(month)
    base = f.with_(range=rng, dealer_id=None, product="", category="", order_id=None)
    pool = Salesman.objects.filter(is_active=True).select_related("user")
    if base.salesman_id:
        pool = pool.filter(pk=base.salesman_id)
    got = {r["id"]: r for r in by_salesman(base, include_idle=False)}
    rows = []
    for s in pool:
        g = got.get(s.id, {"orders": 0, "visits": 0, "qty": 0})
        o_t, v_t = s.monthly_order_target, s.monthly_visit_target
        rows.append({
            "id": s.id, "name": person(s), "order_target": o_t, "orders": g["orders"], "order_left": max(o_t - g["orders"], 0) if o_t else None,
            "order_pct": pct(g["orders"], o_t) if o_t else None, "visit_target": v_t, "visits": g["visits"],
            "visit_left": max(v_t - g["visits"], 0) if v_t else None, "visit_pct": pct(g["visits"], v_t) if v_t else None, "qty": g["qty"], "rank": None,
        })
    rows.sort(key=lambda r: (-(r["order_pct"] if r["order_pct"] is not None else -1), -r["orders"], r["name"].lower()))
    prev, rank = None, 0
    for i, r in enumerate((r for r in rows if r["order_pct"] is not None), start=1):
        if r["order_pct"] != prev:
            rank, prev = i, r["order_pct"]
        r["rank"] = rank

    with_t = [r for r in rows if r["order_target"]]
    sum_t, sum_a = sum(r["order_target"] for r in with_t), sum(r["orders"] for r in with_t)
    cards = [card("target", "Order target", sum_t, hint=f"{len(with_t)} salesmen with a target"), card("achieved", "Orders achieved", sum_a, hint="by those salesmen"),
             card("pct", "Achievement", pct(sum_a, sum_t), "pct"), card("hit", "Reached target", sum(1 for r in with_t if r["orders"] >= r["order_target"]),
                                                                           hint=f"of {len(with_t)}")]
    rankings = []
    if f.management and not f.salesman_id:
        rankings = [ranking("rank", "Target ranking (orders achieved vs target)", "% of target", "pct", ranked(
            [r for r in rows if r["order_pct"] is not None], "order_pct", note=lambda r: f"{r['orders']} of {r['order_target']} orders", tiebreak=lambda r: r["orders"]),
            LINK_SALESMAN)]
    pts = [{"id": r["id"], "label": r["name"], "target": r["order_target"], "achieved": r["orders"]} for r in with_t]
    cols = [col("rank", "Rank", "rank"), col("name", "Salesman", "text", link=LINK_SALESMAN), col("order_target", "Order target", "target"),
            col("orders", "Orders"), col("order_left", "Orders left"), col("order_pct", "Order %", "pct_opt"),
            col("visit_target", "Visit target", "target"), col("visits", "Visits"), col("visit_left", "Visits left"), col("visit_pct", "Visit %", "pct_opt")]
    return payload(
        ctx, "sales-targets", "Sales targets", cards=cards, rankings=rankings, quantity=False,
        charts=[chart("targets", "Target vs achieved orders", "compare", pts, [{"key": "target", "label": "Target"}, {"key": "achieved", "label": "Achieved"}],
                      subtitle=rng.label)] if pts else [],
        tables=[table("targets", f"Targets for {rng.label}", cols, rows, total=len(rows))],
        options=[{"key": "month", "label": "Month", "type": "month", "value": month}],
        notes=["Targets are counts of orders and of visits per month, set on each salesman. The date range above is replaced by the month chosen here.",
               "Only the Salesman filter applies. “No target” means the salesman has no target set for this measure."],
    )


# ───────────────────────────── comparison ─────────────────────────────

KINDS = ("salesman", "product", "dealer", "month", "range")


def _metric_rows(ma, mb, keys):
    labels = {"orders": ("Orders", "int"), "qty": ("Quantity sold", "int"), "visits": ("Visits", "int"), "dealers_ordered": ("Dealers who ordered", "int"),
              "conversion": ("Visit → order rate", "pct"), "avg_qty": ("Avg quantity / order", "dec"), "salesmen_selling": ("Salesmen selling", "int"),
              "products": ("Products sold", "int")}
    rows = []
    for k in keys:
        label, kind = labels[k]
        a, b = ma[k], mb[k]
        rows.append({"metric": label, "kind": kind, "a": a, "b": b, "delta": round(b - a, 1), "change": None if kind == "pct" else change_pct(a, b)})
    return rows


def _side(ctx: Ctx, kind: str, value: str, which: str):
    """(filters, label) for one side of a comparison. Every label is checked against the caller's access first."""
    f = ctx.f
    if kind == "salesman":
        if not f.management:
            raise PermissionDenied("Only management can compare salesmen")
        if not value.isdigit():
            raise ValidationError({which: "Choose a salesman"})
        s = Salesman.objects.select_related("user").filter(pk=int(value)).first()
        if s is None:
            raise NotFound("Salesman not found")
        return f.with_(salesman_id=s.id), person(s)
    if kind == "dealer":
        if not value.isdigit():
            raise ValidationError({which: "Choose a dealer"})
        d = (Dealer.objects.all() if f.management else accessible_dealers(f.user)).filter(pk=int(value)).first()
        if d is None:
            raise NotFound("Dealer not found")
        return f.with_(dealer_id=d.id), d.name
    if kind == "product":
        if not PRODUCT_KEY_RE.match(value or ""):
            raise ValidationError({which: "Choose a product"})
        return f.with_(product=value), product_label(value)
    if kind == "month":
        r = month_range(value, which)
        return f.with_(range=r), r.label
    # range: "YYYY-MM-DD..YYYY-MM-DD"
    lo, _, hi = (value or "").partition("..")
    r = custom_range(parse_day(lo, which), parse_day(hi, which))
    return f.with_(range=r), r.label


def compare(ctx: Ctx):
    p = ctx.params
    kind = p.get("type", "")
    if kind not in KINDS:
        raise ValidationError({"type": "Choose what to compare"})
    fa, la = _side(ctx, kind, p.get("a", ""), "a")
    fb, lb = _side(ctx, kind, p.get("b", ""), "b")
    ma, mb = totals(fa), totals(fb)
    keys = ["orders", "qty", "dealers_ordered", "salesmen_selling", "avg_qty"] if kind == "product" else ["orders", "qty", "visits", "dealers_ordered", "conversion", "avg_qty"]
    rows = _metric_rows(ma, mb, keys)
    la, lb = (la, lb) if la != lb else (f"{la} (A)", f"{lb} (B)")

    def headline(r):
        ch = r["change"]
        value = ch if ch is not None else None
        hint = f"{r['a']:,} → {r['b']:,}" if r["kind"] == "int" else f"{r['a']} → {r['b']}"
        return card(r["metric"].lower().replace(" ", "_"), r["metric"], value, "change", hint)

    head = [headline(r) for r in rows if r["metric"] in ("Orders", "Quantity sold")]
    # Small multiples: each metric has its own scale, so each gets its own pair of bars (never one shared axis).
    pts = [{"label": r["metric"], "a": r["a"], "b": r["b"], "kind": r["kind"]} for r in rows]
    return payload(
        ctx, "compare", "Advanced comparison", cards=head, scopes=[fa, fb],
        charts=[chart("compare", f"{la} vs {lb}", "compare", pts, [{"key": "a", "label": la}, {"key": "b", "label": lb}])],
        tables=[table("compare", "Side by side", [
            {"key": "metric", "label": "Measure", "kind": "text"}, {"key": "a", "label": la, "kind": "mixed"}, {"key": "b", "label": lb, "kind": "mixed"},
            {"key": "delta", "label": "Difference", "kind": "mixed"}, {"key": "change", "label": "Growth / decline", "kind": "change"}], rows, search=False)],
        notes=[f"Growth is measured from {la} to {lb}: positive means {lb} is higher. A dash means there is nothing to compare against (the first value is 0).",
               "Every other filter above still applies to both sides" + (", except the date range, which each side sets itself." if kind in ("month", "range") else ".")],
    )


def compare_options(ctx: Ctx) -> dict:
    """Month choices for the comparison form: every month that has any visit in scope."""
    seen = sorted({v.strftime("%Y-%m") for v in visits(ctx.f, dated=False).dates("visited_at", "month")}, reverse=True)
    return {"months": seen}
