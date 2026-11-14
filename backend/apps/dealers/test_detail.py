from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Role, Salesman, User
from apps.dealers.models import Dealer, DealerAccessGrant, DealerContact, DealerOwnershipHistory, DealerStatus
from apps.visits.models import Followup, Visit, VisitOrderItem

pytestmark = pytest.mark.django_db


def make_user(name, role, phone=None):
    u = User.objects.create_user(name, password="x", role=role)
    s = Salesman.objects.create(user=u, phone_number=phone) if phone else None
    return u, s


def api(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


@pytest.fixture
def world():
    admin, _ = make_user("admin", Role.ADMIN)
    mgr, _ = make_user("mgr", Role.MANAGER)
    alice, a = make_user("alice", Role.SALESMAN, "9000000001")
    bob, b = make_user("bob", Role.SALESMAN, "9000000002")
    carol, c = make_user("carol", Role.SALESMAN, "9000000003")
    st = DealerStatus.objects.create(name="Prospect")
    DealerStatus.objects.create(name="Active")
    d = Dealer.objects.create(name="Sharma Auto", phone="9876543210", city="Pune", state="MH", status=st, gst_number="27ABCDE1234F1Z5")
    DealerOwnershipHistory.objects.create(dealer=d, salesman=a)
    DealerContact.objects.create(dealer=d, name="Raj", phone="9876543210")
    v = Visit.objects.create(salesman=a, dealer=d, visited_at=timezone.now(), notes="Talked")
    VisitOrderItem.objects.create(visit=v, product_name="Film", quantity=3)
    Visit.objects.create(salesman=a, dealer=d, visited_at=timezone.now() - timedelta(days=1))
    Followup.objects.create(dealer=d, salesman=a, visit=v, due_date=timezone.localdate() - timedelta(days=1))
    Followup.objects.create(dealer=d, salesman=a, due_date=timezone.localdate() + timedelta(days=2))
    return dict(admin=admin, mgr=mgr, alice=alice, bob=bob, carol=carol, a=a, b=b, c=c, d=d)


def url(d, suffix=""):
    return f"/api/dealers/{d.id}/{suffix}"


# ---------- detail & permissions ----------

def test_management_detail_has_everything(world):
    r = api(world["mgr"]).get(url(world["d"]))
    assert r.status_code == 200
    assert r.data["profile"]["name"] == "Sharma Auto" and r.data["profile"]["status"] == "Prospect"
    assert r.data["contacts"][0]["name"] == "Raj"
    assert r.data["stats"] == {"visits": 2, "orders": 1, "pending_followups": 2, "overdue_followups": 1}
    assert r.data["owner"]["name"] == "alice"
    assert r.data["permissions"] == {"can_edit": True, "can_transfer": False, "can_manage_access": False}
    assert "salesman_options" not in r.data
    admin_data = api(world["admin"]).get(url(world["d"])).data
    assert admin_data["permissions"]["can_transfer"] is True
    assert {o["name"] for o in admin_data["salesman_options"]} == {"alice", "bob", "carol"}


def test_salesman_sees_own_dealer_without_ownership_or_grant_info(world):
    r = api(world["alice"]).get(url(world["d"]))
    assert r.status_code == 200 and r.data["is_mine"] is True
    assert "owner" not in r.data and "grants" not in r.data and "ownership_history" not in r.data
    assert r.data["permissions"] == {"can_edit": False, "can_transfer": False, "can_manage_access": False}


def test_inaccessible_dealer_is_404_for_salesman(world):
    assert api(world["bob"]).get(url(world["d"])).status_code == 404
    for tab in ("visits", "orders", "followups", "activity"):
        assert api(world["bob"]).get(url(world["d"], tab + "/")).status_code == 404
    assert api(world["bob"]).get("/api/dealers/99999/").status_code == 404


def test_territory_does_not_open_dealer(world):
    from apps.accounts.models import SalesmanTerritory
    SalesmanTerritory.objects.create(salesman=world["b"], state="MH", city="Pune")
    assert api(world["bob"]).get(url(world["d"])).status_code == 404


def test_granted_salesman_can_view_but_not_see_grants(world):
    DealerAccessGrant.objects.create(salesman=world["b"], dealer=world["d"])
    r = api(world["bob"]).get(url(world["d"]))
    assert r.status_code == 200 and r.data["is_mine"] is False and "grants" not in r.data


def test_unauthenticated_rejected(world):
    assert APIClient().get(url(world["d"])).status_code == 401


# ---------- profile edit ----------

def test_manager_can_edit_profile(world):
    r = api(world["mgr"]).patch(url(world["d"]), {"city": "Mumbai", "status": "Active", "phone": "+91 99999 88888"}, format="json")
    assert r.status_code == 200
    d = world["d"]; d.refresh_from_db()
    assert d.city == "Mumbai" and d.status.name == "Active" and d.phone == "9999988888"


def test_edit_forbidden_for_salesman_even_if_owner(world):
    r = api(world["alice"]).patch(url(world["d"]), {"city": "X"}, format="json")
    assert r.status_code == 403
    world["d"].refresh_from_db()
    assert world["d"].city == "Pune"


@pytest.mark.parametrize("payload", [{"gst_number": "BAD"}, {"pincode": "12"}, {"name": "  "}, {"status": "Nope"}])
def test_edit_validation(world, payload):
    assert api(world["mgr"]).patch(url(world["d"]), payload, format="json").status_code == 400


def test_edit_rejects_phone_or_gst_used_by_another_dealer(world):
    Dealer.objects.create(name="Other", phone="9111111111", gst_number="29ABCDE1234F1Z5")
    c = api(world["mgr"])
    assert c.patch(url(world["d"]), {"phone": "9111111111"}, format="json").status_code == 400
    assert c.patch(url(world["d"]), {"gst_number": "29abcde1234f1z5"}, format="json").status_code == 400
    assert c.patch(url(world["d"]), {"phone": "9876543210"}, format="json").status_code == 200  # own number is fine


def test_archive_toggle(world):
    api(world["mgr"]).patch(url(world["d"]), {"is_archived": True}, format="json")
    world["d"].refresh_from_db()
    assert world["d"].is_archived


# ---------- tabs ----------

def test_tabs_content(world):
    c = api(world["mgr"])
    v = c.get(url(world["d"], "visits/")).data
    assert v["count"] == 2 and v["results"][0]["notes"] == "Talked"
    o = c.get(url(world["d"], "orders/")).data
    assert o["count"] == 1 and o["results"][0]["items"] == [{"name": "Film", "quantity": 3, "unit": "pcs"}]
    f = c.get(url(world["d"], "followups/")).data
    assert {x["state"] for x in f["results"]} == {"overdue", "upcoming"}
    assert c.get(url(world["d"], "bogus/")).status_code == 404


def test_tabs_paginate(world):
    d = world["d"]
    Visit.objects.bulk_create(Visit(salesman=world["a"], dealer=d, visited_at=timezone.now() - timedelta(days=i + 5)) for i in range(30))
    c = api(world["mgr"])
    p1 = c.get(url(d, "visits/")).data
    p2 = c.get(url(d, "visits/"), {"page": 2}).data
    assert p1["count"] == 32 and len(p1["results"]) == 25 and len(p2["results"]) == 7


# ---------- ownership transfer ----------

def test_transfer_moves_ownership_and_keeps_history(world):
    d = world["d"]
    r = api(world["admin"]).post(url(d, "transfer/"), {"salesman_id": world["b"].id, "reason": "Region change"}, format="json")
    assert r.status_code == 201 and r.data["owner"]["name"] == "bob"
    rows = list(d.ownerships.order_by("id"))
    assert rows[0].ended_at is not None and rows[1].ended_at is None and rows[1].reason == "Region change"
    assert rows[1].changed_by.username == "admin"
    d.refresh_from_db()
    assert d.primary_salesman_id == world["b"].id
    # access follows ownership, not the legacy column
    assert api(world["alice"]).get(url(d)).status_code == 404
    assert api(world["bob"]).get(url(d)).status_code == 200
    # past visits stay attributed to the previous owner
    assert d.visits.filter(salesman=world["a"]).count() == 2


def test_transfer_to_same_owner_inactive_or_unknown_rejected(world):
    d, c = world["d"], api(world["admin"])
    assert c.post(url(d, "transfer/"), {"salesman_id": world["a"].id}, format="json").status_code == 400
    world["b"].is_active = False; world["b"].save()
    assert c.post(url(d, "transfer/"), {"salesman_id": world["b"].id}, format="json").status_code == 400
    assert c.post(url(d, "transfer/"), {"salesman_id": 9999}, format="json").status_code == 400
    assert c.post(url(d, "transfer/"), {}, format="json").status_code == 400
    assert d.ownerships.filter(ended_at=None).count() == 1


def test_transfer_assigns_unowned_dealer(world):
    loose = Dealer.objects.create(name="Loose")
    r = api(world["admin"]).post(url(loose, "transfer/"), {"salesman_id": world["b"].id}, format="json")
    assert r.status_code == 201 and loose.ownerships.filter(ended_at=None).count() == 1


def test_transfer_retires_redundant_grant(world):
    d = world["d"]
    DealerAccessGrant.objects.create(salesman=world["b"], dealer=d)
    api(world["admin"]).post(url(d, "transfer/"), {"salesman_id": world["b"].id}, format="json")
    assert not DealerAccessGrant.objects.filter(dealer=d, salesman=world["b"], revoked_at=None).exists()


def test_transfer_admin_only(world):
    for who in ("mgr", "alice"):
        r = api(world[who]).post(url(world["d"], "transfer/"), {"salesman_id": world["b"].id}, format="json")
        assert r.status_code == 403
    assert world["d"].ownerships.count() == 1


# ---------- access grants ----------

def test_grant_add_and_revoke_flow(world):
    d, admin = world["d"], api(world["admin"])
    assert api(world["bob"]).get(url(d)).status_code == 404
    r = admin.post(url(d, "grants/"), {"salesman_id": world["b"].id}, format="json")
    assert r.status_code == 201
    assert api(world["bob"]).get(url(d)).status_code == 200
    listed = admin.get(url(d)).data["grants"]
    assert [g["salesman"] for g in listed] == ["bob"] and listed[0]["granted_by"] == "admin"
    assert admin.post(url(d, f"grants/{r.data['id']}/revoke/")).status_code == 200
    assert api(world["bob"]).get(url(d)).status_code == 404
    assert admin.get(url(d)).data["grants"] == []
    assert admin.post(url(d, f"grants/{r.data['id']}/revoke/")).status_code == 404  # already revoked
    g = DealerAccessGrant.objects.get(pk=r.data["id"])
    assert g.revoked_by.username == "admin"


def test_grant_validation(world):
    d, admin = world["d"], api(world["admin"])
    assert admin.post(url(d, "grants/"), {"salesman_id": world["a"].id}, format="json").status_code == 400  # owner
    assert admin.post(url(d, "grants/"), {"salesman_id": world["b"].id}, format="json").status_code == 201
    assert admin.post(url(d, "grants/"), {"salesman_id": world["b"].id}, format="json").status_code == 400  # duplicate
    world["c"].is_active = False; world["c"].save()
    assert admin.post(url(d, "grants/"), {"salesman_id": world["c"].id}, format="json").status_code == 400
    assert admin.post("/api/dealers/99999/grants/", {"salesman_id": world["b"].id}, format="json").status_code == 404


def test_regrant_after_revoke_allowed(world):
    d, admin = world["d"], api(world["admin"])
    g = admin.post(url(d, "grants/"), {"salesman_id": world["b"].id}, format="json").data
    admin.post(url(d, f"grants/{g['id']}/revoke/"))
    assert admin.post(url(d, "grants/"), {"salesman_id": world["b"].id}, format="json").status_code == 201


def test_cannot_revoke_grant_via_another_dealer(world):
    other = Dealer.objects.create(name="Other")
    g = api(world["admin"]).post(url(world["d"], "grants/"), {"salesman_id": world["b"].id}, format="json").data
    assert api(world["admin"]).post(url(other, f"grants/{g['id']}/revoke/")).status_code == 404


def test_grants_admin_only(world):
    d = world["d"]
    for who in ("mgr", "alice", "bob"):
        assert api(world[who]).post(url(d, "grants/"), {"salesman_id": world["c"].id}, format="json").status_code == 403
    g = api(world["admin"]).post(url(d, "grants/"), {"salesman_id": world["b"].id}, format="json").data
    for who in ("mgr", "alice"):
        assert api(world[who]).post(url(d, f"grants/{g['id']}/revoke/")).status_code == 403
    assert DealerAccessGrant.objects.get(pk=g["id"]).revoked_at is None


def test_db_blocks_duplicate_active_grants(world):
    from django.db import IntegrityError, transaction
    DealerAccessGrant.objects.create(salesman=world["b"], dealer=world["d"])
    with pytest.raises(IntegrityError), transaction.atomic():
        DealerAccessGrant.objects.create(salesman=world["b"], dealer=world["d"])


# ---------- activity ----------

def test_activity_history_for_management(world):
    d, admin = world["d"], api(world["admin"])
    g = admin.post(url(d, "grants/"), {"salesman_id": world["b"].id}, format="json").data
    admin.post(url(d, f"grants/{g['id']}/revoke/"))
    admin.post(url(d, "transfer/"), {"salesman_id": world["c"].id, "reason": "Moved"}, format="json")
    r = admin.get(url(d, "activity/")).data
    texts = [e["text"] for e in r["results"]]
    types = {e["type"] for e in r["results"]}
    assert types == {"visit", "followup", "ownership", "access"}
    assert any("Access granted to bob by admin" in t for t in texts)
    assert any("Access revoked for bob by admin" in t for t in texts)
    assert any("Assigned to carol by admin: Moved" in t for t in texts)
    assert any("Ownership ended for alice" in t for t in texts)
    stamps = [e["at"] for e in r["results"]]
    assert stamps == sorted(stamps, reverse=True)


def test_activity_hides_ownership_and_access_from_salesman(world):
    api(world["admin"]).post(url(world["d"], "grants/"), {"salesman_id": world["b"].id}, format="json")
    r = api(world["alice"]).get(url(world["d"], "activity/")).data
    assert {e["type"] for e in r["results"]} <= {"visit", "followup"}
    assert "bob" not in str(r)
