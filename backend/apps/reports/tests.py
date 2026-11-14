"""Reports are read-only, so these tests build one small world with hand-computed answers and check every report
against it: filters together, role scoping, no double counting, exports that obey the filters."""
import io
from datetime import date, datetime, time, timedelta

import pytest
from django.utils import timezone
from openpyxl import load_workbook
from rest_framework.exceptions import ValidationError
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, User
from apps.dealers.models import Dealer, DealerOwnershipHistory
from apps.reports.ranges import resolve_range
from apps.visits.models import Followup, Product, Visit, VisitOrderItem

pytestmark = pytest.mark.django_db


# ───────────────────────────── the world ─────────────────────────────

def at(days_ago: int, hour: int = 12) -> datetime:
    d = timezone.localdate() - timedelta(days=days_ago)
    return datetime.combine(d, time(hour), tzinfo=timezone.get_current_timezone())


def iso(days_ago: int) -> str:
    return (timezone.localdate() - timedelta(days=days_ago)).isoformat()


# Period used by most tests: 25 to 5 days ago. Contains V1, V2, V3, V4 and nothing else.
R = {"preset": "custom", "from": iso(25), "to": iso(5)}


def make_user(name, role):
    return User.objects.create(username=name, first_name=name.title(), role=role)


def make_salesman(name, phone):
    return Salesman.objects.create(user=make_user(name, Role.SALESMAN), phone_number=phone)


def client_for(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


def get(c, slug, **params):
    r = c.get(f"/api/reports/{slug}/", params)
    assert r.status_code == 200, (slug, params, r.status_code, getattr(r, "data", None))
    return r.json()


def tbl(data, id):
    return next(t for t in data["tables"] if t["id"] == id)


def card_of(data, key):
    return next(c for c in data["cards"] if c["key"] == key)["value"]


def visit(sm, dealer, days, lines=(), hour=12):
    v = Visit.objects.create(salesman=sm, dealer=dealer, visited_at=at(days, hour))
    for product, qty in lines:
        if isinstance(product, Product):
            VisitOrderItem.objects.create(visit=v, product=product, product_name=product.name, quantity=qty)
        else:
            VisitOrderItem.objects.create(visit=v, product_name=product, quantity=qty)
    return v


@pytest.fixture
def world():
    admin, manager = make_user("admin", Role.ADMIN), make_user("manager", Role.MANAGER)
    amol, bina = make_salesman("amol", "9000000001"), make_salesman("bina", "9000000002")
    d1 = Dealer.objects.create(name="Alpha Motors", city="Pune", state="MH")
    d2 = Dealer.objects.create(name="Beta Garage", city="Mumbai", state="MH")
    d3 = Dealer.objects.create(name="Gamma Autos", city="Pune", state="MH")
    d5 = Dealer.objects.create(name="Epsilon Wraps", city="Nashik", state="MH")
    for d, s in ((d1, amol), (d3, amol), (d5, amol), (d2, bina)):
        DealerOwnershipHistory.objects.create(dealer=d, salesman=s)
    pa = Product.objects.create(name="Film A", category="Window Film")
    pb = Product.objects.create(name="Film B", category="PPF")
    Product.objects.create(name="Film Z", category="PPF")  # never sold

    v6 = visit(amol, d1, 50, [(pa, 1)])  # before the period: makes Alpha a repeat dealer
    v1 = visit(amol, d1, 20, [(pa, 4), (pb, 6)])  # one order, two lines
    v2 = visit(amol, d1, 12, [(pa, 10)])
    v3 = visit(amol, d3, 12)  # a visit without an order
    v4 = visit(bina, d2, 11, [(pb, 5), ("Custom Tint", 2)])
    v5 = visit(bina, d2, 2, [(pa, 3)])  # after the period
    v7 = visit(amol, d5, 45, [(pb, 2)])  # an old order: Epsilon is idle for 30 days

    # Two follow-ups hang off V1. A join between lines and follow-ups would double V1's units; the reports must not.
    Followup.objects.create(dealer=d1, salesman=amol, visit=v1, due_date=timezone.localdate() - timedelta(days=15), status="completed", created_at=at(20) + timedelta(minutes=1))
    Followup.objects.create(dealer=d1, salesman=amol, visit=v1, due_date=timezone.localdate() + timedelta(days=30), created_at=at(20) + timedelta(minutes=2))
    Followup.objects.create(dealer=d3, salesman=amol, visit=v3, due_date=timezone.localdate() - timedelta(days=14), created_at=at(12) + timedelta(minutes=1))  # overdue, never converted
    Followup.objects.create(dealer=d2, salesman=bina, due_date=timezone.localdate() - timedelta(days=5), status="cancelled", created_at=at(14))
    # created BEFORE its own visit, which has an order: that visit must not count as the follow-up's conversion
    Followup.objects.create(dealer=d1, salesman=amol, visit=v2, due_date=timezone.localdate() - timedelta(days=10), created_at=at(12) - timedelta(hours=1))
    return dict(admin=admin, manager=manager, amol=amol, bina=bina, d1=d1, d2=d2, d3=d3, d5=d5, pa=pa, pb=pb,
                v1=v1, v2=v2, v3=v3, v4=v4, v5=v5, v6=v6, v7=v7)


@pytest.fixture
def adm(world):
    return client_for(world["admin"])


# ───────────────────────────── date presets ─────────────────────────────

TODAY = date(2026, 11, 14)


@pytest.mark.parametrize("preset,start,end", [
    ("today", date(2026, 11, 14), date(2026, 11, 14)),
    ("yesterday", date(2026, 11, 13), date(2026, 11, 13)),
    ("last7", date(2026, 11, 8), date(2026, 11, 14)),
    ("last30", date(2026, 10, 16), date(2026, 11, 14)),
    ("this_month", date(2026, 11, 1), date(2026, 11, 14)),
    ("last_month", date(2026, 10, 1), date(2026, 10, 31)),
    ("this_year", date(2026, 1, 1), date(2026, 11, 14)),
    ("all", None, None),
])
def test_presets(preset, start, end):
    r = resolve_range(preset, today=TODAY)
    assert (r.start, r.end) == (start, end)


def test_last_month_across_new_year_and_leap_february():
    assert resolve_range("last_month", today=date(2027, 1, 9), ).start == date(2026, 12, 1)
    r = resolve_range("last_month", today=date(2024, 3, 5))
    assert (r.start, r.end) == (date(2024, 2, 1), date(2024, 2, 29))


def test_custom_range_validation():
    assert resolve_range("custom", "2026-10-01", "2026-10-05", today=TODAY).end == date(2026, 10, 5)
    assert resolve_range("custom", "2026-10-01", None, today=TODAY).end == TODAY
    for bad in (("custom", None, None), ("custom", "2026-10-09", "2026-10-01"), ("custom", "nope", None), ("bogus", None, None)):
        with pytest.raises(ValidationError):
            resolve_range(*bad, today=TODAY)


def test_bad_params_are_400_not_500(adm):
    for params in ({"preset": "nope"}, {"salesman": "abc"}, {"product": "<script>"}, {"preset": "custom"}):
        assert adm.get("/api/reports/overview/", params).status_code == 400


# ───────────────────────────── access ─────────────────────────────

def test_login_required_and_read_only(world, adm):
    assert APIClient().get("/api/reports/overview/").status_code == 401
    assert APIClient().get("/api/reports/overview/export/").status_code == 401
    assert adm.post("/api/reports/overview/", {}).status_code == 405
    assert adm.get("/api/reports/not-a-report/").status_code == 404


def test_every_report_loads_for_every_role(world):
    slugs = ["overview", "date-wise", "salesman-wise", "dealer-wise", "product-wise", "salesman-product", "order-wise", "periods",
             "visit-performance", "followup-reports", "sales-targets"]
    for user in (world["admin"], world["manager"], world["amol"].user):
        c = client_for(user)
        for slug in slugs:
            r = c.get(f"/api/reports/{slug}/", {"preset": "all"})
            assert r.status_code == 200, (user.role, slug, r.data)


def test_reports_never_write(world, adm):
    models = (Visit, VisitOrderItem, Followup, Dealer, Product, Salesman, DealerOwnershipHistory)
    before = [m.objects.count() for m in models]
    for slug in ("overview", "salesman-wise", "dealer-wise", "followup-reports", "sales-targets", "order-wise"):
        get(adm, slug, preset="all")
        adm.get(f"/api/reports/{slug}/export/", {"preset": "all", "file": "xlsx"})
    assert [m.objects.count() for m in models] == before


# ───────────────────────────── numbers and filters ─────────────────────────────

def test_overview_totals(world, adm):
    d = get(adm, "overview", **R)
    assert card_of(d, "orders") == 3  # V1, V2, V4
    assert card_of(d, "qty") == 4 + 6 + 10 + 5 + 2
    assert card_of(d, "visits") == 4  # V1..V4
    assert card_of(d, "conversion") == 75.0
    assert card_of(d, "dealers") == 3  # Alpha, Gamma, Beta
    assert card_of(d, "salesmen") == 2


def test_orders_and_units_are_never_double_counted(world, adm):
    """V1 has two lines and two follow-ups, V2 a follow-up too: units must still be the plain sum of lines."""
    d = get(adm, "overview", **R)
    assert card_of(d, "qty") == 27
    daily = next(c for c in d["charts"] if c["id"] == "daily")["points"]
    assert sum(p["qty"] for p in daily) == 27 and sum(p["orders"] for p in daily) == 3
    people = tbl(get(adm, "salesman-wise", **R), "salesmen")["rows"]
    assert sum(r["qty"] for r in people) == 27 and sum(r["orders"] for r in people) == 3
    dates = tbl(get(adm, "date-wise", **R), "daily")
    assert dates["totals"]["qty"] == 27 and sum(r["qty"] for r in dates["rows"]) == 27
    assert sum(r["qty"] for r in tbl(get(adm, "product-wise", **R), "products")["rows"]) == 27
    assert sum(r["qty"] for r in tbl(get(adm, "dealer-wise", **R), "dealers")["rows"]) == 27


def test_filters_work_together(world, adm):
    w = world
    assert card_of(get(adm, "overview", **R, product=f"p{w['pa'].id}"), "qty") == 14
    assert card_of(get(adm, "overview", **R, product=f"p{w['pa'].id}"), "orders") == 2
    ppf = get(adm, "overview", **R, category="PPF")  # Film B only: 6 (V1) + 5 (V4)
    assert card_of(ppf, "qty") == 11 and card_of(ppf, "orders") == 2
    custom = get(adm, "overview", **R, product="n:custom tint")
    assert card_of(custom, "qty") == 2 and card_of(custom, "orders") == 1
    assert card_of(get(adm, "overview", **R, salesman=w["amol"].id), "qty") == 20
    assert card_of(get(adm, "overview", **R, dealer=w["d2"].id), "qty") == 7
    both = get(adm, "overview", **R, salesman=w["amol"].id, product=f"p{w['pb'].id}")  # Amol's Film B: V1 only
    assert card_of(both, "qty") == 6 and card_of(both, "orders") == 1
    assert card_of(get(adm, "overview", **R, salesman=w["bina"].id, dealer=w["d1"].id), "qty") == 0


def test_date_presets_change_the_numbers(world, adm):
    assert card_of(get(adm, "overview", preset="today"), "orders") == 0
    assert card_of(get(adm, "overview", preset="yesterday"), "visits") == 0
    assert card_of(get(adm, "overview", preset="last7"), "qty") == 3  # V5 only
    assert card_of(get(adm, "overview", preset="all"), "qty") == 1 + 4 + 6 + 10 + 5 + 2 + 3 + 2
    assert card_of(get(adm, "overview", preset="custom", **{"from": iso(60), "to": iso(40)}), "qty") == 1 + 2


def test_order_id_filter_ignores_the_date_range(world, adm):
    d = get(adm, "order-wise", preset="last7", order=world["v1"].id)  # V1 is 20 days old
    rows = tbl(d, "orders")["rows"]
    assert [r["order_id"] for r in rows] == [world["v1"].id] and rows[0]["qty"] == 10
    assert any("ignored" in n for n in d["notes"])
    assert tbl(get(adm, "order-wise", preset="all", order=world["v3"].id), "orders")["rows"] == []  # a visit with no order is not an order


def test_orders_list_search_and_items(world, adm):
    t = tbl(get(adm, "order-wise", **R), "orders")
    assert t["total"] == 3 and [r["order_id"] for r in t["rows"]] == [world["v4"].id, world["v2"].id, world["v1"].id]  # newest first
    by_id = {r["order_id"]: r for r in t["rows"]}
    assert by_id[world["v1"].id]["items"] == "Film A × 4, Film B × 6" and by_id[world["v1"].id]["lines"] == 2
    assert tbl(get(adm, "order-wise", **R, q="tint"), "orders")["total"] == 1
    assert tbl(get(adm, "order-wise", **R, q=f"#{world['v2'].id}"), "orders")["total"] == 1
    assert tbl(get(adm, "order-wise", **R, q="beta"), "orders")["total"] == 1
    assert tbl(get(adm, "order-wise", **R, q="amol"), "orders")["total"] == 2


def test_orders_page_does_not_query_per_row(world, adm, django_assert_max_num_queries):
    for n in range(30):
        visit(world["amol"], world["d1"], 15, [(world["pa"], 1), (world["pb"], 1)], hour=8 + n % 10)
    with django_assert_max_num_queries(12):
        d = get(adm, "order-wise", **R)
    assert len(tbl(d, "orders")["rows"]) == 25 and tbl(d, "orders")["total"] == 33


def test_product_report_highlights(world, adm):
    d = get(adm, "product-wise", **R)
    assert card_of(d, "most") == "Film A" and card_of(d, "least") == "Custom Tint"
    assert card_of(d, "cat") == "Window Film"  # 14 units against PPF's 11
    rows = {r["label"]: r for r in tbl(d, "products")["rows"]}
    assert rows["Film A"]["qty"] == 14 and rows["Film A"]["orders"] == 2 and rows["Film A"]["dealers"] == 1
    assert rows["Film B"]["qty"] == 11 and rows["Film B"]["dealers"] == 2 and rows["Film B"]["salesmen"] == 2
    assert rows["Custom Tint"]["kind"] == "Custom"
    assert [r["label"] for r in tbl(d, "unsold")["rows"]] == ["Film Z"]
    cats = {r["label"]: r for r in tbl(d, "categories")["rows"]}
    assert cats["PPF"]["qty"] == 11 and cats["PPF"]["orders"] == 2 and cats["Window Film"]["qty"] == 14 and cats["Uncategorised"]["qty"] == 2
    assert card_of(d, "freq") == "Film A"  # Film A and Film B are both in two orders; the tie goes to the larger quantity


def test_a_catalogue_product_renamed_stays_one_row(world, adm):
    world["pa"].name = "Film A Premium"
    world["pa"].save()
    rows = tbl(get(adm, "product-wise", preset="all"), "products")["rows"]
    assert [r["label"] for r in rows].count("Film A Premium") == 1 and not any(r["label"] == "Film A" for r in rows)


def test_free_text_names_merge_ignoring_case(world, adm):
    visit(world["amol"], world["d1"], 10, [("custom tint", 3)])
    rows = [r for r in tbl(get(adm, "product-wise", preset="all"), "products")["rows"] if r["label"].lower() == "custom tint"]
    assert len(rows) == 1 and rows[0]["qty"] == 5


def test_salesman_report_and_leaderboards(world, adm):
    d = get(adm, "salesman-wise", **R)
    rows = {r["name"]: r for r in tbl(d, "salesmen")["rows"]}
    assert rows["Amol"]["visits"] == 3 and rows["Amol"]["orders"] == 2 and rows["Amol"]["qty"] == 20
    assert rows["Amol"]["dealers_visited"] == 2 and rows["Amol"]["dealers_ordered"] == 1 and rows["Amol"]["avg_qty"] == 10.0
    assert rows["Amol"]["conversion"] == 66.7 and rows["Bina"]["conversion"] == 100.0
    rk = {r["id"]: r["rows"] for r in d["rankings"]}
    assert [x["name"] for x in rk["qty"]] == ["Amol", "Bina"] and rk["qty"][0]["rank"] == 1
    assert [x["name"] for x in rk["orders"]] == ["Amol", "Bina"]
    assert rk["conversion"][0]["name"] == "Bina" and rk["conversion"][0]["value"] == 100.0
    assert not any("revenue" in r["title"].lower() for r in d["rankings"])


def test_leaderboard_ties_share_a_rank(world, adm):
    bina = world["bina"]
    visit(bina, world["d2"], 8, [(world["pa"], 1)])  # Bina: 2 orders in the period, same as Amol
    rk = {r["id"]: r["rows"] for r in get(adm, "salesman-wise", **R)["rankings"]}
    assert [x["rank"] for x in rk["orders"]] == [1, 1]


def test_idle_salesmen_are_listed_with_zeros_but_not_ranked(world, adm):
    make_salesman("chitra", "9000000003")
    d = get(adm, "salesman-wise", **R)
    rows = {r["name"]: r for r in tbl(d, "salesmen")["rows"]}
    assert rows["Chitra"]["orders"] == 0 and rows["Chitra"]["conversion"] == 0.0
    assert all(x["name"] != "Chitra" for r in d["rankings"] for x in r["rows"])


def test_salesman_detail_has_complete_history(world, adm):
    d = get(adm, f"salesman-wise/{world['amol'].id}", preset="all")
    hist = tbl(d, "orders")
    assert hist["total"] == 4  # V6, V1, V2, V7
    assert card_of(d, "orders") == 4 and card_of(d, "qty") == 1 + 10 + 10 + 2
    assert adm.get("/api/reports/salesman-wise/99999/").status_code == 404


def test_dealer_report_new_repeat_and_idle(world, adm):
    d = get(adm, "dealer-wise", **R)
    kinds = {r["name"]: r["type"] for r in tbl(d, "dealers")["rows"]}
    assert kinds == {"Alpha Motors": "Repeat", "Beta Garage": "New"}
    assert card_of(d, "new") == 1 and card_of(d, "repeat") == 1
    idle = {r["name"]: r for r in tbl(d, "idle")["rows"]}
    assert set(idle) == {"Gamma Autos", "Epsilon Wraps"}  # never ordered / last order 45 days ago
    assert idle["Gamma Autos"]["status"] == "Never ordered" and idle["Gamma Autos"]["days"] is None
    assert idle["Epsilon Wraps"]["days"] == 45
    assert [r["name"] for r in tbl(d, "idle")["rows"]][0] == "Gamma Autos"  # never ordered first
    assert set(r["name"] for r in tbl(get(adm, "dealer-wise", **R, idle_days=60), "idle")["rows"]) == {"Gamma Autos"}
    assert [x["name"] for x in next(r for r in d["rankings"] if r["id"] == "top_qty")["rows"]] == ["Alpha Motors", "Beta Garage"]


def test_idle_list_respects_product_filter_and_archive(world, adm):
    world["d3"].is_archived = True
    world["d3"].save()
    names = {r["name"] for r in tbl(get(adm, "dealer-wise", **R), "idle")["rows"]}
    assert "Gamma Autos" not in names
    # "no order for Film B recently": Alpha's last Film B order was 20 days ago, Beta's 11, Epsilon's 45
    only_b = {r["name"] for r in tbl(get(adm, "dealer-wise", **R, product=f"p{world['pb'].id}", idle_days=30), "idle")["rows"]}
    assert only_b == {"Epsilon Wraps"}


def test_dealer_detail(world, adm):
    d = get(adm, f"dealer-wise/{world['d1'].id}", preset="all")
    assert card_of(d, "orders") == 3 and card_of(d, "qty") == 1 + 10 + 10
    assert tbl(d, "orders")["total"] == 3


def test_salesman_vs_product(world, adm):
    d = get(adm, "salesman-product", **R)
    pairs = {(r["salesman"], r["product"]): r["qty"] for r in tbl(d, "matrix")["rows"]}
    assert pairs == {("Amol", "Film A"): 14, ("Amol", "Film B"): 6, ("Bina", "Film B"): 5, ("Bina", "Custom Tint"): 2}
    top = {r["product"]: r["salesman"] for r in tbl(d, "top_product")["rows"]}
    assert top == {"Film A": "Amol", "Film B": "Amol", "Custom Tint": "Bina"}
    assert card_of(d, "top") == "Amol"
    best = {r["name"]: r["top_products"] for r in tbl(d, "best_products")["rows"]}
    assert best["Amol"].startswith("Film A (14)") and best["Bina"].startswith("Film B (5)")
    one = get(adm, "salesman-product", **R, product=f"p{world['pb'].id}")  # who sells Film B the most?
    assert [(r["salesman"], r["qty"]) for r in tbl(one, "matrix")["rows"]] == [("Amol", 6), ("Bina", 5)]
    assert tbl(one, "matrix")["rows"][0]["share"] == pytest.approx(54.5)


def test_visit_performance(world, adm):
    d = get(adm, "visit-performance", **R)
    assert [card_of(d, k) for k in ("visits", "orders", "without")] == [4, 3, 1] and card_of(d, "conversion") == 75.0
    barren = tbl(d, "barren")["rows"]
    assert [r["id"] for r in barren] == [world["v3"].id]
    outcome = next(c for c in d["charts"] if c["id"] == "outcome")["points"]
    assert [p["value"] for p in outcome] == [3, 1]


def test_followup_report(world, adm):
    d = get(adm, "followup-reports", **R)  # by due date: the completed, the overdue ones and the cancelled one
    assert [card_of(d, k) for k in ("total", "pending", "completed", "overdue", "cancelled")] == [4, 2, 1, 2, 1]
    # only the completed follow-up on Alpha was followed by a later order (V2); the one created before V2 does not count V2
    assert card_of(d, "converted") == 1
    rows = {r["name"]: r for r in tbl(d, "salesmen")["rows"]}
    assert rows["Amol"]["converted"] == 1 and rows["Amol"]["rate"] == 33.3 and rows["Bina"]["converted"] == 0
    assert len(tbl(d, "overdue")["rows"]) == 2
    status = next(c for c in d["charts"] if c["id"] == "status")["points"]
    assert [p["value"] for p in status] == [1, 0, 2, 1]


def test_followup_conversion_needs_the_same_salesman(world, adm):
    visit(world["bina"], world["d3"], 3, [(world["pa"], 1)])  # Bina orders at Gamma after Amol's follow-up there
    assert card_of(get(adm, "followup-reports", **R), "converted") == 1  # still only Alpha's


def test_periods(world, adm):
    d = get(adm, "periods", preset="all")
    months = tbl(d, "monthly")["rows"]
    assert sum(r["qty"] for r in months) == 33 and sum(r["orders"] for r in months) == 6
    assert months[0]["qty_change"] is not None or len(months) == 1
    assert [r["period"] for r in months] == sorted([r["period"] for r in months], reverse=True)
    assert sum(r["qty"] for r in tbl(d, "yearly")["rows"]) == 33


def test_date_wise_lists_only_active_days_newest_first(world, adm):
    rows = tbl(get(adm, "date-wise", **R), "daily")["rows"]
    assert [r["date"] for r in rows] == [iso(11), iso(12), iso(20)]
    assert rows[1] == {"date": iso(12), "weekday": rows[1]["weekday"], "orders": 1, "qty": 10, "visits": 2, "dealers": 1}


# ───────────────────────────── targets ─────────────────────────────

def test_targets_for_a_month(world, adm):
    amol, bina = world["amol"], world["bina"]
    amol.monthly_order_target, amol.monthly_visit_target = 4, 5
    amol.save()
    bina.monthly_order_target = 2
    bina.save()
    for day in (5, 10):  # March 2025: Amol 2 orders + 1 plain visit; Bina 2 orders
        v = Visit.objects.create(salesman=amol, dealer=world["d1"], visited_at=datetime(2025, 3, day, 12, tzinfo=timezone.get_current_timezone()))
        VisitOrderItem.objects.create(visit=v, product_name="x", quantity=1)
        v = Visit.objects.create(salesman=bina, dealer=world["d2"], visited_at=datetime(2025, 3, day, 13, tzinfo=timezone.get_current_timezone()))
        VisitOrderItem.objects.create(visit=v, product_name="x", quantity=1)
    Visit.objects.create(salesman=amol, dealer=world["d1"], visited_at=datetime(2025, 3, 20, 12, tzinfo=timezone.get_current_timezone()))
    d = get(adm, "sales-targets", month="2025-03")
    rows = {r["name"]: r for r in tbl(d, "targets")["rows"]}
    a = rows["Amol"]
    assert (a["order_target"], a["orders"], a["order_left"], a["order_pct"]) == (4, 2, 2, 50.0)
    assert (a["visit_target"], a["visits"], a["visit_left"], a["visit_pct"]) == (5, 3, 2, 60.0)
    assert rows["Bina"]["order_pct"] == 100.0 and rows["Bina"]["rank"] == 1 and a["rank"] == 2
    assert card_of(d, "target") == 6 and card_of(d, "achieved") == 4 and card_of(d, "hit") == 1
    assert [x["name"] for x in d["rankings"][0]["rows"]] == ["Bina", "Amol"]
    assert adm.get("/api/reports/sales-targets/", {"month": "2025-13"}).status_code == 400


def test_targets_leave_untargeted_salesmen_unranked(world, adm):
    d = get(adm, "sales-targets", month="2025-03")
    rows = tbl(d, "targets")["rows"]
    assert all(r["rank"] is None and r["order_pct"] is None and r["order_left"] is None for r in rows)


# ───────────────────────────── comparison ─────────────────────────────

def test_compare_ranges_and_growth(world, adm):
    a, b = f"{iso(25)}..{iso(15)}", f"{iso(14)}..{iso(5)}"
    d = get(adm, "compare", type="range", a=a, b=b)
    rows = {r["metric"]: r for r in tbl(d, "compare")["rows"]}
    assert (rows["Orders"]["a"], rows["Orders"]["b"], rows["Orders"]["change"]) == (1, 2, 100.0)
    assert (rows["Quantity sold"]["a"], rows["Quantity sold"]["b"], rows["Quantity sold"]["change"]) == (10, 17, 70.0)
    assert rows["Visit → order rate"]["change"] is None and rows["Visit → order rate"]["delta"] == -33.3  # 100% -> 66.7%, in points


def test_compare_products_salesmen_dealers(world, adm):
    w = world
    d = get(adm, "compare", type="product", a=f"p{w['pa'].id}", b=f"p{w['pb'].id}", **R)
    rows = {r["metric"]: r for r in tbl(d, "compare")["rows"]}
    assert (rows["Quantity sold"]["a"], rows["Quantity sold"]["b"], rows["Quantity sold"]["change"]) == (14, 11, -21.4)
    assert "Visits" not in rows  # visits do not depend on the product
    d = get(adm, "compare", type="salesman", a=w["amol"].id, b=w["bina"].id, **R)
    rows = {r["metric"]: r for r in tbl(d, "compare")["rows"]}
    assert (rows["Quantity sold"]["a"], rows["Quantity sold"]["b"]) == (20, 7) and rows["Quantity sold"]["change"] == -65.0
    d = get(adm, "compare", type="dealer", a=w["d1"].id, b=w["d2"].id, **R)
    assert {r["metric"]: r["a"] for r in tbl(d, "compare")["rows"]}["Orders"] == 2


def test_compare_months_and_no_base(world, adm):
    for m, day, qty in (("2025-03", 5, 10), ("2025-04", 7, 15)):
        v = Visit.objects.create(salesman=world["amol"], dealer=world["d1"], visited_at=datetime(2025, int(m[-2:]), day, 12, tzinfo=timezone.get_current_timezone()))
        VisitOrderItem.objects.create(visit=v, product_name="x", quantity=qty)
    rows = {r["metric"]: r for r in tbl(get(adm, "compare", type="month", a="2025-03", b="2025-04"), "compare")["rows"]}
    assert rows["Quantity sold"]["change"] == 50.0
    rows = {r["metric"]: r for r in tbl(get(adm, "compare", type="month", a="2025-02", b="2025-03"), "compare")["rows"]}
    assert rows["Quantity sold"]["a"] == 0 and rows["Quantity sold"]["change"] is None  # nothing to grow from


def test_compare_validation(world, adm):
    for params in ({}, {"type": "x"}, {"type": "month", "a": "2025-03"}, {"type": "salesman", "a": "z", "b": "1"}, {"type": "range", "a": "1..2", "b": "3..4"}):
        assert adm.get("/api/reports/compare/", params).status_code == 400
    assert adm.get("/api/reports/compare/", {"type": "salesman", "a": 999, "b": 998}).status_code == 404


# ───────────────────────────── role scoping ─────────────────────────────

def test_salesman_sees_only_own_numbers_whatever_they_ask_for(world):
    w = world
    c = client_for(w["bina"].user)
    d = get(c, "overview", **R)
    assert card_of(d, "orders") == 1 and card_of(d, "qty") == 7 and d["meta"]["scope"] == "own"
    assert all(card["key"] != "salesmen" for card in d["cards"])
    sneaky = get(c, "overview", **R, salesman=w["amol"].id)  # the parameter is ignored
    assert card_of(sneaky, "qty") == 7
    assert card_of(get(c, "overview", **R, dealer=w["d1"].id), "qty") == 0  # not Bina's dealer
    rows = tbl(get(c, "salesman-wise", **R), "salesmen")["rows"]
    assert [r["name"] for r in rows] == ["Bina"] and get(c, "salesman-wise", **R)["rankings"] == []
    assert {r["dealer"] for r in tbl(get(c, "order-wise", preset="all"), "orders")["rows"]} == {"Beta Garage"}
    assert {r["salesman"] for r in tbl(get(c, "salesman-product", **R), "matrix")["rows"]} == {"Bina"}
    assert {r["name"] for r in tbl(get(c, "dealer-wise", **R), "dealers")["rows"]} == {"Beta Garage"}
    assert {r["name"] for r in tbl(get(c, "dealer-wise", **R), "idle")["rows"]} == set()
    assert card_of(get(c, "followup-reports", preset="all"), "total") == 1  # only Bina's own
    assert [r["name"] for r in tbl(get(c, "sales-targets"), "targets")["rows"]] == ["Bina"]


def test_salesman_cannot_open_other_peoples_detail_pages_or_compare_salesmen(world):
    w = world
    c = client_for(w["bina"].user)
    assert c.get(f"/api/reports/salesman-wise/{w['amol'].id}/").status_code == 404
    assert c.get(f"/api/reports/salesman-wise/{w['bina'].id}/").status_code == 200
    assert c.get(f"/api/reports/dealer-wise/{w['d1'].id}/").status_code == 404  # not Bina's dealer: same answer as a missing one
    assert c.get("/api/reports/dealer-wise/99999/").status_code == 404
    assert c.get(f"/api/reports/dealer-wise/{w['d2'].id}/").status_code == 200
    assert c.get("/api/reports/compare/", {"type": "salesman", "a": w["amol"].id, "b": w["bina"].id}).status_code == 403
    assert c.get("/api/reports/compare/", {"type": "dealer", "a": w["d1"].id, "b": w["d2"].id}).status_code == 404  # never leaks the other dealer's name
    ok = c.get("/api/reports/compare/", {"type": "product", "a": f"p{w['pa'].id}", "b": f"p{w['pb'].id}", **R})
    assert ok.status_code == 200 and {r["metric"]: r["a"] for r in ok.json()["tables"][0]["rows"]}["Quantity sold"] == 0


def test_a_dealer_transferred_away_leaves_the_old_salesmans_reports(world):
    """Same rule as Visit History: once a dealer is not theirs any more, their old visits drop out of their lists."""
    DealerOwnershipHistory.objects.filter(dealer=world["d2"]).update(ended_at=timezone.now())
    d = get(client_for(world["bina"].user), "overview", preset="all")
    assert card_of(d, "orders") == 0 and card_of(d, "visits") == 0
    assert card_of(get(client_for(world["admin"]), "overview", preset="all"), "orders") == 6  # management still sees everything


def test_user_without_a_salesman_profile_is_refused(world):
    ghost = make_user("ghost", Role.SALESMAN)
    assert client_for(ghost).get("/api/reports/overview/").status_code == 403


def test_options(world, adm):
    o = adm.get("/api/reports/options/").json()
    assert {s["name"] for s in o["salesmen"]} == {"Amol", "Bina"} and o["categories"] == ["PPF", "Window Film"]
    labels = {p["value"]: p["label"] for p in o["products"]}
    assert "n:custom tint" in labels and labels[f"p{world['pa'].id}"] == "Film A"
    so = client_for(world["bina"].user).get("/api/reports/options/").json()
    assert so["salesmen"] == [] and so["management"] is False
    assert len(o["months"]) >= 2 and o["months"] == sorted(o["months"], reverse=True)
    found = adm.get("/api/reports/dealer-options/", {"q": "alpha"}).json()
    assert [d["name"] for d in found] == ["Alpha Motors"]
    mine = client_for(world["bina"].user).get("/api/reports/dealer-options/", {"q": "alpha"}).json()
    assert mine == []  # type-ahead never reveals dealers the salesman cannot see


# ───────────────────────────── exports ─────────────────────────────

def xlsx(resp):
    assert resp.status_code == 200 and "spreadsheetml" in resp["Content-Type"] and "attachment" in resp["Content-Disposition"]
    return load_workbook(io.BytesIO(resp.content))


def test_excel_export_respects_filters(world, adm):
    wb = xlsx(adm.get("/api/reports/order-wise/export/", {**R, "file": "xlsx"}))
    assert wb.sheetnames[0] == "Summary" and "Orders" in wb.sheetnames
    assert wb["Orders"].max_row == 1 + 3  # header + 3 orders
    narrowed = xlsx(adm.get("/api/reports/order-wise/export/", {**R, "file": "xlsx", "product": "n:custom tint"}))
    assert narrowed["Orders"].max_row == 1 + 1
    summary = [[c.value for c in row] for row in wb["Summary"].iter_rows()]
    flat = " ".join(str(x) for row in summary for x in row if x)
    assert "Filters applied" in flat and "Period" in flat
    filtered = " ".join(str(c.value) for row in narrowed["Summary"].iter_rows() for c in row if c.value)
    assert "Custom tint" in filtered or "custom tint" in filtered.lower()


def test_excel_export_has_every_row_not_just_the_screen_page(world, adm):
    for n in range(40):
        visit(world["amol"], world["d1"], 16, [(world["pa"], 1)], hour=1 + n % 20)
    assert len(tbl(get(adm, "order-wise", **R), "orders")["rows"]) == 25
    wb = xlsx(adm.get("/api/reports/order-wise/export/", {**R, "file": "xlsx"}))
    assert wb["Orders"].max_row == 1 + 43


def test_excel_text_is_never_a_formula(world, adm):
    visit(world["amol"], world["d1"], 9, [('=HYPERLINK("http://evil.example","click")', 1), ("+1+1", 1)])
    wb = xlsx(adm.get("/api/reports/product-wise/export/", {"preset": "all", "file": "xlsx"}))
    ws = wb["Product-wise sales"]
    hits = [c for row in ws.iter_rows() for c in row if isinstance(c.value, str) and c.value.startswith(("=", "+"))]
    assert len(hits) == 2 and all(c.data_type == "s" for c in hits)  # text, not a formula


def test_overview_export_carries_chart_data(world, adm):
    wb = xlsx(adm.get("/api/reports/overview/export/", {**R, "file": "xlsx"}))
    assert {"Daily sales", "Top-selling products"} <= set(wb.sheetnames)


def test_pdf_export(world, adm):
    r = adm.get("/api/reports/salesman-wise/export/", {**R, "file": "pdf"})
    assert r.status_code == 200 and r["Content-Type"] == "application/pdf" and r.content[:5] == b"%PDF-"
    assert "salesman-wise-report" in r["Content-Disposition"] and iso(25) in r["Content-Disposition"]
    for slug in ("overview", "dealer-wise", "followup-reports", "sales-targets", "periods", "visit-performance", "product-wise", "salesman-product"):
        assert adm.get(f"/api/reports/{slug}/export/", {"preset": "all", "file": "pdf"}).content[:5] == b"%PDF-"
    assert adm.get(f"/api/reports/salesman-wise/{world['amol'].id}/export/", {"preset": "all", "file": "pdf"}).content[:5] == b"%PDF-"
    assert adm.get("/api/reports/compare/export/", {"type": "product", "a": f"p{world['pa'].id}", "b": f"p{world['pb'].id}", "file": "pdf"}).content[:5] == b"%PDF-"


def test_pdf_survives_non_latin_text(world, adm):
    visit(world["amol"], world["d1"], 9, [("फिल्म ग्लास", 1)])
    assert adm.get("/api/reports/product-wise/export/", {"preset": "all", "file": "pdf"}).content[:5] == b"%PDF-"


def test_export_is_scoped_for_salesmen(world):
    c = client_for(world["bina"].user)
    wb = xlsx(c.get("/api/reports/order-wise/export/", {"preset": "all", "file": "xlsx", "salesman": world["amol"].id}))
    rows = [[cell.value for cell in row] for row in wb["Orders"].iter_rows(min_row=2)]
    assert len(rows) == 2  # Bina's V4 and V5 only, despite asking for Amol
    assert not any("Alpha" in str(v) for r in rows for v in r)


def test_bad_export_format_is_rejected(world, adm):
    assert adm.get("/api/reports/overview/export/", {"file": "docx"}).status_code == 400


# ───────────────────────────── units: never add 5 kg to 3 rolls ─────────────────────────────

@pytest.fixture
def mixed(world):
    """Add one order in rolls, inside the period, to a world that is otherwise all pieces."""
    v = visit(world["amol"], world["d1"], 8)
    VisitOrderItem.objects.create(visit=v, product=world["pa"], product_name="Film A", quantity=3, unit="roll")
    return v


def test_single_unit_is_named_and_not_warned(world, adm):
    d = get(adm, "overview", **R)
    assert d["warnings"] == [] and d["meta"]["unit"] == "pcs" and d["meta"]["units"] == ["pcs"]


def test_mixed_units_are_flagged_and_broken_down(world, mixed, adm):
    d = get(adm, "overview", **R)
    assert d["meta"]["unit"] == "mixed" and set(d["meta"]["units"]) == {"pcs", "roll"}
    assert len(d["warnings"]) == 1 and "different units" in d["warnings"][0] and "pcs" in d["warnings"][0] and "roll" in d["warnings"][0]
    by_unit = {r["unit"]: r for r in tbl(d, "units")["rows"]}
    assert by_unit["pcs"]["quantity"] == 27 and by_unit["roll"]["quantity"] == 3 and by_unit["roll"]["orders"] == 1
    assert [c["label"] for c in tbl(d, "units")["columns"]][:2] == ["Unit", "Quantity"]


def test_unit_filter_compares_like_with_like(world, mixed, adm):
    rolls = get(adm, "overview", **R, unit="roll")
    assert card_of(rolls, "qty") == 3 and card_of(rolls, "orders") == 1 and rolls["warnings"] == [] and rolls["meta"]["unit"] == "roll"
    pcs = get(adm, "overview", **R, unit="pcs")
    assert card_of(pcs, "qty") == 27 and card_of(pcs, "orders") == 3 and pcs["warnings"] == []
    assert card_of(get(adm, "overview", **R, unit="ROLL"), "qty") == 3  # capital letters do not matter
    assert card_of(get(adm, "overview", **R, unit="kg"), "qty") == 0
    assert [r["label"] for r in tbl(get(adm, "product-wise", **R, unit="roll"), "products")["rows"]] == ["Film A"]
    assert any(f == {"label": "Unit", "value": "roll"} for f in rolls["meta"]["filters"])
    assert adm.get("/api/reports/overview/", {"unit": "<b>"}).status_code == 400


def test_every_report_that_shows_quantity_warns_and_the_others_do_not(world, mixed, adm):
    for slug in ("overview", "date-wise", "salesman-wise", "dealer-wise", "product-wise", "salesman-product", "order-wise", "periods"):
        assert get(adm, slug, **R)["warnings"], slug
    for slug in ("visit-performance", "followup-reports", "sales-targets"):
        assert get(adm, slug, **R)["warnings"] == [], slug  # no quantities on these screens
    assert get(adm, f"salesman-wise/{world['amol'].id}", **R)["warnings"]


def test_comparing_products_in_different_units_warns(world, mixed, adm):
    w = world
    params = dict(type="product", a=f"p{w['pa'].id}", b=f"p{w['pb'].id}", **R)
    assert get(adm, "compare", **params)["warnings"]  # Film A has rolls, Film B only pieces
    assert get(adm, "compare", **params, unit="pcs")["warnings"] == []


def test_unit_filter_applies_to_the_order_list_and_the_idle_dealer_list(world, mixed, adm):
    rows = tbl(get(adm, "order-wise", **R, unit="roll"), "orders")["rows"]
    assert len(rows) == 1 and rows[0]["items"] == "Film A × 3"
    # Who has not ordered anything in rolls recently? Only Alpha has, so everyone else is idle for that unit.
    idle = {r["name"] for r in tbl(get(adm, "dealer-wise", **R, unit="roll", idle_days=30), "idle")["rows"]}
    assert "Alpha Motors" not in idle and {"Beta Garage", "Gamma Autos", "Epsilon Wraps"} <= idle


def test_options_list_the_units_in_use(world, mixed, adm):
    assert adm.get("/api/reports/options/").json()["units"] == ["pcs", "roll"]


def test_exports_carry_the_unit_warning(world, mixed, adm):
    wb = xlsx(adm.get("/api/reports/salesman-wise/export/", {**R, "file": "xlsx"}))
    cells = [str(c.value) for row in wb["Summary"].iter_rows() for c in row if c.value]
    assert "Warning" in cells and any("different units" in c for c in cells)
    assert adm.get("/api/reports/salesman-wise/export/", {**R, "file": "pdf"}).content[:5] == b"%PDF-"
    overview = xlsx(adm.get("/api/reports/overview/export/", {**R, "file": "xlsx"}))
    assert {"Quantity by unit", "Daily sales"} <= set(overview.sheetnames)  # chart data still exported next to the side table
