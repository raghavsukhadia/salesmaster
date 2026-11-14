from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, User
from apps.dealers.models import Dealer, DealerOwnershipHistory, DealerStatus
from apps.visits.models import Followup, Visit, VisitOrderItem

pytestmark = pytest.mark.django_db

ENDPOINTS = ["dashboard", "dealers", "salesmen", "visits", "followups"]


def client(role):
    u, _ = User.objects.get_or_create(username=f"u-{role}", defaults={"role": role})
    c = APIClient()
    c.force_authenticate(u)
    return c


@pytest.fixture
def data():
    u = User.objects.create_user("amol", first_name="Amol", last_name="J", role=Role.SALESMAN)
    s = Salesman.objects.create(user=u, phone_number="9000000001")
    st = DealerStatus.objects.create(name="Prospect")
    d1 = Dealer.objects.create(name="Owned", city="Pune", state="MH", status=st, primary_salesman=s)
    d2 = Dealer.objects.create(name="Loose", city="Pune", state="MH")
    DealerOwnershipHistory.objects.create(dealer=d1, salesman=s)
    v = Visit.objects.create(salesman=s, dealer=d1, visited_at=timezone.now())
    VisitOrderItem.objects.create(visit=v, product_name="Film", quantity=2)
    today = timezone.localdate()
    Followup.objects.create(dealer=d1, salesman=s, visit=v, due_date=today - timedelta(days=2))
    Followup.objects.create(dealer=d1, salesman=s, due_date=today)
    Followup.objects.create(dealer=d1, salesman=s, due_date=today + timedelta(days=3))
    Followup.objects.create(dealer=d1, salesman=s, due_date=today, status="completed", outcome="no_answer")
    return s, d1, d2


@pytest.mark.parametrize("name", ENDPOINTS)
def test_only_management_may_read(name):
    url = f"/api/management/{name}/"
    assert client(Role.SALESMAN).get(url).status_code == 403
    assert APIClient().get(url).status_code == 401
    assert client(Role.MANAGER).get(url).status_code == 200


def test_dashboard_numbers(data):
    r = client(Role.ADMIN).get("/api/management/dashboard/").data
    assert r["kpis"]["total_dealers"] == 2 and r["kpis"]["visits_today"] == 1
    assert r["unassigned_dealers"] == 1 and r["overdue_followups"] == 1
    assert r["kpis"]["pending_followups"] == 3
    row = r["salesman_activity"][0]
    assert row["name"] == "Amol J" and row["orders"] == 1 and row["followups_due"] == 2


def test_dealers_filters_and_owner(data):
    c = client(Role.MANAGER)
    all_ = c.get("/api/management/dealers/").data
    assert all_["summary"]["unassigned"] == 1 and all_["count"] == 2
    owned = {d["name"]: d["owner"] for d in all_["results"]}
    assert owned == {"Owned": "Amol J", "Loose": None}
    assert c.get("/api/management/dealers/", {"assignment": "unassigned"}).data["count"] == 1
    assert c.get("/api/management/dealers/", {"q": "owned"}).data["count"] == 1
    Dealer.objects.filter(name="Loose").update(is_archived=True)
    assert c.get("/api/management/dealers/").data["count"] == 1
    assert c.get("/api/management/dealers/", {"archive": "archived"}).data["count"] == 1


def test_dealers_sort_name_both_ways(data):
    c = client(Role.MANAGER)
    names = lambda sort: [d["name"] for d in c.get("/api/management/dealers/", {"sort": sort}).data["results"]]
    assert names("name") == ["Loose", "Owned"]
    assert names("name_desc") == ["Owned", "Loose"]


def test_visits_list_and_search_by_product(data):
    r = client(Role.MANAGER).get("/api/management/visits/", {"q": "film"}).data
    assert r["count"] == 1 and r["results"][0]["has_order"] and r["results"][0]["products"] == ["Film"]
    assert r["summary"]["orders"] == 1
    assert client(Role.MANAGER).get("/api/management/visits/", {"q": "nothing"}).data["count"] == 0


def test_followup_tabs_and_summary(data):
    c = client(Role.MANAGER)
    s = c.get("/api/management/followups/").data["summary"]
    assert s == {"overdue": 1, "due_today": 1, "upcoming": 1, "completed": 1, "no_response": 1}
    for tab, state in [("overdue", "overdue"), ("due_today", "due_today"), ("upcoming", "upcoming"), ("completed", "completed")]:
        res = c.get("/api/management/followups/", {"tab": tab}).data["results"]
        assert len(res) == 1 and res[0]["state"] == state


def test_salesmen_list(data):
    r = client(Role.ADMIN).get("/api/management/salesmen/").data
    assert r[0]["name"] == "Amol J" and r[0]["active"] is True


def test_dashboard_activity_has_id_last_visit_and_yesterday_trends(data):
    s, d1, _ = data
    yesterday = timezone.now() - timedelta(days=1)
    Visit.objects.create(salesman=s, dealer=d1, visited_at=yesterday)
    r = client(Role.ADMIN).get("/api/management/dashboard/").data
    row = r["salesman_activity"][0]
    assert row["id"] == s.id
    assert row["last_visit_at"] is not None
    # Today's visit is the newest, so it is the "last activity", not yesterday's.
    assert row["last_visit_at"] == max(Visit.objects.filter(salesman=s).values_list("visited_at", flat=True))
    assert r["trends"] == {"visits_yesterday": 1, "new_dealers_yesterday": 0}


def test_dashboard_last_visit_is_null_for_salesman_without_visits(data):
    u = User.objects.create_user("idle", role=Role.SALESMAN)
    idle = Salesman.objects.create(user=u, phone_number="9000000002")
    rows = {r["id"]: r for r in client(Role.MANAGER).get("/api/management/dashboard/").data["salesman_activity"]}
    assert rows[idle.id]["last_visit_at"] is None and rows[idle.id]["visits_today"] == 0


def test_stale_visit_filter_matches_dashboard_count(data):
    _, d1, d2 = data
    c = client(Role.MANAGER)

    def stale_ids():
        res = c.get("/api/management/dealers/?visit=stale").data
        return {d["id"] for d in res["results"]}, c.get("/api/management/dashboard/").data["no_recent_visit"]

    # Never visited: both dealers are stale.
    ids, card = stale_ids()
    assert ids == {d1.id, d2.id} and card == 2
    # Visited recently: only the loose dealer is left.
    Dealer.objects.filter(pk=d1.pk).update(last_visit_at=timezone.now() - timedelta(days=5))
    ids, card = stale_ids()
    assert ids == {d2.id} and card == 1
    # Older than the 30-day window: stale again.
    Dealer.objects.filter(pk=d1.pk).update(last_visit_at=timezone.now() - timedelta(days=31))
    ids, card = stale_ids()
    assert ids == {d1.id, d2.id} and card == 2
    # The filter is opt-in: the default list is unchanged.
    assert c.get("/api/management/dealers/").data["count"] == 2


def test_visit_row_checkin_is_real_gps_or_null(data):
    s, d1, _ = data
    with_gps = Visit.objects.create(
        salesman=s, dealer=d1, visited_at=timezone.now() - timedelta(minutes=5),
        visit_lat="18.520430", visit_lng="73.856744", salesman_lat="18.520430", salesman_lng="73.856744",
        location_source="browser_gps",
    )
    rows = {r["id"]: r for r in client(Role.MANAGER).get("/api/management/visits/?range=all").data["results"]}
    assert rows[with_gps.id]["checkin"] == {"lat": 18.52043, "lng": 73.856744, "source": "browser_gps"}
    no_gps = next(r for i, r in rows.items() if i != with_gps.id)
    assert no_gps["checkin"] is None
