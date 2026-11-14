from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, User
from apps.dealers.models import Dealer, DealerAccessGrant, DealerOwnershipHistory, DealerStatus
from apps.visits.models import Followup, Product, Visit, VisitOrderItem, VisitProduct

pytestmark = pytest.mark.django_db


def make_user(name, role, phone=None):
    u = User.objects.create_user(name, password="Str0ng-pass-987", role=role, first_name=name.title())
    return u, (Salesman.objects.create(user=u, phone_number=phone) if phone else None)


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
    st = DealerStatus.objects.create(name="Active")
    d = Dealer.objects.create(name="Sharma Auto", shop_name="Sharma Wheels", phone="9876543210", city="Pune", state="MH",
                              status=st, latitude="18.520000", longitude="73.856700", is_archived=True)
    DealerOwnershipHistory.objects.create(dealer=d, salesman=a)
    prod = Product.objects.create(name="Sun Film 35%")
    v = Visit.objects.create(salesman=a, dealer=d, visited_at=timezone.now(), notes="Wants film", visit_lat="18.520500",
                             visit_lng="73.856700", salesman_lat="18.5206", salesman_lng="73.8568", location_source="browser")
    VisitOrderItem.objects.create(visit=v, product_name="Sun Film 35%", product=prod, quantity=4)
    VisitOrderItem.objects.create(visit=v, product_name="Custom tint", quantity=2)
    VisitProduct.objects.create(visit=v, product=prod)
    parent = Followup.objects.create(dealer=d, salesman=a, visit=v, due_date=timezone.localdate() - timedelta(days=3),
                                     status="completed", outcome="call_again", notes="First call")
    f = Followup.objects.create(dealer=d, salesman=a, visit=v, parent=parent, due_date=timezone.localdate() - timedelta(days=2),
                                priority="high", notes="Send quote")
    child = Followup.objects.create(dealer=d, salesman=a, parent=f, due_date=timezone.localdate() + timedelta(days=5))
    return dict(admin=admin, mgr=mgr, alice=alice, bob=bob, a=a, b=b, d=d, v=v, f=f, parent=parent, child=child)


def V(pk): return f"/api/management/visits/{pk}/"
def F(pk): return f"/api/management/followups/{pk}/"


@pytest.mark.parametrize("user", ["admin", "mgr"])
def test_management_can_view_visit_in_full(world, user):
    r = api(world[user]).get(V(world["v"].id))
    assert r.status_code == 200
    d = r.data
    assert d["notes"] == "Wants film" and d["source"] == "web"
    assert d["dealer"]["name"] == "Sharma Auto" and d["dealer"]["shop_name"] == "Sharma Wheels"
    assert d["dealer"]["owner"] == "Alice" and d["dealer"]["status"] == "Active" and d["dealer"]["archived"] is True
    assert d["salesman"]["name"] == "Alice" and d["salesman"]["phone"] == "9000000001"
    assert d["location"]["visit"] == {"lat": 18.5205, "lng": 73.8567} and d["location"]["source"] == "browser"
    assert d["location"]["distance_from_dealer_m"] == 56
    assert d["order"]["has_order"] and d["order"]["total_quantity"] == 6
    assert [(i["name"], i["catalogue"]) for i in d["order"]["items"]] == [("Sun Film 35%", True), ("Custom tint", False)]
    assert d["interests"] == ["Sun Film 35%"]
    assert len(d["followups"]) == 2


def test_visit_without_gps_or_order(world):
    v = Visit.objects.create(salesman=world["b"], dealer=world["d"], visited_at=timezone.now())
    d = api(world["mgr"]).get(V(v.id)).data
    assert d["location"]["distance_from_dealer_m"] is None and d["location"]["visit"] == {"lat": None, "lng": None}
    assert d["order"] == {"has_order": False, "items": [], "total_quantity": 0, "total_amount": 0} and d["followups"] == []


def test_visit_still_visible_to_management_after_owner_changes(world):
    DealerOwnershipHistory.objects.filter(dealer=world["d"]).update(ended_at=timezone.now())
    DealerOwnershipHistory.objects.create(dealer=world["d"], salesman=world["b"])
    d = api(world["admin"]).get(V(world["v"].id)).data
    assert d["dealer"]["owner"] == "Bob" and d["salesman"]["name"] == "Alice"


def test_unowned_dealer_has_no_owner(world):
    DealerOwnershipHistory.objects.filter(dealer=world["d"]).update(ended_at=timezone.now())
    assert api(world["mgr"]).get(V(world["v"].id)).data["dealer"]["owner"] is None


@pytest.mark.parametrize("make_url", [V, F])
def test_salesmen_and_anonymous_rejected_even_for_own_records(world, make_url):
    pk = world["v"].id if make_url is V else world["f"].id
    assert api().get(make_url(pk)).status_code == 401
    assert api(world["alice"]).get(make_url(pk)).status_code == 403   # owner
    assert api(world["bob"]).get(make_url(pk)).status_code == 403
    DealerAccessGrant.objects.create(dealer=world["d"], salesman=world["b"])
    assert api(world["bob"]).get(make_url(pk)).status_code == 403   # grant holder


@pytest.mark.parametrize("make_url", [V, F])
def test_unknown_id_404_and_write_methods_not_allowed(world, make_url):
    c = api(world["admin"])
    assert c.get(make_url(99999)).status_code == 404
    pk = world["v"].id if make_url is V else world["f"].id
    for m in ("post", "patch", "put", "delete"):
        assert getattr(c, m)(make_url(pk), {}, format="json").status_code == 405


def test_followup_detail_and_derived_history(world):
    d = api(world["mgr"]).get(F(world["f"].id)).data
    assert d["state"] == "overdue" and d["days_overdue"] == 2 and d["priority"] == "high" and d["status"] == "pending"
    assert d["notes"] == "Send quote" and d["dealer"]["name"] == "Sharma Auto" and d["salesman"]["name"] == "Alice"
    assert d["visit"]["id"] == world["v"].id
    assert d["parent_id"] == world["parent"].id and d["next_ids"] == [world["child"].id]
    types = [e["type"] for e in d["history"]]
    assert sorted(types) == ["child", "created", "parent", "visit"]
    ats = [e["at"] for e in d["history"]]
    assert ats == sorted(ats, reverse=True)


def test_followup_outcome_and_completed_state(world):
    d = api(world["admin"]).get(F(world["parent"].id)).data
    assert d["state"] == "completed" and d["outcome"] == "call_again" and d["days_overdue"] == 0
    assert d["parent_id"] is None and d["next_ids"] == [world["f"].id]


def test_followup_without_visit_or_parent(world):
    d = api(world["admin"]).get(F(world["child"].id)).data
    assert d["visit"] is None and d["state"] == "upcoming"
    assert [e["type"] for e in d["history"]] == ["created", "parent"]


def test_followup_cancelled_state(world):
    Followup.objects.filter(pk=world["f"].pk).update(status="cancelled")
    assert api(world["admin"]).get(F(world["f"].id)).data["state"] == "cancelled"


def test_detail_uses_bounded_queries(world, django_assert_max_num_queries):
    for _ in range(10):
        v = Visit.objects.create(salesman=world["a"], dealer=world["d"], visited_at=timezone.now())
        VisitOrderItem.objects.create(visit=v, product_name="x", quantity=1)
    c = api(world["admin"])
    with django_assert_max_num_queries(12):
        c.get(V(world["v"].id))
    with django_assert_max_num_queries(12):
        c.get(F(world["f"].id))
