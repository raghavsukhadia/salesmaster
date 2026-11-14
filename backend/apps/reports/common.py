"""Payload shape shared by every report, and the aggregation primitives they reuse.

A report is a function `build(ctx) -> dict` returning:

    {report, title, meta, cards, charts, tables, rankings, options, notes}

The screen renders it generically and the Excel / PDF export walks the same dict, so an export can never disagree
with what the user is looking at.
"""
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from django.db.models import Count, Max, Min, Sum
from django.db.models.functions import TruncDate, TruncMonth, TruncYear
from django.utils import timezone

from apps.accounts.models import Salesman
from apps.dealers.models import Dealer
from apps.management.views import person

from .scope import PKEY, Filters, lines, product_label, visits

PAGE_SIZE = 25
SCREEN_CAP = 1000  # rows per table sent to the browser; Excel / PDF exports lift it
EXPORT_CAP = 100_000
DAILY_POINTS = 92  # a daily chart longer than this shows the most recent window


@dataclass
class Ctx:
    f: Filters
    params: object  # request.query_params
    export: bool = False
    pk: int | None = None

    @property
    def cap(self) -> int:
        return EXPORT_CAP if self.export else SCREEN_CAP

    def page(self) -> int:
        raw = self.params.get("page", "1")
        return max(1, int(raw)) if str(raw).isdigit() else 1


def pct(n, d) -> float:
    return round(100.0 * n / d, 1) if d else 0.0


def ratio(n, d) -> float:
    return round(n / d, 1) if d else 0.0


def change_pct(old, new):
    """Growth from `old` to `new` in percent; None when there is no base to compare against."""
    if not old:
        return None
    return round(100.0 * (new - old) / old, 1)


def card(key, label, value, fmt="int", hint=""):
    return {"key": key, "label": label, "value": value, "format": fmt, "hint": hint}


def col(key, label, kind="int", link=None):
    c = {"key": key, "label": label, "kind": kind}
    if link:
        c["link"] = link
    return c


def table(id, title, columns, rows, *, subtitle="", total=None, totals=None, compact=False, search=True):
    return {
        "id": id, "title": title, "subtitle": subtitle, "columns": columns, "rows": rows,
        "total": len(rows) if total is None else total, "totals": totals, "compact": compact, "search": search,
    }


def day(d) -> str:
    return d.isoformat() if d else ""


def stamp(dt) -> str:
    return timezone.localtime(dt).strftime("%Y-%m-%d %H:%M") if dt else ""


def salesman_names(ids) -> dict:
    return {s.id: person(s) for s in Salesman.objects.filter(pk__in=set(ids)).select_related("user")}


def dealer_info(ids) -> dict:
    return {d.id: d for d in Dealer.objects.filter(pk__in=set(ids))}


def where(d) -> str:
    return ", ".join(x for x in (d.city, d.state) if x)


def describe_filters(f: Filters) -> list[dict]:
    out = [{"label": "Period", "value": f.range.label if f.dated else "Ignored (Order ID set)"}]
    if f.range.start and f.dated:
        out[0]["value"] += f" ({f.range.start:%d %b %Y} – {(f.range.end or timezone.localdate()):%d %b %Y})"
    if f.management and f.salesman_id:
        out.append({"label": "Salesman", "value": salesman_names([f.salesman_id]).get(f.salesman_id, "Unknown")})
    if f.dealer_id:
        d = Dealer.objects.filter(pk=f.dealer_id).first()
        out.append({"label": "Dealer", "value": d.name if d else "Unknown"})
    if f.product:
        out.append({"label": "Product", "value": product_label(f.product)})
    if f.category:
        out.append({"label": "Category", "value": f.category})
    if f.unit:
        out.append({"label": "Unit", "value": f.unit})
    if f.order_id:
        out.append({"label": "Order ID", "value": f"#{f.order_id}"})
    return out


def unit_mix(*fs: Filters) -> list[dict]:
    """Which units the matching order lines use, with their totals. Quantities in different units must not be added up
    (5 kg + 3 rolls is not 8 of anything), so every quantity report checks this and warns when it is mixed."""
    acc: dict = {}
    for f in fs:
        for r in lines(f).order_by().values("unit").annotate(q=Sum("quantity"), n=Count("id"), orders=Count("visit_id", distinct=True)):
            a = acc.setdefault(r["unit"], {"unit": r["unit"], "quantity": 0, "lines": 0, "orders": 0})
            a["quantity"] += r["q"] or 0
            a["lines"] += r["n"]
            a["orders"] += r["orders"]
    return sorted(acc.values(), key=lambda u: (-u["lines"], u["unit"]))


def unit_table(f: Filters):
    rows = unit_mix(f)
    if not rows:
        return None
    return table("units", "Quantity by unit", [col("unit", "Unit", "text"), col("quantity", "Quantity"), col("orders", "Orders"), col("lines", "Order lines")], rows,
                 subtitle="Each unit is counted on its own", compact=True, search=False)


def payload(ctx: Ctx, report, title, *, cards=(), charts=(), tables=(), rankings=(), options=(), notes=(), quantity=True, scopes=None):
    """`quantity=False` for reports that show no quantities (visits, follow-ups, targets): they skip the mixed-unit check.
    `scopes` lists every filter set the report reads from when it reads from several (a comparison reads from two)."""
    f = ctx.f
    names = [u["unit"] for u in unit_mix(*(scopes or [f]))] if quantity else []
    mixed = len(names) > 1
    start, end = f.range.start, f.range.end
    return {
        "report": report,
        "title": title,
        "meta": {
            "range": {"preset": f.range.preset, "from": day(start), "to": day(end or (timezone.localdate() if start else None)), "label": f.range.label},
            "filters": describe_filters(f),
            "scope": "company" if f.management else "own",
            "generated_at": timezone.now().isoformat(),
            "units": names, "unit": "mixed" if mixed else (names[0] if names else ""),
        },
        "warnings": [f"Quantities are recorded in different units ({', '.join(names)}), and a total adds them together, which only makes sense within one unit. "
                     "Choose a Unit in the filters to compare like with like."] if mixed else [],
        "cards": list(cards), "charts": list(charts), "tables": list(tables),
        "rankings": list(rankings), "options": list(options), "notes": list(notes),
    }


# ───────────────────────────── aggregation primitives ─────────────────────────────

def totals(f: Filters) -> dict:
    """Headline numbers. Lines and visits are two separate aggregates, never joined."""
    ln = lines(f).aggregate(
        qty=Sum("quantity"), orders=Count("visit_id", distinct=True), dealers=Count("visit__dealer_id", distinct=True),
        salesmen=Count("visit__salesman_id", distinct=True), products=Count(PKEY, distinct=True),
    )
    vs = visits(f).aggregate(visits=Count("id"), dealers=Count("dealer_id", distinct=True), salesmen=Count("salesman_id", distinct=True))
    orders = ln["orders"] or 0
    return {
        "qty": ln["qty"] or 0, "orders": orders, "dealers_ordered": ln["dealers"] or 0, "salesmen_selling": ln["salesmen"] or 0,
        "products": ln["products"] or 0, "visits": vs["visits"] or 0, "dealers_visited": vs["dealers"] or 0,
        "salesmen_visiting": vs["salesmen"] or 0,
        # orders are a subset of visits under the same filters, so this can never exceed 100%
        "conversion": pct(orders, vs["visits"] or 0),
        "avg_qty": ratio(ln["qty"] or 0, orders),
    }


def _as_date(v):
    if isinstance(v, datetime):
        return timezone.localtime(v).date() if timezone.is_aware(v) else v.date()
    return v


def effective_span(f: Filters) -> tuple[date | None, date | None]:
    """The period a chart should cover. 'All time' (open start) uses the first recorded visit."""
    start, end = f.range.start, f.range.end
    if not f.dated:
        agg = visits(f, dated=False).aggregate(lo=Min("visited_at"), hi=Max("visited_at"))
        return (_as_date(agg["lo"]), _as_date(agg["hi"])) if agg["lo"] else (None, None)
    today = timezone.localdate()
    if start is None:
        lo = visits(f).aggregate(lo=Min("visited_at"))["lo"]
        start = _as_date(lo) if lo else None
    return start, end or today


def sales_by_period(f: Filters, trunc):
    """{bucket_date: {qty, orders, dealers, visits}} for a Trunc* function over the visit date."""
    out: dict = {}
    for r in (lines(f).annotate(b=trunc("visit__visited_at")).values("b")
              .annotate(qty=Sum("quantity"), orders=Count("visit_id", distinct=True), dealers=Count("visit__dealer_id", distinct=True))):
        out[_as_date(r["b"])] = {"qty": r["qty"] or 0, "orders": r["orders"], "dealers": r["dealers"], "visits": 0}
    for r in visits(f).annotate(b=trunc("visited_at")).values("b").annotate(n=Count("id")):
        out.setdefault(_as_date(r["b"]), {"qty": 0, "orders": 0, "dealers": 0, "visits": 0})["visits"] = r["n"]
    return out


def daily(f: Filters):
    return sales_by_period(f, TruncDate)


def monthly(f: Filters):
    return sales_by_period(f, TruncMonth)


def yearly(f: Filters):
    return sales_by_period(f, TruncYear)


def day_points(data: dict, span, keys=("qty", "orders", "visits")):
    """A gap-free daily series (zero days included) limited to the most recent DAILY_POINTS days."""
    start, end = span
    if start is None or end is None:
        return [], False
    truncated = (end - start).days + 1 > DAILY_POINTS
    if truncated:
        start = end - timedelta(days=DAILY_POINTS - 1)
    pts, d = [], start
    while d <= end:
        row = data.get(d, {})
        pts.append({"label": d.isoformat(), **{k: row.get(k, 0) for k in keys}})
        d += timedelta(days=1)
    return pts, truncated


def month_points(data: dict, span, keys=("qty", "orders", "visits"), cap=36):
    start, end = span
    if start is None or end is None:
        return [], False
    y, m = start.year, start.month
    pts = []
    while (y, m) <= (end.year, end.month):
        d = date(y, m, 1)
        row = data.get(d, {})
        pts.append({"label": f"{y}-{m:02d}", **{k: row.get(k, 0) for k in keys}})
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    truncated = len(pts) > cap
    return pts[-cap:], truncated


def year_points(data: dict, span, keys=("qty", "orders", "visits")):
    start, end = span
    if start is None or end is None:
        return []
    return [{"label": str(y), **{k: data.get(date(y, 1, 1), {}).get(k, 0) for k in keys}} for y in range(start.year, end.year + 1)]


def chart(id, title, kind, points, series, *, subtitle="", measurable=False, note="", x="text"):
    """kind: line | column | hbar | segments | compare. `series` = [{key, label}].
    `x` says how the browser should format point labels: day (YYYY-MM-DD), month (YYYY-MM), year or text.
    `measurable` charts can be switched between the MEASURES keys on screen (one axis, one measure at a time)."""
    return {"id": id, "title": title, "subtitle": subtitle, "type": kind, "series": series, "points": points,
            "measurable": measurable, "note": note, "x": x}


MEASURES = [{"key": "qty", "label": "Quantity sold"}, {"key": "orders", "label": "Orders"}]
