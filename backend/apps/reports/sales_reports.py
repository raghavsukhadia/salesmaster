"""Overview, date-wise, monthly/yearly, order-wise and product-wise reports."""
from collections import defaultdict

from django.db.models import Count, Max, Q, Sum

from apps.accounts.models import Salesman
from apps.dealers.access import accessible_dealers
from apps.dealers.models import Dealer
from apps.visits.models import Product, Visit

from .aggregates import UNCATEGORISED, by_dealer, by_product, by_salesman, category_totals
from .common import (
    MEASURES, Ctx, PAGE_SIZE, card, change_pct, chart, col, daily, day_points, effective_span, month_points,
    monthly, payload, ratio, stamp, table, totals, unit_table, where, year_points, yearly,
)
from .scope import lines

TOP_N = 10


def top_union(rows, key_a="qty", key_b="orders", n=TOP_N):
    """Top-n by each measure, so the on-screen Quantity / Orders switch always has a full ranking to show."""
    a = sorted(rows, key=lambda r: (-r[key_a], r["label"].lower()))[:n]
    b = sorted(rows, key=lambda r: (-r[key_b], r["label"].lower()))[:n]
    seen, out = set(), []
    for r in a + b:
        if r["id"] not in seen:
            seen.add(r["id"])
            out.append(r)
    return out


def overview(ctx: Ctx):
    f = ctx.f
    t = totals(f)
    span = effective_span(f)
    d_pts, d_cut = day_points(daily(f), span, keys=("qty", "orders"))
    m_pts, m_cut = month_points(monthly(f), span, keys=("qty", "orders"))
    y_pts = year_points(yearly(f), span, keys=("qty", "orders"))

    total_dealers = (Dealer.objects.all() if f.management else accessible_dealers(f.user)).filter(is_archived=False).count()
    cards = [
        card("orders", "Total orders", t["orders"], hint="Visits that recorded an order"),
        card("qty", "Products sold", t["qty"], hint=f"quantity across {t['products']} product{'s' if t['products'] != 1 else ''}"),
        card("visits", "Total visits", t["visits"], hint=f"{t['dealers_visited']} dealers visited"),
        card("conversion", "Visit → order rate", t["conversion"], "pct", hint=f"{t['orders']} of {t['visits']} visits"),
        card("dealers", "Dealers visited", t["dealers_visited"], hint=f"of {total_dealers} dealers · {t['dealers_ordered']} ordered"),
    ]
    if f.management and not f.salesman_id:
        cards.append(card("salesmen", "Active salesmen", t["salesmen_visiting"], hint=f"of {Salesman.objects.filter(is_active=True).count()} salesmen"))

    charts = [
        chart("daily", "Daily sales", "line", d_pts, MEASURES, measurable=True, x="day",
              note=f"Showing the most recent {len(d_pts)} days of the period." if d_cut else ""),
        chart("monthly", "Monthly sales", "column", m_pts, MEASURES, measurable=True, x="month",
              note="Showing the most recent 36 months." if m_cut else ""),
        chart("yearly", "Yearly sales", "column", y_pts, MEASURES, measurable=True, x="year"),
    ]
    if f.management and not f.salesman_id:
        sm = [{"id": s["id"], "label": s["name"], "qty": s["qty"], "orders": s["orders"]} for s in by_salesman(f, include_idle=False)]
        charts.append(chart("salesmen", "Salesman performance", "hbar", top_union(sm), MEASURES, measurable=True, subtitle="Top 10"))
    pr = [{"id": p["key"], "label": p["label"], "qty": p["qty"], "orders": p["orders"]} for p in by_product(f)]
    charts.append(chart("products", "Top-selling products", "hbar", top_union(pr), MEASURES, measurable=True, subtitle="Top 10"))
    dl = by_dealer(f)
    dl_rows = [{"id": d["id"], "label": d["name"], "qty": d["qty"], "orders": d["orders"]} for d in dl]
    charts.append(chart("dealers", "Dealer-wise sales", "hbar", top_union(dl_rows), MEASURES, measurable=True, subtitle="Top 10"))
    return payload(ctx, "overview", "Overview", cards=cards, charts=charts, tables=[t for t in (unit_table(f),) if t])


def date_wise(ctx: Ctx):
    f = ctx.f
    data = daily(f)
    span = effective_span(f)
    pts, cut = day_points(data, span, keys=("qty", "orders"))
    t = totals(f)
    rows = [
        {"date": d.isoformat(), "weekday": d.strftime("%a"), "orders": v["orders"], "qty": v["qty"], "visits": v["visits"], "dealers": v["dealers"]}
        for d, v in sorted(data.items(), reverse=True) if v["orders"] or v["visits"]
    ]
    cols = [col("date", "Date", "date"), col("weekday", "Day", "text"), col("orders", "Orders"), col("qty", "Quantity sold"),
            col("visits", "Visits"), col("dealers", "Dealers ordering")]
    totals_row = {"date": "Total", "orders": t["orders"], "qty": t["qty"], "visits": t["visits"], "dealers": t["dealers_ordered"]}
    cards = [card("orders", "Orders", t["orders"]), card("qty", "Quantity sold", t["qty"]), card("visits", "Visits", t["visits"]),
             card("days", "Days with orders", sum(1 for v in data.values() if v["orders"]), hint=f"{len(rows)} days with any activity")]
    return payload(
        ctx, "date-wise", "Date-wise sales", cards=cards,
        charts=[chart("daily", "Sales by day", "line", pts, MEASURES, measurable=True, x="day",
                      note=f"Chart shows the most recent {len(pts)} days; the table lists every day." if cut else "")],
        tables=[table("daily", "Day by day", cols, rows[:ctx.cap], total=len(rows), totals=totals_row)],
    )


def _period_rows(points, label_key="label"):
    """Ascending points -> rows with change vs the previous period (None for the first)."""
    rows, prev = [], None
    for p in points:
        rows.append({
            "period": p[label_key], "orders": p["orders"], "qty": p["qty"], "visits": p["visits"], "dealers": p["dealers"],
            "qty_change": change_pct(prev["qty"], p["qty"]) if prev else None,
            "orders_change": change_pct(prev["orders"], p["orders"]) if prev else None,
        })
        prev = p
    return rows[::-1]


def periods(ctx: Ctx):
    f = ctx.f
    span = effective_span(f)
    keys = ("qty", "orders", "visits", "dealers")
    m_pts, m_cut = month_points(monthly(f), span, keys=keys, cap=120)
    y_pts = year_points(yearly(f), span, keys=keys)
    t = totals(f)

    def cols(kind):
        return [col("period", kind[0], kind[1]), col("orders", "Orders"), col("qty", "Quantity sold"), col("visits", "Visits"),
                col("dealers", "Dealers ordering"), col("orders_change", "Orders vs prev.", "change"), col("qty_change", "Quantity vs prev.", "change")]

    return payload(
        ctx, "periods", "Monthly / yearly sales",
        cards=[card("orders", "Orders", t["orders"]), card("qty", "Quantity sold", t["qty"]),
               card("months", "Months covered", len(m_pts)), card("years", "Years covered", len(y_pts))],
        charts=[
            chart("monthly", "Monthly sales", "column", m_pts[-36:], MEASURES, measurable=True, x="month",
                  note="Chart shows the most recent 36 months; the table lists them all." if len(m_pts) > 36 else ""),
            chart("yearly", "Yearly sales", "column", y_pts, MEASURES, measurable=True, x="year"),
        ],
        tables=[
            table("monthly", "Month by month", cols(("Month", "month")), _period_rows(m_pts)),
            table("yearly", "Year by year", cols(("Year", "text")), _period_rows(y_pts)),
        ],
        notes=["“vs prev.” compares each period with the one before it inside the selected range; the first period has nothing to compare with."],
    )


def order_table(ctx: Ctx, *, title="Orders", hide=()):
    """The paged / searchable order list, shared by the Order-wise report and the salesman / dealer history pages.
    Returns (table, aggregate) where aggregate has the orders, quantity and dealers of the *searched* list."""
    f = ctx.f
    base = lines(f)
    q = (ctx.params.get("q") or "").strip()[:100]
    if q:
        cond = (Q(visit__dealer__name__icontains=q) | Q(visit__dealer__phone__icontains=q) | Q(visit__dealer__city__icontains=q)
                | Q(visit__salesman__user__first_name__icontains=q) | Q(visit__salesman__user__last_name__icontains=q)
                | Q(visit__salesman__user__username__icontains=q) | Q(visit__salesman_name__icontains=q) | Q(product_name__icontains=q))
        digits = q.lstrip("#")
        if digits.isdigit() and len(digits) <= 12:
            cond |= Q(visit_id=int(digits))
        base = base.filter(cond)

    agg = base.aggregate(qty=Sum("quantity"), orders=Count("visit_id", distinct=True), dealers=Count("visit__dealer_id", distinct=True))
    n_orders = agg["orders"] or 0
    grouped = base.values("visit_id").annotate(at=Max("visit__visited_at")).order_by("-at", "-visit_id")
    if ctx.export:
        ids = [r["visit_id"] for r in grouped[:ctx.cap]]
        page, size = 1, max(1, len(ids))
    else:
        page, size = ctx.page(), PAGE_SIZE
        ids = [r["visit_id"] for r in grouped[(page - 1) * size: page * size]]

    visit_map = {v.id: v for v in Visit.objects.filter(id__in=ids).select_related("salesman__user", "dealer")}
    items, qty_by = defaultdict(list), defaultdict(int)
    for ln in lines(f).filter(visit_id__in=ids).select_related("product").order_by("id"):
        name = ln.product.name if ln.product_id else ln.product_name
        items[ln.visit_id].append(f"{name} × {ln.quantity}")
        qty_by[ln.visit_id] += ln.quantity
    visit_path = "/visits/{order_id}" if f.management else "/visit-history/{order_id}"
    rows = []
    for vid in ids:
        v = visit_map.get(vid)
        if v is None:
            continue
        rows.append({
            "order_id": vid, "date": stamp(v.visited_at), "salesman": v.salesman_name, "salesman_id": v.salesman_id,
            "dealer": v.dealer.name, "dealer_id": v.dealer_id, "location": where(v.dealer),
            "items": ", ".join(items[vid]), "lines": len(items[vid]), "qty": qty_by[vid],
        })
    cols = [col("order_id", "Order ID", "order", link={"path": visit_path}), col("date", "Date", "datetime")]
    if f.management and "salesman" not in hide:
        cols.append(col("salesman", "Salesman", "text", link={"path": "/reports/salesman-wise/{salesman_id}", "search": "preset=all"}))
    if "dealer" not in hide:
        cols += [col("dealer", "Dealer", "text", link={"path": "/reports/dealer-wise/{dealer_id}", "search": "preset=all"}),
                 col("location", "Location", "text")]
    cols += [col("items", "Items", "text"), col("lines", "Lines"), col("qty", "Quantity")]
    tbl = table("orders", title, cols, rows, total=n_orders)
    tbl.update({"server": True, "page": page, "page_size": size})
    return tbl, {"orders": n_orders, "qty": agg["qty"] or 0, "dealers": agg["dealers"] or 0}


def orders(ctx: Ctx):
    f = ctx.f
    tbl, a = order_table(ctx)
    return payload(
        ctx, "order-wise", "Order-wise report",
        cards=[card("orders", "Orders", a["orders"]), card("qty", "Quantity sold", a["qty"]),
               card("dealers", "Dealers", a["dealers"]), card("avg", "Avg quantity per order", ratio(a["qty"], a["orders"]), "dec")],
        tables=[tbl],
        notes=["An order is one visit that recorded at least one product line; its Order ID is the visit number."]
        + (["The date range is ignored while an Order ID is set."] if f.order_id else []),
    )


def products(ctx: Ctx):
    f = ctx.f
    rows = by_product(f)
    cats = category_totals(f)
    total_qty = sum(r["qty"] for r in rows)

    cards = []
    if rows:
        most = rows[0]
        least = sorted(rows, key=lambda r: (r["qty"], r["orders"], r["label"].lower()))[0]
        freq = sorted(rows, key=lambda r: (-r["orders"], -r["qty"], r["label"].lower()))[0]
        cards = [
            card("most", "Most-selling product", most["label"], "text", hint=f"quantity {most['qty']:,}"),
            card("least", "Least-selling product", least["label"], "text", hint=f"quantity {least['qty']:,}"),
            card("freq", "Most frequently ordered", freq["label"], "text", hint=f"in {freq['orders']:,} orders"),
            card("cat", "Best-selling category", cats[0]["label"], "text", hint=f"quantity {cats[0]['qty']:,}"),
            card("count", "Products sold", len(rows), hint=f"quantity {total_qty:,} in total"),
        ]
    table_rows = [{**r, "share": round(100.0 * r["qty"] / total_qty, 1) if total_qty else 0.0, "kind": "Custom" if r["custom"] else "Catalogue"} for r in rows]

    out_tables = [
        table("products", "Product-wise sales", [
            col("label", "Product", "text"), col("category", "Category", "text"), col("kind", "Type", "text"), col("qty", "Quantity sold"),
            col("orders", "Orders"), col("dealers", "Dealers"), col("salesmen", "Salesmen"), col("share", "Share of quantity", "pct")],
            table_rows[:ctx.cap], total=len(table_rows), totals={"label": "Total", "qty": total_qty}),
        table("categories", "Category-wise sales", [col("label", "Category", "text"), col("products", "Products"), col("qty", "Quantity sold"),
                                                     col("orders", "Orders"), col("dealers", "Dealers")], cats, compact=True),
    ]
    # Catalogue products with no sales in the period: only meaningful when no product filter narrows the list.
    if not f.product:
        sold = {r["key"] for r in rows}
        pool = Product.objects.filter(is_active=True)
        if f.category:
            pool = pool.filter(category__iexact=f.category)
        idle = [{"label": p.name, "category": p.category or UNCATEGORISED} for p in pool.order_by("name") if f"p{p.id}" not in sold]
        out_tables.append(table("unsold", "Catalogue products with no sales in this period", [col("label", "Product", "text"), col("category", "Category", "text")],
                                idle[:ctx.cap], total=len(idle), compact=True))

    if (ut := unit_table(f)):
        out_tables.append(ut)
    pr = [{"id": r["key"], "label": r["label"], "qty": r["qty"], "orders": r["orders"]} for r in rows]
    ct = [{"id": c["label"], "label": c["label"], "qty": c["qty"], "orders": c["orders"]} for c in cats]
    return payload(
        ctx, "product-wise", "Product-wise report", cards=cards,
        charts=[chart("products", "Product comparison", "hbar", top_union(pr, n=12), MEASURES, measurable=True, subtitle="Top 12"),
                chart("categories", "Category comparison", "hbar", top_union(ct), MEASURES, measurable=True)],
        tables=out_tables,
        notes=["Products added by salesmen as free text are grouped by name, ignoring capital letters, and labelled Custom."],
    )
