from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, SalesmanTerritory, User
from apps.dealers.access import accessible_dealers
from apps.dealers.models import Dealer, DealerAccessGrant, DealerOwnershipHistory
from apps.visits.models import Followup, Visit, VisitOrderItem

pytestmark = pytest.mark.django_db

PW = "Str0ng-pass-987"
BASE = "/api/management/salesmen/"


def make_user(name, role, phone=None):
    u = User.objects.create_user(name, password=PW, role=role)
    s = Salesman.objects.create(user=u, phone_number=phone) if phone else None
    return u, s


def api(user=None):
    c = APIClient()
    if user:
        c.force_authenticate(user)
    return c


@pytest.fixture
def world():
    admin, _ = make_user("admin", Role.ADMIN)
    mgr, _ = make_user("mgr", Role.MANAGER)
    alice, a = make_user("alice", Role.SALESMAN, "9000000001")
    bob, b = make_user("bob", Role.SALESMAN, "9000000002")
    d1 = Dealer.objects.create(name="One Motors", phone="9111111111", city="Pune", state="MH")
    d2 = Dealer.objects.create(name="Two Motors", phone="9222222222", city="Pune", state="MH")
    for d in (d1, d2):
        DealerOwnershipHistory.objects.create(dealer=d, salesman=a)
    return dict(admin=admin, mgr=mgr, alice=alice, bob=bob, a=a, b=b, d1=d1, d2=d2)


NEW = {"username": "newbie", "password": PW, "first_name": "New", "last_name": "Guy",
       "email": "n@x.com", "phone_number": "+91 98765 43210"}


def owner_ids(salesman):
    return set(DealerOwnershipHistory.objects.filter(salesman=salesman, ended_at__isnull=True).values_list("dealer_id", flat=True))


# ---------- permissions ----------

def test_anonymous_and_salesman_rejected(world):
    assert api().get(BASE).status_code == 401
    c = api(world["alice"])
    assert c.get(BASE).status_code == 403
    assert c.get(f"{BASE}{world['a'].id}/").status_code == 403
    assert c.post(BASE + "create/", NEW, format="json").status_code == 403


@pytest.mark.parametrize("method,suffix,body", [
    ("post", "create/", NEW),
    ("post", "{id}/reset-password/", {"password": PW}),
    ("put", "{id}/territories/", {"territories": []}),
    ("post", "{id}/assign-dealers/", {"dealer_ids": [1]}),
    ("post", "{id}/offboard/", {}),
    ("delete", "{id}/", None),
])
def test_admin_only_actions_forbidden_for_manager(world, method, suffix, body):
    r = getattr(api(world["mgr"]), method)(BASE + suffix.format(id=world["b"].id), body, format="json")
    assert r.status_code == 403


def test_manager_can_view_and_edit(world):
    c = api(world["mgr"])
    assert c.get(f"{BASE}{world['a'].id}/").status_code == 200
    r = c.patch(f"{BASE}{world['a'].id}/", {"first_name": "Alicia", "daily_visit_target": 5}, format="json")
    assert r.status_code == 200 and r.data["name"] == "Alicia" and r.data["targets"]["daily_visits"] == 5


# ---------- create / edit ----------

def test_admin_creates_salesman_with_working_login(world):
    r = api(world["admin"]).post(BASE + "create/", NEW, format="json")
    assert r.status_code == 201, r.data
    assert r.data["phone"] == "9876543210"
    login = api().post("/api/auth/token/", {"username": "newbie", "password": PW}, format="json")
    assert login.status_code == 200
    assert User.objects.get(username="newbie").role == Role.SALESMAN


@pytest.mark.parametrize("patch,field", [
    ({"username": "ALICE"}, "username"),
    ({"phone_number": "9000000001"}, "phone_number"),
    ({"phone_number": "123"}, "phone_number"),
    ({"password": "123"}, "password"),
])
def test_create_validation(world, patch, field):
    r = api(world["admin"]).post(BASE + "create/", {**NEW, **patch}, format="json")
    assert r.status_code == 400 and field in str(r.data)
    assert not User.objects.filter(username="newbie").exists()


def test_edit_rejects_duplicate_phone_and_negative_targets(world):
    c = api(world["admin"])
    assert c.patch(f"{BASE}{world['a'].id}/", {"phone_number": "9000000002"}, format="json").status_code == 400
    assert c.patch(f"{BASE}{world['a'].id}/", {"monthly_visit_target": -1}, format="json").status_code == 400
    assert c.patch(f"{BASE}{world['a'].id}/", {"phone_number": "9000000001"}, format="json").status_code == 200


def test_unknown_salesman_404(world):
    assert api(world["admin"]).get(f"{BASE}99999/").status_code == 404


def test_deactivate_blocks_login_and_api_then_reactivate(world):
    c = api(world["admin"])
    c.patch(f"{BASE}{world['a'].id}/", {"is_active": False}, format="json")
    world["alice"].refresh_from_db()
    assert not world["alice"].is_active
    assert api().post("/api/auth/token/", {"username": "alice", "password": PW}, format="json").status_code == 401
    c.patch(f"{BASE}{world['a'].id}/", {"is_active": True}, format="json")
    assert api().post("/api/auth/token/", {"username": "alice", "password": PW}, format="json").status_code == 200


def test_reset_password(world):
    r = api(world["admin"]).post(f"{BASE}{world['a'].id}/reset-password/", {"password": "An0ther-pass-55"}, format="json")
    assert r.status_code == 200
    assert api().post("/api/auth/token/", {"username": "alice", "password": "An0ther-pass-55"}, format="json").status_code == 200
    assert api(world["admin"]).post(f"{BASE}{world['a'].id}/reset-password/", {"password": "1"}, format="json").status_code == 400


def test_list_keeps_old_keys_and_adds_targets(world):
    rows = api(world["mgr"]).get(BASE).data
    row = next(r for r in rows if r["id"] == world["a"].id)
    assert {"name", "phone", "email", "active", "territories", "targets", "username"} <= set(row)


# ---------- territories ----------

def test_territories_replace_dedupe_and_do_not_grant_access(world):
    c = api(world["admin"])
    r = c.put(f"{BASE}{world['b'].id}/territories/", {"territories": [
        {"state": "MH", "city": "Pune"}, {"state": "mh", "city": "PUNE"}, {"state": "GJ"}]}, format="json")
    assert r.status_code == 200 and len(r.data["territories"]) == 2
    c.put(f"{BASE}{world['b'].id}/territories/", {"territories": [{"state": "KA"}]}, format="json")
    assert list(SalesmanTerritory.objects.filter(salesman=world["b"]).values_list("state", flat=True)) == ["KA"]
    world["d1"].refresh_from_db()
    assert world["d1"].pk not in set(accessible_dealers(world["bob"]).values_list("pk", flat=True))


def test_territory_requires_state(world):
    r = api(world["admin"]).put(f"{BASE}{world['b'].id}/territories/", {"territories": [{"state": ""}]}, format="json")
    assert r.status_code == 400


# ---------- assignment ----------

def test_assign_dealers_transfers_and_keeps_history(world):
    r = api(world["admin"]).post(f"{BASE}{world['b'].id}/assign-dealers/",
                                 {"dealer_ids": [world["d1"].id, world["d2"].id], "reason": "Rebalance"}, format="json")
    assert r.status_code == 200 and r.data == {"assigned": 2, "already_owned": 0}
    assert owner_ids(world["b"]) == {world["d1"].id, world["d2"].id}
    assert owner_ids(world["a"]) == set()
    assert DealerOwnershipHistory.objects.filter(dealer=world["d1"]).count() == 2
    assert world["d1"].pk in set(accessible_dealers(world["bob"]).values_list("pk", flat=True))


def test_assign_skips_already_owned(world):
    r = api(world["admin"]).post(f"{BASE}{world['a'].id}/assign-dealers/", {"dealer_ids": [world["d1"].id]}, format="json")
    assert r.data == {"assigned": 0, "already_owned": 1}


def test_assign_is_atomic_on_unknown_dealer(world):
    r = api(world["admin"]).post(f"{BASE}{world['b'].id}/assign-dealers/", {"dealer_ids": [world["d1"].id, 99999]}, format="json")
    assert r.status_code == 400
    assert owner_ids(world["b"]) == set() and len(owner_ids(world["a"])) == 2


def test_assign_to_inactive_rejected_and_empty_rejected(world):
    world["b"].is_active = False
    world["b"].save()
    c = api(world["admin"])
    assert c.post(f"{BASE}{world['b'].id}/assign-dealers/", {"dealer_ids": [world["d1"].id]}, format="json").status_code == 400
    assert c.post(f"{BASE}{world['a'].id}/assign-dealers/", {"dealer_ids": []}, format="json").status_code == 400


# ---------- offboarding & delete ----------

def test_offboard_with_transfer(world):
    Followup.objects.create(dealer=world["d1"], salesman=world["a"], due_date=timezone.localdate())
    DealerAccessGrant.objects.create(dealer=world["d1"], salesman=world["a"]) if False else None
    r = api(world["admin"]).post(f"{BASE}{world['a'].id}/offboard/", {"transfer_to": world["b"].id}, format="json")
    assert r.status_code == 200 and r.data["dealers_moved"] == 2 and r.data["followups_reassigned"] == 1
    assert owner_ids(world["b"]) == {world["d1"].id, world["d2"].id}
    assert not DealerAccessGrant.objects.filter(salesman=world["a"], revoked_at__isnull=True).exists()
    world["a"].refresh_from_db()
    world["alice"].refresh_from_db()
    assert not world["a"].is_active and not world["alice"].is_active


def test_offboard_without_transfer_releases_dealers(world):
    r = api(world["admin"]).post(f"{BASE}{world['a'].id}/offboard/", {}, format="json")
    assert r.status_code == 200 and r.data["dealers_released"] == 2
    assert owner_ids(world["a"]) == set()


def test_offboard_rejects_self_and_inactive_target(world):
    c = api(world["admin"])
    assert c.post(f"{BASE}{world['a'].id}/offboard/", {"transfer_to": world["a"].id}, format="json").status_code == 400
    world["b"].is_active = False
    world["b"].save()
    assert c.post(f"{BASE}{world['a'].id}/offboard/", {"transfer_to": world["b"].id}, format="json").status_code == 400
    assert owner_ids(world["a"]) != set()


def test_delete_blocked_with_history_allowed_without(world):
    c = api(world["admin"])
    assert c.delete(f"{BASE}{world['a'].id}/").status_code == 400
    assert Salesman.objects.filter(pk=world["a"].pk).exists()
    _, fresh = make_user("fresh", Role.SALESMAN, "9000000009")
    assert c.delete(f"{BASE}{fresh.id}/").status_code == 204
    assert not User.objects.filter(username="fresh").exists()


# ---------- performance & tabs ----------

def test_performance_against_targets(world):
    a = world["a"]
    a.daily_visit_target, a.monthly_visit_target, a.monthly_order_target = 2, 4, 1
    a.save()
    now = timezone.now()
    v = Visit.objects.create(salesman=a, dealer=world["d1"], visited_at=now)
    VisitOrderItem.objects.create(visit=v, product_name="Film", quantity=1)
    Visit.objects.create(salesman=a, dealer=world["d2"], visited_at=now)
    Followup.objects.create(dealer=world["d1"], salesman=a, due_date=timezone.localdate() - timedelta(days=2))
    p = api(world["mgr"]).get(f"{BASE}{a.id}/").data["performance"]
    assert p["today"] == {"visits": 2, "target": 2, "percent": 100}
    assert p["month"]["visits"] == 2 and p["month"]["visit_percent"] == 50
    assert p["month"]["orders"] == 1 and p["month"]["order_percent"] == 100
    assert p["followups"]["overdue"] == 1 and p["dealers_owned"] == 2


def test_performance_without_targets_has_no_percent(world):
    p = api(world["mgr"]).get(f"{BASE}{world['b'].id}/").data["performance"]
    assert p["today"]["percent"] is None and p["last_visit_at"] is None


def test_visits_and_dealers_tabs_scoped_and_paginated(world):
    for i in range(30):
        Visit.objects.create(salesman=world["a"], dealer=world["d1"], visited_at=timezone.now() - timedelta(minutes=i))
    Visit.objects.create(salesman=world["b"], dealer=world["d1"], visited_at=timezone.now())
    c = api(world["mgr"])
    r = c.get(f"{BASE}{world['a'].id}/visits/").data
    assert r["count"] == 30 and len(r["results"]) == 25
    assert len(c.get(f"{BASE}{world['a'].id}/visits/?page=2").data["results"]) == 5
    assert c.get(f"{BASE}{world['b'].id}/visits/").data["count"] == 1
    d = c.get(f"{BASE}{world['a'].id}/dealers/?q=two").data
    assert [x["name"] for x in d["results"]] == ["Two Motors"]
