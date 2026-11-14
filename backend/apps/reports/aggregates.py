"""Grouped figures shared by several reports. Each helper runs one query on order lines and one on visits and merges
them in Python, so nothing is ever joined across lines, visits and follow-ups."""
from django.db.models import Count, Max, Sum, Value
from django.db.models.functions import Coalesce

from apps.accounts.models import Salesman

from .common import dealer_info, pct, ratio, salesman_names, where
from .scope import PKEY, Filters, lines, visits

UNCATEGORISED = "Uncategorised"


def by_salesman(f: Filters, *, include_idle: bool = True) -> list[dict]:
    vs = {r["salesman_id"]: r for r in visits(f).values("salesman_id").annotate(n=Count("id"), dealers=Count("dealer_id", distinct=True))}
    ls = {
        r["visit__salesman_id"]: r
        for r in lines(f).values("visit__salesman_id").annotate(
            qty=Sum("quantity"), orders=Count("visit_id", distinct=True), dealers=Count("visit__dealer_id", distinct=True))
    }
    ids = set(vs) | set(ls)
    if include_idle:
        if f.salesman_id:
            ids.add(f.salesman_id)
        elif f.management:
            ids |= set(Salesman.objects.filter(is_active=True).values_list("id", flat=True))
    names = salesman_names(ids)
    rows = []
    for sid in ids:
        v, l = vs.get(sid, {}), ls.get(sid, {})
        n_visits, orders, qty = v.get("n", 0), l.get("orders", 0), l.get("qty") or 0
        rows.append({
            "id": sid, "name": names.get(sid, f"Salesman {sid}"), "visits": n_visits, "orders": orders, "qty": qty,
            "dealers_visited": v.get("dealers", 0), "dealers_ordered": l.get("dealers", 0),
            "avg_qty": ratio(qty, orders), "conversion": pct(orders, n_visits),
        })
    return rows


def by_product(f: Filters) -> list[dict]:
    rows = []
    qs = (lines(f).annotate(pkey=PKEY).values("pkey").annotate(
        label=Coalesce(Max("product__name"), Max("product_name")), category=Coalesce(Max("product__category"), Value("")),
        qty=Sum("quantity"), orders=Count("visit_id", distinct=True), dealers=Count("visit__dealer_id", distinct=True),
        salesmen=Count("visit__salesman_id", distinct=True)))
    for r in qs:
        rows.append({
            "key": r["pkey"], "label": r["label"], "category": r["category"] or UNCATEGORISED, "custom": r["pkey"].startswith("n:"),
            "qty": r["qty"] or 0, "orders": r["orders"], "dealers": r["dealers"], "salesmen": r["salesmen"],
        })
    rows.sort(key=lambda x: (-x["qty"], x["label"].lower()))
    return rows


def category_totals(f: Filters) -> list[dict]:
    """Exact per-category quantity, orders and dealers (an order with two products of one category counts once)."""
    qs = (lines(f).annotate(cat=Coalesce("product__category", Value(""))).values("cat")
          .annotate(qty=Sum("quantity"), orders=Count("visit_id", distinct=True), dealers=Count("visit__dealer_id", distinct=True),
                    products=Count(PKEY, distinct=True)))
    rows = [{"label": r["cat"] or UNCATEGORISED, "qty": r["qty"] or 0, "orders": r["orders"], "dealers": r["dealers"], "products": r["products"]} for r in qs]
    rows.sort(key=lambda x: (-x["qty"], x["label"].lower()))
    return rows


def by_dealer(f: Filters, limit: int | None = None) -> list[dict]:
    qs = (lines(f).values("visit__dealer_id").annotate(
        qty=Sum("quantity"), orders=Count("visit_id", distinct=True), products=Count(PKEY, distinct=True), last=Max("visit__visited_at"))
        .order_by("-qty", "-orders", "visit__dealer_id"))
    if limit:
        qs = qs[:limit]
    raw = list(qs)
    info = dealer_info(r["visit__dealer_id"] for r in raw)
    out = []
    for r in raw:
        d = info.get(r["visit__dealer_id"])
        out.append({
            "id": r["visit__dealer_id"], "name": d.name if d else "Unknown", "location": where(d) if d else "",
            "qty": r["qty"] or 0, "orders": r["orders"], "products": r["products"], "last_order": r["last"],
        })
    return out
