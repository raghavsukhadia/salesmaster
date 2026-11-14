"""Salesman-wise, dealer-wise and salesman-vs-product reports (plus the salesman / dealer drill-down pages)."""
import dataclasses
from collections import defaultdict
from datetime import timedelta

from django.db.models import Count, F, Max, Min, OuterRef, Subquery, Sum
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework.exceptions import NotFound

from apps.accounts.models import Salesman
from apps.dealers.access import accessible_dealers
from apps.dealers.models import Dealer, DealerOwnershipHistory
from apps.management.views import person

from .aggregates import by_dealer, by_product, by_salesman
from .common import (
    MEASURES, Ctx, card, chart, col, daily, day_points, effective_span, pct, payload, salesman_names, stamp, table, totals, where,
)
from .sales_reports import order_table, top_union
from .scope import PKEY, lines

IDLE_CHOICES = (30, 60, 90)
LINK_SALESMAN = {"path": "/reports/salesman-wise/{id}", "search": "preset=all"}
LINK_DEALER = {"path": "/reports/dealer-wise/{id}", "search": "preset=all"}


def ranked(rows, value, *, note=None, n=10, tiebreak=None):
    """Top-n with competition ranking (equal values share a rank). Zero never ranks."""
    key = tiebreak or (lambda r: 0)
    ordered = sorted((r for r in rows if r[value] > 0), key=lambda r: (-r[value], -key(r), str(r.get("name") or r.get("label")).lower()))
    out, prev, rank = [], None, 0
    for i, r in enumerate(ordered[:n], start=1):
        if r[value] != prev:
            rank, prev = i, r[value]
        out.append({"rank": rank, "id": r["id"], "name": r.get("name") or r.get("label"), "value": r[value], "note": note(r) if note else ""})
    return out


def ranking(id, title, unit, fmt, rows, link):
    return {"id": id, "title": title, "unit": unit, "format": fmt, "link": link, "rows": rows}


# ───────────────────────────── salesmen ─────────────────────────────

def salesmen(ctx: Ctx):
    f = ctx.f
    rows = by_salesman(f)
    rows.sort(key=lambda r: (-r["qty"], -r["orders"], r["name"].lower()))
    t = totals(f)
    cols = [col("name", "Salesman", "text", link=LINK_SALESMAN), col("visits", "Visits"), col("orders", "Orders"), col("qty", "Quantity sold"),
            col("dealers_visited", "Dealers visited"), col("dealers_ordered", "Dealers ordered"), col("avg_qty", "Avg qty / order", "dec"),
            col("conversion", "Conversion", "pct")]
    cards = [card("salesmen", "Salesmen", len(rows)), card("orders", "Orders", t["orders"]), card("qty", "Quantity sold", t["qty"]),
             card("conversion", "Visit → order rate", t["conversion"], "pct", hint=f"{t['orders']} of {t['visits']} visits")]
    top = next((r for r in rows if r["qty"] > 0), None)
    if top and f.management and not f.salesman_id:
        cards.insert(1, card("top", "Top seller", top["name"], "text", hint=f"quantity {top['qty']:,}"))

    rankings, charts = [], []
    if f.management and not f.salesman_id:
        note_v = lambda r: f"{r['visits']} visits"  # noqa: E731
        rankings = [
            ranking("orders", "Highest number of orders", "orders", "int", ranked(rows, "orders", note=note_v), LINK_SALESMAN),
            ranking("qty", "Highest quantity sold", "quantity", "int", ranked(rows, "qty", note=lambda r: f"{r['orders']} orders"), LINK_SALESMAN),
            ranking("conversion", "Highest visit conversion rate", "% of visits", "pct",
                    ranked([r for r in rows if r["visits"] > 0], "conversion", note=lambda r: f"{r['orders']} of {r['visits']} visits", tiebreak=lambda r: r["visits"]),
                    LINK_SALESMAN),
        ]
        pts = [{"id": r["id"], "label": r["name"], "qty": r["qty"], "orders": r["orders"]} for r in rows]
        charts = [chart("salesmen", "Salesman comparison", "hbar", top_union(pts, n=12), MEASURES, measurable=True)]
    return payload(
        ctx, "salesman-wise", "Salesman-wise report", cards=cards, charts=charts, rankings=rankings,
        tables=[table("salesmen", "Salesman performance", cols, rows[:ctx.cap], total=len(rows))],
        notes=["Click a salesman to open their complete sales history.",
               "Visit → order rate is the share of visits that recorded an order. Ties on a leaderboard share a rank."],
    )


def _salesman_or_404(ctx: Ctx, pk: int) -> Salesman:
    s = Salesman.objects.select_related("user").filter(pk=pk).first()
    if s is None or (not ctx.f.management and ctx.f.salesman_id != pk):
        raise NotFound("Salesman not found")  # the same answer for a missing salesman and someone else's
    return s


def salesman_detail(ctx: Ctx):
    s = _salesman_or_404(ctx, ctx.pk)
    f = ctx.f.with_(salesman_id=s.id)
    ctx2 = dataclasses.replace(ctx, f=f)
    t = totals(f)
    pts, cut = day_points(daily(f), effective_span(f), keys=("qty", "orders"))
    hist, _ = order_table(ctx2, title="Complete sales history", hide=("salesman",))
    prods = by_product(f)
    deal = by_dealer(f, limit=ctx.cap)
    pr_pts = [{"id": p["key"], "label": p["label"], "qty": p["qty"], "orders": p["orders"]} for p in prods]
    return payload(
        ctx2, "salesman-detail", person(s),
        cards=[card("orders", "Orders", t["orders"]), card("qty", "Quantity sold", t["qty"]), card("visits", "Visits", t["visits"]),
               card("dealers", "Dealers ordered", t["dealers_ordered"], hint=f"{t['dealers_visited']} visited"),
               card("avg", "Avg quantity / order", t["avg_qty"], "dec"), card("conversion", "Visit → order rate", t["conversion"], "pct")],
        charts=[chart("daily", "Sales by day", "line", pts, MEASURES, measurable=True, x="day"),
                chart("products", "Products sold", "hbar", top_union(pr_pts), MEASURES, measurable=True, subtitle="Top 10")],
        tables=[
            hist,
            table("products", "Products sold", [col("label", "Product", "text"), col("category", "Category", "text"), col("qty", "Quantity sold"),
                                                 col("orders", "Orders"), col("dealers", "Dealers")], prods[:ctx.cap], total=len(prods)),
            table("dealers", "Dealers sold to", [col("name", "Dealer", "text", link=LINK_DEALER), col("location", "Location", "text"),
                                                  col("orders", "Orders"), col("qty", "Quantity"), col("products", "Products"), col("last_order", "Last order", "datetime")],
                  [{**d, "last_order": stamp(d["last_order"])} for d in deal]),
        ],
        notes=[f"Showing {person(s)}'s activity for the selected period. Choose “All time” for the complete history."],
    )


# ───────────────────────────── dealers ─────────────────────────────

def _top_products_by_dealer(f, dealer_ids, per=3) -> dict:
    sums = defaultdict(list)
    qs = (lines(f).filter(visit__dealer_id__in=dealer_ids).annotate(pkey=PKEY).values("visit__dealer_id", "pkey")
          .annotate(label=Coalesce(Max("product__name"), Max("product_name")), qty=Sum("quantity")))
    for r in qs:
        sums[r["visit__dealer_id"]].append((r["qty"] or 0, r["label"]))
    return {d: ", ".join(f"{label} ({qty:,})" for qty, label in sorted(v, key=lambda x: (-x[0], x[1].lower()))[:per]) for d, v in sums.items()}


def idle_dealers(ctx: Ctx, days: int):
    f = ctx.f
    pool = (Dealer.objects.all() if f.management else accessible_dealers(f.user)).filter(is_archived=False)
    if f.management and f.salesman_id:
        pool = pool.filter(pk__in=DealerOwnershipHistory.objects.filter(salesman_id=f.salesman_id, ended_at__isnull=True).values("dealer_id"))
    if f.dealer_id:
        pool = pool.filter(pk=f.dealer_id)
    now = timezone.now()
    recent = lines(f, dated=False).filter(visit__visited_at__gte=now - timedelta(days=days)).values("visit__dealer_id")
    last = Subquery(lines(f, dated=False).filter(visit__dealer_id=OuterRef("pk")).order_by("-visit__visited_at").values("visit__visited_at")[:1])
    qs = pool.exclude(pk__in=recent).annotate(last_order=last).order_by(F("last_order").asc(nulls_first=True), "name")
    total = qs.count()
    page = list(qs[:ctx.cap])
    owners = {}
    if f.management and page:
        for o in DealerOwnershipHistory.objects.filter(dealer_id__in=[d.id for d in page], ended_at__isnull=True).select_related("salesman__user"):
            owners[o.dealer_id] = person(o.salesman)
    rows = [{
        "id": d.id, "name": d.name, "location": where(d), "owner": owners.get(d.id, "—" if f.management else ""),
        "last_order": stamp(d.last_order) if d.last_order else "",
        # calendar days, so the figure does not flip by one depending on the time of day the report is opened
        "days": (timezone.localdate() - timezone.localtime(d.last_order).date()).days if d.last_order else None,
        "status": "Never ordered" if d.last_order is None else "Idle",
    } for d in page]
    return rows, total


def dealers(ctx: Ctx):
    f = ctx.f
    raw = by_dealer(f)
    first = {
        r["visit__dealer_id"]: r for r in lines(f, dated=False).values("visit__dealer_id").annotate(first=Min("visit__visited_at"), n=Count("visit_id", distinct=True))
    }
    lo, _ = f.range.bounds() if f.dated else (None, None)

    def kind(d):
        r = first.get(d["id"])
        if r is None:
            return "New"
        # With a start date: new = first ever order falls inside the period. All time has no "before", so repeat = 2+ orders.
        return ("New" if r["first"] >= lo else "Repeat") if lo else ("New" if r["n"] <= 1 else "Repeat")

    for d in raw:
        d["type"] = kind(d)
    n_new = sum(1 for d in raw if d["type"] == "New")
    idle_days = int(ctx.params.get("idle_days", 30)) if str(ctx.params.get("idle_days", "30")).isdigit() else 30
    idle_days = idle_days if idle_days in IDLE_CHOICES else 30
    idle_rows, idle_total = idle_dealers(ctx, idle_days)

    shown = raw[:ctx.cap]
    prefs = _top_products_by_dealer(f, [d["id"] for d in shown])
    rows = [{**d, "last_order": stamp(d["last_order"]), "top_products": prefs.get(d["id"], "")} for d in shown]
    top_rows = lambda key: ranked([{"id": d["id"], "name": d["name"], "qty": d["qty"], "orders": d["orders"]} for d in raw], key,  # noqa: E731
                                  note=lambda r: f"{r['orders'] if key == 'qty' else r['qty']:,} {'orders' if key == 'qty' else 'quantity'}")
    rankings = [
        ranking("top_orders", "Top 10 dealers by orders", "orders", "int", top_rows("orders"), LINK_DEALER),
        ranking("top_qty", "Top 10 dealers by quantity", "quantity", "int", top_rows("qty"), LINK_DEALER),
    ]
    cards = [
        card("dealers", "Dealers who ordered", len(raw)), card("new", "New dealers", n_new, hint="first order inside the period"),
        card("repeat", "Repeat dealers", len(raw) - n_new, hint="ordered before the period too" if lo else "2 or more orders"),
        card("idle", f"No order in {idle_days} days", idle_total, hint="from dealers you can see"),
    ]
    options = [{"key": "idle_days", "label": "No recent order means none in the last", "type": "choice", "value": idle_days,
                "choices": [[str(d), f"{d} days"] for d in IDLE_CHOICES]}]
    pts = [{"id": d["id"], "label": d["name"], "qty": d["qty"], "orders": d["orders"]} for d in raw]
    return payload(
        ctx, "dealer-wise", "Dealer-wise report", cards=cards, rankings=rankings, options=options,
        charts=[chart("dealers", "Dealer comparison", "hbar", top_union(pts), MEASURES, measurable=True, subtitle="Top 10")],
        tables=[
            table("dealers", "Dealer purchases in this period", [
                col("name", "Dealer", "text", link=LINK_DEALER), col("location", "Location", "text"), col("type", "Type", "badge"),
                col("orders", "Orders"), col("qty", "Quantity"), col("products", "Products"), col("last_order", "Last order", "datetime"),
                col("top_products", "Preferred products", "text")], rows, total=len(raw)),
            table("idle", f"Dealers without an order in the last {idle_days} days", [
                col("name", "Dealer", "text", link=LINK_DEALER), col("location", "Location", "text"),
                *([col("owner", "Owner", "text")] if f.management else []), col("status", "Status", "badge"),
                col("last_order", "Last order", "datetime"), col("days", "Days since", "int")], idle_rows, total=idle_total),
        ],
        notes=["New / repeat: a dealer is new when their very first order falls inside the selected period. "
               + ("" if lo else "“All time” has no earlier period, so dealers with 2 or more orders count as repeat. ")
               + "The idle list ignores the date range and looks at today's last " + str(idle_days) + " days."],
    )


def dealer_detail(ctx: Ctx):
    f0 = ctx.f
    dealer = (Dealer.objects.all() if f0.management else accessible_dealers(f0.user)).filter(pk=ctx.pk).first()
    if dealer is None:
        raise NotFound("Dealer not found")  # missing and inaccessible look the same
    f = f0.with_(dealer_id=dealer.id)
    ctx2 = dataclasses.replace(ctx, f=f)
    t = totals(f)
    ever = lines(f, dated=False).aggregate(first=Min("visit__visited_at"), last=Max("visit__visited_at"))
    hist, _ = order_table(ctx2, title="Purchase history", hide=("dealer",))
    prods = by_product(f)
    pts, _ = day_points(daily(f), effective_span(f), keys=("qty", "orders"))
    pr_pts = [{"id": p["key"], "label": p["label"], "qty": p["qty"], "orders": p["orders"]} for p in prods]
    return payload(
        ctx2, "dealer-detail", dealer.name,
        cards=[card("orders", "Orders", t["orders"]), card("qty", "Quantity bought", t["qty"]), card("visits", "Visits", t["visits"]),
               card("products", "Products", t["products"]),
               card("first", "First order", stamp(ever["first"])[:10] or "—", "text"), card("last", "Last order", stamp(ever["last"])[:10] or "—", "text")],
        charts=[chart("daily", "Purchases by day", "line", pts, MEASURES, measurable=True, x="day"),
                chart("products", "Product preferences", "hbar", top_union(pr_pts), MEASURES, measurable=True, subtitle="Top 10")],
        tables=[hist, table("products", "Product preferences", [col("label", "Product", "text"), col("category", "Category", "text"), col("qty", "Quantity"),
                                                                 col("orders", "Orders")], prods[:ctx.cap], total=len(prods))],
        notes=[f"{dealer.name}" + (f", {where(dealer)}" if where(dealer) else "") + ". First / last order are all-time."],
    )


# ───────────────────────────── salesman vs product ─────────────────────────────

def salesman_product(ctx: Ctx):
    f = ctx.f
    qs = (lines(f).annotate(pkey=PKEY).values("visit__salesman_id", "pkey").annotate(
        label=Coalesce(Max("product__name"), Max("product_name")), qty=Sum("quantity"), orders=Count("visit_id", distinct=True),
        dealers=Count("visit__dealer_id", distinct=True)))
    raw = [{"sid": r["visit__salesman_id"], "key": r["pkey"], "product": r["label"], "qty": r["qty"] or 0, "orders": r["orders"], "dealers": r["dealers"]} for r in qs]
    names = salesman_names(r["sid"] for r in raw)
    prod_total, sales_total = defaultdict(int), defaultdict(int)
    for r in raw:
        prod_total[r["key"]] += r["qty"]
        sales_total[r["sid"]] += r["qty"]
    for r in raw:
        r["salesman"] = names.get(r["sid"], "")
        r["share"] = pct(r["qty"], prod_total[r["key"]])
    raw.sort(key=lambda r: (-r["qty"], r["product"].lower(), r["salesman"].lower()))

    by_prod, by_sales = defaultdict(list), defaultdict(list)
    for r in raw:
        by_prod[r["key"]].append(r)
        by_sales[r["sid"]].append(r)
    top_per_product = []
    for key, rs in by_prod.items():
        best = min(rs, key=lambda r: (-r["qty"], -r["orders"], r["salesman"].lower()))
        top_per_product.append({"product": best["product"], "salesman": best["salesman"], "sid": best["sid"], "qty": best["qty"],
                                "orders": best["orders"], "share": best["share"], "sellers": len(rs), "total": prod_total[key], "key": key})
    top_per_product.sort(key=lambda r: (-r["total"], r["product"].lower()))
    best_per_salesman = []
    for sid, rs in by_sales.items():
        top3 = sorted(rs, key=lambda r: (-r["qty"], r["product"].lower()))[:3]
        best_per_salesman.append({"id": sid, "name": names.get(sid, ""), "qty": sales_total[sid], "products": len(rs),
                                  "top_products": ", ".join(f"{r['product']} ({r['qty']:,})" for r in top3)})
    best_per_salesman.sort(key=lambda r: (-r["qty"], r["name"].lower()))

    cards = []
    if best_per_salesman:
        top = best_per_salesman[0]
        cards.append(card("top", "Highest overall product sales", top["name"], "text", hint=f"quantity {top['qty']:,} across {top['products']} products"))
    cards.append(card("pairs", "Salesman × product pairs", len(raw)))
    cards.append(card("products", "Products sold", len(prod_total)))

    mgmt = f.management
    tables = [
        table("matrix", "Which salesman sells which product", [
            *([col("salesman", "Salesman", "text", link={"path": "/reports/salesman-wise/{sid}", "search": "preset=all"})] if mgmt else []),
            col("product", "Product", "text"), col("qty", "Quantity"), col("orders", "Orders"), col("dealers", "Dealers"),
            *([col("share", "Share of product", "pct")] if mgmt else [])], raw[:ctx.cap], total=len(raw)),
    ]
    charts = []
    if mgmt:
        tables.insert(0, table("top_product", "Top salesman for each product", [
            col("product", "Product", "text"), col("salesman", "Top salesman", "text", link={"path": "/reports/salesman-wise/{sid}", "search": "preset=all"}),
            col("qty", "Their quantity"), col("share", "Share of product", "pct"), col("total", "Product total"), col("sellers", "Salesmen selling it")],
            top_per_product[:ctx.cap], total=len(top_per_product)))
        pts = [{"id": r["key"], "label": f"{r['product']} — {r['salesman']}", "qty": r["qty"], "orders": r["orders"]} for r in top_per_product]
        charts = [chart("top_product", "Top salesman per product", "hbar", top_union(pts, n=12), MEASURES, measurable=True, subtitle="Top 12 by quantity")]
    tables.append(table("best_products", "Best products for each salesman", [
        col("name", "Salesman", "text", link=LINK_SALESMAN), col("qty", "Total quantity"), col("products", "Products"), col("top_products", "Top products", "text")],
        best_per_salesman[:ctx.cap], total=len(best_per_salesman)))
    return payload(
        ctx, "salesman-product", "Salesman vs product analysis", cards=cards, charts=charts, tables=tables,
        notes=["Use the Product filter to see who sells one product the most. Share of product is the salesman's part of that product's total quantity."],
    )
